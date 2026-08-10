#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const landingSource = readText("apps/landing/src/main.ts");
const landingHtml = readText("apps/landing/index.html");

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(cargoVersion, "Could not read the desktop Cargo package version.");
assert.equal(packageJson.version, tauriConfig.version, "package.json and tauri.conf.json versions differ.");
assert.equal(cargoVersion, tauriConfig.version, "Cargo.toml and tauri.conf.json versions differ.");

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
for (const binary of [
  "target/bundled-tools/ffmpeg",
  "target/bundled-tools/ffprobe",
  "target/bundled-tools/fruit-truckd",
]) {
  assert.ok(externalBins.has(binary), `Release bundle is missing external binary: ${binary}`);
}
assert.equal(
  releaseConfig.bundle?.resources?.["target/bundled-tools/licenses/"],
  "licenses/",
  "Release bundle is not packaging the FFmpeg license directory.",
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

const downloadUrl = "https://github.com/jbaehova/fruit-truck/releases/latest/download/Fruit-Truck-macOS-universal.dmg";
assert.ok(landingSource.includes(`const DOWNLOAD_URL = "${downloadUrl}"`), "Landing-page runtime download URL changed.");
assert.ok(landingHtml.includes(`href="${downloadUrl}"`), "Landing-page fallback download URL changed.");

console.log(`Release contract is valid for Fruit Truck v${tauriConfig.version} and FFmpeg ${ffmpegValues.FFMPEG_VERSION}.`);
