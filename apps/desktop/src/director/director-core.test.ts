import test from "node:test";
import assert from "node:assert/strict";
import {
  cloneDirectorPlan,
  createDefaultDirectorPlan,
  createDefaultDirectorShot,
  ensureDirectorPlan,
} from "./defaults.ts";
import {
  applyDirectorEasing,
  computeCameraPreviewTransform,
  normalizePointToContent,
  resampleDirectorPath,
  sampleDirectorAnimatic,
  sampleDirectorPath,
  simplifyDirectorPath,
} from "./preview.ts";
import type { DirectorMotion, DirectorPlan } from "./types.ts";
import {
  DIRECTOR_VALIDATION_CODES,
  normalizeDirectorPlan,
  validateDirectorPlan,
} from "./validation.ts";

function goldenPlan(): DirectorPlan {
  return {
    schemaVersion: 1,
    enabled: true,
    sourceAssetId: "asset-source",
    canvas: { sourceWidth: 1920, sourceHeight: 1080 },
    cameraRig: {
      id: "rig-1",
      sensorPreset: "cinema",
      lensPreset: "anamorphic",
      focalLengthMm: 50,
      aperture: 2.8,
      focusSubjectId: "subject-1",
      aspectRatio: "16:9",
    },
    subjects: [{
      id: "subject-1",
      label: "Fruit crate",
      region: { type: "box", x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
      sourceAssetId: "asset-source",
    }],
    motions: [
      {
        id: "motion-subject",
        targetType: "subject",
        targetId: "subject-1",
        kind: "translate",
        path: [{ x: 0.1, y: 0.3 }, { x: 0.5, y: 0.2 }, { x: 0.9, y: 0.3 }],
        intensity: 1,
        start: 0,
        end: 1,
        easing: "linear",
        order: 1,
        actionLabel: "Move across frame",
      },
      {
        id: "motion-camera",
        targetType: "camera",
        kind: "dolly",
        direction: "in",
        intensity: 1,
        start: 0,
        end: 1,
        easing: "linear",
        order: 1,
      },
    ],
    keyframes: [
      { id: "key-first", assetId: "asset-first", role: "first", time: 0 },
      { id: "key-last", assetId: "asset-last", role: "last", time: 1 },
    ],
    shots: [{
      id: "shot-1",
      order: 1,
      durationSeconds: 5,
      promptFragment: "Fresh fruit arrives.",
      motionIds: ["motion-subject", "motion-camera"],
      keyframeIds: ["key-first", "key-last"],
      speed: "linear",
    }],
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}

test("Director defaults are lazy, deterministic when injected, and snapshot-safe", () => {
  let sequence = 0;
  const plan = createDefaultDirectorPlan({
    sourceAssetId: "asset-1",
    now: "2026-09-04T00:00:00.000Z",
    createId: (prefix) => `${prefix}-${++sequence}`,
  });

  assert.equal(plan.cameraRig.id, "camera-rig-1");
  assert.equal(plan.sourceAssetId, "asset-1");
  assert.equal(plan.updatedAt, "2026-09-04T00:00:00.000Z");
  assert.deepEqual(plan.shots, []);
  assert.equal(ensureDirectorPlan(plan), plan);

  const copy = cloneDirectorPlan(plan);
  assert.deepEqual(copy, plan);
  assert.notEqual(copy, plan);
  assert.notEqual(copy.cameraRig, plan.cameraRig);
});

test("pointer normalization ignores letterboxing and clamps exact edges", () => {
  const bounds = { left: 100, top: 50, width: 800, height: 450 };
  assert.deepEqual(normalizePointToContent({ x: 500, y: 275 }, bounds), { x: 0.5, y: 0.5 });
  assert.deepEqual(normalizePointToContent({ x: 900, y: 500 }, bounds), { x: 1, y: 1 });
  assert.equal(normalizePointToContent({ x: 99, y: 275 }, bounds), null);
  assert.equal(normalizePointToContent({ x: 500, y: 501 }, bounds), null);
  assert.equal(normalizePointToContent({ x: Number.NaN, y: 275 }, bounds), null);
});

test("RDP simplification and arc-length resampling preserve path geometry", () => {
  const denseLine = Array.from({ length: 200 }, (_, index) => ({
    x: index / 199,
    y: 0.5 + Math.sin(index) * 0.00001,
  }));
  const simplified = simplifyDirectorPath(denseLine, 0.001);
  assert.equal(simplified.length, 2);
  assert.deepEqual(simplified[0], { x: 0, y: 0.5 });
  assert.equal(simplified[1].x, 1);

  const corner = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  assert.deepEqual(resampleDirectorPath(corner, 5), [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 0.5 },
    { x: 1, y: 1 },
  ]);
  assert.deepEqual(sampleDirectorPath(corner, 0.25), { x: 0.5, y: 0 });
});

test("easing and animatic sampling return renderer-ready transforms", () => {
  assert.equal(applyDirectorEasing(0.5, "linear"), 0.5);
  assert.equal(applyDirectorEasing(0.5, "ease_in"), 0.25);
  assert.equal(applyDirectorEasing(0.5, "ease_out"), 0.75);
  assert.equal(applyDirectorEasing(0.25, "ease_in_out"), 0.125);

  const plan = goldenPlan();
  const preview = sampleDirectorAnimatic(plan, 2.5);
  assert.ok(preview);
  assert.equal(preview.normalizedTime, 0.5);
  assert.equal(preview.cameraTransform.scale, 1.12);
  assert.equal(preview.subjects[0].transform.translateX, 0.4);
  assert.deepEqual(preview.keyframes.map((marker) => marker.timeSeconds), [0, 5]);

  const accelerated = sampleDirectorAnimatic({
    ...plan,
    shots: plan.shots.map((shot) => ({ ...shot, speed: "speed_up" as const })),
  }, 1.25);
  assert.equal(accelerated?.normalizedTime, 0.0625);
  const slowed = sampleDirectorAnimatic({
    ...plan,
    shots: plan.shots.map((shot) => ({ ...shot, speed: "slow_motion" as const })),
  }, 1.25);
  assert.ok(slowed && slowed.normalizedTime < 0.25);
});

test("camera preview stacks at most the supplied deterministic transforms", () => {
  const motions: DirectorMotion[] = [
    {
      id: "pan",
      targetType: "camera",
      kind: "pan",
      direction: "left",
      intensity: 1,
      start: 0,
      end: 1,
      easing: "linear",
      order: 1,
    },
    {
      id: "roll",
      targetType: "camera",
      kind: "roll",
      direction: "right",
      intensity: 0.5,
      start: 0,
      end: 1,
      easing: "linear",
      order: 2,
    },
  ];
  assert.deepEqual(computeCameraPreviewTransform(motions, 1), {
    translateX: 0.12,
    translateY: 0,
    scale: 1,
    rotateDegrees: 6,
    opacity: 1,
  });
});

test("camera path translation moves the canvas opposite the camera trajectory", () => {
  const motion: DirectorMotion = {
    id: "camera-path",
    targetType: "camera",
    kind: "translate",
    path: [{ x: 0.2, y: 0.4 }, { x: 0.8, y: 0.6 }],
    intensity: 1,
    start: 0,
    end: 1,
    easing: "linear",
    order: 1,
  };
  const transform = computeCameraPreviewTransform([motion], 1);
  assert.ok(Math.abs(transform.translateX + 0.6) < 1e-12);
  assert.ok(Math.abs(transform.translateY + 0.2) < 1e-12);
});

test("valid plans pass hard limits and explicit asset checks", () => {
  const result = validateDirectorPlan(goldenPlan(), {
    availableAssetIds: new Set(["asset-source", "asset-first", "asset-last"]),
    maxKeyframes: 2,
    maxDurationSeconds: 5,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test("asset availability is checked only from an explicit caller snapshot", () => {
  const unchecked = validateDirectorPlan(goldenPlan());
  assert.equal(unchecked.errors.some((issue) => issue.code === DIRECTOR_VALIDATION_CODES.missingAsset), false);

  const checked = validateDirectorPlan(goldenPlan(), { availableAssetIds: ["asset-source"] });
  assert.equal(checked.valid, false);
  assert.equal(
    checked.errors.filter((issue) => issue.code === DIRECTOR_VALIDATION_CODES.missingAsset).length,
    2,
  );
  assert.match(
    checked.errors.find((issue) => issue.code === DIRECTOR_VALIDATION_CODES.missingAsset)?.message ?? "",
    /relinked/,
  );
});

test("validation reports stable codes for static conflicts and provider duration limits", () => {
  const plan = goldenPlan();
  plan.motions.push({
    id: "motion-static",
    targetType: "camera",
    kind: "static",
    intensity: 0,
    start: 0.25,
    end: 0.75,
    easing: "linear",
    order: 2,
  });
  plan.shots[0].motionIds = ["motion-camera", "motion-static"];

  const result = validateDirectorPlan(plan, { maxDurationSeconds: 4 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((issue) => issue.code === DIRECTOR_VALIDATION_CODES.staticCameraConflict));
  assert.ok(result.errors.some((issue) => issue.code === DIRECTOR_VALIDATION_CODES.totalDurationLimit));
});

test("validation warns about overlapping opposing camera directions in one Motion Stack", () => {
  const plan = createDefaultDirectorPlan({ sourceAssetId: "source", now: "2026-09-04T00:00:00.000Z" });
  plan.motions = [
    { id: "pan-left", targetType: "camera", kind: "pan", direction: "left", intensity: 0.5, start: 0, end: 0.8, easing: "linear", order: 1 },
    { id: "pan-right", targetType: "camera", kind: "pan", direction: "right", intensity: 0.5, start: 0.2, end: 1, easing: "linear", order: 2 },
  ];
  plan.shots = [{ ...createDefaultDirectorShot(), motionIds: ["pan-left", "pan-right"] }];

  const result = validateDirectorPlan(plan, { availableAssetIds: ["source"] });

  assert.ok(result.warnings.some((issue) => issue.code === DIRECTOR_VALIDATION_CODES.opposingCameraConflict));
});

test("validation enforces fidelity-addressable IDs, path count, keyframe roles, and plan size", () => {
  const plan = goldenPlan();
  plan.cameraRig.id = "subject-1";
  plan.motions[0].path = Array.from({ length: 129 }, (_, index) => ({ x: index / 128, y: 0.5 }));
  plan.keyframes.push({ id: "key-first-2", assetId: "different-first", role: "first", time: 0 });
  plan.shots[0].keyframeIds.push("key-first-2");

  const result = validateDirectorPlan(plan, { maxSerializedBytes: 1 });
  const codes = new Set(result.errors.map((issue) => issue.code));
  assert.ok(codes.has(DIRECTOR_VALIDATION_CODES.duplicateId));
  assert.ok(codes.has(DIRECTOR_VALIDATION_CODES.pathPointLimit));
  assert.ok(codes.has(DIRECTOR_VALIDATION_CODES.keyframeRoleConflict));
  assert.ok(codes.has(DIRECTOR_VALIDATION_CODES.planTooLarge));
});

test("first and last frame role conflicts are global across shots", () => {
  const plan = goldenPlan();
  plan.keyframes.push({ id: "other-first", assetId: "asset-other", role: "first", time: 0 });
  plan.shots.push({
    id: "shot-2",
    order: 2,
    durationSeconds: 2,
    promptFragment: "",
    motionIds: [],
    keyframeIds: ["other-first"],
    speed: "linear",
  });

  const result = validateDirectorPlan(plan);
  assert.ok(result.errors.some((issue) => issue.code === DIRECTOR_VALIDATION_CODES.keyframeRoleConflict));
});

test("a motion or keyframe cannot be assigned to multiple shots", () => {
  const plan = goldenPlan();
  plan.shots.push({
    id: "shot-2",
    order: 2,
    durationSeconds: 2,
    promptFragment: "Second shot",
    motionIds: ["motion-subject"],
    keyframeIds: ["key-last"],
    speed: "linear",
  });

  const result = validateDirectorPlan(plan);
  assert.equal(
    result.errors.filter((issue) => issue.code === DIRECTOR_VALIDATION_CODES.multipleShotAssignment).length,
    2,
  );
});

test("normalization clamps values without silently dropping controls", () => {
  const plan = goldenPlan();
  plan.subjects[0].region = { type: "box", x: 0.8, y: -0.2, width: 0.5, height: 0.6 };
  plan.motions[0].intensity = 2;
  plan.motions[0].start = 0.9;
  plan.motions[0].end = -0.2;
  plan.motions[0].path = [{ x: -1, y: 2 }, { x: 0.5, y: 0.5 }];
  plan.keyframes[0].time = 0.75;

  const normalized = normalizeDirectorPlan(plan);
  assert.deepEqual(normalized.subjects[0].region, {
    type: "box",
    x: 0.8,
    y: 0,
    width: 0.19999999999999996,
    height: 0.39999999999999997,
  });
  assert.equal(normalized.motions.length, plan.motions.length);
  assert.equal(normalized.motions[0].intensity, 1);
  assert.deepEqual(
    { start: normalized.motions[0].start, end: normalized.motions[0].end },
    { start: 0, end: 0.9 },
  );
  assert.deepEqual(normalized.motions[0].path?.[0], { x: 0, y: 1 });
  assert.equal(normalized.keyframes[0].time, 0);
});
