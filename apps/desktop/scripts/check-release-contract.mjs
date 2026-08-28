#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const repositoryRootIndex = process.argv.indexOf("--repository-root");
const providedRepositoryRoot = repositoryRootIndex === -1 ? undefined : process.argv[repositoryRootIndex + 1];
if (repositoryRootIndex !== -1) assert.ok(providedRepositoryRoot, "--repository-root requires a value.");
const repositoryDirectory = providedRepositoryRoot === undefined
  ? resolve(desktopDirectory, "../..")
  : resolve(providedRepositoryRoot);
const readText = (path) => readFileSync(resolve(repositoryDirectory, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));

const packageJson = readJson("apps/desktop/package.json");
const tauriConfig = readJson("apps/desktop/src-tauri/tauri.conf.json");
const releaseConfig = readJson("apps/desktop/src-tauri/tauri.release.conf.json");
const cargoToml = readText("apps/desktop/src-tauri/Cargo.toml");
const ffmpegEnvironment = readText("apps/desktop/scripts/ffmpeg-version.env");
const mediaBuildScript = readText("apps/desktop/scripts/build-ffmpeg-macos.sh");
const releaseWorkflow = readText(".github/workflows/release.yml");
const supportDocs = readText("docs/SUPPORT.md");
const workflowFiles = readdirSync(resolve(repositoryDirectory, ".github/workflows"))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort()
  .map((name) => [name, readText(`.github/workflows/${name}`)]);

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(cargoVersion, "Could not read the desktop Cargo package version.");
assert.equal(packageJson.version, tauriConfig.version, "package.json and tauri.conf.json versions differ.");
assert.equal(cargoVersion, tauriConfig.version, "Cargo.toml and tauri.conf.json versions differ.");

const csp = tauriConfig.app?.security?.csp ?? "";
assert.ok(!csp.includes("https://openrouter.ai"), "Production renderer CSP still permits direct OpenRouter connections.");
for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
  assert.ok(csp.includes(directive), `Production renderer CSP is missing ${directive}.`);
}

const runnerPath = resolve(repositoryDirectory, "run.sh");
assert.ok(existsSync(runnerPath), "The tracked source-tree runner is missing.");
assert.ok((statSync(runnerPath).mode & 0o111) !== 0, "run.sh must be executable.");
assert.match(readText("run.sh"), /ffprobe/, "run.sh does not document the source-tree FFprobe requirement.");
assert.ok(!readText(".gitignore").split(/\r?\n/).includes("run.sh"), "run.sh is still ignored instead of tracked.");

const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1];
  assert.ok(tag, "--tag requires a value.");
  assert.match(tag, /^v\d+\.\d+\.\d+$/, "Release tag must be a stable v-prefixed semantic version.");
  assert.equal(tag, `v${tauriConfig.version}`, "Release tag does not match the desktop version.");
}

assert.equal(tauriConfig.bundle?.createUpdaterArtifacts, true, "Tauri updater artifacts are not enabled.");
const updater = tauriConfig.plugins?.updater;
assert.deepEqual(
  updater?.endpoints,
  ["https://github.com/jbaehova/fruit-truck/releases/latest/download/latest.json"],
  "The desktop updater endpoint no longer points at the latest GitHub Release.",
);
assert.ok(updater?.pubkey, "The updater public key is missing.");
const decodedPublicKey = Buffer.from(updater.pubkey, "base64").toString("utf8");
assert.match(decodedPublicKey, /minisign public key/i, "The updater public key is not a valid encoded minisign public key.");

const externalBins = new Set(releaseConfig.bundle?.externalBin ?? []);
assert.deepEqual(
  [...externalBins],
  ["target/bundled-tools/ffprobe"],
  "Release bundle must contain FFprobe and no removed sidecars.",
);
assert.equal(
  releaseConfig.bundle?.resources?.["target/bundled-tools/licenses/"],
  "licenses/",
  "Release bundle is not packaging the FFmpeg license directory.",
);
for (const removedPath of [
  "agent-kit",
  "apps/desktop/src/agent.ts",
  "apps/desktop/src/agentBridge.ts",
  "apps/desktop/src/components/AssemblyDialog.tsx",
  "apps/desktop/src-tauri/src/core_client.rs",
  "apps/desktop/src-tauri/crates/fruit-truck-cli",
  "apps/desktop/src-tauri/crates/fruit-truck-core",
  "apps/desktop/src-tauri/crates/fruit-truck-protocol",
  "apps/desktop/src-tauri/crates/fruit-truckd",
]) {
  assert.equal(existsSync(resolve(repositoryDirectory, removedPath)), false, `Removed path still exists: ${removedPath}`);
}
const nativeSource = readText("apps/desktop/src-tauri/src/lib.rs");
for (const removedCommand of ["assemble_video", "read_agent_sessions", "commit_agent_operations", "report_desktop_runtime"]) {
  assert.ok(!nativeSource.includes(removedCommand), `Removed native command is still exposed: ${removedCommand}`);
}
assert.match(
  releaseWorkflow,
  /prepare-macos-release-assets\.sh/,
  "The release workflow does not prepare the self-contained Apple Silicon assets.",
);
assert.match(releaseWorkflow, /runs-on: macos-15/, "The release workflow is not pinned to the Apple Silicon runner.");
assert.match(
  releaseWorkflow,
  /--target aarch64-apple-darwin/,
  "The release workflow does not build the Apple Silicon target.",
);
for (const unsupportedReleaseValue of ["macos-15-intel", "x86_64-apple-darwin", "universal-apple-darwin"]) {
  assert.ok(
    !releaseWorkflow.includes(unsupportedReleaseValue),
    `The release workflow still contains unsupported architecture work: ${unsupportedReleaseValue}`,
  );
}
assert.equal(
  packageJson.scripts?.["bundle:mac"],
  "bash scripts/build-macos-apple-silicon.sh",
  "The macOS bundle command must use the complete Apple Silicon release path.",
);

const ffmpegValues = Object.fromEntries(
  ffmpegEnvironment
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("=", 2)),
);
assert.match(ffmpegValues.FFMPEG_VERSION ?? "", /^\d+\.\d+(?:\.\d+)?$/, "Pinned FFmpeg version is invalid.");
assert.match(ffmpegValues.FFMPEG_SHA256 ?? "", /^[0-9a-f]{64}$/, "Pinned FFmpeg SHA-256 is invalid.");
assert.equal(
  ffmpegValues.FFMPEG_SOURCE_URL,
  `https://ffmpeg.org/releases/ffmpeg-${ffmpegValues.FFMPEG_VERSION}.tar.xz`,
  "Pinned FFmpeg source URL and version differ.",
);
assert.match(mediaBuildScript, /--disable-ffmpeg/, "The release media build still enables the removed FFmpeg program.");
assert.ok(!mediaBuildScript.includes('INSTALL_DIR}/bin/ffmpeg"'), "The release media build still copies the removed FFmpeg program.");

assert.match(releaseWorkflow, /verify-github-release\.sh/, "Release workflow does not run the GitHub release verifier.");
assert.deepEqual(
  workflowFiles.map(([name]) => name),
  ["release.yml"],
  "Only the macOS release workflow should remain enabled.",
);

for (const [workflowName, workflow] of workflowFiles) {
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s@]+)@([^\s#]+)\s*$/gm)) {
    assert.match(match[2], /^[0-9a-f]{40}$/, `${workflowName} uses mutable action ref ${match[1]}@${match[2]}.`);
  }
}

assert.equal(packageJson.scripts?.["check:bundle"], "node scripts/check-bundle-budget.mjs", "Bundle budget script is not wired.");
assert.equal(packageJson.scripts?.["check:licenses"], "node scripts/check-dependency-licenses.mjs", "License policy script is not wired.");
assert.equal(packageJson.scripts?.sbom, "node scripts/generate-sbom.mjs", "SBOM script is not wired.");
assert.match(packageJson.scripts?.["test:coverage"] ?? "", /test-coverage-lines=/, "Node coverage thresholds are not configured.");
assert.match(supportDocs, /\/api\/v1\/images/, "Support matrix is missing the image endpoint.");
assert.match(supportDocs, /\/api\/v1\/videos/, "Support matrix is missing the video endpoint.");
assert.match(supportDocs, /\/api\/v1\/chat\/completions/, "Support matrix is missing the planner endpoint.");
assert.match(supportDocs, /not.*general-purpose chat/i, "Support matrix does not limit chat scope.");

assert.match(
  releaseWorkflow,
  /releaseAssetNamePattern: Fruit-Truck-macOS-universal\[ext\]/,
  "The stable GitHub Release asset name changed.",
);
assert.match(
  releaseWorkflow,
  /releases\/latest\/download\/Fruit-Truck-macOS-universal\.dmg/,
  "The permanent GitHub Release DMG URL changed.",
);
assert.match(
  releaseWorkflow,
  /releases\/download\/\$RELEASE_TAG\/Fruit-Truck-macOS-universal\.dmg/,
  "The version-specific DMG link is missing from generated release notes.",
);
assert.match(releaseWorkflow, /## Download/, "The release body is missing its download section.");

console.log(`Release contract is valid for Fruit Truck v${tauriConfig.version} and FFmpeg ${ffmpegValues.FFMPEG_VERSION}.`);
