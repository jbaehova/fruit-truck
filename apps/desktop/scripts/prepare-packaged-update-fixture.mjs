#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/studio/phase-3/", import.meta.url));
const TRANSACTION_ID = "packaged-update-fixture";

export const PACKAGED_UPDATE_DIRECTOR_PLAN = Object.freeze({
  schemaVersion: 1,
  enabled: true,
  sourceAssetId: "phase3-source-frame",
  cameraRig: {
    id: "phase3-update-camera-rig",
    sensorPreset: "cinema",
    lensPreset: "anamorphic",
    focalLengthMm: 40,
    aperture: 2.8,
    focusSubjectId: "phase3-update-subject",
    aspectRatio: "16:9",
  },
  subjects: [{
    id: "phase3-update-subject",
    label: "Fruit truck",
    region: { type: "box", x: 0.12, y: 0.28, width: 0.44, height: 0.51 },
    sourceAssetId: "phase3-source-frame",
  }],
  motions: [{
    id: "phase3-update-motion",
    targetType: "subject",
    targetId: "phase3-update-subject",
    kind: "translate",
    path: [{ x: 0.18, y: 0.57 }, { x: 0.72, y: 0.54 }],
    direction: "right",
    intensity: 0.72,
    start: 0,
    end: 1,
    easing: "ease_in_out",
    order: 1,
    actionLabel: "Truck crosses the market",
  }],
  keyframes: [],
  shots: [{
    id: "phase3-update-shot",
    order: 1,
    durationSeconds: 8,
    promptFragment: "Track the truck through the market without changing its identity.",
    motionIds: ["phase3-update-motion"],
    keyframeIds: [],
    speed: "linear",
  }],
  updatedAt: "2026-09-04T05:00:00.000Z",
  futureProviderIndependentControl: { mode: "lossless", values: [1, 2, 3] },
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function privateJson(value) {
  return Buffer.from(JSON.stringify(value));
}

function safeManagedPath(root, relativePath) {
  assert.equal(isAbsolute(relativePath), false, `Managed fixture path must be relative: ${relativePath}`);
  const destination = resolve(root, relativePath);
  const fromRoot = relative(resolve(root), destination);
  assert.ok(fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
  assert.ok(relativePath.startsWith("assets/") || relativePath.startsWith("generated/"));
  return destination;
}

async function writePrivate(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixturePayload(dataRoot) {
  const fixtureText = await readFile(join(FIXTURE_ROOT, "v6-production-workspace.json"), "utf8");
  return JSON.parse(fixtureText.replaceAll("{{FRUIT_TRUCK_HOME}}", dataRoot));
}

async function installManagedAssets(dataRoot) {
  const expectedManifest = JSON.parse(await readFile(join(FIXTURE_ROOT, "asset-manifest.expected.json"), "utf8"));
  for (const entry of expectedManifest.entries) {
    const source = safeManagedPath(FIXTURE_ROOT, entry.relativePath);
    const destination = safeManagedPath(dataRoot, entry.relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await chmod(dirname(destination), 0o700);
    await copyFile(source, destination);
    await chmod(destination, 0o600);
    const bytes = await readFile(destination);
    assert.equal(bytes.length, entry.byteSize);
    assert.equal(sha256(bytes), entry.sha256);
  }
  return expectedManifest;
}

function workspaceEnvelope(payload) {
  const payloadChecksum = sha256(Buffer.from(JSON.stringify(canonicalValue(payload))));
  return {
    payloadChecksum,
    bytes: privateJson({
      schema_version: 1,
      saved_at_ms: 1788483600000,
      checksum: payloadChecksum,
      payload,
    }),
  };
}

/** Seed the exact v6 source state before the instrumented prior test bundle boots. */
export async function preparePackagedUpdateSource(dataRoot) {
  assert.ok(isAbsolute(dataRoot), "The packaged update fixture root must be absolute.");
  assert.equal(basename(dataRoot), "data", "The packaged update fixture must use the isolated smoke data directory.");

  const payload = await fixturePayload(dataRoot);
  assert.equal(payload.schemaVersion, 6);
  const imageThread = payload.sessions
    .flatMap((session) => session.threads.image)
    .find((thread) => thread.id === "phase3-image-thread");
  assert.ok(imageThread, "The packaged update fixture is missing its image thread.");
  imageThread.draft.directorPlan = structuredClone(PACKAGED_UPDATE_DIRECTOR_PLAN);
  const imageAttempt = imageThread.attempts.find((attempt) => attempt.id === "phase3-image-attempt");
  assert.ok(imageAttempt?.snapshot, "The packaged update fixture is missing its image attempt snapshot.");
  imageAttempt.snapshot.directorPlan = structuredClone(PACKAGED_UPDATE_DIRECTOR_PLAN);

  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
  const expectedManifest = await installManagedAssets(dataRoot);
  const envelope = workspaceEnvelope(payload);
  await writePrivate(join(dataRoot, "workspace", "workspace-state-v1.json"), envelope.bytes);
  return { payloadChecksum: envelope.payloadChecksum, manifest: expectedManifest };
}

export async function preparePackagedUpdateFixture(dataRoot, toVersion, { fromVersion = "0.6.6" } = {}) {
  assert.ok(isAbsolute(dataRoot), "The packaged update fixture root must be absolute.");
  assert.match(toVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.match(fromVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.equal(basename(dataRoot), "data", "The packaged update fixture must use the isolated smoke data directory.");

  const payload = await fixturePayload(dataRoot);
  assert.equal(payload.schemaVersion, 6);
  const imageThread = payload.sessions
    .flatMap((session) => session.threads.image)
    .find((thread) => thread.id === "phase3-image-thread");
  assert.ok(imageThread, "The packaged update fixture is missing its image thread.");
  imageThread.draft.directorPlan = structuredClone(PACKAGED_UPDATE_DIRECTOR_PLAN);
  const imageAttempt = imageThread.attempts.find((attempt) => attempt.id === "phase3-image-attempt");
  assert.ok(imageAttempt?.snapshot, "The packaged update fixture is missing its image attempt snapshot.");
  imageAttempt.snapshot.directorPlan = structuredClone(PACKAGED_UPDATE_DIRECTOR_PLAN);

  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await chmod(dataRoot, 0o700);
  const expectedManifest = await installManagedAssets(dataRoot);

  const envelope = workspaceEnvelope(payload);
  const payloadChecksum = envelope.payloadChecksum;
  const envelopeBytes = envelope.bytes;
  const manifestBytes = privateJson(expectedManifest);
  const snapshotChecksum = sha256(envelopeBytes);
  const manifestChecksum = sha256(manifestBytes);
  const timestamp = "2026-09-04T05:00:00.000Z";
  const transaction = {
    schemaVersion: 1,
    id: TRANSACTION_ID,
    fromAppVersion: fromVersion,
    toAppVersion: toVersion,
    fromStudioSchema: 6,
    targetStudioSchema: 8,
    phase: "awaiting_restart",
    createdAt: timestamp,
    updatedAt: timestamp,
    snapshotPath: `update-snapshots/${TRANSACTION_ID}/workspace-envelope.json`,
    snapshotChecksum,
    assetManifestPath: `update-snapshots/${TRANSACTION_ID}/asset-manifest.json`,
    assetManifestChecksum: manifestChecksum,
  };
  const transactionBytes = privateJson(transaction);

  await writePrivate(join(dataRoot, "workspace", "workspace-state-v1.json"), envelopeBytes);
  await writePrivate(join(dataRoot, "update-snapshots", TRANSACTION_ID, "workspace-envelope.json"), envelopeBytes);
  await writePrivate(join(dataRoot, "update-snapshots", TRANSACTION_ID, "asset-manifest.json"), manifestBytes);
  await writePrivate(join(dataRoot, "update-snapshots", TRANSACTION_ID, "transaction.json"), transactionBytes);
  await writePrivate(join(dataRoot, "update-transactions", "history", `${TRANSACTION_ID}.json`), transactionBytes);
  await writePrivate(join(dataRoot, "update-transactions", "current.json"), transactionBytes);

  return { transactionId: TRANSACTION_ID, payloadChecksum, snapshotChecksum, manifestChecksum };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const dataRoot = resolve(process.argv[2] ?? "");
  const toVersion = process.argv[3] ?? "";
  preparePackagedUpdateFixture(dataRoot, toVersion).then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
