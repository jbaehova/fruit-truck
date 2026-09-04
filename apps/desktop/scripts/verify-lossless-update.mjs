#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadStudioStateWithRecovery,
  STUDIO_BACKUP_KEY_PREFIX,
  STUDIO_STORAGE_KEY,
} from "../src/studio.ts";
import {
  migrateStudioForUpdate,
  workspaceInvariantsHold,
} from "../src/updateMigration.ts";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/studio/phase-3/", import.meta.url));
const FIXED_NOW = new Date("2026-09-04T05:00:00.000Z");
const MANAGED_ROOTS = new Set(["assets", "generated"]);

function memoryStorage(raw) {
  const values = new Map([[STUDIO_STORAGE_KEY, raw]]);
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      get length() { return values.size; },
      key: (index) => [...values.keys()][index] ?? null,
    },
  };
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function allThreads(state) {
  return (state.sessions ?? []).flatMap((session) => [
    ...(session.threads?.image ?? []),
    ...(session.threads?.video ?? []),
  ]);
}

function recursivelyCollectArrayIds(value, propertyName, collected = []) {
  if (value === null || typeof value !== "object") return collected;
  if (Array.isArray(value)) {
    for (const item of value) recursivelyCollectArrayIds(item, propertyName, collected);
    return collected;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === propertyName && Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && typeof item.id === "string") collected.push(item.id);
      }
    }
    recursivelyCollectArrayIds(child, propertyName, collected);
  }
  return collected;
}

export function collectWorkspaceInvariants(state) {
  const threads = allThreads(state);
  const attempts = threads.flatMap((thread) => thread.attempts ?? []);
  const enhancementAttempts = threads.flatMap((thread) => thread.enhancementAttempts ?? []);
  const assets = (state.sessions ?? []).flatMap((session) => session.assets ?? []);
  const agentJobIds = (state.sessions ?? []).flatMap((session) => {
    const currentJobIds = session.agent?.execution?.currentJobIds;
    return Array.isArray(currentJobIds) ? currentJobIds.filter((id) => typeof id === "string") : [];
  });
  return {
    sessionIds: sorted((state.sessions ?? []).map((session) => session.id)),
    threadIds: sorted(threads.map((thread) => thread.id)),
    assetIds: sorted(assets.map((asset) => asset.id)),
    attemptIds: sorted(attempts.map((attempt) => attempt.id)),
    enhancementAttemptIds: sorted(enhancementAttempts.map((attempt) => attempt.id)),
    costLedgerIds: sorted(recursivelyCollectArrayIds(state, "costLedger")),
    providerJobIds: sorted([
      ...assets.map((asset) => asset.jobId).filter(Boolean),
      ...attempts.map((attempt) => attempt.jobId).filter(Boolean),
      ...agentJobIds,
    ]),
    localPaths: sorted(assets.map((asset) => asset.localPath).filter(Boolean)),
  };
}

function assertWorkspaceInvariants(before, after) {
  const source = collectWorkspaceInvariants(before);
  const migrated = collectWorkspaceInvariants(after);
  const report = {};
  for (const key of Object.keys(source)) {
    report[`${key}Equal`] = true;
    assert.deepEqual(migrated[key], source[key], `${key} changed during migration`);
  }
  return report;
}

function findThread(state, sessionId, mode, threadId) {
  return state.sessions.find((session) => session.id === sessionId)
    ?.threads?.[mode]?.find((thread) => thread.id === threadId);
}

function assertLegacyPromptsPreserved(before, after) {
  for (const session of before.sessions) {
    for (const mode of ["image", "video"]) {
      for (const thread of session.threads[mode]) {
        const migratedThread = findThread(after, session.id, mode, thread.id);
        assert.ok(migratedThread, `thread ${thread.id} is missing after migration`);
        const draftTexts = migratedThread.draft.promptHistory.entries.map((entry) => entry.text);
        for (const prompt of [thread.draft.prompt, thread.draft.enhancedPrompt]) {
          if (typeof prompt === "string" && prompt.length > 0) {
            assert.ok(draftTexts.includes(prompt), `draft prompt was not retained for ${thread.id}`);
          }
        }
        for (const attempt of thread.attempts ?? []) {
          if (!attempt.snapshot) continue;
          const migratedAttempt = migratedThread.attempts.find((candidate) => candidate.id === attempt.id);
          assert.ok(migratedAttempt?.snapshot, `attempt snapshot ${attempt.id} is missing`);
          const snapshotTexts = migratedAttempt.snapshot.promptHistory.entries.map((entry) => entry.text);
          for (const prompt of [attempt.snapshot.prompt, attempt.snapshot.enhancedPrompt]) {
            if (typeof prompt === "string" && prompt.length > 0) {
              assert.ok(snapshotTexts.includes(prompt), `snapshot prompt was not retained for ${attempt.id}`);
            }
          }
        }
      }
    }
  }
}

function withoutRecovery(state) {
  const copy = structuredClone(state);
  delete copy.recovery;
  return copy;
}

async function fixtureText(name, fruitTruckHome) {
  const raw = await readFile(join(FIXTURE_ROOT, name), "utf8");
  return raw.replaceAll("{{FRUIT_TRUCK_HOME}}", fruitTruckHome);
}

function migrateRaw(raw) {
  const { storage, values } = memoryStorage(raw);
  const result = loadStudioStateWithRecovery({ storage, now: () => FIXED_NOW });
  return { result, values };
}

async function verifyV6Migration(fruitTruckHome) {
  const raw = await fixtureText("v6-production-workspace.json", fruitTruckHome);
  const before = JSON.parse(raw);
  const updateMigration = migrateStudioForUpdate(before);
  const repeatedUpdateMigration = migrateStudioForUpdate(before);
  const first = migrateRaw(raw);
  const second = migrateRaw(raw);
  const { state, migration, recovery } = first.result;

  assert.deepEqual(updateMigration.migration, { fromVersion: 6, toVersion: 8, steps: ["v6→v7", "v7→v8"] });
  assert.equal(workspaceInvariantsHold(updateMigration.invariants), true);
  assert.deepEqual(updateMigration.state, repeatedUpdateMigration.state, "update migration is not deterministic");
  assert.equal(recovery.kind, "migrated");
  assert.deepEqual(migration?.steps, ["v6→v7", "v7→v8"]);
  assert.equal(state.schemaVersion, 8);
  assert.equal(state.promptModel, "google/gemini-3.8-flash");
  assert.equal(state.defaultEnhancePrompt, undefined);
  assert.deepEqual(state.directorPresets, []);
  assert.deepEqual(withoutRecovery(state), withoutRecovery(second.result.state), "v6 migration is not deterministic");

  const invariantReport = updateMigration.invariants;
  assertWorkspaceInvariants(before, updateMigration.state);
  assertWorkspaceInvariants(before, state);
  assertLegacyPromptsPreserved(before, state);
  assertLegacyPromptsPreserved(before, updateMigration.state);
  const image = findThread(state, "phase3-session-v6", "image", "phase3-image-thread");
  const video = findThread(state, "phase3-session-v6", "video", "phase3-video-thread");
  assert.ok(image && video);
  const enhanced = image.draft.promptHistory.entries.find((entry) => entry.kind === "enhancement_result");
  const updateImage = findThread(
    updateMigration.state,
    "phase3-session-v6",
    "image",
    "phase3-image-thread",
  );
  assert.ok(updateImage);
  const updateEnhanced = updateImage.draft.promptHistory.entries.find((entry) => entry.kind === "enhancement_result");
  assert.equal(enhanced?.negativePrompt, "blurred signage, altered truck identity");
  assert.equal(enhanced?.enhancementArtifact?.signature, "phase3-enhancement-signature");
  assert.equal(enhanced?.enhancementAttemptId, "phase3-enhancement-completed");
  assert.equal(updateEnhanced?.enhancementAttemptId, "phase3-enhancement-completed");
  assert.equal(updateEnhanced?.enhancementArtifact?.signature, "phase3-enhancement-signature");
  assert.equal(image.enhancementAttempts.find((attempt) => attempt.id === "phase3-enhancement-uncertain")?.status, "uncertain");
  assert.equal(video.attempts[0]?.status, "in_progress");
  assert.equal(video.attempts[0]?.jobId, "provider-video-job-phase3");
  assert.ok(recovery.attempts.some((attempt) =>
    attempt.attemptId === "phase3-video-attempt-active"
      && attempt.classification === "video_job_resumable"
      && attempt.resumable));
  assert.equal(state.activeSessionId, before.activeSessionId);
  assert.deepEqual(state.sessions[0].activeThreadIds, before.sessions[0].activeThreadIds);
  assert.deepEqual(state.sessions[0].costLedger, before.sessions[0].costLedger);
  assert.equal(
    image.enhancementAttempts.find((attempt) => attempt.id === "phase3-enhancement-completed")?.actualCostUsd,
    0.007,
  );
  assert.equal(
    image.attempts.find((attempt) => attempt.id === "phase3-image-attempt")?.actualCostUsd,
    0.043,
  );
  assert.deepEqual(state.opaqueRootField, before.opaqueRootField);
  assert.deepEqual(state.sessions[0].agent, before.sessions[0].agent);

  const backupKey = [...first.values.keys()].find((key) => key.startsWith(STUDIO_BACKUP_KEY_PREFIX));
  assert.ok(backupKey, "v6 migration did not retain a pre-migration backup");
  assert.equal(first.values.get(backupKey), raw, "v6 migration backup did not preserve exact bytes");

  const migratedRaw = first.values.get(STUDIO_STORAGE_KEY);
  assert.ok(migratedRaw);
  const idempotent = migrateRaw(migratedRaw);
  assert.equal(idempotent.result.recovery.kind, "loaded");
  assert.equal(idempotent.result.migration, undefined);
  assert.deepEqual(withoutRecovery(idempotent.result.state), withoutRecovery(state));
  assert.equal(idempotent.values.get(STUDIO_STORAGE_KEY), migratedRaw);
  const updateIdempotent = migrateStudioForUpdate(updateMigration.state);
  assert.deepEqual(updateIdempotent.migration, { fromVersion: 8, toVersion: 8, steps: [] });
  assert.deepEqual(updateIdempotent.state, updateMigration.state);

  return { state, invariantReport, migratedRaw };
}

async function verifyV7Migration(fruitTruckHome) {
  const raw = await fixtureText("v7-fifty-prompt-history.json", fruitTruckHome);
  const before = JSON.parse(raw);
  const updateMigration = migrateStudioForUpdate(before);
  const { result, values } = migrateRaw(raw);
  assert.deepEqual(updateMigration.migration, { fromVersion: 7, toVersion: 8, steps: ["v7→v8"] });
  assert.equal(workspaceInvariantsHold(updateMigration.invariants), true);
  assert.equal(result.recovery.kind, "migrated");
  assert.deepEqual(result.migration?.steps, ["v7→v8"]);
  assertWorkspaceInvariants(before, result.state);
  const history = result.state.sessions[0].threads.image[0].draft.promptHistory;
  assert.equal(history.entries.length, 50);
  assert.deepEqual(
    JSON.parse(JSON.stringify(history.entries)),
    before.sessions[0].threads.image[0].draft.promptHistory.entries,
  );
  assert.equal(history.cursor, 49);
  assert.equal(result.state.sessions[0].opaqueV7Field.preserve, "exactly");
  const backupKey = [...values.keys()].find((key) => key.startsWith(STUDIO_BACKUP_KEY_PREFIX));
  assert.ok(backupKey);
  assert.equal(values.get(backupKey), raw);
  return result.state;
}

async function verifyV8Preservation(fruitTruckHome) {
  const raw = await fixtureText("v8-director-missing-asset.json", fruitTruckHome);
  const before = JSON.parse(raw);
  const updateMigration = migrateStudioForUpdate(before);
  const { result, values } = migrateRaw(raw);
  assert.deepEqual(updateMigration.migration, { fromVersion: 8, toVersion: 8, steps: [] });
  assert.equal(workspaceInvariantsHold(updateMigration.invariants), true);
  assert.equal(result.recovery.kind, "loaded");
  assert.equal(result.migration, undefined);
  assert.equal(values.get(STUDIO_STORAGE_KEY), raw, "current v8 bytes were unexpectedly rewritten");
  assertWorkspaceInvariants(before, result.state);
  const beforeThread = before.sessions[0].threads.video[0];
  const afterThread = result.state.sessions[0].threads.video[0];
  assert.deepEqual(afterThread.draft.directorPlan, beforeThread.draft.directorPlan);
  assert.deepEqual(afterThread.attempts[0].snapshot.directorPlan, beforeThread.attempts[0].snapshot.directorPlan);
  assert.notEqual(afterThread.draft.directorPlan, afterThread.attempts[0].snapshot.directorPlan);
  const missing = result.state.sessions[0].assets.find((asset) => asset.id === "phase3-v8-missing-result");
  assert.equal(missing?.storageAvailability, "missing");
  assert.equal(missing?.localPath, join(fruitTruckHome, "generated", "missing-output.mp4"));
  return { state: result.state, raw };
}

async function verifyMigrationFailureRetainsPrimary(fruitTruckHome) {
  const raw = await fixtureText("v6-production-workspace.json", fruitTruckHome);
  const malformed = JSON.parse(raw);
  malformed.sessions[0].threads.image[0].attempts[0].status = "invalid-production-status";
  const malformedRaw = `${JSON.stringify(malformed, null, 2)}\n`;
  assert.throws(() => migrateStudioForUpdate(malformed), /invalid-production-status|failed validation/);
  const { result, values } = migrateRaw(malformedRaw);
  assert.equal(result.recovery.kind, "migration_failed");
  assert.equal(result.recovery.requiresUserAction, true);
  assert.equal(values.get(STUDIO_STORAGE_KEY), malformedRaw);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeManagedPath(root, relativePath) {
  assert.equal(isAbsolute(relativePath), false, `manifest path must be relative: ${relativePath}`);
  assert.equal(relativePath.includes("\\"), false, `manifest path must use portable separators: ${relativePath}`);
  const segments = relativePath.split("/");
  assert.ok(segments.length >= 2 && MANAGED_ROOTS.has(segments[0]), `manifest root is not managed: ${relativePath}`);
  assert.ok(segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), `manifest path escapes its root: ${relativePath}`);
  const destination = resolve(root, ...segments);
  const fromRoot = relative(resolve(root), destination);
  assert.ok(fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot), `manifest path escapes FRUIT_TRUCK_HOME: ${relativePath}`);
  return destination;
}

async function stableFileDigest(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await lstat(path);
    assert.equal(before.isSymbolicLink(), false, `managed asset is a symlink: ${path}`);
    assert.equal(before.isFile(), true, `managed asset is not a regular file: ${path}`);
    const sha256 = await sha256File(path);
    const after = await lstat(path);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { byteSize: after.size, sha256 };
    }
  }
  throw new Error(`managed asset changed while hashing: ${path}`);
}

async function installAssetFixtures(root, manifest) {
  for (const entry of manifest.entries) {
    const source = safeManagedPath(FIXTURE_ROOT, entry.relativePath);
    const destination = safeManagedPath(root, entry.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function buildAssetManifest(state, root, createdAtMs) {
  const entries = [];
  for (const session of state.sessions) {
    for (const asset of session.assets) {
      if (!asset.localPath || basename(asset.localPath).endsWith(".part")) continue;
      assert.equal(isAbsolute(asset.localPath), true, `asset ${asset.id} does not have an absolute managed path`);
      const relativePath = relative(root, asset.localPath).split(sep).join("/");
      const path = safeManagedPath(root, relativePath);
      const digest = await stableFileDigest(path);
      if (asset.byteSize !== undefined) assert.equal(asset.byteSize, digest.byteSize, `metadata size differs for ${asset.id}`);
      if (asset.fingerprint !== undefined) assert.equal(asset.fingerprint, digest.sha256, `metadata fingerprint differs for ${asset.id}`);
      entries.push({
        assetId: asset.id,
        kind: asset.kind,
        origin: asset.origin,
        relativePath,
        ...digest,
      });
    }
  }
  entries.sort((left, right) => left.assetId.localeCompare(right.assetId));
  return { schemaVersion: 1, createdAtMs, entries };
}

async function validateAssetManifest(manifest, root) {
  for (const entry of manifest.entries) {
    const path = safeManagedPath(root, entry.relativePath);
    const digest = await stableFileDigest(path);
    assert.equal(digest.byteSize, entry.byteSize, `managed asset size changed: ${entry.assetId}`);
    assert.equal(digest.sha256, entry.sha256, `managed asset checksum changed: ${entry.assetId}`);
  }
  return { verifiedCount: manifest.entries.length, errors: [] };
}

async function rejects(operation, pattern) {
  await assert.rejects(operation, pattern);
}

async function verifyAssetContract(state, root) {
  const expected = JSON.parse(await readFile(join(FIXTURE_ROOT, "asset-manifest.expected.json"), "utf8"));
  await installAssetFixtures(root, expected);
  const before = await buildAssetManifest(state, root, expected.createdAtMs);
  assert.deepEqual(before, expected, "fixture asset manifest drifted from its checked-in contract");

  const manifestPath = join(root, "update-snapshots", "fixture-transaction", "asset-manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  const manifestBytes = `${JSON.stringify(before)}\n`;
  await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
  const manifestChecksum = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
  assert.equal(manifestChecksum, createHash("sha256").update(manifestBytes).digest("hex"));
  const report = await validateAssetManifest(before, root);

  const ignoredPart = join(root, "generated", "download-in-flight.part");
  await writeFile(ignoredPart, "partial fixture bytes\n", { mode: 0o600 });
  const withPartReference = structuredClone(state);
  withPartReference.sessions[0].assets.push({
    id: "phase3-partial-file",
    name: "download-in-flight.part",
    kind: "video",
    mimeType: "video/mp4",
    origin: "generated",
    createdAt: "2026-09-04T05:00:00.000Z",
    localPath: ignoredPart,
  });
  assert.equal((await buildAssetManifest(withPartReference, root, expected.createdAtMs)).entries.length, expected.entries.length);

  const traversal = structuredClone(before);
  traversal.entries[0].relativePath = "../outside-user-data";
  await rejects(() => validateAssetManifest(traversal, root), /escapes|managed/);

  const target = safeManagedPath(root, expected.entries[0].relativePath);
  const source = safeManagedPath(FIXTURE_ROOT, expected.entries[0].relativePath);
  await appendFile(target, "tampered\n");
  await rejects(() => validateAssetManifest(before, root), /size changed|checksum changed/);
  await copyFile(source, target);

  await unlink(target);
  await rejects(() => validateAssetManifest(before, root), /ENOENT/);
  await copyFile(source, target);

  await unlink(target);
  await symlink(source, target);
  await rejects(() => validateAssetManifest(before, root), /symlink/);
  await unlink(target);
  await copyFile(source, target);

  const after = await buildAssetManifest(state, root, expected.createdAtMs);
  assert.deepEqual(after, before, "managed asset bytes changed during verification");
  return { ...report, manifestChecksum };
}

async function verifyMissingAssetFailsReadOnly(v8, root) {
  const missingPath = join(root, "generated", "missing-output.mp4");
  const before = v8.raw;
  const manifest = {
    schemaVersion: 1,
    createdAtMs: 1788483600000,
    entries: [{
      assetId: "phase3-v8-missing-result",
      kind: "video",
      origin: "generated",
      relativePath: "generated/missing-output.mp4",
      byteSize: 1,
      sha256: "00".repeat(32),
    }],
  };
  await rejects(() => validateAssetManifest(manifest, root), /ENOENT/);
  assert.equal(await fixtureText("v8-director-missing-asset.json", root), before);
  await rejects(() => lstat(missingPath), /ENOENT/);
}

function assertSafeTemporaryRoot(root) {
  const absolute = realpathSync(root);
  const temporaryRoot = realpathSync(tmpdir());
  assert.equal(isAbsolute(absolute), true);
  assert.notEqual(absolute, realpathSync(homedir()));
  assert.ok(absolute.startsWith(`${temporaryRoot}${sep}`), `verification root is outside the system temp directory: ${absolute}`);
  assert.ok(basename(absolute).startsWith("fruit-truck-lossless-update-"));
}

export async function runVerification() {
  const root = await mkdtemp(join(tmpdir(), "fruit-truck-lossless-update-"));
  assertSafeTemporaryRoot(root);
  const sandbox = await realpath(root);
  assertSafeTemporaryRoot(sandbox);
  const priorFruitTruckHome = process.env.FRUIT_TRUCK_HOME;
  process.env.FRUIT_TRUCK_HOME = sandbox;
  try {
    await mkdir(join(sandbox, "workspace"), { recursive: true });
    const v6 = await verifyV6Migration(sandbox);
    await writeFile(join(sandbox, "workspace", "v6-source.json"), await fixtureText("v6-production-workspace.json", sandbox), { mode: 0o600 });
    await writeFile(join(sandbox, "workspace", "v8-migrated.json"), v6.migratedRaw, { mode: 0o600 });
    await verifyV7Migration(sandbox);
    const v8 = await verifyV8Preservation(sandbox);
    await verifyMigrationFailureRetainsPrimary(sandbox);
    const assetReport = await verifyAssetContract(v6.state, sandbox);
    await verifyMissingAssetFailsReadOnly(v8, sandbox);
    return {
      fixtureSchemas: [6, 7, 8],
      migrationSteps: ["v6→v7", "v7→v8"],
      invariantReport: v6.invariantReport,
      promptHistoryEntriesVerified: 50,
      activeVideoRecoveryVerified: true,
      directorPlanVerified: true,
      missingAssetFailureVerified: true,
      assetReport,
      isolatedFruitTruckHome: true,
    };
  } finally {
    if (priorFruitTruckHome === undefined) delete process.env.FRUIT_TRUCK_HOME;
    else process.env.FRUIT_TRUCK_HOME = priorFruitTruckHome;
    assertSafeTemporaryRoot(sandbox);
    await rm(sandbox, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runVerification()
    .then((report) => {
      process.stdout.write(`Lossless update release fixture verification passed.\n${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`Lossless update release fixture verification failed: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
