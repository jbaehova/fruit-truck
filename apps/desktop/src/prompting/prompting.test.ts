import assert from "node:assert/strict";
import test from "node:test";
import {
  PROMPT_PLAN_RESPONSE_FORMAT,
  compilePromptPlan,
  parsePromptPlan,
  profileInstruction,
  promptEnhancementSignature,
  promptProfileForModel,
  resolvePromptWorkflow,
  validateCompiledPrompt,
} from "./index.ts";
import type {
  PromptPlan,
  PromptReferenceInput,
  PromptTarget,
} from "./types.ts";

function reference(
  slot: number,
  overrides: Partial<PromptReferenceInput> = {},
): PromptReferenceInput {
  return {
    slot,
    name: `reference-${slot}.png`,
    mediaType: "image/png",
    role: "reference",
    purpose: "subject_identity",
    ...overrides,
  };
}

function plan(overrides: Partial<PromptPlan> = {}): PromptPlan {
  return {
    version: 1,
    mode: "image",
    workflow: "text_to_image",
    language: "en",
    deliverable: "a polished product image",
    intent: "show the product clearly",
    scene: ["a quiet studio"],
    subjects: ["a red apple"],
    action: ["rests on a table"],
    composition: ["centered medium shot"],
    camera: ["eye level"],
    lighting: ["softbox lighting"],
    color: ["warm red"],
    style: ["clean commercial"],
    materials: ["smooth skin"],
    exactText: [],
    temporalBeats: [],
    subjectMotion: [],
    cameraMotion: [],
    audio: [],
    editChanges: [],
    preserve: ["the product identity"],
    ambiguities: [],
    constraints: [{ requirement: "no extra logos", desiredState: "only the requested logo is visible" }],
    references: [],
    ...overrides,
  };
}

function target(overrides: Partial<PromptTarget> = {}): PromptTarget {
  return {
    id: "runway/gen-4.5",
    name: "Runway Gen-4.5",
    options: { duration: 5, aspect_ratio: "16:9" },
    providerJson: '{"order":["default"]}',
    ...overrides,
  };
}

test("resolves image and video workflows from edit state and reference roles", () => {
  assert.equal(resolvePromptWorkflow({ mode: "image", references: [] }), "text_to_image");
  assert.equal(resolvePromptWorkflow({ mode: "image", references: [reference(1)] }), "text_to_image");
  assert.equal(resolvePromptWorkflow({ mode: "image", references: [reference(1), reference(2)] }), "multi_reference_compose");
  assert.equal(resolvePromptWorkflow({ mode: "image", editMode: true, references: [reference(1)] }), "image_edit");
  assert.equal(resolvePromptWorkflow({ mode: "image", editMode: true, hasMask: true, references: [reference(1)] }), "inpaint");

  assert.equal(resolvePromptWorkflow({ mode: "video", references: [] }), "text_to_video");
  assert.equal(resolvePromptWorkflow({
    mode: "video",
    references: [reference(1, { role: "first_frame", purpose: "first_frame" })],
  }), "image_to_video");
  assert.equal(resolvePromptWorkflow({
    mode: "video",
    references: [
      reference(1, { role: "first_frame", purpose: "first_frame" }),
      reference(2, { role: "last_frame", purpose: "last_frame" }),
    ],
  }), "first_last_frame");
  assert.equal(resolvePromptWorkflow({
    mode: "video",
    references: [reference(1, { mediaType: "audio/mpeg", purpose: "audio" })],
  }), "audio_visual_reference");
  assert.equal(resolvePromptWorkflow({
    mode: "video",
    references: [reference(1, { mediaType: "video/mp4", purpose: "motion" })],
  }), "video_to_video");
  assert.equal(resolvePromptWorkflow({ mode: "video", references: [reference(1)] }), "reference_to_video");
});

test("prompt enhancement signatures invalidate on target, options, and reference-purpose changes", () => {
  const baseInput = {
    plannerModel: "openai/gpt-5.6",
    promptVersion: "fruit-prompt-planner-v2.0.0",
    target: target(),
    workflow: "image_to_video" as const,
    prompt: "Animate @1 with a slow push-in.",
    references: [reference(1, { purpose: "subject_identity", fingerprint: "asset-fingerprint" })],
  };

  const base = promptEnhancementSignature(baseInput);
  assert.equal(base, promptEnhancementSignature({
    ...baseInput,
    target: target({ providerJson: '{"order":["default"]}' }),
  }));
  assert.notEqual(base, promptEnhancementSignature({
    ...baseInput,
    target: target({ id: "google/veo-3.1" }),
  }));
  assert.notEqual(base, promptEnhancementSignature({
    ...baseInput,
    target: target({ options: { duration: 8, aspect_ratio: "16:9" } }),
  }));
  assert.notEqual(base, promptEnhancementSignature({
    ...baseInput,
    references: [reference(1, { purpose: "style", fingerprint: "asset-fingerprint" })],
  }));
});

test("strict planner parsing accepts a complete plan and rejects malformed contracts", () => {
  const valid = plan({
    references: [{
      slot: 1,
      target: "the apple",
      purpose: "subject_identity",
      priority: "required",
      evidence: "user",
      copy: ["shape"],
      preserve: ["proportions"],
      ignore: ["background clutter"],
    }],
  });

  assert.deepEqual(parsePromptPlan(JSON.stringify(valid)), valid);
  assert.equal(PROMPT_PLAN_RESPONSE_FORMAT.json_schema.strict, true);
  assert.throws(() => parsePromptPlan("{"), /invalid JSON/);
  assert.throws(() => parsePromptPlan("[]"), /non-object plan/);
  assert.throws(() => parsePromptPlan(JSON.stringify({ ...valid, scene: "not an array" })), /field scene must be a string array/);
  assert.throws(() => parsePromptPlan(JSON.stringify({ ...valid, constraints: [{ requirement: "only one subject" }] })), /invalid constraint/);
  assert.throws(() => parsePromptPlan(JSON.stringify({
    ...valid,
    references: [{ ...valid.references[0], purpose: "invented-purpose" }],
  })), /invalid reference contract/);
});

test("model-specific profiles change compilation structure and constraint policy", () => {
  const references = [reference(1, { purpose: "product_identity" })];
  const sourcePlan = plan({
    references: [{
      slot: 1,
      target: "the product",
      purpose: "product_identity",
      priority: "required",
      evidence: "user",
      copy: ["label shape"],
      preserve: ["silhouette"],
      ignore: ["unrelated background details"],
    }],
    constraints: [{ requirement: "no extra logos", desiredState: "only the requested logo is visible" }],
  });

  const openAiProfile = promptProfileForModel("image", "openai/gpt-image-1");
  const openAi = compilePromptPlan({
    plan: sourcePlan,
    profile: openAiProfile,
    workflow: "text_to_image",
    references,
  });
  assert.equal(openAiProfile.id, "openai-gpt-image-v1");
  assert.equal(openAi.negativePrompt, undefined);
  assert.match(openAi.prompt, /Deliverable:/);
  assert.match(openAi.prompt, /no extra logos; only the requested logo is visible/);

  const googleProfile = promptProfileForModel("image", "google/gemini-2.5-flash-image");
  const google = compilePromptPlan({
    plan: sourcePlan,
    profile: googleProfile,
    workflow: "text_to_image",
    references,
  });
  assert.equal(googleProfile.id, "google-image-v1");
  assert.equal(google.negativePrompt, "no extra logos");
  assert.match(google.prompt, /only the requested logo is visible/);
  assert.doesNotMatch(google.prompt, /no extra logos/);

  const fluxProfile = promptProfileForModel("image", "black-forest-labs/flux-2-pro");
  const flux = compilePromptPlan({
    plan: sourcePlan,
    profile: fluxProfile,
    workflow: "text_to_image",
    references,
  });
  assert.equal(fluxProfile.id, "bfl-flux-image-v1");
  assert.equal(flux.negativePrompt, undefined);
  assert.match(flux.prompt, /only the requested logo is visible/);
  assert.doesNotMatch(flux.prompt, /no extra logos/);
});

test("compiler preserves deliberate ambiguity and gives reference priority executable meaning", () => {
  const references = [
    reference(1, { purpose: "product_identity" }),
    reference(2, { purpose: "style" }),
  ];
  const compiled = compilePromptPlan({
    plan: plan({
      ambiguities: ["the distant shape may be a hill or a cloud"],
      references: [
        {
          slot: 1,
          target: "the product",
          purpose: "product_identity",
          priority: "required",
          evidence: "user",
          copy: ["label geometry"],
          preserve: ["silhouette"],
          ignore: [],
        },
        {
          slot: 2,
          target: "the finish",
          purpose: "style",
          priority: "optional",
          evidence: "user",
          copy: ["surface texture"],
          preserve: [],
          ignore: [],
        },
      ],
    }),
    profile: promptProfileForModel("image", "openai/gpt-image-1"),
    workflow: "multi_reference_compose",
    references,
  });

  assert.match(compiled.prompt, /the distant shape may be a hill or a cloud/);
  assert.match(compiled.prompt, /@1 is required/);
  assert.match(compiled.prompt, /Optionally use @2/);
  assert.deepEqual(compiled.requiredSlots, [1]);
  assert.deepEqual(compiled.referencePriorities, { 1: "required", 2: "optional" });
  assert.equal(validateCompiledPrompt(compiled, references), null);
  assert.equal(validateCompiledPrompt({
    ...compiled,
    coveredSlots: [1],
    prompt: compiled.prompt.replace(/^.*@2.*\n?/m, ""),
  }, references), null);
});

test("compiler fills missing references and validation catches omitted or invented slots", () => {
  const references = [
    reference(1, { purpose: "product_identity" }),
    reference(2, { purpose: "style" }),
  ];
  const compiled = compilePromptPlan({
    plan: plan({
      references: [
        {
          slot: 1,
          target: "the product",
          purpose: "style",
          priority: "required",
          evidence: "role",
          copy: ["label geometry"],
          preserve: ["silhouette"],
          ignore: [],
        },
        {
          slot: 1,
          target: "duplicate contract",
          purpose: "style",
          priority: "required",
          evidence: "role",
          copy: ["duplicate"],
          preserve: [],
          ignore: [],
        },
        {
          slot: 9,
          target: "unavailable input",
          purpose: "context",
          priority: "required",
          evidence: "role",
          copy: ["invented"],
          preserve: [],
          ignore: [],
        },
      ],
    }),
    profile: promptProfileForModel("image", "openai/gpt-image-1"),
    workflow: "multi_reference_compose",
    references,
  });

  assert.deepEqual(compiled.coveredSlots, [1, 2]);
  assert.match(compiled.warnings.join("\n"), /invented unavailable reference @9/);
  assert.match(compiled.warnings.join("\n"), /duplicated reference @1/);
  assert.match(compiled.warnings.join("\n"), /omitted reference @2/);
  assert.match(compiled.prompt, /@1/);
  assert.match(compiled.prompt, /@2/);
  assert.doesNotMatch(compiled.prompt, /@9/);
  assert.equal(validateCompiledPrompt(compiled, references), null);

  assert.equal(
    validateCompiledPrompt({ ...compiled, coveredSlots: [1] }, references),
    "The compiled prompt does not cover required reference @2.",
  );
  assert.equal(
    validateCompiledPrompt({ ...compiled, prompt: compiled.prompt.replace("@2", "slot-2") }, references),
    "The compiled prompt does not bind required reference @2.",
  );
  assert.equal(
    validateCompiledPrompt({ ...compiled, prompt: `${compiled.prompt} @9` }, references),
    "The compiled prompt invented reference @9.",
  );
});

test("image-to-video compilation focuses on motion instead of restating the source frame", () => {
  const references = [reference(1, { role: "first_frame", purpose: "first_frame" })];
  const sourcePlan = plan({
    deliverable: "a five-second image-to-video shot",
    intent: "animate the supplied opening frame",
    scene: ["a moonlit studio with a red jacket"],
    subjects: ["a dancer in a red jacket"],
    style: ["cinematic grain"],
    lighting: ["blue moonlight"],
    color: ["deep blue"],
    action: ["the dancer turns toward camera"],
    subjectMotion: ["the fabric ripples in the breeze"],
    cameraMotion: ["a slow push-in"],
    temporalBeats: ["the dancer turns", "the camera settles on the final pose"],
    preserve: ["the source composition and identity"],
    references: [{
      slot: 1,
      target: "the opening frame",
      purpose: "first_frame",
      priority: "required",
      evidence: "role",
      copy: ["source appearance"],
      preserve: ["subject identity"],
      ignore: ["incidental background details"],
    }],
  });
  const runwayProfile = promptProfileForModel("video", "runway/gen-4.5");

  const motionFocused = compilePromptPlan({
    plan: sourcePlan,
    profile: runwayProfile,
    workflow: "image_to_video",
    references,
  });
  assert.equal(runwayProfile.motionFocusedImageToVideo, true);
  assert.match(motionFocused.prompt, /the dancer turns toward camera/);
  assert.match(motionFocused.prompt, /a slow push-in/);
  assert.match(motionFocused.prompt, /the camera settles on the final pose/);
  assert.doesNotMatch(motionFocused.prompt, /moonlit studio/);
  assert.doesNotMatch(motionFocused.prompt, /red jacket/);
  assert.match(profileInstruction(runwayProfile, "image_to_video"), /Do not spend the prompt budget re-describing static details/);

  const textToVideo = compilePromptPlan({
    plan: sourcePlan,
    profile: runwayProfile,
    workflow: "text_to_video",
    references,
  });
  assert.match(textToVideo.prompt, /moonlit studio/);
  assert.match(textToVideo.prompt, /red jacket/);
});
