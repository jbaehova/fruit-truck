import test from "node:test";
import assert from "node:assert/strict";
import { composeEditPrompt, hasGenerationInstructions, promptGuideDimensions } from "./mask.ts";

test("prompt mask guides are bounded without changing aspect ratio", () => {
  assert.deepEqual(promptGuideDimensions(4096, 2048), { width: 1536, height: 768 });
  assert.deepEqual(promptGuideDimensions(800, 600), { width: 800, height: 600 });
  assert.deepEqual(promptGuideDimensions(0, 600), { width: 0, height: 0 });
});

test("masked edit prompts use explicit, separated semantics", () => {
  const prompt = composeEditPrompt({
    prompt: "Turn the selected panel blue.",
    target: "@2",
    hasMask: true,
    maskInstructions: "Keep the embossed logo.",
  });

  assert.match(prompt, /^\[EDIT TASK\]\nTarget image: @2/);
  assert.match(prompt, /\[MASK SEMANTICS\]\nTransparent pixels in @2 are a coarse semantic selection cue/);
  assert.match(prompt, /Never create a new object that follows the brush-stroke silhouette/);
  assert.match(prompt, /do not absorb or regenerate adjacent or overlapping people, hands, fingers, limbs/);
  assert.match(prompt, /\[MASK INSTRUCTIONS\]\nKeep the embossed logo\./);
  assert.match(prompt, /\[USER PROMPT\]\nTurn the selected panel blue\./);
  assert.match(prompt, /\[PRESERVATION PRIORITY\]/);
  assert.match(prompt, /preserve the exact pose, finger count and placement, grasp angle, contact points, overlap, and occlusion/i);
  assert.match(prompt, /Do not invent new grip or contact geometry/);
  assert.doesNotMatch(prompt, /red overlay/i);
});

test("unmasked image edits do not invent mask instructions", () => {
  const prompt = composeEditPrompt({
    prompt: "Make it cinematic.",
    target: "@1",
    hasMask: false,
    maskInstructions: "",
  });

  assert.doesNotMatch(prompt, /MASK SEMANTICS/);
  assert.match(prompt, /\[USER PROMPT\]\nMake it cinematic\.$/);
});

test("mask instructions can be the sole edit instruction", () => {
  assert.equal(hasGenerationInstructions({
    prompt: "",
    hasMask: true,
    maskInstructions: "Turn the selected feathers black.",
  }), true);
  assert.equal(hasGenerationInstructions({ prompt: "", hasMask: true, maskInstructions: "  " }), false);
  assert.equal(hasGenerationInstructions({ prompt: "", hasMask: false, maskInstructions: "Change it." }), false);

  const prompt = composeEditPrompt({
    prompt: "",
    target: "@1",
    hasMask: true,
    maskInstructions: "Turn the selected feathers black.",
  });

  assert.match(prompt, /\[MASK INSTRUCTIONS\]\nTurn the selected feathers black\./);
  assert.match(prompt, /\[PRESERVATION PRIORITY\]/);
  assert.doesNotMatch(prompt, /\[USER PROMPT\]/);
});
