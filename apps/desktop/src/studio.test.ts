import assert from "node:assert/strict";
import test from "node:test";
import {
  activeGenerationAttempt,
  beginGeneratedImageEdit,
  createSession,
  createSiblingGenerationThread,
  effectiveThreadDraft,
  effectiveThreadModelId,
  emptyDraft,
  initializeSessionCatalogDefaults,
  loadStudioState,
  nextAvailableSessionName,
  optionOverridesFromDefaults,
  importFileAsset,
  mediaMimeFromSource,
  mediaNameForMime,
  requestedImageDimensions,
  saveStudioState,
  type StudioState,
} from "./studio.ts";

test("browser imports reject empty and oversized media before storage", async () => {
  await assert.rejects(
    importFileAsset(new File([], "empty.jpg", { type: "image/jpeg" })),
    /is empty/,
  );
  await assert.rejects(
    importFileAsset(new File([new Uint8Array(30 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" })),
    /30 MB local safety limit/,
  );
});

test("generated media names and requested image dimensions match actual output", () => {
  assert.equal(mediaMimeFromSource("/generated/result.jpeg", "image/png"), "image/jpeg");
  assert.equal(mediaNameForMime("image-result.png", "image/jpeg"), "image-result.jpg");
  assert.deepEqual(requestedImageDimensions(592, 448, "512", "4:3"), { width: 512, height: 384 });
  assert.deepEqual(requestedImageDimensions(448, 592, "1K", "3:4"), { width: 768, height: 1024 });
});

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
    }],
  });

  assert.deepEqual(configured.generationDefaults.modelIds, { image: "image/default", video: "video/generate" });
  assert.deepEqual(configured.generationDefaults.options.image, { quality: "standard" });
  assert.deepEqual(configured.generationDefaults.options.video, { duration: 5, resolution: undefined, aspect_ratio: undefined, generate_audio: undefined });
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
      schemaVersion: 5,
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

test("new image and video tabs inherit the active tab model", () => {
  const session = createSession("Model inheritance");
  session.generationDefaults.modelIds = { image: "image/default", video: "video/default" };

  const imageSource = session.threads.image[0];
  const defaultSibling = createSiblingGenerationThread(imageSource, 2);
  assert.equal(defaultSibling.modelOverrideId, undefined);
  assert.equal(effectiveThreadModelId(session, defaultSibling), "image/default");
  session.generationDefaults.modelIds.image = "image/default-next";
  assert.equal(effectiveThreadModelId(session, defaultSibling), "image/default-next");

  imageSource.modelOverrideId = "image/current";
  const imageSibling = createSiblingGenerationThread(imageSource, 3);
  assert.equal(imageSibling.modelOverrideId, "image/current");
  assert.equal(effectiveThreadModelId(session, imageSibling), "image/current");

  const videoSource = session.threads.video[0];
  videoSource.modelOverrideId = "video/current";
  const videoSibling = createSiblingGenerationThread(videoSource, 2);
  assert.equal(videoSibling.modelOverrideId, "video/current");
  assert.equal(effectiveThreadModelId(session, videoSibling), "video/current");
});

test("schema 3 migrates attached #mentions once while schema 4 and newer preserve plain #text", () => {
  withLocalStorage((writes) => {
    const legacySession = createSession("Legacy mentions");
    const legacyDraft = legacySession.threads.image[0].draft;
    legacyDraft.references = [{ assetId: "asset-one", slot: 1, role: "reference" }];
    legacyDraft.prompt = "Change #1 but keep #2 plain.";
    legacyDraft.enhancedPrompt = "Enhance #1.";
    legacyDraft.imageEditTarget = "#1";
    legacyDraft.maskInstructions = "Mask #1.";
    writes.set("fruit-truck.studio.v1", JSON.stringify({
      schemaVersion: 3,
      activeSessionId: legacySession.id,
      promptModel: "openai/gpt-5.6-luna",
      sessions: [legacySession],
    }));

    const migrated = loadStudioState();
    const migratedDraft = migrated.sessions[0].threads.image[0].draft;
    assert.equal(migrated.schemaVersion, 5);
    assert.equal(migratedDraft.prompt, "Change @1 but keep #2 plain.");
    assert.equal(migratedDraft.enhancedPrompt, "Enhance @1.");
    assert.equal(migratedDraft.imageEditTarget, "@1");
    assert.equal(migratedDraft.maskInstructions, "Mask @1.");

    const currentSession = createSession("Current plain text");
    currentSession.threads.image[0].draft.references = [{ assetId: "asset-one", slot: 1, role: "reference" }];
    currentSession.threads.image[0].draft.prompt = "Keep #1 as plain text.";
    writes.set("fruit-truck.studio.v1", JSON.stringify({
      schemaVersion: 4,
      activeSessionId: currentSession.id,
      promptModel: "openai/gpt-5.6-luna",
      sessions: [currentSession],
    }));
    assert.equal(loadStudioState().sessions[0].threads.image[0].draft.prompt, "Keep #1 as plain text.");
  });
});

test("editing a generated result starts with only that result as numbered input @1", () => {
  const draft = emptyDraft();
  draft.references = [
    { assetId: "reference-one", role: "reference", slot: 1 },
    { assetId: "reference-two", role: "reference", slot: 2 },
  ];
  draft.imageEditMode = true;
  draft.imageEditTarget = "@2";
  draft.maskInstructions = "Change the old target.";
  draft.maskStrokes = [{ points: [{ x: 0.5, y: 0.5 }], size: 0.1 }];
  draft.enhancedPrompt = "Expanded old prompt";
  draft.enhancedPromptDirty = true;
  draft.enhancedVisualCount = 3;

  const edit = beginGeneratedImageEdit(draft, "generated-result");

  assert.deepEqual(edit.references, [{ assetId: "generated-result", role: "reference", slot: 1 }]);
  assert.equal(edit.imageEditMode, true);
  assert.equal(edit.imageEditTarget, "@1");
  assert.deepEqual(edit.maskStrokes, []);
  assert.equal(edit.maskInstructions, "");
  assert.equal(edit.enhancedPrompt, "");
  assert.equal(edit.enhancedPromptDirty, false);
  assert.equal(edit.enhancedVisualCount, 0);
});

test("option overrides retain only fields that differ from live defaults", () => {
  assert.deepEqual(
    optionOverridesFromDefaults({ quality: "standard", n: 1, seed: 7 }, { quality: "standard", n: 3, seed: 7 }),
    { n: 3 },
  );
});

test("schema 4 removes submitted video edit jobs with the rest of the unsupported edit state", () => {
  withLocalStorage((writes) => {
    const session = createSession("Legacy video edit cleanup");
    const generate = session.threads.video[0];
    generate.draft.prompt = "Generate a new clip";
    const edit = {
      ...createSiblingGenerationThread(generate, 2),
      id: "legacy-edit-thread",
      videoWorkflow: "edit" as const,
      draft: {
        ...emptyDraft(),
        prompt: "Edit the source clip",
        references: [{ assetId: "legacy-video", role: "video_reference", slot: 1 }],
      },
      attempts: [{
        id: "legacy-edit-attempt",
        status: "in_progress" as const,
        backend: "openrouter" as const,
        draftRevision: 0,
        requestedBy: "human" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        modelId: "legacy/video",
        request: { model: "legacy/video" },
        inputAssetIds: ["legacy-video"],
        assetIds: [],
        jobId: "legacy-edit-job",
        pollAttempts: 2,
      }],
    };
    session.assets.push({
      id: "legacy-video",
      name: "legacy.mp4",
      kind: "video",
      mimeType: "video/mp4",
      origin: "generated",
      createdAt: new Date().toISOString(),
      localPath: "/Users/test/.fruit-truck/generated/legacy.mp4",
    });
    session.agent.execution.currentJobIds = ["legacy-edit-job", "legacy-edit-job-only", "generate-job"];
    const legacy = {
      ...session,
      generationDefaults: {
        modelIds: { image: "legacy/image", video: "legacy/video" },
        options: { image: {}, videoGenerate: { duration: 6 }, videoEdit: { duration: 9 } },
        providerJson: { image: "", videoGenerate: "{\"generate\":true}", videoEdit: "{\"edit\":true}" },
      },
      threads: { ...session.threads, video: [generate, edit] },
      activeThreadIds: { ...session.activeThreadIds, video: edit.id },
      activeVideoJobs: [{
        kind: "video",
        jobId: "legacy-edit-job-only",
        status: "in_progress",
        workflow: "edit" as const,
        attemptId: "legacy-edit-job-only-attempt",
        model: "legacy/video",
        submittedAt: new Date().toISOString(),
        pollAttempts: 3,
        lastPolledAt: new Date().toISOString(),
        nextPollAt: new Date(Date.now() + 10_000).toISOString(),
        request: { model: "legacy/video" },
      }],
    };
    writes.set("fruit-truck.studio.v1", JSON.stringify({
      schemaVersion: 4,
      activeSessionId: session.id,
      promptModel: "openai/gpt-5.6-luna",
      sessions: [legacy],
    }));

    const migrated = loadStudioState();
    const recovered = migrated.sessions[0];
    assert.equal(migrated.schemaVersion, 5);
    assert.deepEqual(recovered.threads.video.map((thread) => thread.id), [generate.id]);
    assert.equal(recovered.activeThreadIds.video, generate.id);
    assert.equal(recovered.assets.some((asset) => asset.id === "legacy-video"), true);
    assert.equal(recovered.threads.video.some((thread) => thread.attempts.some((attempt) => attempt.jobId === "legacy-edit-job")), false);
    assert.equal(recovered.threads.video.some((thread) => thread.attempts.some((attempt) => attempt.jobId === "legacy-edit-job-only")), false);
    assert.deepEqual(recovered.agent.execution.currentJobIds, ["generate-job"]);
    assert.deepEqual(recovered.generationDefaults.options.video, { duration: 6 });
    assert.equal(recovered.generationDefaults.providerJson.video, "{\"generate\":true}");
    assert.doesNotMatch(JSON.stringify(recovered), /videoWorkflow|video_reference|videoEdit/);
  });
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
    saveStudioState({ schemaVersion: 5, activeSessionId: session.id, promptModel: "openai/gpt-5.6-luna", sessions: [session] });
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
