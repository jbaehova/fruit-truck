import test from "node:test";
import assert from "node:assert/strict";
import { composeEditPrompt } from "./mask.ts";

test("masked edit prompts use explicit, separated semantics", () => {
  const prompt = composeEditPrompt({
    prompt: "Turn the selected panel blue.",
    target: "#2",
    hasMask: true,
    maskInstructions: "Keep the embossed logo.",
  });

  assert.match(prompt, /^\[EDIT TASK\]\nTarget image: #2/);
  assert.match(prompt, /\[MASK SEMANTICS\]\nTransparent pixels in #2 are the editable mask\./);
  assert.match(prompt, /\[MASK INSTRUCTIONS\]\nKeep the embossed logo\./);
  assert.match(prompt, /\[USER PROMPT\]\nTurn the selected panel blue\.$/);
  assert.doesNotMatch(prompt, /red overlay/i);
});

test("unmasked image edits do not invent mask instructions", () => {
  const prompt = composeEditPrompt({
    prompt: "Make it cinematic.",
    target: "#1",
    hasMask: false,
    maskInstructions: "",
  });

  assert.doesNotMatch(prompt, /MASK SEMANTICS/);
  assert.match(prompt, /\[USER PROMPT\]\nMake it cinematic\.$/);
});
