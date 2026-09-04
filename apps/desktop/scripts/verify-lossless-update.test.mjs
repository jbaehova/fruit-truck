import assert from "node:assert/strict";
import test from "node:test";
import { runVerification } from "./verify-lossless-update.mjs";

test("release fixtures prove the lossless update contract in an isolated home", async () => {
  const report = await runVerification();
  assert.deepEqual(report.fixtureSchemas, [6, 7, 8]);
  assert.deepEqual(report.migrationSteps, ["v6→v7", "v7→v8"]);
  assert.equal(Object.values(report.invariantReport).every(Boolean), true);
  assert.equal(report.promptHistoryEntriesVerified, 50);
  assert.equal(report.activeVideoRecoveryVerified, true);
  assert.equal(report.directorPlanVerified, true);
  assert.equal(report.missingAssetFailureVerified, true);
  assert.equal(report.assetReport.verifiedCount, 3);
  assert.match(report.assetReport.manifestChecksum, /^[a-f0-9]{64}$/);
  assert.equal(report.isolatedFruitTruckHome, true);
});
