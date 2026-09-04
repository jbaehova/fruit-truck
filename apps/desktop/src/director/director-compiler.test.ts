import assert from "node:assert/strict";
import test from "node:test";
import { compileDirectorPlan } from "./compiler.ts";
import { GOLDEN_DIRECTOR_PLAN } from "./golden-fixture.ts";
import type { DirectorCapability, DirectorPlan } from "./types.ts";

function capability(overrides: Partial<DirectorCapability> = {}): DirectorCapability {
  return {
    cameraParameters: new Set(),
    supportsFirstFrame: false,
    supportsLastFrame: false,
    maxKeyframes: 0,
    supportsTimestampedKeyframes: false,
    supportsMultiShot: false,
    supportsVisualInstruction: false,
    supportsNativeTrajectory: false,
    allowedPassthroughParameters: new Set(),
    ...overrides,
  };
}

function plan(overrides: Partial<DirectorPlan> = {}): DirectorPlan {
  return {
    schemaVersion: 1,
    enabled: true,
    sourceAssetId: "source",
    cameraRig: {
      id: "rig",
      sensorPreset: "cinema",
      lensPreset: "anamorphic",
      focalLengthMm: 50,
      aperture: 2.8,
      aspectRatio: "16:9",
    },
    subjects: [{
      id: "fruit",
      label: "fruit crate",
      sourceAssetId: "source",
      region: { type: "box", x: 0.1, y: 0.2, width: 0.2, height: 0.25 },
    }],
    motions: [{
      id: "motion-1",
      targetType: "subject",
      targetId: "fruit",
      kind: "translate",
      path: [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.1 }, { x: 0.8, y: 0.7 }],
      intensity: 0.8,
      start: 0,
      end: 1,
      easing: "ease_in_out",
      order: 1,
      actionLabel: "sweep right",
    }],
    keyframes: [
      { id: "first", assetId: "first-asset", role: "first", time: 0 },
      { id: "last", assetId: "last-asset", role: "last", time: 1 },
    ],
    shots: [{
      id: "shot-1",
      order: 1,
      durationSeconds: 4,
      promptFragment: "Reveal the fruit truck.",
      motionIds: ["motion-1"],
      keyframeIds: ["first", "last"],
      speed: "linear",
    }],
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

test("native structured controls, keyframes, and shots compile without prompt duplication", () => {
  const nativePlan = plan({
    motions: [{
      id: "motion-1",
      targetType: "camera",
      kind: "dolly",
      direction: "in",
      intensity: 0.8,
      start: 0,
      end: 1,
      easing: "ease_in_out",
      order: 1,
      actionLabel: "dolly in",
    }],
  });
  const result = compileDirectorPlan({
    plan: nativePlan,
    capability: capability({
      cameraParameters: new Set(["focal_length_mm", "camera_motion"]),
      allowedPassthroughParameters: new Set(["aperture", "aspect_ratio"]),
      parameterDescriptors: {
        focal_length_mm: { type: "range", min: 12, max: 300 },
        camera_motion: { type: "enum", values: ["dolly_in"] },
      },
      supportsFirstFrame: true,
      supportsLastFrame: true,
      maxKeyframes: 2,
      supportsMultiShot: true,
      multiShotContract: { parameter: "shots", shape: "array" },
    }),
    availableAssetIds: ["source", "first-asset", "last-asset"],
    durationSeconds: 4,
  });

  assert.equal(result.canGenerate, true);
  assert.equal(result.validation.valid, true);
  assert.equal(result.fidelityByControlId["motion-1"], "native");
  assert.equal(result.fidelityByControlId.first, "keyframe");
  assert.equal(result.fidelityByControlId.last, "keyframe");
  assert.equal(result.fidelityByControlId["shot-1"], "native");
  assert.equal(result.providerOptions.focal_length_mm, 50);
  assert.equal(result.providerOptions.aperture, 2.8);
  assert.equal(result.providerOptions.aspect_ratio, "16:9");
  assert.equal(result.providerOptions.camera_motion, "dolly_in");
  assert.equal(Array.isArray(result.providerOptions.shots), true);
  assert.deepEqual(result.frameBindings, [
    { assetId: "first-asset", role: "first_frame" },
    { assetId: "last-asset", role: "last_frame" },
  ]);
  assert.doesNotMatch(result.promptBrief, /sweep right/i);
});

test("golden three-shot plan preserves the complete fallback contract", () => {
  const result = compileDirectorPlan({
    plan: structuredClone(GOLDEN_DIRECTOR_PLAN),
    capability: capability({ supportsFirstFrame: true, supportsLastFrame: true, maxKeyframes: 2 }),
    availableAssetIds: ["golden-first", "golden-last"],
    durationSeconds: 6,
  });

  assert.equal(result.canGenerate, true);
  assert.deepEqual(result.frameBindings, [
    { assetId: "golden-first", role: "first_frame" },
    { assetId: "golden-last", role: "last_frame" },
  ]);
  assert.deepEqual(result.visualInstructions, []);
  assert.equal(result.fidelityByControlId["golden-curve"], "prompt");
  assert.equal(result.fidelityByControlId["golden-dolly"], "prompt");
  assert.equal(result.fidelityByControlId["golden-orbit"], "prompt");
  assert.equal(result.fidelityByControlId["golden-key-first"], "keyframe");
  assert.equal(result.fidelityByControlId["golden-key-last"], "keyframe");
  assert.match(result.promptBrief, /Follow the normalized screen path/i);
  assert.match(result.promptBrief, /Shot 2 camera motions overlap/i);
  assert.match(result.promptBrief, /Shot 3 \(2s, speed up\)/i);
  assert.match(result.warnings.join(" "), /native multi-shot support is not proven/i);
});

test("visual trajectory fallback keeps the original asset separate from its SVG overlay", () => {
  const result = compileDirectorPlan({
    plan: plan({ keyframes: [] }),
    capability: capability({ supportsVisualInstruction: true }),
    availableAssetIds: ["source"],
    durationSeconds: 4,
  });

  assert.equal(result.fidelityByControlId["motion-1"], "visual");
  assert.equal(result.fidelityByControlId.fruit, "visual");
  assert.equal(result.visualInstructions.length, 1);
  assert.equal(result.visualInstructions[0]?.sourceAssetId, "source");
  assert.match(result.visualInstructions[0]?.overlay ?? "", /^<svg/);
  assert.match(result.promptBrief, /attached Director guide paired with its original source image/i);
  assert.match(result.visualInstructions[0]?.overlay ?? "", /polyline/);
  assert.doesNotMatch(result.visualInstructions[0]?.overlay ?? "", /data:image/);
});

test("timestamped keyframes emit an explicit start, middle, and end path anchor plan", () => {
  const anchoredPlan = plan({
    keyframes: [
      { id: "first", assetId: "first-asset", role: "first", time: 0 },
      { id: "middle", assetId: "middle-asset", role: "middle", time: 0.5 },
      { id: "last", assetId: "last-asset", role: "last", time: 1 },
    ],
    shots: [{ ...plan().shots[0]!, keyframeIds: ["first", "middle", "last"] }],
  });
  const result = compileDirectorPlan({
    plan: anchoredPlan,
    capability: capability({
      supportsFirstFrame: true,
      supportsLastFrame: true,
      supportsTimestampedKeyframes: true,
      maxKeyframes: 3,
    }),
    availableAssetIds: ["source", "first-asset", "middle-asset", "last-asset"],
    durationSeconds: 4,
  });

  assert.equal(result.fidelityByControlId["motion-1"], "keyframe");
  assert.match(result.promptBrief, /keyframe path anchor plan/i);
  assert.match(result.promptBrief, /start frame first at 0\.00s maps to \(0\.20, 0\.30\)/i);
  assert.match(result.promptBrief, /middle frame middle at 2\.00s maps to \(0\.57, 0\.24\)/i);
  assert.match(result.promptBrief, /end frame last at 4\.00s maps to \(0\.80, 0\.70\)/i);
});

test("a path without a middle frame does not claim keyframe fidelity", () => {
  const result = compileDirectorPlan({
    plan: plan(),
    capability: capability({
      supportsFirstFrame: true,
      supportsLastFrame: true,
      supportsTimestampedKeyframes: true,
      maxKeyframes: 3,
    }),
    availableAssetIds: ["source", "first-asset", "last-asset"],
    durationSeconds: 4,
  });

  assert.equal(result.fidelityByControlId["motion-1"], "prompt");
  assert.doesNotMatch(result.promptBrief, /keyframe path anchor plan/i);
});

test("visual guides for separate shots remain separate even when they share a source", () => {
  const secondMotion = { ...plan().motions[0]!, id: "motion-2", order: 1 as const, actionLabel: "return left" };
  const multiShotPlan = plan({
    keyframes: [],
    motions: [plan().motions[0]!, secondMotion],
    shots: [
      { id: "shot-1", order: 1, durationSeconds: 2, promptFragment: "Outbound", motionIds: ["motion-1"], keyframeIds: [], speed: "linear" },
      { id: "shot-2", order: 2, durationSeconds: 2, promptFragment: "Return", motionIds: ["motion-2"], keyframeIds: [], speed: "linear" },
    ],
  });
  const result = compileDirectorPlan({
    plan: multiShotPlan,
    capability: capability({ supportsVisualInstruction: true }),
    availableAssetIds: ["source"],
    durationSeconds: 4,
  });

  assert.equal(result.visualInstructions.length, 2);
  assert.match(result.visualInstructions[0]!.overlay, /Shot 1/);
  assert.match(result.visualInstructions[1]!.overlay, /Shot 2/);
});

test("partially overlapping prompt camera moves are described as simultaneous and structured conflicts are resolved", () => {
  const cameraPlan = plan({
    subjects: [],
    keyframes: [],
    motions: [
      {
        id: "dolly",
        targetType: "camera",
        kind: "dolly",
        direction: "in",
        intensity: 0.7,
        start: 0,
        end: 0.8,
        easing: "ease_in",
        order: 1,
      },
      {
        id: "orbit",
        targetType: "camera",
        kind: "orbit",
        direction: "left",
        intensity: 0.5,
        start: 0.4,
        end: 1,
        easing: "linear",
        order: 2,
      },
    ],
    shots: [
      { id: "shot-1", order: 1, durationSeconds: 2, promptFragment: "Opening", motionIds: ["dolly", "orbit"], keyframeIds: [], speed: "linear" },
      { id: "shot-2", order: 2, durationSeconds: 2, promptFragment: "Detail", motionIds: [], keyframeIds: [], speed: "slow_motion" },
      { id: "shot-3", order: 3, durationSeconds: 2, promptFragment: "Finish", motionIds: [], keyframeIds: [], speed: "speed_up" },
    ],
  });
  const result = compileDirectorPlan({
    plan: cameraPlan,
    capability: capability(),
    availableAssetIds: ["source"],
    durationSeconds: 6,
    basePrompt: "A static camera watches the truck.",
  });

  assert.equal(result.fidelityByControlId.dolly, "prompt");
  assert.equal(result.fidelityByControlId.orbit, "prompt");
  assert.match(result.promptBrief, /overlap from 40% to 80%/i);
  assert.match(result.promptBrief, /simultaneously/i);
  assert.match(result.promptBrief, /ignore static-camera wording/i);
  assert.match(result.promptBrief, /Shot 1/);
  assert.match(result.warnings.join(" "), /Hard warning/i);
  assert.match(result.warnings.join(" "), /takes precedence/i);
});

test("a boolean trajectory toggle never receives an invented path object", () => {
  const result = compileDirectorPlan({
    plan: plan({ keyframes: [] }),
    capability: capability({
      supportsNativeTrajectory: true,
      supportsVisualInstruction: true,
      allowedPassthroughParameters: new Set(["trajectory"]),
      parameterDescriptors: { trajectory: { type: "boolean" } },
    }),
    availableAssetIds: ["source"],
    durationSeconds: 4,
  });

  assert.equal(result.providerOptions.trajectory, undefined);
  assert.equal(result.fidelityByControlId["motion-1"], "visual");
  assert.match(result.warnings.join(" "), /no structured path payload contract/i);
});

test("overlapping camera moves in separate shots stay independent", () => {
  const cameraPlan = plan({
    keyframes: [],
    motions: [
      {
        id: "shot-one-pan",
        targetType: "camera",
        kind: "pan",
        direction: "left",
        intensity: 0.5,
        start: 0,
        end: 1,
        easing: "linear",
        order: 1,
      },
      {
        id: "shot-two-dolly",
        targetType: "camera",
        kind: "dolly",
        direction: "in",
        intensity: 0.7,
        start: 0,
        end: 1,
        easing: "ease_in_out",
        order: 1,
      },
    ],
    shots: [
      { id: "shot-1", order: 1, durationSeconds: 2, promptFragment: "Opening", motionIds: ["shot-one-pan"], keyframeIds: [], speed: "linear" },
      { id: "shot-2", order: 2, durationSeconds: 2, promptFragment: "Detail", motionIds: ["shot-two-dolly"], keyframeIds: [], speed: "linear" },
    ],
  });
  const result = compileDirectorPlan({
    plan: cameraPlan,
    capability: capability(),
    availableAssetIds: ["source"],
    durationSeconds: 4,
  });

  assert.doesNotMatch(result.promptBrief, /simultaneously/i);
  assert.match(result.promptBrief, /Shot 1 Camera action 1: pan left/i);
  assert.match(result.promptBrief, /Shot 2 Camera action 1: dolly in/i);
});

test("camera direction and rig conflicts are explicitly resolved", () => {
  const conflictPlan = plan({
    keyframes: [],
    motions: [{
      id: "pan-left",
      targetType: "camera",
      kind: "pan",
      direction: "left",
      intensity: 0.6,
      start: 0,
      end: 1,
      easing: "linear",
      order: 1,
    }],
    shots: [{ id: "shot-1", order: 1, durationSeconds: 4, promptFragment: "Opening", motionIds: ["pan-left"], keyframeIds: [], speed: "linear" }],
  });
  const result = compileDirectorPlan({
    plan: conflictPlan,
    capability: capability(),
    availableAssetIds: ["source"],
    durationSeconds: 4,
    basePrompt: "카메라는 고정하고 팬 오른쪽으로 촬영한다. Use an 85mm lens at f/1.4.",
  });

  assert.match(result.warnings.join(" "), /static camera/i);
  assert.match(result.warnings.join(" "), /pan right/i);
  assert.match(result.warnings.join(" "), /focal length/i);
  assert.match(result.warnings.join(" "), /aperture/i);
  assert.match(result.promptBrief, /use pan left/i);
  assert.match(result.promptBrief, /50mm/i);
  assert.match(result.promptBrief, /f\/2.8/i);
});

test("shot prompt conflicts are resolved with the selected model vocabulary", () => {
  const conflictPlan = plan({
    keyframes: [],
    motions: [{
      id: "pan-left",
      targetType: "camera",
      kind: "pan",
      direction: "left",
      intensity: 0.6,
      start: 0,
      end: 1,
      easing: "linear",
      order: 1,
    }],
    shots: [{
      id: "shot-1",
      order: 1,
      durationSeconds: 4,
      promptFragment: "Pan right with an 85mm lens at f/1.4.",
      motionIds: ["pan-left"],
      keyframeIds: [],
      speed: "linear",
    }],
  });
  const result = compileDirectorPlan({
    plan: conflictPlan,
    capability: capability(),
    availableAssetIds: ["source"],
    durationSeconds: 4,
    promptProfileId: "runway-video-v1",
  });

  assert.match(result.promptBrief, /Camera movement action 1/i);
  assert.match(result.warnings.join(" "), /Shot 1 prompt requests pan right/i);
  assert.match(result.warnings.join(" "), /Shot 1 prompt names a focal length/i);
  assert.match(result.warnings.join(" "), /Shot 1 prompt names an aperture/i);
});

test("orphaned motions and keyframes remain stored but do not affect the request", () => {
  const orphanPlan = plan({
    shots: [{ id: "shot-1", order: 1, durationSeconds: 4, promptFragment: "Opening", motionIds: [], keyframeIds: [], speed: "linear" }],
  });
  const result = compileDirectorPlan({
    plan: orphanPlan,
    capability: capability({ supportsFirstFrame: true, supportsLastFrame: true, maxKeyframes: 2 }),
    availableAssetIds: ["source", "first-asset", "last-asset"],
    durationSeconds: 4,
  });

  assert.equal(result.fidelityByControlId["motion-1"], "unsupported");
  assert.equal(result.fidelityByControlId.first, "unsupported");
  assert.equal(result.fidelityByControlId.last, "unsupported");
  assert.deepEqual(result.frameBindings, []);
  assert.doesNotMatch(result.promptBrief, /sweep right/i);
  assert.match(result.warnings.join(" "), /not assigned to a shot/i);
});

test("frame images do not consume general Visual reference capacity", () => {
  const result = compileDirectorPlan({
    plan: plan({ keyframes: [] }),
    capability: capability({ supportsVisualInstruction: true }),
    availableAssetIds: ["source"],
    durationSeconds: 4,
    existingFrameBindings: [
      { assetId: "source", role: "first_frame" },
      { assetId: "last-asset", role: "last_frame" },
    ],
    maxInputReferences: 1,
    allowMixedFrameAndReferences: true,
  });

  assert.equal(result.fidelityByControlId["motion-1"], "visual");
  assert.equal(result.visualInstructions.length, 1);
});

test("visual fidelity falls back to prompt when general references fill route capacity", () => {
  const result = compileDirectorPlan({
    plan: plan({ keyframes: [] }),
    capability: capability({ supportsVisualInstruction: true }),
    availableAssetIds: ["source", "reference-a", "reference-b"],
    durationSeconds: 4,
    existingFrameBindings: [
      { assetId: "source", role: "first_frame" },
      { assetId: "reference-a", role: "reference" },
      { assetId: "reference-b", role: "reference" },
    ],
    maxInputReferences: 2,
    allowMixedFrameAndReferences: true,
  });

  assert.equal(result.fidelityByControlId["motion-1"], "prompt");
  assert.equal(result.visualInstructions.length, 0);
  assert.match(result.warnings.join(" "), /attachment capacity/i);
});

test("visual fidelity only combines with frame roles when the route contract allows it", () => {
  const visualCapability = capability({ supportsVisualInstruction: true });
  const input = {
    plan: plan({ keyframes: [] }),
    capability: visualCapability,
    availableAssetIds: ["source"],
    durationSeconds: 4,
    existingFrameBindings: [{ assetId: "source", role: "first_frame" }] as const,
    maxInputReferences: 4,
  };

  const incompatible = compileDirectorPlan(input);
  assert.equal(incompatible.fidelityByControlId["motion-1"], "prompt");
  assert.equal(incompatible.visualInstructions.length, 0);
  assert.match(incompatible.warnings.join(" "), /cannot be combined/i);

  const compatible = compileDirectorPlan({ ...input, allowMixedFrameAndReferences: true });
  assert.equal(compatible.fidelityByControlId["motion-1"], "visual");
  assert.equal(compatible.visualInstructions.length, 1);
});

test("selected duration is enforced even when the model maximum is longer", () => {
  const result = compileDirectorPlan({
    plan: plan({ shots: [{ ...plan().shots[0], durationSeconds: 8 }] }),
    capability: capability(),
    availableAssetIds: ["source", "first-asset", "last-asset"],
    durationSeconds: 5,
    maxDurationSeconds: 10,
  });

  assert.equal(result.canGenerate, false);
  assert.ok(result.blockingIssues.some((issue) => issue.code === "director.shot.total_duration_limit"));
});

test("multi-shot support without an exact field contract falls back to prompt", () => {
  const result = compileDirectorPlan({
    plan: plan(),
    capability: capability({ supportsMultiShot: true }),
    availableAssetIds: ["source", "first-asset", "last-asset"],
    durationSeconds: 4,
  });

  assert.equal(result.providerOptions.shots, undefined);
  assert.equal(result.fidelityByControlId["shot-1"], "prompt");
});

test("prompt motion fallback includes target, path, timing, order, intensity, and easing", () => {
  const result = compileDirectorPlan({
    plan: plan({ keyframes: [] }),
    capability: capability(),
    availableAssetIds: ["source"],
    durationSeconds: 4,
  });

  assert.equal(result.fidelityByControlId["motion-1"], "prompt");
  assert.match(result.promptBrief, /Subject fruit crate action 1/);
  assert.match(result.promptBrief, /0% to 100%/);
  assert.match(result.promptBrief, /intensity 0.8/);
  assert.match(result.promptBrief, /ease in out/);
  assert.match(result.promptBrief, /\(0\.20, 0\.30\).*\(0\.80, 0\.70\)/);
});

test("frame bindings are deduplicated and unsupported keyframes remain visible", () => {
  const duplicateFirstPlan = plan({
    keyframes: [
      { id: "first-a", assetId: "first-asset", role: "first", time: 0 },
      { id: "first-b", assetId: "first-asset", role: "first", time: 0 },
      { id: "last", assetId: "last-asset", role: "last", time: 1 },
    ],
    shots: [{
      id: "shot-1",
      order: 1,
      durationSeconds: 4,
      promptFragment: "Reveal",
      motionIds: ["motion-1"],
      keyframeIds: ["first-a", "first-b", "last"],
      speed: "linear",
    }],
  });
  const result = compileDirectorPlan({
    plan: duplicateFirstPlan,
    capability: capability({ supportsFirstFrame: true, maxKeyframes: 2 }),
    availableAssetIds: ["source", "first-asset", "last-asset"],
    durationSeconds: 4,
  });

  assert.deepEqual(result.frameBindings, [{ assetId: "first-asset", role: "first_frame" }]);
  assert.equal(result.fidelityByControlId["first-a"], "keyframe");
  assert.equal(result.fidelityByControlId["first-b"], "keyframe");
  assert.equal(result.fidelityByControlId.last, "unsupported");
  assert.match(result.warnings.join(" "), /last.*unsupported/i);
});

test("asset and duration validation errors remain visible and block generation", () => {
  const result = compileDirectorPlan({
    plan: plan(),
    capability: capability({ supportsFirstFrame: true, supportsLastFrame: true, maxKeyframes: 2 }),
    availableAssetIds: ["source", "first-asset"],
    durationSeconds: 3,
  });

  assert.equal(result.canGenerate, false);
  assert.equal(result.validation.valid, false);
  assert.ok(result.blockingIssues.some((issue) => issue.code === "director.asset.missing"));
  assert.ok(result.blockingIssues.some((issue) => issue.code === "director.shot.total_duration_limit"));
});

test("disabled plans return stable unsupported fidelity without blocking the base request", () => {
  const disabled = plan({ enabled: false });
  const result = compileDirectorPlan({ plan: disabled, capability: capability() });

  assert.equal(result.canGenerate, true);
  assert.equal(result.fidelityByControlId.rig, "unsupported");
  assert.equal(result.fidelityByControlId["motion-1"], "unsupported");
  assert.deepEqual(result.providerOptions, {});
  assert.equal(result.promptBrief, "");
});
