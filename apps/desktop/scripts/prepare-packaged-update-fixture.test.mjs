import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { preparePackagedUpdateFixture } from "./prepare-packaged-update-fixture.mjs";

test("prepares a private pending transaction for the packaged update smoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "fruit-truck-native-smoke."));
  const dataRoot = join(root, "data");
  try {
    const report = await preparePackagedUpdateFixture(dataRoot, "0.7.0");
    const currentBytes = await readFile(join(dataRoot, "workspace", "workspace-state-v1.json"));
    const snapshotBytes = await readFile(join(dataRoot, "update-snapshots", report.transactionId, "workspace-envelope.json"));
    const transaction = JSON.parse(await readFile(join(dataRoot, "update-transactions", "current.json"), "utf8"));
    const manifestBytes = await readFile(join(dataRoot, transaction.assetManifestPath));

    assert.deepEqual(snapshotBytes, currentBytes);
    assert.equal(createHash("sha256").update(snapshotBytes).digest("hex"), transaction.snapshotChecksum);
    assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), transaction.assetManifestChecksum);
    assert.equal(transaction.phase, "awaiting_restart");
    assert.equal(transaction.fromStudioSchema, 6);
    assert.equal(transaction.targetStudioSchema, 8);
    assert.equal(transaction.toAppVersion, "0.7.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
