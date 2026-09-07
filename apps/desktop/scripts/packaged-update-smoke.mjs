#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PACKAGED_UPDATE_DIRECTOR_PLAN,
  preparePackagedUpdateSource,
} from "./prepare-packaged-update-fixture.mjs";

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
const EXPECTED_ASSET_MANIFEST_PATH = fileURLToPath(
  new URL("../fixtures/studio/phase-3/asset-manifest.expected.json", import.meta.url),
);
const MANAGED_ASSET_ENTRY_FIELDS = [
  "assetId",
  "kind",
  "origin",
  "relativePath",
  "byteSize",
  "sha256",
];

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

function payloadChecksum(payload) {
  return sha256(Buffer.from(JSON.stringify(canonicalValue(payload))));
}

async function readExpectedAssetManifest() {
  return JSON.parse(await readFile(EXPECTED_ASSET_MANIFEST_PATH, "utf8"));
}

function comparableManifestEntries(manifest, label) {
  assert.ok(Array.isArray(manifest?.entries), `${label} must contain an entries array.`);
  const entries = manifest.entries.map((entry) => {
    assert.ok(entry && typeof entry === "object", `${label} contains an invalid entry.`);
    return Object.fromEntries(MANAGED_ASSET_ENTRY_FIELDS.map((field) => [field, entry[field]]));
  });
  const assetIds = entries.map((entry) => entry.assetId);
  assert.equal(new Set(assetIds).size, assetIds.length, `${label} contains duplicate asset IDs.`);
  return entries.sort((left, right) => String(left.assetId).localeCompare(String(right.assetId)));
}

function semverParts(version) {
  assert.match(version, SEMVER);
  return version.split(/[+-]/, 1)[0].split(".").map(Number);
}

function compareVersions(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function selectPriorReleaseTag(releases, targetVersion) {
  assert.match(targetVersion, SEMVER);
  const candidates = releases
    .filter((release) => release && release.isDraft !== true && release.isPrerelease !== true)
    .map((release) => RELEASE_TAG.exec(String(release.tagName ?? "")))
    .filter(Boolean)
    .map((match) => ({ tag: `v${match[1]}`, version: match[1] }))
    .filter(({ version }) => compareVersions(version, targetVersion) < 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  assert.ok(candidates.length > 0, `No published prior release exists below ${targetVersion}.`);
  return candidates[0];
}

export function assertIsolatedDataRoot(dataRoot, smokeRoot) {
  assert.ok(isAbsolute(dataRoot), "The packaged updater smoke data root must be absolute.");
  assert.ok(isAbsolute(smokeRoot), "The packaged updater smoke root must be absolute.");
  assert.equal(basename(dataRoot), "data");
  const fromSmokeRoot = relative(resolve(smokeRoot), resolve(dataRoot));
  assert.ok(fromSmokeRoot && fromSmokeRoot !== ".." && !fromSmokeRoot.startsWith(`..${sep}`) && !isAbsolute(fromSmokeRoot));
}

export function smokeTimeoutMs(raw = "180") {
  const seconds = Number(raw);
  assert.ok(Number.isSafeInteger(seconds) && seconds >= 30 && seconds <= 900,
    "FRUIT_TRUCK_PACKAGED_UPDATE_TIMEOUT_SECONDS must be an integer from 30 to 900.");
  return seconds * 1_000;
}

export function createLocalUpdaterManifest({ version, origin, artifactName, signature }) {
  assert.match(version, SEMVER);
  const url = new URL(`/${encodeURIComponent(artifactName)}`, `${origin}/`).href;
  const platform = { signature: signature.trim(), url };
  assert.ok(platform.signature.length > 0, "The updater signature is empty.");
  return {
    version,
    notes: "Fruit Truck packaged updater release gate",
    pub_date: "2026-09-04T00:00:00.000Z",
    platforms: {
      "darwin-aarch64": platform,
      "darwin-aarch64-app": platform,
    },
  };
}

export function createPriorRendererDriver({ origin, expectedVersion }) {
  assert.match(expectedVersion, SEMVER);
  const endpoint = JSON.stringify(origin);
  const version = JSON.stringify(expectedVersion);
  return `(() => {
  "use strict";
  const endpoint = ${endpoint};
  const expectedVersion = ${version};
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") throw new Error("Tauri IPC is unavailable.");
  const nativeInvoke = internals.invoke.bind(internals);
  let sourceWorkspaceIsolated = false;
  let managedScanIsolated = false;
  const report = async (type, detail = {}) => {
    const response = await fetch(endpoint + "/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, detail, at: new Date().toISOString() }),
    });
    if (!response.ok) throw new Error("Packaged updater smoke event failed: " + response.status);
  };
  const smokeInvoke = async (command, args, options) => {
    if (command === "load_workspace_state") {
      sourceWorkspaceIsolated = true;
      await report("source-workspace-isolated", { command });
      return null;
    }
    if (command === "save_workspace_state") {
      await report("source-workspace-save-isolated", { command });
      return null;
    }
    if (command === "scan_managed_assets") {
      managedScanIsolated = true;
      await report("managed-scan-isolated", { command });
      return [];
    }
    if (command === "credential_status") {
      return { configured: true, maskedKey: "sk-smok…gate", path: "packaged-update-smoke" };
    }
    if (command === "openrouter_request") {
      const path = args && typeof args.path === "string" ? args.path : "";
      await report(path.startsWith("/videos/") ? "video-status-polled" : "openrouter-request", { path });
      if (path === "/key") return { label: "packaged-update-smoke" };
      if (path === "/images/models" || path === "/videos/models" || path.startsWith("/models?")) return { data: [] };
      if (path.startsWith("/videos/")) return { id: path.slice("/videos/".length), status: "in_progress" };
      return { data: [] };
    }
    if (command === "plugin:updater|check") await report("updater-check", { expectedVersion });
    if (command === "plugin:updater|download_and_install") {
      await report("updater-install-started", { expectedVersion });
      const prepared = await fetch(endpoint + "/prepared", { method: "POST" });
      if (!prepared.ok) throw new Error("The pre-install transaction check failed: " + await prepared.text());
      const result = await nativeInvoke(command, args, options);
      await report("updater-install-finished", { expectedVersion });
      return result;
    }
    if (command === "plugin:process|restart") {
      await report("restart-intercepted", { expectedVersion });
      const response = await fetch(endpoint + "/installed", { method: "POST" });
      if (!response.ok) throw new Error("The pre-relaunch transaction check failed: " + await response.text());
      return nativeInvoke(command, args, options);
    }
    return nativeInvoke(command, args, options);
  };
  Object.defineProperty(window, "__FRUIT_TRUCK_PACKAGED_UPDATE_INVOKE__", {
    value: smokeInvoke,
  });
  const reportDriverError = (event) => {
    const error = event instanceof Error
      ? event
      : event && typeof event === "object" && "reason" in event ? event.reason : event?.error;
    void report("driver-error", {
      message: error instanceof Error ? error.message : String(error || "Unknown driver error"),
    }).catch(() => undefined);
  };
  window.addEventListener("error", reportDriverError);
  window.addEventListener("unhandledrejection", reportDriverError);
  localStorage.setItem("fruit-truck.onboarding.complete.v1", "true");
  void report("driver-ready", { expectedVersion }).catch(reportDriverError);
  const deadline = Date.now() + 90_000;
  const timer = setInterval(() => {
    const buttons = [...document.querySelectorAll(".update-actions button")];
    const install = buttons.find((button) => !button.disabled && button !== buttons[0]);
    if (install && sourceWorkspaceIsolated && managedScanIsolated) {
      clearInterval(timer);
      void report("update-prompt-accepted", { text: install.textContent || "" })
        .then(() => install.click())
        .catch(reportDriverError);
    } else if (Date.now() >= deadline) {
      clearInterval(timer);
      void report("driver-timeout", {
        expectedVersion,
        sourceWorkspaceIsolated,
        managedScanIsolated,
        enabledUpdateButtonCount: buttons.filter((button) => !button.disabled).length,
      }).catch(reportDriverError);
    }
  }, 100);
})();\n`;
}

export async function installPriorInvokeBridge(worktree) {
  const corePath = join(worktree, "apps", "desktop", "node_modules", "@tauri-apps", "api", "core.js");
  const core = await readFile(corePath, "utf8");
  const smokeInvokeName = "__FRUIT_TRUCK_PACKAGED_UPDATE_INVOKE__";
  const nativeInvoke = "return window.__TAURI_INTERNALS__.invoke(cmd, args, options);";
  assert.equal(
    core.includes(smokeInvokeName),
    false,
    "The packaged update smoke invoke bridge was already installed.",
  );
  assert.equal(
    core.split(nativeInvoke).length - 1,
    1,
    "The installed @tauri-apps/api core invoke implementation is incompatible with the packaged update smoke bridge.",
  );
  const bridgedInvoke = `const smokeInvoke = window.${smokeInvokeName};
    if (typeof smokeInvoke === 'function') return smokeInvoke(cmd, args, options);
    ${nativeInvoke}`;
  await writeFile(corePath, core.replace(nativeInvoke, bridgedInvoke));
  return { corePath };
}

export async function injectPriorRenderer(worktree, origin, expectedVersion) {
  const desktop = join(worktree, "apps", "desktop");
  const driverPath = join(desktop, "dist", "packaged-update-driver.js");
  const indexPath = join(desktop, "dist", "index.html");
  const index = await readFile(indexPath, "utf8");
  assert.ok(!index.includes("packaged-update-driver.js"), "The prior bundle driver was already injected.");
  assert.match(index, /<\/head>/);
  await writeFile(driverPath, createPriorRendererDriver({ origin: new URL(origin).origin, expectedVersion }));
  await writeFile(indexPath, index.replace("</head>", "<script src=\"./packaged-update-driver.js\"></script></head>"));
  return { driverPath, indexPath };
}

export async function preparePriorBundle(
  worktree,
  origin,
  priorVersion,
  expectedVersion,
  { inject = true } = {},
) {
  assert.match(priorVersion, SEMVER);
  assert.ok(compareVersions(priorVersion, expectedVersion) < 0, "The test bundle version must be older than the updater version.");
  const desktop = join(worktree, "apps", "desktop");
  const configPath = join(desktop, "src-tauri", "packaged-update-smoke.conf.json");
  const packagePath = join(desktop, "package.json");
  const cargoPath = join(desktop, "src-tauri", "Cargo.toml");
  const baseConfig = JSON.parse(await readFile(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"));
  const releaseConfig = JSON.parse(await readFile(join(desktop, "src-tauri", "tauri.release.conf.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const cargoToml = await readFile(cargoPath, "utf8");
  assert.match(cargoToml, /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m);
  const windowConfig = baseConfig.app?.windows?.[0];
  assert.ok(windowConfig, "The prior release has no primary Tauri window.");
  const csp = String(baseConfig.app?.security?.csp ?? "");
  assert.match(csp, /connect-src[^;]*/);
  const originValue = new URL(origin).origin;
  const smokeCsp = csp.replace(/connect-src([^;]*)/, (directive) => `${directive} ${originValue}`);
  const config = {
    version: priorVersion,
    build: { beforeBuildCommand: "" },
    app: {
      windows: [{ ...windowConfig, visible: false, focus: false, maximized: true }],
      security: { ...baseConfig.app.security, csp: smokeCsp },
    },
    bundle: {
      ...releaseConfig.bundle,
      targets: ["app"],
      createUpdaterArtifacts: false,
    },
    plugins: {
      updater: {
        ...baseConfig.plugins.updater,
        endpoints: [`${originValue}/latest.json`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(packagePath, `${JSON.stringify({ ...packageJson, version: priorVersion }, null, 2)}\n`);
  await writeFile(cargoPath, cargoToml.replace(
    /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m,
    (_match, prefix, suffix) => `${prefix}${priorVersion}${suffix}`,
  ));
  const invokeBridge = await installPriorInvokeBridge(worktree);
  const injected = inject ? await injectPriorRenderer(worktree, originValue, expectedVersion) : {};
  return { configPath, packagePath, cargoPath, effectiveVersion: priorVersion, ...invokeBridge, ...injected };
}

async function writeStatus(statusPath, state) {
  await writeFile(statusPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(statusPath, 0o600);
}

async function serveArtifact(response, artifactPath, request) {
  const metadata = await stat(artifactPath);
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", "application/gzip");
  if (!range) {
    response.writeHead(200, { "Content-Length": metadata.size });
    if (request.method === "HEAD") return response.end();
    return createReadStream(artifactPath).pipe(response);
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), metadata.size - 1) : metadata.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= metadata.size) {
    response.writeHead(416, { "Content-Range": `bytes */${metadata.size}` });
    return response.end();
  }
  response.writeHead(206, {
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${metadata.size}`,
  });
  if (request.method === "HEAD") return response.end();
  return createReadStream(artifactPath, { start, end }).pipe(response);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert.ok(size <= 64 * 1024, "Packaged updater smoke event is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function pathWithin(root, relativePath) {
  assert.equal(isAbsolute(relativePath), false, `Expected a relative path: ${relativePath}`);
  const path = resolve(root, relativePath);
  const fromRoot = relative(resolve(root), path);
  assert.ok(fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
  return path;
}

export async function verifyPreparedUpdateTransaction(
  dataRoot,
  fromVersion,
  toVersion,
  { expectedPhase = "awaiting_restart" } = {},
) {
  const transaction = JSON.parse(await readFile(join(dataRoot, "update-transactions", "current.json"), "utf8"));
  assert.equal(transaction.phase, expectedPhase);
  assert.equal(transaction.fromAppVersion, fromVersion);
  assert.equal(transaction.toAppVersion, toVersion);
  assert.equal(transaction.fromStudioSchema, 6);
  assert.equal(transaction.targetStudioSchema, 8);
  const currentBytes = await readFile(join(dataRoot, "workspace", "workspace-state-v1.json"));
  const snapshotBytes = await readFile(pathWithin(dataRoot, transaction.snapshotPath));
  const manifestBytes = await readFile(pathWithin(dataRoot, transaction.assetManifestPath));
  assert.deepEqual(snapshotBytes, currentBytes, "The native pre-update snapshot did not preserve the exact v6 envelope bytes.");
  assert.equal(sha256(snapshotBytes), transaction.snapshotChecksum);
  assert.equal(sha256(manifestBytes), transaction.assetManifestChecksum);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.checksum, payloadChecksum(snapshot.payload));
  assert.equal(snapshot.payload.schemaVersion, 6);
  const imageThread = snapshot.payload.sessions
    .flatMap((session) => session.threads.image)
    .find((thread) => thread.id === "phase3-image-thread");
  assert.deepEqual(imageThread?.draft?.directorPlan, PACKAGED_UPDATE_DIRECTOR_PLAN);
  assert.deepEqual(imageThread?.attempts?.find((attempt) => attempt.id === "phase3-image-attempt")?.snapshot?.directorPlan,
    PACKAGED_UPDATE_DIRECTOR_PLAN);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const expectedManifest = await readExpectedAssetManifest();
  assert.equal(manifest.schemaVersion, expectedManifest.schemaVersion);
  assert.deepEqual(
    comparableManifestEntries(manifest, "The native managed-asset manifest"),
    comparableManifestEntries(expectedManifest, "The expected managed-asset manifest"),
    "The native managed-asset manifest entries differ from the complete expected fixture set.",
  );
  for (const entry of manifest.entries) {
    const assetBytes = await readFile(pathWithin(dataRoot, entry.relativePath));
    assert.equal(assetBytes.length, entry.byteSize);
    assert.equal(sha256(assetBytes), entry.sha256);
  }
  return transaction;
}

export async function runLocalUpdaterServer({
  port,
  artifactPath,
  signaturePath,
  dataRoot,
  statusPath,
  fromVersion,
  toVersion,
}) {
  assertIsolatedDataRoot(dataRoot, dirname(dataRoot));
  const origin = `http://127.0.0.1:${port}`;
  const artifactName = basename(artifactPath);
  const signature = await readFile(signaturePath, "utf8");
  const manifest = createLocalUpdaterManifest({ version: toVersion, origin, artifactName, signature });
  const state = {
    ready: false,
    preInstallTransactionVerified: false,
    preRelaunchTransactionVerified: false,
    events: [],
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    try {
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        return response.end();
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/latest.json") {
        const bytes = Buffer.from(JSON.stringify(manifest));
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": bytes.length });
        return request.method === "HEAD" ? response.end() : response.end(bytes);
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === `/${encodeURIComponent(artifactName)}`) {
        return await serveArtifact(response, artifactPath, request);
      }
      if (request.method === "POST" && url.pathname === "/events") {
        const event = JSON.parse(await readBody(request));
        assert.equal(typeof event.type, "string");
        state.events.push(event);
        if (event.type === "driver-error") {
          state.error = `Packaged updater driver failed: ${String(event.detail?.message ?? "unknown error")}`;
        }
        await writeStatus(statusPath, state);
        response.writeHead(204);
        return response.end();
      }
      if (request.method === "POST" && url.pathname === "/prepared") {
        assert.equal(state.events.some((event) => event.type === "updater-install-started"), true,
          "The pre-install check ran before the updater invocation was requested.");
        const transaction = await verifyPreparedUpdateTransaction(dataRoot, fromVersion, toVersion, {
          expectedPhase: "downloading",
        });
        state.preInstallTransactionVerified = true;
        state.events.push({
          type: "pre-install-transaction-verified",
          detail: { transactionId: transaction.id },
          at: new Date().toISOString(),
        });
        await writeStatus(statusPath, state);
        response.writeHead(204);
        return response.end();
      }
      if (request.method === "POST" && url.pathname === "/installed") {
        assert.equal(state.events.some((event) => event.type === "updater-install-finished"), true,
          "The pre-relaunch check ran before the real updater install completed.");
        const transaction = await verifyPreparedUpdateTransaction(dataRoot, fromVersion, toVersion);
        state.preRelaunchTransactionVerified = true;
        state.events.push({
          type: "pre-relaunch-transaction-verified",
          detail: { transactionId: transaction.id },
          at: new Date().toISOString(),
        });
        await writeStatus(statusPath, state);
        response.writeHead(204);
        return response.end();
      }
      response.writeHead(404);
      response.end("Not found");
    } catch (error) {
      state.error = error instanceof Error ? error.stack : String(error);
      await writeStatus(statusPath, state).catch(() => {});
      response.writeHead(500);
      response.end(state.error);
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolvePromise);
  });
  state.ready = true;
  await writeStatus(statusPath, state);
  process.stdout.write(`Packaged updater smoke server listening on ${origin}.\n`);
  return { server, origin, manifest };
}

async function managedAssetHashes(dataRoot) {
  const manifest = await readExpectedAssetManifest();
  const values = [];
  for (const entry of manifest.entries) {
    const path = pathWithin(dataRoot, entry.relativePath);
    const bytes = await readFile(path);
    assert.equal(bytes.length, entry.byteSize, `Managed asset size changed: ${entry.relativePath}`);
    assert.equal(sha256(bytes), entry.sha256, `Managed asset bytes changed: ${entry.relativePath}`);
    values.push({ relativePath: entry.relativePath, sha256: entry.sha256 });
  }
  return values;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function collectPackagedUpdateInvariants(payload) {
  assert.ok(payload && typeof payload === "object" && Array.isArray(payload.sessions));
  const invariants = {
    sessionIds: [],
    threadIds: [],
    assetIds: [],
    attemptIds: [],
    enhancementAttemptIds: [],
    costLedgerIds: [],
    providerJobIds: [],
    localPaths: [],
  };
  for (const session of payload.sessions) {
    invariants.sessionIds.push(session.id);
    for (const asset of session.assets ?? []) {
      invariants.assetIds.push(asset.id);
      if (typeof asset.localPath === "string") invariants.localPaths.push(asset.localPath);
      else if (typeof asset.externalUrl === "string" && /^(?:\/|[A-Za-z]:[\\/])/.test(asset.externalUrl)) {
        invariants.localPaths.push(asset.externalUrl);
      }
      if (typeof asset.jobId === "string" && asset.jobId) invariants.providerJobIds.push(asset.jobId);
    }
    for (const entry of session.costLedger ?? []) invariants.costLedgerIds.push(entry.id);
    for (const job of session.activeVideoJobs ?? []) {
      if (typeof job.jobId === "string" && job.jobId) invariants.providerJobIds.push(job.jobId);
    }
    for (const mode of ["image", "video"]) {
      for (const thread of session.threads?.[mode] ?? []) {
        invariants.threadIds.push(thread.id);
        for (const attempt of thread.attempts ?? []) {
          invariants.attemptIds.push(attempt.id);
          if (typeof attempt.jobId === "string" && attempt.jobId) invariants.providerJobIds.push(attempt.jobId);
        }
        for (const attempt of thread.enhancementAttempts ?? []) {
          invariants.enhancementAttemptIds.push(attempt.id);
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(invariants).map(([name, values]) => [name, sortedUnique(values)]));
}

export async function verifyPackagedUpdate({ dataRoot, statusPath, fromVersion, toVersion }) {
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(status.error, undefined, status.error);
  assert.equal(status.preInstallTransactionVerified, true);
  assert.equal(status.preRelaunchTransactionVerified, true);
  const eventTypes = status.events.map((event) => event.type);
  for (const required of [
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
  ]) {
    assert.ok(eventTypes.includes(required), `Missing packaged updater event: ${required}`);
  }
  const order = [
    "updater-install-started",
    "pre-install-transaction-verified",
    "updater-install-finished",
    "restart-intercepted",
    "pre-relaunch-transaction-verified",
  ];
  const indexes = order.map((type) => eventTypes.indexOf(type));
  assert.deepEqual(indexes, [...indexes].sort((left, right) => left - right),
    "The updater install and restart events were not ordered.");

  const transaction = JSON.parse(await readFile(join(dataRoot, "update-transactions", "current.json"), "utf8"));
  assert.equal(transaction.phase, "complete");
  assert.equal(transaction.fromAppVersion, fromVersion);
  assert.equal(transaction.toAppVersion, toVersion);
  assert.equal(transaction.fromStudioSchema, 6);
  assert.equal(transaction.targetStudioSchema, 8);

  const snapshot = JSON.parse(await readFile(pathWithin(dataRoot, transaction.snapshotPath), "utf8"));
  const workspace = JSON.parse(await readFile(join(dataRoot, "workspace", "workspace-state-v1.json"), "utf8"));
  assert.equal(workspace.schema_version, 1);
  assert.match(workspace.checksum, /^[0-9a-f]{64}$/);
  assert.equal(workspace.checksum, payloadChecksum(workspace.payload));
  assert.equal(workspace.payload.schemaVersion, 8);
  assert.equal(workspace.payload.activeSessionId, "phase3-session-v6");
  const beforeInvariants = collectPackagedUpdateInvariants(snapshot.payload);
  const afterInvariants = collectPackagedUpdateInvariants(workspace.payload);
  for (const name of Object.keys(beforeInvariants)) {
    assert.deepEqual(afterInvariants[name], beforeInvariants[name], `Protected workspace invariant changed: ${name}.`);
  }
  const session = workspace.payload.sessions.find((item) => item.id === "phase3-session-v6");
  assert.ok(session);
  const imageThread = session.threads.image.find((thread) => thread.id === "phase3-image-thread");
  assert.ok(imageThread);
  assert.deepEqual(imageThread.draft.directorPlan, PACKAGED_UPDATE_DIRECTOR_PLAN);
  assert.deepEqual(imageThread.attempts.find((attempt) => attempt.id === "phase3-image-attempt")?.snapshot?.directorPlan,
    PACKAGED_UPDATE_DIRECTOR_PLAN);
  const promptTexts = imageThread.draft.promptHistory.entries.map((entry) => entry.text);
  assert.ok(promptTexts.includes("Use @1 as the exact fruit truck identity in a roadside portrait."));
  assert.ok(promptTexts.includes("Use @1 as the exact red fruit truck identity, parked at a sunlit roadside market with legible painted produce signs."));
  const activeAttempt = session.threads.video
    .flatMap((thread) => thread.attempts)
    .find((attempt) => attempt.id === "phase3-video-attempt-active");
  assert.equal(activeAttempt?.status, "in_progress");
  assert.equal(activeAttempt?.jobId, "provider-video-job-phase3");
  const assets = await managedAssetHashes(dataRoot);
  return {
    transactionId: transaction.id,
    schemaVersion: workspace.payload.schemaVersion,
    assets,
    eventTypes,
    invariants: afterInvariants,
  };
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  if (command === "select-prior") {
    const releases = JSON.parse(await readFile(resolve(option("releases") ?? ""), "utf8"));
    const result = selectPriorReleaseTag(releases, option("to-version") ?? "");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "prepare-source") {
    const dataRoot = resolve(option("data-root") ?? "");
    const report = await preparePackagedUpdateSource(dataRoot);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (command === "prepare-prior") {
    const result = await preparePriorBundle(
      resolve(option("worktree") ?? ""),
      option("origin") ?? "",
      option("from-version") ?? "",
      option("to-version") ?? "",
      { inject: false },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "inject-prior") {
    const result = await injectPriorRenderer(
      resolve(option("worktree") ?? ""),
      option("origin") ?? "",
      option("to-version") ?? "",
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "serve") {
    await runLocalUpdaterServer({
      port: Number(option("port")),
      artifactPath: resolve(option("artifact") ?? ""),
      signaturePath: resolve(option("signature") ?? ""),
      dataRoot: resolve(option("data-root") ?? ""),
      statusPath: resolve(option("status") ?? ""),
      fromVersion: option("from-version") ?? "",
      toVersion: option("to-version") ?? "",
    });
    return;
  }
  if (command === "verify") {
    const report = await verifyPackagedUpdate({
      dataRoot: resolve(option("data-root") ?? ""),
      statusPath: resolve(option("status") ?? ""),
      fromVersion: option("from-version") ?? "",
      toVersion: option("to-version") ?? "",
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  throw new Error("Usage: packaged-update-smoke.mjs select-prior|prepare-source|prepare-prior|inject-prior|serve|verify [options]");
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
