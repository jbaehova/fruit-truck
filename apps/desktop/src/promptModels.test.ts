import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROMPT_MODEL,
  PROMPT_MODELS,
  migrateLegacyPromptModel,
  promptModelDefinition,
} from "./promptModels.ts";

test("prompt planner registry contains exactly the Phase 2 models at high effort", () => {
  assert.deepEqual(PROMPT_MODELS.map(({ id, label, reasoningEffort }) => ({ id, label, reasoningEffort })), [
    { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", reasoningEffort: "high" },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", reasoningEffort: "high" },
    { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoningEffort: "high" },
  ]);
  assert.equal(DEFAULT_PROMPT_MODEL, "google/gemini-3.8-flash");
  assert.equal(promptModelDefinition("openai/gpt-5.6-sol").reasoningEffort, "high");
});

test("legacy and unknown planner models migrate to Gemini without changing valid models", () => {
  assert.equal(migrateLegacyPromptModel("openai/gpt-5.6-luna"), DEFAULT_PROMPT_MODEL);
  assert.equal(migrateLegacyPromptModel("openai/gpt-5.6-terra"), DEFAULT_PROMPT_MODEL);
  assert.equal(migrateLegacyPromptModel("anthropic/claude-opus-5"), "anthropic/claude-opus-5");
});
