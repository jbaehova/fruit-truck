import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { migrateStudioForUpdate } from "../src/updateMigration.ts";
import { preparePackagedUpdateFixture } from "./prepare-packaged-update-fixture.mjs";
import {
  assertIsolatedDataRoot,
  createLocalUpdaterManifest,
  createPriorRendererDriver,
  preparePriorBundle,
  runLocalUpdaterServer,
  selectPriorReleaseTag,
  smokeTimeoutMs,
  verifyPackagedUpdate,
  verifyPreparedUpdateTransaction,
} from "./packaged-update-smoke.mjs";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

test("selects the newest stable published release older than the target", () => {
  assert.deepEqual(selectPriorReleaseTag([
    { tagName: "v0.6.5", isDraft: false, isPrerelease: false },
    { tagName: "v0.6.7", isDraft: true, isPrerelease: false },
    { tagName: "v0.6.6", isDraft: false, isPrerelease: false },
    { tagName: "v0.7.0-beta.1", isDraft: false, isPrerelease: true },
    { tagName: "notes", isDraft: false, isPrerelease: false },
  ], "0.6.7"), { tag: "v0.6.6", version: "0.6.6" });
  assert.throws(() => selectPriorReleaseTag([], "0.6.7"), /No published prior release/);
});

test("creates an exact local Apple Silicon manifest from the updater signature", () => {
  const manifest = createLocalUpdaterManifest({
    version: "0.6.7",
    origin: "http://127.0.0.1:43127",
    artifactName: "Fruit Truck.app.tar.gz",
    signature: "signed-updater-bytes\n",
  });
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-aarch64", "darwin-aarch64-app"]);
  for (const platform of Object.values(manifest.platforms)) {
    assert.equal(platform.signature, "signed-updater-bytes");
    assert.equal(platform.url, "http://127.0.0.1:43127/Fruit%20Truck.app.tar.gz");
  }
});

test("serves the signed manifest and verifies native transaction checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "fruit-truck-updater-server."));
  const dataRoot = join(root, "data");
  const artifactPath = join(root, "Fruit Truck.app.tar.gz");
  const signaturePath = `${artifactPath}.sig`;
  const statusPath = join(root, "status.json");
  const reservation = createNetServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  let server;
  try {
    await preparePackagedUpdateFixture(dataRoot, "0.6.7", { fromVersion: "0.6.6" });
    const transactionPath = join(dataRoot, "update-transactions", "current.json");
    const transaction = JSON.parse(await readFile(transactionPath, "utf8"));
    transaction.phase = "downloading";
    await writeFile(transactionPath, JSON.stringify(transaction), { mode: 0o600 });
    await writeFile(artifactPath, "signed updater artifact");
    await writeFile(signaturePath, "updater-signature\n");
    ({ server } = await runLocalUpdaterServer({
      port,
      artifactPath,
      signaturePath,
      dataRoot,
      statusPath,
      fromVersion: "0.6.6",
      toVersion: "0.6.7",
    }));
    const origin = `http://127.0.0.1:${port}`;
    const options = await fetch(`${origin}/events`, { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    const manifest = await (await fetch(`${origin}/latest.json`)).json();
    assert.equal(manifest.platforms["darwin-aarch64"].signature, "updater-signature");
    await fetch(`${origin}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "updater-install-started" }),
    });
    assert.equal((await fetch(`${origin}/prepared`, { method: "POST" })).status, 204);

    transaction.phase = "awaiting_restart";
    await writeFile(transactionPath, JSON.stringify(transaction), { mode: 0o600 });
    for (const type of ["updater-install-finished", "restart-intercepted"]) {
      await fetch(`${origin}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
    }
    assert.equal((await fetch(`${origin}/installed`, { method: "POST" })).status, 204);
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(status.preInstallTransactionVerified, true);
    assert.equal(status.preRelaunchTransactionVerified, true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a native managed-asset manifest that omits an expected entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "fruit-truck-updater-manifest-regression."));
  const dataRoot = join(root, "data");
  try {
    await preparePackagedUpdateFixture(dataRoot, "0.6.7", { fromVersion: "0.6.6" });
    const transactionPath = join(dataRoot, "update-transactions", "current.json");
    const transaction = JSON.parse(await readFile(transactionPath, "utf8"));
    const manifestPath = join(dataRoot, transaction.assetManifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.entries.pop();
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    transaction.assetManifestChecksum = createHash("sha256").update(manifestBytes).digest("hex");
    await writeFile(transactionPath, JSON.stringify(transaction), { mode: 0o600 });

    await assert.rejects(
      verifyPreparedUpdateTransaction(dataRoot, "0.6.6", "0.6.7"),
      /native managed-asset manifest entries differ from the complete expected fixture set/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the prior-bundle driver delegates updater install and restart to real Tauri IPC", () => {
  const driver = createPriorRendererDriver({ origin: "http://127.0.0.1:43127", expectedVersion: "0.6.7" });
  assert.match(driver, /nativeInvoke\(command, args, options\)/);
  assert.match(driver, /plugin:updater\|download_and_install/);
  assert.match(driver, /endpoint \+ "\/prepared"/);
  assert.match(driver, /plugin:process\|restart/);
  assert.match(driver, /update-prompt-accepted/);
  assert.match(driver, /document\.querySelectorAll\("\.update-actions button"\)/);
  assert.match(driver, /command === "load_workspace_state"/);
  assert.match(driver, /command === "save_workspace_state"/);
  assert.match(driver, /command === "scan_managed_assets"/);
  assert.match(driver, /"video-status-polled"/);
  assert.match(driver, /path\.startsWith\("\/videos\/"\)/);
  assert.match(driver, /sourceWorkspaceIsolated && managedScanIsolated/);
  assert.doesNotMatch(driver, /plugin:updater\|download_and_install[^]*return \{[^]*available:/);
});

test("prepares only a hidden, non-focused prior app and leaves production config untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "fruit-truck-prior-config."));
  const desktop = join(root, "apps", "desktop");
  const tauri = join(desktop, "src-tauri");
  const dist = join(desktop, "dist");
  try {
    await mkdir(tauri, { recursive: true });
    await mkdir(dist, { recursive: true });
    const production = {
      app: {
        windows: [{ title: "Fruit Truck", maximized: true }],
        security: { csp: "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; script-src 'self'" },
      },
      plugins: { updater: { pubkey: "public", endpoints: ["https://example.invalid/latest.json"] } },
    };
    await writeFile(join(tauri, "tauri.conf.json"), JSON.stringify(production));
    await writeFile(join(tauri, "tauri.release.conf.json"), JSON.stringify({ bundle: { externalBin: ["ffprobe"] } }));
    await writeFile(join(desktop, "package.json"), JSON.stringify({ name: "fruit-truck", version: "0.6.7" }));
    await writeFile(join(tauri, "Cargo.toml"), "[package]\nname = \"fruit-truck\"\nversion = \"0.6.7\"\n");
    await writeFile(join(dist, "index.html"), "<html><head></head><body></body></html>");
    const result = await preparePriorBundle(root, "http://127.0.0.1:43127", "0.6.6", "0.6.7");

    const after = JSON.parse(await readFile(join(tauri, "tauri.conf.json"), "utf8"));
    assert.deepEqual(after, production);
    const smoke = JSON.parse(await readFile(join(tauri, "packaged-update-smoke.conf.json"), "utf8"));
    assert.equal(smoke.app.windows[0].visible, false);
    assert.equal(smoke.app.windows[0].focus, false);
    assert.equal(smoke.app.windows[0].maximized, true);
    assert.equal(smoke.version, "0.6.6");
    assert.equal(result.effectiveVersion, "0.6.6");
    assert.equal(JSON.parse(await readFile(join(desktop, "package.json"), "utf8")).version, "0.6.6");
    assert.match(await readFile(join(tauri, "Cargo.toml"), "utf8"), /^version = "0\.6\.6"$/m);
    assert.equal(smoke.plugins.updater.dangerousInsecureTransportProtocol, true);
    assert.deepEqual(smoke.plugins.updater.endpoints, ["http://127.0.0.1:43127/latest.json"]);
    assert.match(smoke.app.security.csp, /http:\/\/127\.0\.0\.1:43127/);
    assert.match(await readFile(join(dist, "index.html"), "utf8"), /packaged-update-driver\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces isolated homes and bounded update waits", () => {
  assert.doesNotThrow(() => assertIsolatedDataRoot("/private/tmp/smoke/data", "/private/tmp/smoke"));
  assert.throws(() => assertIsolatedDataRoot("/private/tmp/data", "/private/tmp/smoke"));
  assert.throws(() => assertIsolatedDataRoot("/private/tmp/smoke-escape/data", "/private/tmp/smoke"));
  assert.equal(smokeTimeoutMs("30"), 30_000);
  assert.equal(smokeTimeoutMs("900"), 900_000);
  assert.throws(() => smokeTimeoutMs("29"), /30 to 900/);
  assert.throws(() => smokeTimeoutMs("901"), /30 to 900/);
});

test("verifies the post-relaunch marker, recovered video poll, v8 invariants, Director bytes, and exact assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "fruit-truck-packaged-verify."));
  const dataRoot = join(root, "data");
  const statusPath = join(root, "status.json");
  try {
    await preparePackagedUpdateFixture(dataRoot, "0.6.7", { fromVersion: "0.6.6" });
    const prepared = await verifyPreparedUpdateTransaction(dataRoot, "0.6.6", "0.6.7");
    assert.equal(prepared.phase, "awaiting_restart");
    const workspacePath = join(dataRoot, "workspace", "workspace-state-v1.json");
    const workspace = JSON.parse(await readFile(workspacePath, "utf8"));
    workspace.payload = migrateStudioForUpdate(workspace.payload).state;
    workspace.checksum = createHash("sha256")
      .update(JSON.stringify(canonicalValue(workspace.payload)))
      .digest("hex");
    await writeFile(workspacePath, JSON.stringify(workspace), { mode: 0o600 });
    await chmod(workspacePath, 0o600);
    const transactionPath = join(dataRoot, "update-transactions", "current.json");
    const transaction = JSON.parse(await readFile(transactionPath, "utf8"));
    transaction.phase = "complete";
    await writeFile(transactionPath, JSON.stringify(transaction), { mode: 0o600 });
    const types = [
      "driver-ready",
      "source-workspace-isolated",
      "managed-scan-isolated",
      "updater-check",
      "update-prompt-accepted",
      "source-workspace-save-isolated",
      "updater-install-started",
      "pre-install-transaction-verified",
      "updater-install-finished",
      "restart-intercepted",
      "pre-relaunch-transaction-verified",
      "video-status-polled",
    ];
    const validStatus = {
      preInstallTransactionVerified: true,
      preRelaunchTransactionVerified: true,
      events: types.map((type) => type === "video-status-polled"
        ? { type, detail: { path: "/videos/provider-video-job-phase3" } }
        : { type }),
    };
    await writeFile(statusPath, JSON.stringify(validStatus));

    const report = await verifyPackagedUpdate({ dataRoot, statusPath, fromVersion: "0.6.6", toVersion: "0.6.7" });
    assert.equal(report.schemaVersion, 8);
    assert.equal(report.assets.length, 3);
    assert.ok(report.invariants.costLedgerIds.length > 0);
    assert.ok(report.eventTypes.includes("video-status-polled"));

    const wrongVideoPollStatus = structuredClone(validStatus);
    wrongVideoPollStatus.events.find((event) => event.type === "video-status-polled").detail.path = "/videos/wrong-job";
    await writeFile(statusPath, JSON.stringify(wrongVideoPollStatus));
    await assert.rejects(
      verifyPackagedUpdate({ dataRoot, statusPath, fromVersion: "0.6.6", toVersion: "0.6.7" }),
      /video-status-polled for \/videos\/provider-video-job-phase3/,
    );

    const prematureVideoPollStatus = structuredClone(validStatus);
    const [videoPollEvent] = prematureVideoPollStatus.events.splice(-1, 1);
    prematureVideoPollStatus.events.unshift(videoPollEvent);
    await writeFile(statusPath, JSON.stringify(prematureVideoPollStatus));
    await assert.rejects(
      verifyPackagedUpdate({ dataRoot, statusPath, fromVersion: "0.6.6", toVersion: "0.6.7" }),
      /recovered video poll events were not ordered/,
    );
    await writeFile(statusPath, JSON.stringify(validStatus));

    const verifiedWorkspace = await readFile(workspacePath, "utf8");
    const missingLedger = JSON.parse(verifiedWorkspace);
    missingLedger.payload.sessions[0].costLedger.pop();
    missingLedger.checksum = createHash("sha256")
      .update(JSON.stringify(canonicalValue(missingLedger.payload)))
      .digest("hex");
    await writeFile(workspacePath, JSON.stringify(missingLedger), { mode: 0o600 });
    await assert.rejects(
      verifyPackagedUpdate({ dataRoot, statusPath, fromVersion: "0.6.6", toVersion: "0.6.7" }),
      /Protected workspace invariant changed: costLedgerIds/,
    );
    await writeFile(workspacePath, verifiedWorkspace, { mode: 0o600 });

    await writeFile(join(dataRoot, "assets", "source-frame.png"), "tampered");
    await assert.rejects(
      verifyPackagedUpdate({ dataRoot, statusPath, fromVersion: "0.6.6", toVersion: "0.6.7" }),
      /Managed asset size changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CI launcher has a bounded cleanup trap for app, server, worktree, and smoke root", async () => {
  const script = await readFile(new URL("./smoke-native-app.sh", import.meta.url), "utf8");
  assert.match(script, /trap cleanup EXIT INT TERM/);
  assert.match(script, /kill -TERM "\$\{app_pid\}"/);
  assert.match(script, /kill -TERM "\$\{server_pid\}"/);
  assert.match(script, /worktree remove --force/);
  assert.match(script, /fruit-truck-packaged-update\.\*/);
  assert.match(script, /CI:-.*GITHUB_ACTIONS:-/s);
  assert.match(script, /CARGO_TARGET_DIR="\$\{prior_target\}"/);
  assert.match(script, /security find-identity/);
  assert.match(script, /security import "\$\{certificate_path\}"/);
  assert.match(script, /Authority=Developer ID Application:/);
  assert.match(script, /notarytool submit/);
  assert.match(script, /stapler validate/);
  assert.match(script, /spctl --assess --type execute/);
  assert.match(script, /expected_video_status_path="\/videos\/provider-video-job-phase3"/);
  assert.match(script, /any\(\.type == "video-status-polled" and \.detail\.path == \$expected_path\)/);
  assert.match(script, /transaction_phase\}" == "complete" && "\$\{video_status_polled\}" == "true"/);
  assert.match(script, /transaction_phase\}" != "complete" \|\| "\$\{video_status_polled\}" != "true"/);
});
