import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultDirectorPlan } from "./defaults.ts";
import { directorDiagnosticSummary } from "./diagnostics.ts";

test("Director diagnostics report presence and fidelity without exposing asset IDs or paths", () => {
  const plan = createDefaultDirectorPlan({
    sourceAssetId: "private-source-id",
    now: "2026-09-04T00:00:00.000Z",
    createId: (prefix) => `${prefix}-id`,
  });
  plan.keyframes.push({ id: "last-id", assetId: "missing-last-id", role: "last", time: 1 });
  const summary = directorDiagnosticSummary(
    plan,
    new Set(["private-source-id"]),
    {
      fidelityByControlId: { [plan.cameraRig.id]: "prompt", "last-id": "unsupported" },
      providerOptions: {},
      frameBindings: [],
      visualInstructions: [],
      promptBrief: "private Director instructions",
      warnings: [],
    },
    ["missing_asset", "missing_asset"],
  );

  assert.equal(summary.sourceAssetPresent, true);
  assert.deepEqual(summary.referencedAssets, { present: 1, missing: 1 });
  assert.deepEqual(summary.fidelity, { prompt: 1, unsupported: 1 });
  assert.deepEqual(summary.validationErrorCodes, ["missing_asset"]);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("private-source-id"), false);
  assert.equal(serialized.includes("missing-last-id"), false);
  assert.equal(serialized.includes("private Director instructions"), false);
});
