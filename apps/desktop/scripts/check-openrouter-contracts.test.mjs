import assert from "node:assert/strict";
import test from "node:test";
import { validateFixtureContracts } from "./check-openrouter-contracts.mjs";

test("runtime-normalized OpenRouter fixtures cover multiple image and video provider families", () => {
  const result = validateFixtureContracts();
  assert.deepEqual(result.image, { models: 2, providers: 4 });
  assert.deepEqual(result.video, { models: 2, providers: 4 });
});
