import assert from "node:assert/strict";
import test from "node:test";
import { generationPresetDiff } from "./generationPresets.ts";

test("generation preset diff reports model, option, and provider changes", () => {
  const preset = {
    id: "preset-1",
    name: "Portrait",
    mode: "image" as const,
    modelId: "example/new",
    options: { resolution: "2K", n: 2 },
    providerJson: "{\"only\":[\"example\"]}",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(generationPresetDiff(preset, {
    mode: "image",
    modelId: "example/old",
    options: { resolution: "1K", n: 2 },
    providerJson: "",
  }).map((entry) => entry.field), ["model", "resolution", "provider"]);
});
