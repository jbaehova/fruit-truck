import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultDirectorPlan } from "./director/defaults.ts";
import type { DirectorPlan } from "./director/types.ts";
import {
  applyDirectorPreset,
  cloneGenerationAttemptSnapshot,
  createDirectorPreset,
  createSession,
  deleteDirectorPreset,
  emptyDraft,
  ensureDraftDirectorPlan,
  loadStudioStateWithRecovery,
  MAX_DIRECTOR_PLAN_BYTES,
  restoreDraftFromAttemptSnapshot,
  saveDirectorPreset,
  saveStudioState,
  STUDIO_BACKUP_KEY_PREFIX,
  STUDIO_STORAGE_KEY,
  type GenerationAttemptSnapshot,
  type StudioState,
  type StudioStorage,
} from "./studio.ts";

function memoryStorage(initial: Record<string, string> = {}): {
  storage: StudioStorage;
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      get length() { return values.size; },
      key: (index) => [...values.keys()][index] ?? null,
    },
  };
}

function directorPlanFixture(): DirectorPlan {
  const plan = createDefaultDirectorPlan({
    sourceAssetId: "frame-a",
    now: "2026-09-04T00:00:00.000Z",
    createId: (prefix) => `${prefix}-fixture`,
  });
  plan.subjects = [{
    id: "subject-truck",
    label: "Fruit truck",
    region: { type: "box", x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    sourceAssetId: "frame-a",
  }];
  plan.motions = [{
    id: "motion-truck",
    targetType: "subject",
    targetId: "subject-truck",
    kind: "translate",
    path: [{ x: 0.1, y: 0.3 }, { x: 0.8, y: 0.6 }],
    intensity: 0.75,
    start: 0,
    end: 1,
    easing: "ease_in_out",
    order: 1,
  }];
  plan.keyframes = [{ id: "keyframe-last", assetId: "frame-b", role: "last", time: 1 }];
  plan.shots = [{
    id: "shot-fixture",
    order: 1,
    durationSeconds: 5,
    promptFragment: "Follow the truck",
    motionIds: ["motion-truck"],
    keyframeIds: ["keyframe-last"],
    speed: "linear",
  }];
  return plan;
}

function snapshotFixture(plan: DirectorPlan): GenerationAttemptSnapshot {
  return {
    mode: "video",
    modelId: "video/example",
    prompt: "A fruit truck follows the road",
    enhancePrompt: false,
    enhancedPrompt: "",
    options: { duration: 5 },
    providerJson: "{}",
    assetBindings: [],
    imageEditMode: false,
    imageEditTarget: "",
    maskInstructions: "",
    maskStrokes: [],
    directorPlan: plan,
  };
}

test("v6 passes through v7 and reaches v8 without inventing Director plans", () => {
  const session = createSession("v6 workspace");
  const raw = JSON.stringify({
    schemaVersion: 6,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    sessions: [{
      ...session,
      legacyEnhancementFields: { signature: "keep-me" },
      threads: {
        ...session.threads,
        video: session.threads.video.map((thread) => ({
          ...thread,
          draft: { ...thread.draft, legacyEnhancementDraftField: ["keep", "all"] },
        })),
      },
    }],
    legacyRootField: { exact: true },
  });
  const { storage, values } = memoryStorage({ [STUDIO_STORAGE_KEY]: raw });

  const result = loadStudioStateWithRecovery({
    storage,
    now: () => new Date("2026-09-04T01:00:00.000Z"),
  });

  assert.equal(result.state.schemaVersion, 8);
  assert.deepEqual(result.migration?.steps, ["v6→v7", "v7→v8"]);
  assert.deepEqual(result.state.directorPresets, []);
  assert.equal(result.state.sessions[0].threads.video[0].draft.directorPlan, undefined);
  assert.deepEqual(
    (result.state as unknown as Record<string, unknown>).legacyRootField,
    { exact: true },
  );
  assert.deepEqual(
    (result.state.sessions[0] as unknown as Record<string, unknown>).legacyEnhancementFields,
    { signature: "keep-me" },
  );
  assert.deepEqual(
    (result.state.sessions[0].threads.video[0].draft as unknown as Record<string, unknown>)
      .legacyEnhancementDraftField,
    ["keep", "all"],
  );
  const backupKey = [...values.keys()].find((key) => key.startsWith(STUDIO_BACKUP_KEY_PREFIX));
  assert.ok(backupKey);
  assert.equal(values.get(backupKey), raw);
});

test("v7 to v8 preserves complete Director drafts and attempt snapshots", () => {
  const session = createSession("Director migration");
  const plan = directorPlanFixture() as DirectorPlan & {
    futureControl: { kind: string; payload: number[] };
  };
  plan.futureControl = { kind: "provider-independent", payload: [1, 2, 3] };
  const thread = session.threads.video[0];
  thread.draft.directorPlan = plan;
  thread.attempts = [{
    id: "attempt-director",
    status: "completed",
    draftRevision: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:01:00.000Z",
    inputAssetIds: ["frame-a", "frame-b"],
    assetIds: [],
    snapshot: snapshotFixture(plan),
  }];
  const raw = JSON.stringify({
    schemaVersion: 7,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    sessions: [session],
  });
  const { storage } = memoryStorage({ [STUDIO_STORAGE_KEY]: raw });

  const result = loadStudioStateWithRecovery({ storage });
  const migratedThread = result.state.sessions[0].threads.video[0];
  const migratedPlan = migratedThread.draft.directorPlan as typeof plan;
  const snapshotPlan = migratedThread.attempts[0].snapshot?.directorPlan as typeof plan;

  assert.deepEqual(result.migration?.steps, ["v7→v8"]);
  assert.deepEqual(migratedPlan, plan);
  assert.deepEqual(snapshotPlan, plan);
  assert.deepEqual(migratedPlan.futureControl, plan.futureControl);
  migratedPlan.motions[0].intensity = 0.1;
  assert.equal(snapshotPlan.motions[0].intensity, 0.75);
});

test("Director defaults remain lazy and historical snapshot clones do not alias", () => {
  const empty = emptyDraft();
  assert.equal(empty.directorPlan, undefined);

  const opened = ensureDraftDirectorPlan(empty, {
    now: "2026-09-04T00:00:00.000Z",
    createId: (prefix) => `${prefix}-lazy`,
  });
  assert.equal(empty.directorPlan, undefined);
  assert.equal(opened.directorPlan?.schemaVersion, 1);

  const plan = directorPlanFixture();
  const snapshot = snapshotFixture(plan);
  const copiedSnapshot = cloneGenerationAttemptSnapshot(snapshot);
  copiedSnapshot.directorPlan!.motions[0].intensity = 0.2;
  assert.equal(snapshot.directorPlan!.motions[0].intensity, 0.75);

  const restored = restoreDraftFromAttemptSnapshot(empty, snapshot);
  restored.directorPlan!.motions[0].intensity = 0.3;
  assert.equal(snapshot.directorPlan!.motions[0].intensity, 0.75);
  assert.deepEqual(restored.options, snapshot.options);
});

test("Director presets omit assets, rebind on apply, persist, and delete", () => {
  const original = directorPlanFixture();
  const preset = createDirectorPreset("  Road follow  ", original, {
    id: "preset-road-follow",
    now: "2026-09-04T02:00:00.000Z",
  });
  assert.equal(preset.name, "Road follow");
  assert.equal("sourceAssetId" in preset.plan, false);
  assert.equal("subjects" in preset.plan, false);
  assert.equal("keyframes" in preset.plan, false);

  const target = directorPlanFixture();
  target.sourceAssetId = "new-frame";
  target.subjects[0].id = "new-subject";
  target.subjects[0].sourceAssetId = "new-frame";
  target.keyframes[0].id = "new-keyframe";
  target.keyframes[0].assetId = "new-last-frame";
  target.shots[0].keyframeIds = ["new-keyframe"];
  const applied = applyDirectorPreset(target, preset, "2026-09-04T03:00:00.000Z");
  assert.equal(applied.sourceAssetId, "new-frame");
  assert.equal(applied.subjects[0].sourceAssetId, "new-frame");
  assert.equal(applied.keyframes[0].assetId, "new-last-frame");
  assert.equal(applied.motions[0].targetId, "new-subject");
  assert.deepEqual(applied.shots[0].keyframeIds, ["new-keyframe"]);
  assert.equal(applied.updatedAt, "2026-09-04T03:00:00.000Z");

  const session = createSession("Presets");
  const state: StudioState = {
    schemaVersion: 8,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    sessions: [session],
    directorPresets: [],
  };
  const saved = saveDirectorPreset(state, preset);
  const { storage } = memoryStorage();
  saveStudioState(saved, { storage });
  const loaded = loadStudioStateWithRecovery({ storage }).state;
  assert.deepEqual(loaded.directorPresets, [preset]);
  assert.deepEqual(deleteDirectorPreset(loaded, preset.id).directorPresets, []);
});

test("multi-shot presets keep the destination keyframe grouping by shot order", () => {
  const original = directorPlanFixture();
  original.keyframes.push({ id: "keyframe-middle", assetId: "frame-middle", role: "middle", time: 0.5 });
  original.shots[0].keyframeIds = ["keyframe-last"];
  original.shots.push({
    id: "shot-second",
    order: 2,
    durationSeconds: 3,
    promptFragment: "Second shot",
    motionIds: [],
    keyframeIds: ["keyframe-middle"],
    speed: "speed_up",
  });
  const preset = createDirectorPreset("Two shots", original, {
    id: "preset-two-shots",
    now: "2026-09-04T04:00:00.000Z",
  });
  const destination = directorPlanFixture();
  destination.keyframes = [
    { id: "destination-first", assetId: "new-first", role: "first", time: 0 },
    { id: "destination-middle", assetId: "new-middle", role: "middle", time: 0.5 },
  ];
  destination.shots = [
    { ...destination.shots[0], order: 1, keyframeIds: ["destination-first"] },
    { id: "destination-shot-two", order: 2, durationSeconds: 3, promptFragment: "Destination second", motionIds: [], keyframeIds: ["destination-middle"], speed: "linear" },
  ];

  const applied = applyDirectorPreset(destination, preset, "2026-09-04T05:00:00.000Z");

  assert.deepEqual(applied.shots[0].keyframeIds, ["destination-first"]);
  assert.deepEqual(applied.shots[1].keyframeIds, ["destination-middle"]);
  assert.deepEqual(applied.keyframes.map((keyframe) => keyframe.assetId), ["new-first", "new-middle"]);
});

test("oversized Director plans cannot replace durable Studio metadata", () => {
  const session = createSession("Oversized Director plan");
  const plan = directorPlanFixture();
  plan.motions[0].actionLabel = "x".repeat(MAX_DIRECTOR_PLAN_BYTES);
  session.threads.video[0].draft.directorPlan = plan;
  const state: StudioState = {
    schemaVersion: 8,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    sessions: [session],
    directorPresets: [],
  };
  const { storage, values } = memoryStorage();

  assert.throws(
    () => saveStudioState(state, { storage }),
    /exceeds the 512 KB persistence limit/,
  );
  assert.equal(values.has(STUDIO_STORAGE_KEY), false);
});
