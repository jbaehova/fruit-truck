import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDefaultDirectorPlan } from "./director/defaults.ts";
import { createSession, type StudioState } from "./studio.ts";
import {
  WORKSPACE_MUTATION_LOCK_MESSAGE,
  WorkspaceInvariantError,
  assertWorkspaceInvariants,
  assertWorkspaceMutable,
  collectWorkspaceInvariants,
  compareWorkspaceInvariants,
  inspectActiveUpdateOperations,
  migrateStudioForUpdate,
  migrateV6ToV7,
  migrateV7ToV8,
  workspaceInvariantsHold,
  type UpdateStudioV7State,
} from "./updateMigration.ts";

const CREATED_AT = "2026-09-04T00:00:00.000Z";

function phase3Fixture(name: string): unknown {
  return JSON.parse(readFileSync(
    new URL(`../fixtures/studio/phase-3/${name}`, import.meta.url),
    "utf8",
  )) as unknown;
}

function legacyArtifact(prompt: string) {
  return {
    schemaVersion: 1,
    signature: "legacy-enhancement-signature",
    plannerModel: "openai/gpt-5.6-terra",
    createdAt: CREATED_AT,
    prompt,
    negativePrompt: "blur, watermark",
    actualCostUsd: 0.07,
  };
}

function legacyDraft(original: string, enhanced: string, enabled: boolean) {
  return {
    prompt: original,
    references: [],
    options: {},
    providerJson: "",
    enhancePrompt: enabled,
    enhancedPrompt: enhanced,
    enhancedPromptDirty: false,
    enhancedVisualCount: 0,
    enhancementArtifact: legacyArtifact(enhanced),
    imageEditMode: false,
    imageEditTarget: "",
    maskInstructions: "",
    maskStrokes: [],
  };
}

function v6Fixture(): Record<string, unknown> {
  const session = createSession("Production v6");
  session.id = "session-v6";
  session.activeThreadIds.image = "thread-image";
  session.activeThreadIds.video = "thread-video";
  session.threads.image[0].id = "thread-image";
  session.threads.video[0].id = "thread-video";
  session.assets = [{
    id: "asset-upload",
    name: "input.png",
    kind: "image",
    mimeType: "image/png",
    origin: "upload",
    createdAt: CREATED_AT,
    localPath: "/managed/assets/input.png",
    byteSize: 123,
    fingerprint: "sha256:input",
  }, {
    id: "asset-result",
    name: "result.mp4",
    kind: "video",
    mimeType: "video/mp4",
    origin: "generated",
    createdAt: CREATED_AT,
    localPath: "/managed/generated/result.mp4",
    jobId: "provider-job-1",
    byteSize: 456,
    fingerprint: "sha256:result",
  }];
  const original = "An orange fruit truck at sunrise";
  const enhanced = "A cinematic orange fruit truck at sunrise";
  const snapshotOriginal = "Snapshot fruit truck";
  const snapshotEnhanced = "Cinematic snapshot fruit truck";
  session.threads.image[0] = {
    ...session.threads.image[0],
    draft: legacyDraft(original, enhanced, true) as never,
    attempts: [{
      id: "attempt-image",
      status: "completed",
      draftRevision: 3,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      completedAt: CREATED_AT,
      inputAssetIds: ["asset-upload"],
      assetIds: ["asset-result"],
      actualCostUsd: 0.4,
      costRecordedAt: CREATED_AT,
      snapshot: {
        ...legacyDraft(snapshotOriginal, snapshotEnhanced, true),
        mode: "image",
        modelId: "image/model",
        assetBindings: [],
      } as never,
    }],
    enhancementAttempts: [{
      id: "enhancement-completed",
      requestKey: "enhancement-request",
      status: "completed",
      threadRevision: 3,
      originalPrompt: original,
      enhancedPrompt: enhanced,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      actualCostUsd: 0.07,
      costRecordedAt: CREATED_AT,
    }],
  };
  session.threads.video[0] = {
    ...session.threads.video[0],
    draft: legacyDraft("Video original", "Video enhanced", false) as never,
    attempts: [{
      id: "attempt-video",
      status: "in_progress",
      draftRevision: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      submittedAt: CREATED_AT,
      inputAssetIds: ["asset-upload"],
      assetIds: [],
      jobId: "provider-job-1",
    }],
    enhancementAttempts: [{
      id: "enhancement-uncertain",
      requestKey: "enhancement-uncertain-request",
      status: "uncertain",
      threadRevision: 1,
      originalPrompt: "Video original",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }],
  };
  session.costLedger = [{
    id: "cost-generation",
    category: "generation",
    actualCostUsd: 0.4,
    recordedAt: CREATED_AT,
  }, {
    id: "cost-enhancement",
    category: "prompt_enhancement",
    actualCostUsd: 0.07,
    recordedAt: CREATED_AT,
  }];
  return {
    schemaVersion: 6,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-terra",
    defaultEnhancePrompt: false,
    generationPresets: [],
    sessions: [session],
  };
}

test("v6 to v7 migrates drafts and attempt snapshots deterministically", () => {
  const input = v6Fixture();
  const original = structuredClone(input);
  const first = migrateV6ToV7(input);
  const second = migrateV6ToV7(input);
  const session = first.sessions[0];
  const threads = session.threads as { image: Array<Record<string, unknown>>; video: Array<Record<string, unknown>> };
  const image = threads.image[0];
  const draft = image.draft as Record<string, unknown>;
  const history = draft.promptHistory as {
    cursor: number;
    enhancementLocked: boolean;
    entries: Array<Record<string, unknown>>;
  };
  const attempts = image.attempts as Array<Record<string, unknown>>;
  const snapshot = attempts[0].snapshot as Record<string, unknown>;
  const snapshotHistory = snapshot.promptHistory as { entries: Array<Record<string, unknown>> };

  assert.deepEqual(input, original);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 7);
  assert.equal(first.promptModel, "google/gemini-3.8-flash");
  assert.equal(first.defaultEnhancePrompt, undefined);
  assert.equal(draft.prompt, "A cinematic orange fruit truck at sunrise");
  assert.equal(history.cursor, 1);
  assert.equal(history.enhancementLocked, true);
  assert.deepEqual(history.entries.map((entry) => entry.text), [
    "An orange fruit truck at sunrise",
    "A cinematic orange fruit truck at sunrise",
  ]);
  assert.equal(history.entries[1].plannerModel, "google/gemini-3.8-flash");
  assert.equal(history.entries[1].negativePrompt, "blur, watermark");
  assert.equal(history.entries[1].enhancementAttemptId, "enhancement-completed");
  assert.deepEqual(history.entries[1].enhancementArtifact, legacyArtifact(
    "A cinematic orange fruit truck at sunrise",
  ));
  assert.deepEqual(snapshotHistory.entries.map((entry) => entry.text), [
    "Snapshot fruit truck",
    "Cinematic snapshot fruit truck",
  ]);
  for (const container of [draft, snapshot]) {
    assert.equal(container.enhancePrompt, undefined);
    assert.equal(container.enhancedPrompt, undefined);
    assert.equal(container.enhancementArtifact, undefined);
  }
});

test("v6 to v7 links dirty enhanced text to its immutable completed attempt provenance", () => {
  const input = v6Fixture();
  const session = (input.sessions as Array<Record<string, unknown>>)[0];
  const threads = session.threads as { image: Array<Record<string, unknown>> };
  const image = threads.image[0];
  const draft = image.draft as Record<string, unknown>;
  const artifact = draft.enhancementArtifact as Record<string, unknown>;
  const plannerResult = "A cinematic orange fruit truck at sunrise";
  const editedResult = "A cinematic orange fruit truck at sunrise with hand-painted peach signs";
  artifact.signature = "dirty-enhancement-request";
  artifact.prompt = plannerResult;
  artifact.createdAt = "2026-09-04T00:01:00.000Z";
  delete artifact.actualCostUsd;
  draft.enhancedPrompt = editedResult;
  draft.enhancedPromptDirty = true;
  const generationAttempt = (image.attempts as Array<Record<string, unknown>>)[0];
  const snapshot = generationAttempt.snapshot as Record<string, unknown>;
  snapshot.prompt = draft.prompt;
  snapshot.enhancedPrompt = editedResult;
  snapshot.enhancedPromptDirty = true;
  snapshot.enhancementArtifact = structuredClone(artifact);
  image.enhancementAttempts = [{
    id: "enhancement-canonical",
    requestKey: "dirty-enhancement-request",
    status: "completed",
    threadRevision: 3,
    originalPrompt: "An orange fruit truck at sunrise",
    enhancedPrompt: plannerResult,
    createdAt: "2026-09-04T00:00:30.000Z",
    updatedAt: "2026-09-04T00:01:00.000Z",
    actualCostUsd: 0.07,
    costRecordedAt: "2026-09-04T00:01:00.000Z",
  }, {
    id: "enhancement-visible-decoy",
    requestKey: "unrelated-request",
    status: "completed",
    threadRevision: 3,
    originalPrompt: "An orange fruit truck at sunrise",
    enhancedPrompt: editedResult,
    createdAt: "2026-09-04T00:02:00.000Z",
    updatedAt: "2026-09-04T00:03:00.000Z",
    actualCostUsd: 0.11,
  }];

  const migrated = migrateV6ToV7(input);
  const migratedImage = ((migrated.sessions[0].threads as {
    image: Array<Record<string, unknown>>;
  }).image[0]);
  const migratedDraft = migratedImage.draft as Record<string, unknown>;
  const history = migratedDraft.promptHistory as { entries: Array<Record<string, unknown>> };
  const result = history.entries[1];
  const migratedArtifact = result.enhancementArtifact as Record<string, unknown>;
  const migratedGenerationAttempt = (migratedImage.attempts as Array<Record<string, unknown>>)[0];
  const migratedSnapshot = migratedGenerationAttempt.snapshot as Record<string, unknown>;
  const snapshotHistory = migratedSnapshot.promptHistory as { entries: Array<Record<string, unknown>> };

  assert.equal(migratedDraft.prompt, editedResult);
  assert.equal(result.text, editedResult);
  assert.equal(result.enhancementAttemptId, "enhancement-canonical");
  assert.equal(result.actualCostUsd, 0.07);
  assert.equal(migratedArtifact.prompt, plannerResult);
  assert.notEqual(result.text, migratedArtifact.prompt);
  assert.equal(result.negativePrompt, "blur, watermark");
  assert.equal(snapshotHistory.entries[1].enhancementAttemptId, "enhancement-canonical");
  assert.equal(snapshotHistory.entries[1].actualCostUsd, 0.07);
  assert.equal(snapshotHistory.entries[1].text, editedResult);
  assert.equal(
    (snapshotHistory.entries[1].enhancementArtifact as Record<string, unknown>).prompt,
    plannerResult,
  );
});

test("v7 to v8 preserves existing Director plans without creating absent plans", () => {
  const v7 = migrateV6ToV7(v6Fixture());
  const session = v7.sessions[0];
  const threads = session.threads as { image: Array<Record<string, unknown>>; video: Array<Record<string, unknown>> };
  const plan = createDefaultDirectorPlan({
    sourceAssetId: "asset-upload",
    now: CREATED_AT,
    createId: (prefix) => `${prefix}-stable`,
  });
  plan.motions.push({
    id: "motion-stable",
    targetType: "camera",
    kind: "dolly",
    direction: "in",
    intensity: 0.5,
    start: 0,
    end: 1,
    easing: "ease_in_out",
    order: 1,
  });
  const imageDraft = threads.image[0].draft as Record<string, unknown>;
  const imageAttempts = threads.image[0].attempts as Array<Record<string, unknown>>;
  const imageSnapshot = imageAttempts[0].snapshot as Record<string, unknown>;
  imageDraft.directorPlan = structuredClone(plan);
  imageSnapshot.directorPlan = structuredClone(plan);
  const original = structuredClone(v7);
  const migrated = migrateV7ToV8(v7);

  assert.deepEqual(v7, original);
  assert.equal(migrated.schemaVersion, 8);
  assert.deepEqual(migrated.directorPresets, []);
  assert.deepEqual(migrated.sessions[0].threads.image[0].draft.directorPlan, plan);
  assert.deepEqual(migrated.sessions[0].threads.image[0].attempts[0].snapshot?.directorPlan, plan);
  assert.equal(migrated.sessions[0].threads.video[0].draft.directorPlan, undefined);
  assert.equal(migrated.sessions[0].threads.video[0].attempts[0].status, "in_progress");
});

test("the sequential update migration returns v8 and a complete invariant report", () => {
  const result = migrateStudioForUpdate(v6Fixture());

  assert.equal(result.state.schemaVersion, 8);
  assert.deepEqual(result.migration, {
    fromVersion: 6,
    toVersion: 8,
    steps: ["v6→v7", "v7→v8"],
  });
  assert.equal(workspaceInvariantsHold(result.invariants), true);
  assert.deepEqual(result.invariants, {
    sessionIdsEqual: true,
    threadIdsEqual: true,
    assetIdsEqual: true,
    attemptIdsEqual: true,
    enhancementAttemptIdsEqual: true,
    costLedgerIdsEqual: true,
    providerJobIdsEqual: true,
    localPathsEqual: true,
    legacyPromptsPreserved: true,
  });
});

test("the production v6 release fixture reaches v8 without identity loss", () => {
  const result = migrateStudioForUpdate(phase3Fixture("v6-production-workspace.json"));
  const session = result.state.sessions[0];
  const threads = [...session.threads.image, ...session.threads.video];

  assert.deepEqual(result.migration.steps, ["v6→v7", "v7→v8"]);
  assert.equal(workspaceInvariantsHold(result.invariants), true);
  assert.equal(session.id, "phase3-session-v6");
  assert.ok(session.assets.some((asset) => asset.id === "phase3-source-frame"));
  assert.ok(session.assets.some((asset) => asset.id === "phase3-active-video-bytes"));
  assert.ok(threads.some((thread) => thread.attempts.some((attempt) =>
    attempt.jobId === "provider-video-job-phase3" && attempt.status === "in_progress")));
  assert.ok(threads.some((thread) => thread.draft.promptHistory.entries.some((entry) =>
    entry.text === "Use @1 as the exact fruit truck identity in a roadside portrait.")));
  assert.ok(threads.some((thread) => thread.draft.promptHistory.entries.some((entry) =>
    entry.text === "Use @1 as the exact red fruit truck identity, parked at a sunlit roadside market with legible painted produce signs.")));
});

test("the v7 fifty-checkpoint fixture migrates without trimming history", () => {
  const input = phase3Fixture("v7-fifty-prompt-history.json");
  const inputHistory = (input as {
    sessions: Array<{
      threads: { image: Array<{ draft: { promptHistory: { entries: Array<{ id: string }> } } }> };
    }>;
  }).sessions[0].threads.image[0].draft.promptHistory;
  const result = migrateStudioForUpdate(input);
  const history = result.state.sessions[0].threads.image[0].draft.promptHistory;

  assert.deepEqual(result.migration.steps, ["v7→v8"]);
  assert.equal(history.entries.length, 50);
  assert.equal(history.cursor, 49);
  assert.deepEqual(
    history.entries.map((entry) => entry.id),
    inputHistory.entries.map((entry) => entry.id),
  );
});

test("the invariant report rejects removal from an existing v7 prompt history", () => {
  const input = phase3Fixture("v7-fifty-prompt-history.json");
  const migrated = migrateStudioForUpdate(input).state;
  migrated.sessions[0].threads.image[0].draft.promptHistory.entries.splice(10, 1);

  const report = compareWorkspaceInvariants(
    collectWorkspaceInvariants(input),
    collectWorkspaceInvariants(migrated),
  );
  assert.equal(report.legacyPromptsPreserved, false);
});

test("the current v8 Director fixture remains byte-data equivalent", () => {
  const input = phase3Fixture("v8-director-missing-asset.json");
  const result = migrateStudioForUpdate(input);

  assert.deepEqual(result.migration.steps, []);
  assert.deepEqual(result.state, input);
  assert.equal(result.state.sessions[0].assets.some((asset) =>
    asset.storageAvailability === "missing"), true);
  assert.equal(result.state.directorPresets.length, 1);
});

test("v8 update migration is idempotent and does not use browser storage", () => {
  const migrated = migrateStudioForUpdate(v6Fixture()).state;
  const before = structuredClone(migrated);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let browserStorageTouched = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => { browserStorageTouched = true; return null; },
      setItem: () => { browserStorageTouched = true; },
      removeItem: () => { browserStorageTouched = true; },
    },
  });
  try {
    const first = migrateStudioForUpdate(migrated);
    const second = migrateStudioForUpdate(first.state);
    assert.deepEqual(first.state, before);
    assert.deepEqual(second.state, before);
    assert.deepEqual(first.migration.steps, []);
    assert.deepEqual(second.migration.steps, []);
    assert.equal(browserStorageTouched, false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("invariant collection and comparison expose every required mismatch", () => {
  const before = collectWorkspaceInvariants(v6Fixture());
  const after = structuredClone(before);
  after.sessionIds = [];
  after.threadIds = [];
  after.assetIds = [];
  after.attemptIds = [];
  after.enhancementAttemptIds = [];
  after.costLedgerIds = [];
  after.providerJobIds = [];
  after.localPaths = [];
  after.promptHistories = [];

  assert.deepEqual(compareWorkspaceInvariants(before, after), {
    sessionIdsEqual: false,
    threadIdsEqual: false,
    assetIdsEqual: false,
    attemptIdsEqual: false,
    enhancementAttemptIdsEqual: false,
    costLedgerIdsEqual: false,
    providerJobIdsEqual: false,
    localPathsEqual: false,
    legacyPromptsPreserved: false,
  });
});

test("invariant assertion fails closed when a protected asset disappears", () => {
  const before = v6Fixture();
  const after = migrateStudioForUpdate(before).state;
  after.sessions[0].assets = after.sessions[0].assets.filter((asset) => asset.id !== "asset-upload");

  assert.throws(
    () => assertWorkspaceInvariants(before, after),
    (error: unknown) => error instanceof WorkspaceInvariantError
      && error.failed.includes("assetIdsEqual")
      && error.failed.includes("localPathsEqual"),
  );
});

test("migration rejects unsupported schemas and malformed Director data", () => {
  const unsupported = { ...v6Fixture(), schemaVersion: 5 };
  assert.throws(
    () => migrateStudioForUpdate(unsupported),
    /Unsupported update Studio schema 5/,
  );

  const v7 = migrateV6ToV7(v6Fixture());
  const session = v7.sessions[0];
  const threads = session.threads as { image: Array<Record<string, unknown>> };
  const draft = threads.image[0].draft as Record<string, unknown>;
  draft.directorPlan = { schemaVersion: 999 };
  assert.throws(
    () => migrateV7ToV8(v7),
    /failed validation/,
  );
});

test("active update gate scans all threads and includes materialization and durability", () => {
  const state = migrateStudioForUpdate(v6Fixture()).state;
  const second = createSession("Second session");
  second.id = "session-second";
  second.threads.image[0].attempts = [{
    id: "attempt-submitting",
    status: "submitting",
    draftRevision: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    inputAssetIds: [],
    assetIds: [],
  }, {
    id: "generation-uncertain-does-not-block",
    status: "uncertain",
    draftRevision: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    inputAssetIds: [],
    assetIds: [],
  }];
  second.threads.video[0].attempts = [{
    id: "legacy-enhancing",
    status: "enhancing",
    draftRevision: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    inputAssetIds: [],
    assetIds: [],
  }];
  second.threads.video[0].enhancementAttempts = [{
    id: "enhancement-in-progress",
    requestKey: "request-in-progress",
    status: "in_progress",
    threadRevision: 1,
    originalPrompt: "prompt",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }];
  state.sessions.push(second);

  const gate = inspectActiveUpdateOperations({
    state,
    pendingMaterializationCount: 2,
    materializationInFlight: true,
    pendingDurableSaveCount: 3,
    durableSavePending: true,
    durableSaveError: new Error("disk unavailable"),
  });

  assert.equal(gate.allowed, false);
  assert.deepEqual(gate.activeGenerationAttemptIds, ["attempt-submitting", "attempt-video"]);
  assert.deepEqual(gate.activeEnhancementAttemptIds, [
    "enhancement-in-progress",
    "enhancement-uncertain",
    "legacy-enhancing",
  ]);
  assert.equal(gate.activeAttemptCount, 5);
  assert.equal(gate.pendingMaterializationCount, 2);
  assert.equal(gate.pendingDurableSaveCount, 3);
  assert.equal(gate.activeOperationCount, 7);
  assert.deepEqual(gate.blockers, [
    "generation_in_flight",
    "enhancement_in_flight",
    "result_materialization_pending",
    "durable_save_failed",
  ]);
});

test("active update gate permits a settled workspace", () => {
  const state = migrateStudioForUpdate(v6Fixture()).state;
  for (const session of state.sessions) {
    for (const thread of [...session.threads.image, ...session.threads.video]) {
      thread.attempts = thread.attempts.map((attempt) => ({ ...attempt, status: "completed" }));
      thread.enhancementAttempts = thread.enhancementAttempts?.map((attempt) => ({
        ...attempt,
        status: "completed",
      }));
    }
  }
  const gate = inspectActiveUpdateOperations({ state });
  assert.equal(gate.allowed, true);
  assert.equal(gate.activeOperationCount, 0);
  assert.deepEqual(gate.blockers, []);
});

test("mutation lock assertion blocks active update locks only", () => {
  assert.doesNotThrow(() => assertWorkspaceMutable(undefined));
  assert.doesNotThrow(() => assertWorkspaceMutable({ active: false }));
  assert.throws(
    () => assertWorkspaceMutable({ active: true, reason: "update", transactionId: "tx-1" }),
    new RegExp(WORKSPACE_MUTATION_LOCK_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("v7 type remains consumable as raw update payload", () => {
  const v7: UpdateStudioV7State = migrateV6ToV7(v6Fixture());
  const result: StudioState = migrateStudioForUpdate(v7).state;
  assert.equal(result.schemaVersion, 8);
});
