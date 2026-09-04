import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  activeGenerationAttempt,
  beginGeneratedImageEdit,
  markReferenceAsEditTarget,
  restoreReferenceAfterEditTarget,
  createSession,
  createSiblingGenerationThread,
  effectiveThreadDraft,
  effectiveThreadModelId,
  acknowledgeStudioRecovery,
  exportStudioState,
  importFileAsset,
  importGeneratedImage,
  loadStudioState,
  loadStudioStateWithRecovery,
  listStudioManagedAssetReferences,
  mediaMimeFromSource,
  mediaNameForMime,
  nextAvailableSessionName,
  preferredCatalogModel,
  readStudioBackup,
  reconcileManagedAssetIndex,
  reconcileVerifiedUpdateAssetIndex,
  reconcileStartupAttempts,
  recordSessionCost,
  requestedImageDimensions,
  resolveAssetSource,
  saveStudioState,
  STUDIO_BACKUP_KEY_PREFIX,
  STUDIO_LAST_KNOWN_GOOD_KEY,
  STUDIO_STORAGE_KEY,
  StudioPersistenceError,
  type GenerationDraftState,
  type StudioStorage,
  type StudioState,
} from "./studio.ts";
import type { PromptEnhancementArtifact } from "./prompting/index.ts";

function enhancementArtifactFixture() {
  return {
    schemaVersion: 1,
    signature: "enhancement-signature",
    plannerModel: "test-planner",
    createdAt: "2026-01-01T00:00:00.000Z",
    prompt: "a bright red truck",
    negativePrompt: "blur",
    profileId: "image-default",
    profileVersion: "1",
    workflow: "text_to_image",
    coveredSlots: [1],
    warnings: [],
    plan: {
      language: "en",
      deliverable: "image",
      intent: "create a truck",
      scene: [],
      subjects: [],
      action: [],
      composition: [],
      camera: [],
      lighting: [],
      color: [],
      style: [],
      materials: [],
      exactText: [],
      temporalBeats: [],
      subjectMotion: [],
      cameraMotion: [],
      audio: [],
      editChanges: [],
      preserve: [],
      constraints: [],
      references: [],
    },
  } as unknown as PromptEnhancementArtifact;
}

function withLocalStorage(run: (writes: Map<string, string>) => void) {
  const writes = new Map<string, string>();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => writes.get(key) ?? null,
      setItem: (key: string, value: string) => writes.set(key, value),
      removeItem: (key: string) => writes.delete(key),
      get length() { return writes.size; },
      key: (index: number) => [...writes.keys()][index] ?? null,
    },
  });
  try {
    run(writes);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
  }
}

test("incompatible pre-v6 metadata retains original bytes and exposes recovery", () => {
  withLocalStorage((writes) => {
    writes.set("unrelated-indexeddb-sentinel", "preserved");
    const original = JSON.stringify({
      schemaVersion: 5,
      activeSessionId: "legacy-session",
      promptModel: "openai/gpt-5.6-luna",
      sessions: [{ id: "legacy-session", assets: [{ localPath: "/managed/keep.png" }] }],
    });
    writes.set(STUDIO_STORAGE_KEY, original);

    const result = loadStudioStateWithRecovery();
    const state = result.state;
    assert.equal(state.schemaVersion, 8);
    assert.equal(result.recovery.kind, "migration_failed");
    assert.equal(result.recovery.requiresUserAction, true);
    assert.equal(result.recovery.rawStateAvailable, true);
    assert.equal(writes.get(STUDIO_STORAGE_KEY), original);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].threads.image.length, 1);
    assert.equal(state.sessions[0].threads.video.length, 1);
    assert.equal(writes.get("unrelated-indexeddb-sentinel"), "preserved");
  });
});

const LEGACY_CREATED_AT = "2025-06-01T00:00:00.000Z";

function legacyDraft(prompt: string, referenceAssetId = "asset-image") {
  return {
    prompt,
    references: [{ assetId: referenceAssetId, slot: 1, role: "reference" }],
    options: { quality: "high", seed: 7 },
    providerJson: '{"provider":"legacy","seed":7}',
    enhancePrompt: false,
    enhancedPrompt: `${prompt} (enhanced)`,
    enhancedPromptDirty: false,
    enhancedVisualCount: 1,
    imageEditMode: false,
    imageEditTarget: "",
    maskInstructions: "",
    maskStrokes: [],
  };
}

function legacyAssets() {
  return [
    {
      id: "asset-image",
      name: "truck-original.png",
      kind: "image",
      mimeType: "image/png",
      origin: "generated",
      createdAt: LEGACY_CREATED_AT,
      externalUrl: "/managed/truck-original.png",
      width: 1024,
      height: 768,
      byteSize: 1234,
    },
    {
      id: "asset-video",
      name: "truck-result.mp4",
      kind: "video",
      mimeType: "video/mp4",
      origin: "generated",
      createdAt: LEGACY_CREATED_AT,
      localPath: "/managed/truck-result.mp4",
      jobId: "job-legacy",
      duration: 5,
      byteSize: 4321,
    },
  ];
}

function legacyVideoJob() {
  return {
    kind: "video",
    jobId: "job-legacy",
    status: "pending",
    model: "video/legacy-model",
    submittedAt: LEGACY_CREATED_AT,
    request: { duration: 5, resolution: "720p" },
    inputAssetIds: ["asset-image"],
    actualCostUsd: 0.84,
  };
}

function legacyState(version: 1 | 2 | 3 | 4): Record<string, unknown> {
  const mention = version < 4 ? "Use #1 as the truck subject" : "Use @1 as the truck subject";
  const session = {
    id: "legacy-session",
    name: "Recovered legacy workspace",
    createdAt: LEGACY_CREATED_AT,
    updatedAt: LEGACY_CREATED_AT,
    mode: "video",
    assets: legacyAssets(),
    selectedModelIds: { image: "image/legacy-model", video: "video/legacy-model" },
    drafts: {
      image: legacyDraft(mention),
      videoGenerate: legacyDraft(`${mention}; generate a moving shot`),
      videoEdit: legacyDraft(`${mention}; edit the existing shot`, "asset-video"),
    },
    videoWorkflow: "generate",
    activeVideoJobs: [legacyVideoJob()],
    lastResultAssetIds: { image: ["asset-image"], video: ["asset-video"] },
    customLegacyField: { preserved: true },
  };
  return {
    schemaVersion: version,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-terra",
    sessions: [session],
  };
}

function v5Thread(
  mode: "image" | "video",
  id: string,
  status: "completed" | "in_progress",
  attemptId: string,
) {
  const isImage = mode === "image";
  return {
    id,
    requestKey: `request:${attemptId}`,
    name: `${mode} legacy thread`,
    mode,
    createdAt: LEGACY_CREATED_AT,
    updatedAt: LEGACY_CREATED_AT,
    revision: 3,
    outputRole: isImage ? "generated_image" : "generated_video",
    optionOverrides: { quality: "high" },
    providerJsonOverride: '{"thread":"legacy"}',
    draft: legacyDraft(isImage ? "Use @1 for image identity" : "Use @1 for first frame"),
    attempts: [{
      id: attemptId,
      requestKey: `request:${attemptId}`,
      status,
      backend: "openrouter",
      draftRevision: 3,
      requestedBy: "human",
      createdAt: LEGACY_CREATED_AT,
      updatedAt: LEGACY_CREATED_AT,
      submittedAt: LEGACY_CREATED_AT,
      completedAt: status === "completed" ? LEGACY_CREATED_AT : undefined,
      modelId: isImage ? "image/legacy-model" : "video/legacy-model",
      snapshot: {
        mode,
        modelId: isImage ? "image/legacy-model" : "video/legacy-model",
        outputRole: isImage ? "generated_image" : "generated_video",
        prompt: isImage ? "Use @1 for image identity" : "Use @1 for first frame",
        enhancePrompt: false,
        enhancedPrompt: "legacy enhanced prompt",
        options: { quality: "high" },
        providerJson: '{"snapshot":true}',
        assetBindings: [{ assetId: isImage ? "asset-image" : "asset-video", slot: 1, role: "reference" }],
        imageEditMode: false,
        imageEditTarget: "",
        maskInstructions: "",
        maskStrokes: [],
      },
      request: { model: isImage ? "image/legacy-model" : "video/legacy-model" },
      inputAssetIds: ["asset-image"],
      assetIds: status === "completed" ? [isImage ? "asset-image" : "asset-video"] : [],
      resultSources: isImage ? ["https://provider.example/image-result"] : undefined,
      recoveryPath: isImage ? "/managed/recovery/image-result.json" : undefined,
      jobId: status === "in_progress" ? "job-v5" : undefined,
      actualCostUsd: isImage ? 0.42 : 0.84,
      costRecordedAt: LEGACY_CREATED_AT,
    }],
    enhancementAttempts: [{
      id: `${attemptId}-enhancement`,
      requestKey: `enhance:${attemptId}`,
      status: "in_progress",
      threadRevision: 3,
      originalPrompt: "legacy prompt",
      createdAt: LEGACY_CREATED_AT,
      updatedAt: LEGACY_CREATED_AT,
      actualCostUsd: 0.03,
      costRecordedAt: LEGACY_CREATED_AT,
    }],
  };
}

function v5State(): Record<string, unknown> {
  const imageThread = v5Thread("image", "thread-v5-image", "completed", "attempt-v5-image");
  const videoThread = v5Thread("video", "thread-v5-video", "in_progress", "attempt-v5-video");
  const session = {
    id: "v5-session",
    name: "v5 workspace",
    createdAt: LEGACY_CREATED_AT,
    updatedAt: LEGACY_CREATED_AT,
    mode: "image",
    assets: legacyAssets(),
    generationDefaults: {
      modelIds: { image: "image/legacy-model", video: "video/legacy-model" },
      options: { image: { quality: "high" }, video: { duration: 5 } },
      providerJson: { image: '{"image":true}', video: '{"video":true}' },
    },
    threads: { image: [imageThread], video: [videoThread] },
    activeThreadIds: { image: imageThread.id, video: videoThread.id },
    costLedger: [{ id: "legacy-explicit-cost", category: "generation", actualCostUsd: 0.11, recordedAt: LEGACY_CREATED_AT }],
    customV5Field: "preserved",
  };
  return {
    schemaVersion: 5,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-terra",
    sessions: [session],
  };
}

function mapStorage(writes: Map<string, string>): StudioStorage {
  return {
    getItem: (key) => writes.get(key) ?? null,
    setItem: (key, value) => writes.set(key, value),
    removeItem: (key) => writes.delete(key),
    get length() { return writes.size; },
    key: (index) => [...writes.keys()][index] ?? null,
  };
}

test("migrates every legacy schema version sequentially without dropping workspace data", () => {
  for (const version of [1, 2, 3, 4] as const) {
    withLocalStorage((writes) => {
      const original = JSON.stringify(legacyState(version));
      writes.set(STUDIO_STORAGE_KEY, original);
      const result = loadStudioStateWithRecovery({ now: () => new Date("2026-01-01T00:00:00.000Z") });
      const state = result.state;
      assert.equal(result.recovery.kind, "migrated");
      assert.equal(result.migration?.fromVersion, version);
      assert.deepEqual(result.migration?.steps, [
        ...(version === 1 ? ["v1→v2"] : []),
        ...(version <= 2 ? ["v2→v3"] : []),
        ...(version <= 3 ? ["v3→v4"] : []),
        ...(version <= 4 ? ["v4→v5"] : []),
        "v5→v6",
        "v6→v7",
        "v7→v8",
      ]);
      assert.equal(state.schemaVersion, 8);
      assert.equal(state.activeSessionId, "legacy-session");
      assert.equal(state.promptModel, "google/gemini-3.8-flash");
      const session = state.sessions[0];
      assert.equal(session.name, "Recovered legacy workspace");
      assert.deepEqual(session.assets.map((asset) => asset.id), ["asset-image", "asset-video"]);
      assert.equal(session.assets[0].localPath, "/managed/truck-original.png");
      assert.equal(session.assets[0].externalUrl, undefined);
      assert.equal(session.assets[0].byteSize, 1234);
      assert.equal(session.generationDefaults.modelIds.image, "image/legacy-model");
      assert.equal(session.generationDefaults.modelIds.video, "video/legacy-model");
      assert.equal(session.threads.image[0].draft.prompt, "Use @1 as the truck subject");
      assert.equal(session.threads.image[0].draft.promptHistory.cursor, 0);
      assert.deepEqual(
        session.threads.image[0].draft.promptHistory.entries.map(({ text, kind }) => ({ text, kind })),
        [
          { text: "Use @1 as the truck subject", kind: "manual" },
          { text: "Use @1 as the truck subject (enhanced)", kind: "enhancement_result" },
        ],
      );
      assert.deepEqual(effectiveThreadDraft(session, session.threads.image[0]).options, { quality: "high", seed: 7 });
      assert.equal(effectiveThreadDraft(session, session.threads.image[0]).providerJson, '{"provider":"legacy","seed":7}');
      assert.ok(session.threads.video.length >= 1);
      assert.ok(session.threads.video.some((thread) => thread.attempts.some((attempt) => attempt.jobId === "job-legacy")));
      assert.ok(session.threads.image.some((thread) => thread.attempts.some((attempt) => attempt.assetIds.includes("asset-image"))));
      assert.ok(session.threads.video.some((thread) => thread.attempts.some((attempt) => attempt.assetIds.includes("asset-video"))));
      assert.ok(session.costLedger.some((entry) => entry.category === "generation" && entry.actualCostUsd === 0.84));
      assert.deepEqual((session as unknown as Record<string, unknown>).customLegacyField, { preserved: true });
      assert.ok(result.recovery.attempts.some((attempt) => attempt.classification === "video_job_resumable" && attempt.attemptId));
      assert.notEqual(writes.get(STUDIO_STORAGE_KEY), original);
      const backupKeys = [...writes.keys()].filter((key) => key.startsWith(STUDIO_BACKUP_KEY_PREFIX));
      assert.equal(backupKeys.length, 1);
      assert.equal(writes.get(backupKeys[0]), original);
      assert.equal(writes.get(STUDIO_LAST_KNOWN_GOOD_KEY), original);
    });
  }
});

test("migrates v5 attempts, enhancement history, assets, and costs into v6", () => {
  withLocalStorage((writes) => {
    const original = JSON.stringify(v5State());
    writes.set(STUDIO_STORAGE_KEY, original);
    const result = loadStudioStateWithRecovery({ now: () => new Date("2026-01-01T00:00:00.000Z") });
    assert.equal(result.recovery.kind, "migrated");
    assert.equal(result.migration?.fromVersion, 5);
    const session = result.state.sessions[0];
    assert.equal(session.id, "v5-session");
    assert.equal(session.threads.image[0].id, "thread-v5-image");
    assert.equal(session.threads.image[0].attempts[0].id, "attempt-v5-image");
    assert.equal(session.threads.image[0].attempts[0].actualCostUsd, 0.42);
    assert.deepEqual(session.threads.image[0].attempts[0].resultSources, ["https://provider.example/image-result"]);
    assert.equal(session.threads.image[0].attempts[0].recoveryPath, "/managed/recovery/image-result.json");
    assert.equal(session.threads.video[0].attempts[0].jobId, "job-v5");
    assert.equal(session.threads.video[0].attempts[0].status, "in_progress");
    assert.equal(session.threads.image[0].enhancementAttempts?.[0].status, "failed");
    assert.equal(session.threads.image[0].enhancementAttempts?.[0].errorCode, "enhancement_interrupted");
    assert.ok(session.costLedger.some((entry) => entry.id === "legacy-explicit-cost" && entry.actualCostUsd === 0.11));
    assert.ok(session.costLedger.some((entry) => entry.id === "generation:attempt-v5-image" && entry.actualCostUsd === 0.42));
    assert.ok(session.costLedger.some((entry) => entry.id === "prompt-enhancement:attempt-v5-image-enhancement" && entry.actualCostUsd === 0.03));
    assert.equal((session as unknown as Record<string, unknown>).customV5Field, "preserved");
    assert.ok(result.recovery.attempts.some((attempt) => attempt.classification === "video_job_resumable"));
    assert.ok(result.recovery.attempts.some((attempt) => attempt.classification === "enhancement_interrupted"));
  });
});

test("migrates the serialized v0.6.2 schema-v5 production fixture losslessly", () => {
  // Fixture shape is copied from tag v0.6.2 (5b030442) after its
  // saveStudioState history bounding, including the opaque agent ledger.
  const original = readFileSync(new URL("../fixtures/studio/v0.6.2-schema-v5.json", import.meta.url), "utf8").trim();
  const writes = new Map<string, string>([[STUDIO_STORAGE_KEY, original]]);
  const result = loadStudioStateWithRecovery({
    storage: mapStorage(writes),
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });
  const session = result.state.sessions[0];
  assert.equal(result.migration?.fromVersion, 5);
  assert.deepEqual(result.migration?.steps, ["v5→v6", "v6→v7", "v7→v8"]);
  assert.equal(session.id, "v062-session");
  assert.equal(session.mode, "video");
  assert.deepEqual(session.assets.map(({ id, localPath, jobId }) => ({ id, localPath, jobId })), [
    { id: "v062-input", localPath: "/Users/example/.fruit-truck/assets/fruit-truck-reference.png", jobId: undefined },
    { id: "v062-result", localPath: "/Users/example/.fruit-truck/generated/fruit-truck-result.mp4", jobId: "v062-job" },
  ]);
  assert.deepEqual(session.activeThreadIds, { image: "v062-image-thread", video: "v062-video-thread" });
  assert.equal(session.threads.image[0].draft.prompt, "A faithful fruit truck portrait using @1.");
  assert.deepEqual(
    session.threads.image[0].draft.promptHistory.entries.map(({ text, kind }) => ({ text, kind })),
    [
      { text: "Use @1 as the truck identity.", kind: "manual" },
      { text: "A faithful fruit truck portrait using @1.", kind: "enhancement_result" },
    ],
  );
  assert.equal(
    session.threads.image[0].draft.promptHistory.entries[1].enhancementAttemptId,
    "v062-enhancement-attempt",
  );
  assert.equal(session.threads.image[0].draft.promptHistory.entries[1].actualCostUsd, 0.006);
  assert.equal(session.threads.image[0].attempts[0].snapshot?.prompt, "A faithful fruit truck portrait using @1.");
  assert.equal(session.threads.image[0].attempts[0].actualCostUsd, 0.042);
  assert.equal(session.threads.video[0].attempts[0].jobId, "v062-job");
  assert.deepEqual(session.threads.video[0].attempts[0].assetIds, ["v062-result"]);
  assert.equal(session.threads.image[0].enhancementAttempts?.[0].actualCostUsd, 0.006);
  assert.deepEqual(session.costLedger.map(({ id, actualCostUsd }) => ({ id, actualCostUsd })), [
    { id: "generation:v062-image-attempt", actualCostUsd: 0.042 },
    { id: "prompt-enhancement:v062-enhancement-attempt", actualCostUsd: 0.006 },
    { id: "generation:v062-video-attempt", actualCostUsd: 0.84 },
  ]);
  assert.equal((session.agent?.execution as { spentUsd?: unknown } | undefined)?.spentUsd, 0.888);
  const backupKey = [...writes.keys()].find((key) => key.startsWith(STUDIO_BACKUP_KEY_PREFIX));
  assert.ok(backupKey);
  assert.equal(writes.get(backupKey), original);
  assert.equal(writes.get(STUDIO_LAST_KNOWN_GOOD_KEY), original);
});

test("v6 to v7 migrates every draft and snapshot with deterministic history", () => {
  const session = createSession("Phase 2 migration");
  session.assets.push({
    id: "asset-kept",
    name: "kept.png",
    kind: "image",
    mimeType: "image/png",
    origin: "upload",
    createdAt: LEGACY_CREATED_AT,
    localPath: "/managed/kept.png",
  });
  session.costLedger.push({
    id: "cost-kept",
    category: "prompt_enhancement",
    actualCostUsd: 0.07,
    recordedAt: LEGACY_CREATED_AT,
  });
  const plannerResult = "planner enhanced image prompt";
  const artifact = {
    ...enhancementArtifactFixture(),
    signature: "signature-kept",
    prompt: plannerResult,
    createdAt: "2025-06-01T00:01:00.000Z",
  };
  const legacyImageDraft = {
    ...legacyDraft("original image prompt"),
    enhancePrompt: true,
    enhancedPrompt: "edited enhanced image prompt",
    enhancedPromptDirty: true,
    enhancementArtifact: artifact,
  };
  const legacyVideoDraft = {
    ...legacyDraft("original video prompt"),
    enhancePrompt: false,
    enhancedPrompt: "saved enhanced video prompt",
  };
  const attemptBase = {
    id: "attempt-kept",
    status: "completed",
    draftRevision: 2,
    createdAt: LEGACY_CREATED_AT,
    updatedAt: LEGACY_CREATED_AT,
    inputAssetIds: ["asset-kept"],
    assetIds: [],
    snapshot: {
      mode: "image",
      modelId: "image/model",
      prompt: "original image prompt",
      enhancePrompt: true,
      enhancedPrompt: "edited enhanced image prompt",
      enhancedPromptDirty: true,
      enhancementArtifact: artifact,
      options: {},
      providerJson: "",
      assetBindings: [],
      imageEditMode: false,
      imageEditTarget: "",
      maskInstructions: "",
      maskStrokes: [],
    },
  };
  const rawState = {
    schemaVersion: 6,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-terra",
    defaultEnhancePrompt: false,
    sessions: [{
      ...session,
      threads: {
        image: [{
          ...session.threads.image[0],
          draft: legacyImageDraft,
          attempts: [attemptBase],
          enhancementAttempts: [{
            id: "enhancement-kept",
            requestKey: "signature-kept",
            status: "completed",
            threadRevision: 2,
            originalPrompt: "original image prompt",
            enhancedPrompt: plannerResult,
            createdAt: "2025-06-01T00:00:30.000Z",
            updatedAt: "2025-06-01T00:01:00.000Z",
            actualCostUsd: 0.07,
          }, {
            id: "enhancement-decoy",
            requestKey: "different-signature",
            status: "completed",
            threadRevision: 2,
            originalPrompt: "original image prompt",
            enhancedPrompt: "edited enhanced image prompt",
            createdAt: "2025-06-01T00:02:00.000Z",
            updatedAt: "2025-06-01T00:03:00.000Z",
            actualCostUsd: 0.09,
          }],
        }],
        video: [{ ...session.threads.video[0], draft: legacyVideoDraft }],
      },
    }],
  };
  const original = JSON.stringify(rawState);
  const migrate = () => {
    const writes = new Map<string, string>([[STUDIO_STORAGE_KEY, original]]);
    return loadStudioStateWithRecovery({
      storage: mapStorage(writes),
      now: () => new Date("2026-09-04T00:00:00.000Z"),
    });
  };
  const first = migrate();
  const second = migrate();
  const image = first.state.sessions[0].threads.image[0];
  const video = first.state.sessions[0].threads.video[0];
  const snapshot = image.attempts[0].snapshot!;

  assert.deepEqual(first.migration?.steps, ["v6→v7", "v7→v8"]);
  assert.equal(first.state.promptModel, "google/gemini-3.8-flash");
  assert.equal((first.state as unknown as Record<string, unknown>).defaultEnhancePrompt, undefined);
  assert.equal(image.draft.prompt, "edited enhanced image prompt");
  assert.equal(video.draft.prompt, "original video prompt");
  assert.equal(snapshot.prompt, "edited enhanced image prompt");
  assert.deepEqual(image.draft.promptHistory.entries.map((entry) => entry.id),
    second.state.sessions[0].threads.image[0].draft.promptHistory.entries.map((entry) => entry.id));
  assert.equal(image.draft.promptHistory.entries[1].plannerModel, "google/gemini-3.8-flash");
  assert.equal(image.draft.promptHistory.entries[1].enhancementArtifact?.plannerModel, "test-planner");
  assert.equal(snapshot.promptHistory.entries[1].enhancementArtifact?.plannerModel, "test-planner");
  assert.equal(snapshot.promptHistory.entries[1].enhancementAttemptId, "enhancement-kept");
  assert.equal(snapshot.promptHistory.entries[1].actualCostUsd, 0.07);
  assert.equal(image.draft.promptHistory.entries[1].enhancementAttemptId, "enhancement-kept");
  assert.equal(image.draft.promptHistory.entries[1].actualCostUsd, 0.07);
  assert.equal(image.draft.promptHistory.entries[1].text, "edited enhanced image prompt");
  assert.equal(image.draft.promptHistory.entries[1].enhancementArtifact?.prompt, plannerResult);
  assert.notEqual(
    image.draft.promptHistory.entries[1].text,
    image.draft.promptHistory.entries[1].enhancementArtifact?.prompt,
  );
  assert.equal(image.draft.promptHistory.entries[1].negativePrompt, "blur");
  assert.equal(first.state.sessions[0].assets[0].id, "asset-kept");
  assert.equal(first.state.sessions[0].costLedger[0].id, "cost-kept");
  assert.equal(image.attempts[0].id, "attempt-kept");
  assert.equal(image.enhancementAttempts?.[0].id, "enhancement-kept");
  for (const value of [image.draft, video.draft, snapshot] as unknown as Record<string, unknown>[]) {
    assert.equal(value.enhancePrompt, undefined);
    assert.equal(value.enhancedPrompt, undefined);
    assert.equal(value.enhancementArtifact, undefined);
  }
});

test("legacy-shaped schema v8 workspaces normalize and rewrite durably", () => {
  const session = createSession("Legacy v8");
  const legacy = legacyDraft("legacy current prompt");
  legacy.enhancePrompt = true;
  legacy.enhancedPrompt = "legacy visible result";
  const raw = JSON.stringify({
    schemaVersion: 8,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    directorPresets: [],
    sessions: [{
      ...session,
      threads: {
        ...session.threads,
        image: [{ ...session.threads.image[0], draft: legacy }],
      },
    }],
  });
  const writes = new Map<string, string>([[STUDIO_STORAGE_KEY, raw]]);
  const result = loadStudioStateWithRecovery({ storage: mapStorage(writes) });
  const persisted = writes.get(STUDIO_STORAGE_KEY)!;

  assert.equal(result.recovery.kind, "migrated");
  assert.equal(result.state.promptModel, "google/gemini-3.8-flash");
  assert.equal(result.state.sessions[0].threads.image[0].draft.prompt, "legacy visible result");
  assert.notEqual(persisted, raw);
  assert.doesNotMatch(persisted, /defaultEnhancePrompt|enhancedPromptDirty|enhancedVisualCount/);
  assert.match(persisted, /promptHistory/);
});

test("malformed current prompt history is treated as corrupt", () => {
  const session = createSession("Malformed history");
  session.threads.image[0].draft.promptHistory.cursor = 12;
  const raw = JSON.stringify({
    schemaVersion: 8,
    activeSessionId: session.id,
    promptModel: "google/gemini-3.8-flash",
    directorPresets: [],
    sessions: [session],
  });
  const writes = new Map<string, string>([[STUDIO_STORAGE_KEY, raw]]);
  const result = loadStudioStateWithRecovery({ storage: mapStorage(writes) });

  assert.equal(result.recovery.kind, "corrupt");
  assert.equal(result.recovery.requiresUserAction, true);
  assert.equal(writes.get(STUDIO_STORAGE_KEY), raw);
});

test("current prompt history rejects negative checkpoint costs", () => {
  const session = createSession("Negative checkpoint cost");
  session.threads.image[0].draft.promptHistory.entries[0].actualCostUsd = -0.01;
  const state: StudioState = {
    schemaVersion: 8,
    activeSessionId: session.id,
    promptModel: "google/gemini-3.8-flash",
    directorPresets: [],
    sessions: [session],
  };
  assert.throws(() => exportStudioState(state), /actualCostUsd must be non-negative/);
  const raw = JSON.stringify(state);
  const writes = new Map<string, string>([[STUDIO_STORAGE_KEY, raw]]);
  const result = loadStudioStateWithRecovery({ storage: mapStorage(writes) });

  assert.equal(result.recovery.kind, "corrupt");
  assert.equal(writes.get(STUDIO_STORAGE_KEY), raw);
});

test("durable saves trim prompt histories while protecting uncertain attempt checkpoints", () => {
  const session = createSession("Bounded history");
  const thread = session.threads.image[0];
  const historyArtifact = {
    ...enhancementArtifactFixture(),
    prompt: "prompt 1",
    actualCostUsd: 0.017,
  };
  const entries = Array.from({ length: 60 }, (_, index) => ({
    id: `checkpoint-${index}`,
    text: `prompt ${index}`,
    kind: index === 1 ? "enhancement_result" as const : index === 0 ? "before_enhancement" as const : "manual" as const,
    createdAt: `2026-09-04T00:00:${String(index).padStart(2, "0")}.000Z`,
    ...(index < 2 ? {
      enhancementAttemptId: "uncertain-enhancement",
      plannerModel: "google/gemini-3.8-flash" as const,
      reasoningEffort: "high" as const,
    } : {}),
    ...(index === 1 ? {
      negativePrompt: "blur, watermark",
      enhancementArtifact: historyArtifact,
      actualCostUsd: 0.017,
    } : {}),
  }));
  thread.draft.prompt = "prompt 59";
  thread.draft.promptHistory = {
    schemaVersion: 1,
    entries,
    cursor: 59,
    enhancementLocked: false,
    editRevision: 3,
  };
  thread.enhancementAttempts = [{
    id: "uncertain-enhancement",
    requestKey: "uncertain-signature",
    status: "uncertain",
    threadRevision: 3,
    originalPrompt: "prompt 0",
    createdAt: LEGACY_CREATED_AT,
    updatedAt: LEGACY_CREATED_AT,
  }];
  thread.attempts = [{
    id: "generation-with-snapshot",
    status: "completed",
    draftRevision: 3,
    createdAt: LEGACY_CREATED_AT,
    updatedAt: LEGACY_CREATED_AT,
    inputAssetIds: [],
    assetIds: [],
    snapshot: {
      mode: "image",
      modelId: "image/model",
      prompt: "prompt 59",
      promptHistory: structuredClone(thread.draft.promptHistory),
      options: {},
      providerJson: "",
      assetBindings: [],
      imageEditMode: false,
      imageEditTarget: "",
      maskInstructions: "",
      maskStrokes: [],
    },
  }];
  const state: StudioState = {
    schemaVersion: 8,
    activeSessionId: session.id,
    promptModel: "google/gemini-3.8-flash",
    directorPresets: [],
    sessions: [session],
  };
  const exactDraftHistory = structuredClone(thread.draft.promptHistory);
  const exactSnapshotHistory = structuredClone(thread.attempts[0].snapshot!.promptHistory);
  const exported = JSON.parse(exportStudioState(state).json) as {
    sessions: Array<{
      threads: {
        image: Array<{
          draft: GenerationDraftState;
          attempts: Array<{ snapshot?: { promptHistory: GenerationDraftState["promptHistory"] } }>;
        }>;
      };
    }>;
  };
  const exportedThread = exported.sessions[0].threads.image[0];
  assert.equal(exportedThread.draft.promptHistory.entries.length, 60);
  assert.deepEqual(exportedThread.draft.promptHistory, exactDraftHistory);
  assert.deepEqual(exportedThread.attempts[0].snapshot?.promptHistory, exactSnapshotHistory);
  assert.equal(exportedThread.draft.promptHistory.entries[1].actualCostUsd, 0.017);
  assert.deepEqual(
    exportedThread.draft.promptHistory.entries[1].enhancementArtifact,
    historyArtifact,
  );

  const exportedWrites = new Map<string, string>([[STUDIO_STORAGE_KEY, JSON.stringify(exported)]]);
  const exportedRoundTrip = loadStudioStateWithRecovery({
    storage: mapStorage(exportedWrites),
  }).state.sessions[0].threads.image[0];
  assert.deepEqual(
    JSON.parse(JSON.stringify(exportedRoundTrip.draft.promptHistory)),
    exactDraftHistory,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(exportedRoundTrip.attempts[0].snapshot?.promptHistory)),
    exactSnapshotHistory,
  );

  const writes = new Map<string, string>();
  saveStudioState(state, { storage: mapStorage(writes) });
  const loaded = loadStudioStateWithRecovery({ storage: mapStorage(writes) }).state.sessions[0].threads.image[0];

  assert.equal(loaded.draft.promptHistory.entries.length, 50);
  assert.equal(loaded.attempts[0].snapshot?.promptHistory.entries.length, 50);
  assert.equal(loaded.draft.promptHistory.entries.some((entry) => entry.id === "checkpoint-0"), true);
  assert.equal(loaded.draft.promptHistory.entries.some((entry) => entry.id === "checkpoint-1"), true);
  assert.equal(loaded.draft.promptHistory.entries.some((entry) => entry.id === "checkpoint-59"), true);
});

test("migration write failures preserve the source and require explicit recovery", () => {
  const original = JSON.stringify(v5State());
  for (const failure of ["backup", "pending", "current"] as const) {
    const writes = new Map<string, string>([[STUDIO_STORAGE_KEY, original]]);
    const base = mapStorage(writes);
    const storage: StudioStorage = {
      ...base,
      setItem: (key, value) => {
        if ((failure === "backup" && key.startsWith(STUDIO_BACKUP_KEY_PREFIX))
          || (failure === "pending" && key.startsWith("fruit-truck.studio.v1.pending."))
          || (failure === "current" && key === STUDIO_STORAGE_KEY)) {
          throw new Error(`simulated ${failure} quota failure`);
        }
        base.setItem(key, value);
      },
    };
    const result = loadStudioStateWithRecovery({ storage, now: () => new Date("2026-01-01T00:00:00.000Z") });
    assert.equal(result.recovery.kind, "write_failed");
    assert.equal(result.recovery.requiresUserAction, true);
    assert.equal(writes.get(STUDIO_STORAGE_KEY), original);
    assert.equal(result.state.sessions[0].assets.length, 0);
  }
});

test("last-known-good recovery does not overwrite corrupt primary state", () => {
  withLocalStorage((writes) => {
    const first = createSession("First durable state");
    const firstState: StudioState = {
      schemaVersion: 8,
      activeSessionId: first.id,
      promptModel: "google/gemini-3.8-flash",
      directorPresets: [],
      sessions: [first],
    };
    saveStudioState(firstState, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    const second = createSession("Second durable state");
    const secondState: StudioState = { ...firstState, activeSessionId: second.id, sessions: [second] };
    saveStudioState(secondState, { now: () => new Date("2026-01-01T00:00:01.000Z") });
    const knownGood = writes.get(STUDIO_LAST_KNOWN_GOOD_KEY);
    assert.ok(knownGood);
    writes.set(STUDIO_STORAGE_KEY, "{ definitely not valid json");

    const recovered = loadStudioStateWithRecovery();
    assert.equal(recovered.recovery.kind, "recovered_last_known_good");
    assert.equal(recovered.recovery.requiresUserAction, true);
    assert.equal(recovered.state.sessions[0].name, "First durable state");
    assert.equal(writes.get(STUDIO_STORAGE_KEY), "{ definitely not valid json");
    assert.equal(readStudioBackup(STUDIO_LAST_KNOWN_GOOD_KEY), knownGood);
    assert.throws(() => saveStudioState(recovered.state), (error: unknown) =>
      error instanceof StudioPersistenceError && error.code === "recovery_required");

    const acknowledged = acknowledgeStudioRecovery(recovered.state);
    saveStudioState(acknowledged);
    assert.equal(loadStudioState().sessions[0].name, "First durable state");
  });
});

test("startup reconciliation classifies resumable jobs, uncertain submissions, and interrupted enhancements", () => {
  const session = createSession("Attempt recovery");
  const now = "2026-01-02T00:00:00.000Z";
  const image = session.threads.image[0];
  const video = session.threads.video[0];
  image.attempts = [
    { id: "uncertain-image", status: "submitting", draftRevision: 1, createdAt: now, updatedAt: now, inputAssetIds: [], assetIds: [] },
    { id: "enhancing-image", status: "enhancing", draftRevision: 1, createdAt: now, updatedAt: now, inputAssetIds: [], assetIds: [] },
  ];
  video.attempts = [{ id: "resumable-video", status: "in_progress", draftRevision: 1, createdAt: now, updatedAt: now, inputAssetIds: [], assetIds: [], jobId: "job-resume" }];
  video.enhancementAttempts = [{ id: "interrupted-enhancement", requestKey: "enhance:1", status: "in_progress", threadRevision: 1, originalPrompt: "truck", createdAt: now, updatedAt: now }];
  const state: StudioState = {
    schemaVersion: 8,
    activeSessionId: session.id,
    promptModel: "google/gemini-3.8-flash",
    directorPresets: [],
    sessions: [session],
  };
  const reconciled = reconcileStartupAttempts(state, new Date("2026-01-03T00:00:00.000Z"));
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.state.sessions[0].threads.image[0].attempts[0].status, "uncertain");
  assert.equal(reconciled.state.sessions[0].threads.image[0].attempts[0].errorCode, "submission_uncertain");
  assert.equal(reconciled.state.sessions[0].threads.image[0].attempts[1].status, "failed");
  assert.equal(reconciled.state.sessions[0].threads.image[0].attempts[1].errorCode, "enhancement_interrupted");
  assert.equal(reconciled.state.sessions[0].threads.video[0].attempts[0].status, "in_progress");
  assert.equal(reconciled.state.sessions[0].threads.video[0].enhancementAttempts?.[0].status, "failed");
  assert.deepEqual(reconciled.recovery.map((entry) => entry.classification).sort(), [
    "enhancement_interrupted",
    "enhancement_interrupted",
    "submission_uncertain",
    "video_job_resumable",
  ].sort());
});

test("state export and managed-asset references omit ephemeral recovery diagnostics", () => {
  const session = createSession("Export");
  session.assets.push({
    id: "managed-image",
    name: "managed.png",
    kind: "image",
    mimeType: "image/png",
    origin: "generated",
    createdAt: LEGACY_CREATED_AT,
    localPath: "/managed/managed.png",
    byteSize: 12,
  });
  const state: StudioState = {
    schemaVersion: 8,
    activeSessionId: session.id,
    promptModel: "google/gemini-3.8-flash",
    directorPresets: [],
    sessions: [session],
    recovery: {
      kind: "loaded",
      status: "loaded",
      targetSchemaVersion: 8,
      rawStateAvailable: true,
      requiresUserAction: false,
      attempts: [],
    },
  };
  const exported = exportStudioState(state);
  const parsed = JSON.parse(exported.json) as Record<string, unknown>;
  assert.equal(exported.schemaVersion, 8);
  assert.equal(parsed.recovery, undefined);
  assert.deepEqual(session.assets[0], {
    id: "managed-image",
    name: "managed.png",
    kind: "image",
    mimeType: "image/png",
    origin: "generated",
    createdAt: LEGACY_CREATED_AT,
    localPath: "/managed/managed.png",
    byteSize: 12,
  });
  assert.deepEqual(listStudioManagedAssetReferences(state), [{
    sessionId: session.id,
    assetId: "managed-image",
    kind: "image",
    name: "managed.png",
    localPath: "/managed/managed.png",
    blobKey: undefined,
  }]);
});

test("new sessions and sibling threads start with unlocked prompt history", () => {
  const first = createSession("First");
  first.threads.image.push(createSiblingGenerationThread(first.threads.image[0], 2));
  const second = createSession("Second");
  for (const session of [first, second]) {
    for (const thread of [...session.threads.image, ...session.threads.video]) {
      assert.equal(thread.draft.promptHistory.enhancementLocked, false);
      assert.equal(thread.draft.promptHistory.entries.length, 1);
    }
  }
});

test("session cost ledger records generation and enhancement once per id", () => {
  const session = createSession("Costs");
  const generation = recordSessionCost(session, {
    id: "generation:one",
    category: "generation",
    actualCostUsd: 0.25,
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const duplicate = recordSessionCost(generation, {
    id: "generation:one",
    category: "generation",
    actualCostUsd: 0.25,
    recordedAt: "2026-01-01T00:00:01.000Z",
  });
  const enhanced = recordSessionCost(duplicate, {
    id: "prompt-enhancement:one",
    category: "prompt_enhancement",
    actualCostUsd: 0.01,
    recordedAt: "2026-01-01T00:00:02.000Z",
  });
  const corrected = recordSessionCost(enhanced, {
    id: "generation:one",
    category: "generation",
    actualCostUsd: 0.27,
    recordedAt: "2026-01-01T00:00:03.000Z",
  });
  assert.equal(enhanced.costLedger.length, 2);
  assert.equal(enhanced.costLedger.reduce((sum, entry) => sum + entry.actualCostUsd, 0), 0.26);
  assert.equal(corrected.costLedger.length, 2);
  assert.equal(corrected.costLedger.find((entry) => entry.id === "generation:one")?.actualCostUsd, 0.27);
  assert.equal(corrected.costLedger.reduce((sum, entry) => sum + entry.actualCostUsd, 0), 0.28);
});

test("current v8 metadata omits the removed global enhancement preference", () => {
  withLocalStorage((writes) => {
    const session = createSession("Current");
    const state: StudioState = {
      schemaVersion: 8,
      activeSessionId: session.id,
      promptModel: "google/gemini-3.8-flash",
      directorPresets: [],
      sessions: [session],
    };
    saveStudioState(state);
    assert.equal((loadStudioState() as unknown as Record<string, unknown>).defaultEnhancePrompt, undefined);
    assert.doesNotMatch(writes.get("fruit-truck.studio.v1") ?? "", /defaultEnhancePrompt/);
  });
});

test("named generation presets survive a durable state round trip", () => {
  withLocalStorage(() => {
    const session = createSession("Preset workspace");
    const state: StudioState = {
      schemaVersion: 8,
      activeSessionId: session.id,
      promptModel: "google/gemini-3.8-flash",
      directorPresets: [],
      sessions: [session],
      generationPresets: [{
        id: "preset-cinematic",
        name: "Cinematic still",
        mode: "image",
        modelId: "example/cinematic-image",
        options: { quality: "high", aspect_ratio: "16:9", seed: 42 },
        providerJson: '{"only":["example-provider"]}',
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:01.000Z",
      }],
    };

    saveStudioState(state);

    assert.deepEqual(loadStudioState().generationPresets, state.generationPresets);
  });
});

test("current metadata preserves reference purposes and enhancement artifacts", () => {
  withLocalStorage(() => {
    const session = createSession("Semantic metadata");
    const thread = session.threads.image[0];
    const artifact = enhancementArtifactFixture();
    thread.draft.references = [{
      assetId: "style-reference",
      slot: 1,
      role: "reference",
      purpose: "style",
    }];
    thread.draft.prompt = artifact.prompt;
    thread.draft.promptHistory = {
      schemaVersion: 1,
      entries: [{
        id: "result",
        text: artifact.prompt,
        kind: "enhancement_result",
        createdAt: artifact.createdAt,
        plannerModel: "google/gemini-3.8-flash",
        reasoningEffort: "high",
        enhancementArtifact: artifact,
      }],
      cursor: 0,
      enhancementLocked: true,
      editRevision: 0,
    };
    const state: StudioState = {
      schemaVersion: 8,
      activeSessionId: session.id,
      promptModel: "google/gemini-3.8-flash",
      directorPresets: [],
      sessions: [session],
    };

    saveStudioState(state);

    const loadedThread = loadStudioState().sessions[0].threads.image[0];
    assert.deepEqual(loadedThread.draft.references, thread.draft.references);
    assert.deepEqual(loadedThread.draft.promptHistory.entries[0].enhancementArtifact, artifact);
  });
});

test("load supplies semantic purposes for saved references from before purpose persistence", () => {
  withLocalStorage((writes) => {
    const session = createSession("Legacy references");
    const createdAt = "2026-01-01T00:00:00.000Z";
    session.assets.push(
      { id: "legacy-image", name: "legacy.png", kind: "image", mimeType: "image/png", origin: "upload", createdAt },
      { id: "legacy-video", name: "legacy.mp4", kind: "video", mimeType: "video/mp4", origin: "upload", createdAt },
      { id: "legacy-audio", name: "legacy.mp3", kind: "audio", mimeType: "audio/mpeg", origin: "upload", createdAt },
    );
    const state: StudioState = {
      schemaVersion: 8,
      activeSessionId: session.id,
      promptModel: "google/gemini-3.8-flash",
      directorPresets: [],
      sessions: [session],
    };
    const persisted = JSON.parse(JSON.stringify(state)) as {
      sessions: Array<{
        threads: {
          image: Array<{ draft: { references: Array<Record<string, unknown>> } }>;
        };
      }>;
    };
    persisted.sessions[0].threads.image[0].draft.references = [
      { assetId: "legacy-image", slot: 1, role: "reference" },
      { assetId: "legacy-video", slot: 2, role: "reference" },
      { assetId: "legacy-audio", slot: 3, role: "reference" },
      { assetId: "legacy-image", slot: 4, role: "first_frame" },
    ];
    writes.set("fruit-truck.studio.v1", JSON.stringify(persisted));

    const references = loadStudioState().sessions[0].threads.image[0].draft.references;
    assert.deepEqual(references, [
      { assetId: "legacy-image", slot: 1, role: "reference", purpose: "subject_identity" },
      { assetId: "legacy-video", slot: 2, role: "reference", purpose: "motion" },
      { assetId: "legacy-audio", slot: 3, role: "reference", purpose: "audio" },
      { assetId: "legacy-image", slot: 4, role: "first_frame", purpose: "first_frame" },
    ]);
  });
});

test("thread defaults and active attempt helpers remain functional", () => {
  const session = createSession("Workspace");
  const thread = session.threads.image[0];
  session.generationDefaults.modelIds.image = "image/default";
  session.generationDefaults.options.image = { quality: "high" };
  assert.equal(effectiveThreadModelId(session, thread), "image/default");
  assert.deepEqual(effectiveThreadDraft(session, thread).options, { quality: "high" });
  const now = new Date().toISOString();
  thread.attempts.push({
    id: "attempt-active",
    status: "in_progress",
    draftRevision: 0,
    createdAt: now,
    updatedAt: now,
    inputAssetIds: [],
    assetIds: [],
  });
  assert.equal(activeGenerationAttempt(thread)?.id, "attempt-active");
});

test("generated-result editing starts with only that image as input one", () => {
  const session = createSession("Edit");
  const draft = session.threads.image[0].draft;
  draft.references = [{ assetId: "old", role: "reference", purpose: "context", slot: 1 }];
  draft.maskInstructions = "old mask";
  draft.promptHistory.enhancementLocked = true;
  const edit = beginGeneratedImageEdit(draft, "generated-result");
  assert.deepEqual(edit.references, [{
    assetId: "generated-result",
    role: "reference",
    slot: 1,
    purpose: "edit_target",
    purposeBeforeEdit: "subject_identity",
  }]);
  assert.equal(edit.imageEditTarget, "@1");
  assert.equal(edit.maskInstructions, "");
  assert.equal(edit.promptHistory.enhancementLocked, false);
});

test("edit targets restore their prior semantic purpose", () => {
  const styleReference = { assetId: "style", role: "reference" as const, slot: 3, purpose: "style" as const };
  const target = markReferenceAsEditTarget(styleReference);
  assert.equal(target.purpose, "edit_target");
  assert.equal(target.purposeBeforeEdit, "style");
  assert.deepEqual(restoreReferenceAfterEditTarget(target, "image"), styleReference);
});

test("deprecated Sora 2 is not selected as an automatic video default", () => {
  const selected = preferredCatalogModel("video", [
    { id: "openai/sora-2-pro", name: "Sora 2 Pro" },
    { id: "google/veo-3.1", name: "Veo 3.1" },
  ]);
  assert.equal(selected?.id, "google/veo-3.1");
});

test("browser imports reject empty and oversized media before storage", async () => {
  await assert.rejects(importFileAsset(new File([], "empty.jpg", { type: "image/jpeg" })), /is empty/);
  await assert.rejects(
    importFileAsset(new File([new Uint8Array(30 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" })),
    /30 MB local safety limit/,
  );
});

test("generated image imports validate and retain provider bytes while requested transforms stay derivative-only", async () => {
  const providerUrl = "https://provider.example/generated.png";
  const originalBytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const previousFetch = globalThis.fetch;
  const previousImage = globalThis.Image;
  globalThis.Image = class {
    naturalWidth = 1;
    naturalHeight = 1;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  } as unknown as typeof Image;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === providerUrl) {
      return new Response(originalBytes, { headers: { "content-type": "image/png" } });
    }
    return previousFetch(input);
  }) as typeof fetch;
  try {
    const imported = await importGeneratedImage(providerUrl, "provider-result.png", "generated", {
      resolution: "512",
      aspectRatio: "1:1",
    });
    assert.equal(imported.kind, "image");
    assert.equal(imported.mimeType, "image/png");
    assert.equal(imported.byteSize, originalBytes.byteLength);
    assert.equal(imported.externalUrl, undefined);
    assert.ok(imported.blobKey);
    const storedSource = await resolveAssetSource(imported);
    const storedBytes = new Uint8Array(await (await fetch(storedSource)).arrayBuffer());
    assert.deepEqual(storedBytes, originalBytes);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.Image = previousImage;
  }
});

test("generated image imports reject undecodable provider bytes", async () => {
  const providerUrl = "https://provider.example/broken.png";
  const previousFetch = globalThis.fetch;
  const previousImage = globalThis.Image;
  globalThis.Image = class {
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
  } as unknown as typeof Image;
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input) === providerUrl
    ? new Response(new Uint8Array([0, 1, 2, 3]), { headers: { "content-type": "image/png" } })
    : previousFetch(input)) as typeof fetch;
  try {
    await assert.rejects(
      importGeneratedImage(providerUrl, "broken.png", "generated"),
      /Could not validate generated image bytes/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.Image = previousImage;
  }
});

test("managed-file reconciliation marks missing assets, repairs moved paths, and recovers true orphans", () => {
  const state = createSession("Recovery");
  state.assets = [
    { id: "exact", name: "exact.png", kind: "image", mimeType: "image/png", origin: "upload", createdAt: "2026-01-01T00:00:00.000Z", localPath: "/managed/exact.png", fingerprint: "exact:1:image/png" },
    { id: "moved", name: "moved.png", kind: "image", mimeType: "image/png", origin: "upload", createdAt: "2026-01-01T00:00:00.000Z", localPath: "/managed/old.png", fingerprint: "moved:2:image/png" },
    { id: "missing", name: "missing.png", kind: "image", mimeType: "image/png", origin: "upload", createdAt: "2026-01-01T00:00:00.000Z", localPath: "/managed/missing.png", fingerprint: "missing:3:image/png" },
  ];
  const studio: StudioState = { schemaVersion: 8, activeSessionId: state.id, sessions: [state], promptModel: "google/gemini-3.8-flash", directorPresets: [] };
  const result = reconcileManagedAssetIndex(studio, [
    { id: "scan-exact", name: "exact.png", kind: "image", mimeType: "image/png", origin: "upload", createdAt: "2026-01-02T00:00:00.000Z", localPath: "/managed/exact.png", byteSize: 1, fingerprint: "exact:1:image/png" },
    { id: "scan-moved", name: "moved.png", kind: "image", mimeType: "image/png", origin: "upload", createdAt: "2026-01-02T00:00:00.000Z", localPath: "/managed/new.png", byteSize: 2, fingerprint: "moved:2:image/png" },
    { id: "orphan", name: "orphan.png", kind: "image", mimeType: "image/png", origin: "upload", createdAt: "2026-01-02T00:00:00.000Z", localPath: "/managed/orphan.png", byteSize: 4, fingerprint: "orphan:4:image/png" },
    { id: "duplicate", name: "exact-copy.png", kind: "image", mimeType: "image/png", origin: "upload", createdAt: "2026-01-02T00:00:00.000Z", localPath: "/managed/exact-copy.png", byteSize: 1, fingerprint: "exact:1:image/png" },
  ]);
  const assets = result.state.sessions[0].assets;
  assert.equal(assets.find((asset) => asset.id === "exact")?.storageAvailability, "available");
  assert.equal(assets.find((asset) => asset.id === "moved")?.localPath, "/managed/new.png");
  assert.equal(assets.find((asset) => asset.id === "missing")?.storageAvailability, "missing");
  assert.equal(assets.find((asset) => asset.id === "orphan")?.localPath, "/managed/orphan.png");
  assert.deepEqual({ missing: result.missingCount, relinked: result.relinkedCount, recovered: result.recoveredCount, duplicates: result.duplicateFiles.length }, { missing: 1, relinked: 1, recovered: 1, duplicates: 1 });
});

test("update verification reconciliation leaves all workspace assets untouched", () => {
  const session = createSession("Verified update assets");
  const protectedAsset = {
    id: "protected-asset",
    name: "original-name.png",
    kind: "image" as const,
    mimeType: "image/png",
    origin: "edited" as const,
    createdAt: "2025-12-31T23:59:59.000Z",
    localPath: "/managed/generated/original-name.png",
    blobKey: "legacy-protected-blob",
    externalUrl: "https://provider.example/original",
    jobId: "provider-job-protected",
    duration: 2.5,
    width: 1920,
    height: 1080,
    fps: 24,
    codec: "png",
    facePresence: "present" as const,
    byteSize: 321,
    fingerprint: "3c6b18e60a81d64e2b2b8a2f7f755d008a8171a7c0ff1c8ad768ec896dded8b3",
    bridgeAvailability: "desktop_only" as const,
    storageAvailability: "available" as const,
    sourceUrl: "https://provider.example/source",
    sourcePageUrl: "https://provider.example/page",
    license: "fixture-license",
    derivation: {
      kind: "resize_crop" as const,
      sourceAssetId: "source-asset",
      resolution: "1080p",
      aspectRatio: "16:9",
      createdAt: "2025-12-31T23:59:58.000Z",
    },
  };
  const missingAsset = {
    id: "missing-after-update",
    name: "missing.png",
    kind: "image" as const,
    mimeType: "image/png",
    origin: "upload" as const,
    createdAt: LEGACY_CREATED_AT,
    localPath: "/managed/assets/missing.png",
    fingerprint: "missing-sha256",
  };
  session.assets = [protectedAsset, missingAsset];
  const studio: StudioState = {
    schemaVersion: 8,
    activeSessionId: session.id,
    sessions: [session],
    promptModel: "google/gemini-3.8-flash",
    directorPresets: [],
  };
  const scanExact = {
    id: "scan-exact",
    name: "scanner-renamed.mp4",
    kind: "video" as const,
    mimeType: "video/mp4",
    origin: "generated" as const,
    createdAt: "2026-09-04T02:00:00.000Z",
    localPath: protectedAsset.localPath,
    byteSize: protectedAsset.byteSize,
    fingerprint: "scanner-name-size-mime-fingerprint",
    width: 640,
    height: 360,
    duration: 10,
    codec: "h264",
  };
  const duplicateExact = {
    ...scanExact,
    id: "duplicate-exact",
    localPath: "/managed/generated/original-name-copy.png",
  };
  const orphanPrimary = {
    id: "orphan-primary",
    name: "orphan.png",
    kind: "image" as const,
    mimeType: "image/png",
    origin: "upload" as const,
    createdAt: "2026-09-04T02:00:00.000Z",
    localPath: "/managed/assets/a-orphan.png",
    byteSize: 12,
    fingerprint: "orphan-scan-fingerprint",
  };
  const orphanDuplicate = {
    ...orphanPrimary,
    id: "orphan-duplicate",
    localPath: "/managed/assets/z-orphan-copy.png",
  };

  const result = reconcileVerifiedUpdateAssetIndex(studio, [
    { localPath: orphanDuplicate.localPath },
    { localPath: duplicateExact.localPath },
    { localPath: scanExact.localPath },
    { localPath: orphanPrimary.localPath },
  ]);
  const protectedAfter = result.state.sessions[0].assets.find((asset) =>
    asset.id === protectedAsset.id);

  assert.equal(result.state, studio);
  assert.deepEqual(protectedAfter, protectedAsset);
  assert.deepEqual(result.state.sessions[0].assets, [protectedAsset, missingAsset]);
  assert.equal(result.relinkedCount, 0);
  assert.equal(result.missingCount, 1);
  assert.equal(result.recoveredCount, 0);
  assert.deepEqual(result.duplicateFiles, []);
  assert.equal(result.state.sessions[0].assets.some((asset) =>
    asset.id === orphanPrimary.id || asset.id === orphanDuplicate.id), false);
  const reordered = reconcileVerifiedUpdateAssetIndex(studio, [
    { localPath: orphanPrimary.localPath },
    { localPath: scanExact.localPath },
    { localPath: duplicateExact.localPath },
    { localPath: orphanDuplicate.localPath },
  ]);
  assert.equal(reordered.state, studio);
  assert.deepEqual(reordered.state.sessions[0].assets, [protectedAsset, missingAsset]);
  assert.deepEqual(reordered.duplicateFiles, []);
  assert.equal(reordered.missingCount, 1);
});

test("media helpers and generated session names remain stable", () => {
  assert.equal(mediaMimeFromSource("/generated/result.jpeg", "image/png"), "image/jpeg");
  assert.equal(mediaMimeFromSource("/generated/result.svg", "image/png"), "image/svg+xml");
  assert.equal(mediaNameForMime("image-result.png", "image/svg+xml"), "image-result.svg");
  assert.equal(mediaNameForMime("image-result.png", "image/jpeg"), "image-result.jpg");
  assert.deepEqual(requestedImageDimensions(592, 448, "512", "4:3"), { width: 512, height: 384 });
  assert.equal(nextAvailableSessionName([{ name: "Session 2" }], (count) => `Session ${count}`), "Session 3");
});
