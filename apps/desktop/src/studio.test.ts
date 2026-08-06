import assert from "node:assert/strict";
import test from "node:test";
import {
  activeGenerationAttempt,
  createSession,
  effectiveThreadDraft,
  effectiveThreadModelId,
  emptyDraft,
  initializeSessionCatalogDefaults,
  loadStudioState,
  nextAvailableSessionName,
  optionOverridesFromDefaults,
  saveStudioState,
  type StudioState,
} from "./studio.ts";

test("new session names advance past existing generated-name collisions", () => {
  const sessions = [
    { name: "First session" },
    { name: "Session 3" },
  ];
  assert.equal(nextAvailableSessionName(sessions, (count) => `Session ${count}`), "Session 4");
  assert.equal(nextAvailableSessionName([{ name: "세션 2" }], (count) => `세션 ${count}`), "세션 3");
});

test("sessions created after catalog loading inherit usable image and video defaults", () => {
  const configured = initializeSessionCatalogDefaults(createSession("Configured"), {
    image: [{
      id: "image/default",
      name: "Image default",
      supported_parameters: { quality: { type: "enum", values: ["standard", "high"] } },
    }],
    video: [{
      id: "video/generate",
      name: "Video generate",
      supported_durations: [5],
    }, {
      id: "video/edit",
      name: "Video edit",
      architecture: { input_modalities: ["text", "video"] },
      supported_durations: [8],
    }],
  });

  assert.deepEqual(configured.generationDefaults.modelIds, { image: "image/default", video: "video/generate" });
  assert.deepEqual(configured.generationDefaults.options.image, { quality: "standard" });
  assert.deepEqual(configured.generationDefaults.options.videoGenerate, { duration: 5, resolution: undefined, aspect_ratio: undefined, generate_audio: undefined });
  assert.deepEqual(configured.generationDefaults.options.videoEdit, { duration: 8, resolution: undefined, aspect_ratio: undefined, generate_audio: undefined });
});

function withLocalStorage(run: (writes: Map<string, string>) => void) {
  const writes = new Map<string, string>();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => writes.get(key) ?? null,
      setItem: (key: string, value: string) => writes.set(key, value),
      removeItem: (key: string) => writes.delete(key),
    },
  });
  try {
    run(writes);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
  }
}

test("studio metadata rejects Base64 media and keeps managed paths", () => {
  withLocalStorage((writes) => {
    const session = createSession("Managed media");
    session.assets.push({
      id: "asset-managed",
      name: "result.png",
      kind: "image",
      mimeType: "image/png",
      origin: "generated",
      createdAt: new Date().toISOString(),
      localPath: "/Users/test/.fruit-truck/generated/result.png",
    });
    const state: StudioState = {
      schemaVersion: 3,
      activeSessionId: session.id,
      promptModel: "openai/gpt-5.6-luna",
      sessions: [session],
    };
    saveStudioState(state);
    const serialized = [...writes.values()][0];
    assert.match(serialized, /"localPath"/);
    assert.doesNotMatch(serialized, /;base64,/);

    session.assets[0] = {
      ...session.assets[0],
      localPath: undefined,
      externalUrl: "data:image/png;base64,AAAA",
    };
    assert.throws(() => saveStudioState(state), /data URLs cannot be written/);
  });
});

test("new sessions start with one independent thread per mode and inherit live defaults", () => {
  const session = createSession("Parallel desk");
  assert.equal(session.threads.image.length, 1);
  assert.equal(session.threads.video.length, 1);
  assert.equal(session.activeThreadIds.image, session.threads.image[0].id);
  assert.equal(session.activeThreadIds.video, session.threads.video[0].id);

  const thread = session.threads.image[0];
  session.generationDefaults.modelIds.image = "example/default-v1";
  session.generationDefaults.options.image = { n: 2, quality: "standard" };
  assert.equal(effectiveThreadModelId(session, thread), "example/default-v1");
  assert.deepEqual(effectiveThreadDraft(session, thread).options, { n: 2, quality: "standard" });

  session.generationDefaults.modelIds.image = "example/default-v2";
  session.generationDefaults.options.image = { n: 1, quality: "high" };
  thread.modelOverrideId = "example/thread-model";
  thread.optionOverrides = { n: 4 };
  assert.equal(effectiveThreadModelId(session, thread), "example/thread-model");
  assert.deepEqual(effectiveThreadDraft(session, thread).options, { n: 4, quality: "high" });

  const now = new Date().toISOString();
  thread.attempts.push({
    id: "attempt-active",
    status: "in_progress",
    backend: "openrouter",
    draftRevision: 0,
    requestedBy: "human",
    createdAt: now,
    updatedAt: now,
    inputAssetIds: [],
    assetIds: [],
  });
  assert.equal(activeGenerationAttempt(thread)?.id, "attempt-active");
  thread.attempts[0].status = "completed";
  assert.equal(activeGenerationAttempt(thread), undefined);
});

test("option overrides retain only fields that differ from live defaults", () => {
  assert.deepEqual(
    optionOverridesFromDefaults({ quality: "standard", n: 1, seed: 7 }, { quality: "standard", n: 3, seed: 7 }),
    { n: 3 },
  );
});

test("canceled attempts are terminal and persisted history is bounded", () => {
  withLocalStorage((writes) => {
    const session = createSession("Bounded history");
    const thread = session.threads.image[0];
    const now = new Date().toISOString();
    thread.attempts = Array.from({ length: 130 }, (_, index) => ({
      id: `attempt-${index}`,
      status: index === 129 ? "canceled" as const : "completed" as const,
      backend: "openrouter" as const,
      draftRevision: 0,
      requestedBy: "human" as const,
      createdAt: now,
      updatedAt: now,
      inputAssetIds: [],
      assetIds: [],
    }));
    assert.equal(activeGenerationAttempt(thread), undefined);
    saveStudioState({ schemaVersion: 3, activeSessionId: session.id, promptModel: "openai/gpt-5.6-luna", sessions: [session] });
    const persisted = JSON.parse(writes.get("fruit-truck.studio.v1") ?? "{}") as StudioState;
    assert.equal(persisted.sessions[0].threads.image[0].attempts.length, 100);
  });
});

test("schema 1 sessions migrate their drafts and active video job into visible threads", () => {
  withLocalStorage((writes) => {
    const base = createSession("Legacy production");
    const imageDraft = emptyDraft();
    const videoDraft = emptyDraft();
    imageDraft.prompt = "A red truck at dusk";
    videoDraft.prompt = "The truck crosses frame";
    const legacy = {
      ...base,
      drafts: { image: imageDraft, videoGenerate: videoDraft, videoEdit: emptyDraft() },
      selectedModelIds: { image: "legacy/image", video: "legacy/video" },
      activeVideoJobs: [{
      kind: "video",
      jobId: "job-legacy",
      status: "in_progress" as const,
      workflow: "generate" as const,
      model: "legacy/video",
      submittedAt: new Date().toISOString(),
      request: { model: "legacy/video" },
      }],
    };
    const serialized = {
      schemaVersion: 1,
      activeSessionId: legacy.id,
      promptModel: "openai/gpt-5.6-luna",
      sessions: [{ ...legacy, generationDefaults: undefined, threads: undefined, activeThreadIds: undefined }],
    };
    writes.set("fruit-truck.studio.v1", JSON.stringify(serialized));

    const migrated = loadStudioState().sessions[0];
    assert.equal(migrated.threads.image[0].draft.prompt, "A red truck at dusk");
    assert.equal(migrated.generationDefaults.modelIds.image, "legacy/image");
    assert.equal(migrated.threads.video.some((thread) => thread.attempts.some((attempt) => attempt.jobId === "job-legacy")), true);
    assert.equal("drafts" in migrated, false);
    assert.equal("activeVideoJobs" in migrated, false);
  });
});

test("schema 2 migrates session video jobs even when generation threads already exist", () => {
  withLocalStorage((writes) => {
    const session = createSession("Schema two");
    const videoThread = session.threads.video[0];
    const submittedAt = new Date().toISOString();
    const legacy = {
      ...session,
      activeVideoJobs: [{
        kind: "video" as const,
        jobId: "job-schema-two",
        status: "in_progress" as const,
        threadId: videoThread.id,
        attemptId: "attempt-schema-two",
        workflow: "generate" as const,
        model: "legacy/video",
        submittedAt,
        request: { model: "legacy/video" },
      }],
    };
    writes.set("fruit-truck.studio.v1", JSON.stringify({ schemaVersion: 2, activeSessionId: session.id, promptModel: "openai/gpt-5.6-luna", sessions: [legacy] }));
    const migrated = loadStudioState().sessions[0];
    assert.equal(migrated.threads.video[0].attempts.find((attempt) => attempt.jobId === "job-schema-two")?.id, "attempt-schema-two");
    assert.equal("activeVideoJobs" in migrated, false);
  });
});
