#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const desktopDirectory = resolve(import.meta.dirname, "..");
const outputIndex = process.argv.indexOf("--output");
const outputPath = resolve(
  outputIndex === -1 ? resolve(desktopDirectory, "fruit-truck.cdx.json") : process.argv[outputIndex + 1] ?? "",
);
const packageLock = JSON.parse(readFileSync(resolve(desktopDirectory, "package-lock.json"), "utf8"));

const npmComponents = Object.entries(packageLock.packages ?? {})
  .filter(([location]) => location.startsWith("node_modules/"))
  .map(([location, packageInfo]) => {
    const name = location.slice("node_modules/".length);
    const component = {
      type: "library",
      name,
      version: packageInfo.version,
      scope: "required",
      "bom-ref": `pkg:npm/${encodePurlName(name)}@${packageInfo.version}`,
      purl: `pkg:npm/${encodePurlName(name)}@${packageInfo.version}`,
      licenses: licenseExpression(packageInfo.license),
    };
    const integrity = packageInfo.integrity;
    if (typeof integrity === "string" && integrity.startsWith("sha512-")) {
      component.hashes = [{ alg: "SHA-512", content: Buffer.from(integrity.slice("sha512-"), "base64").toString("hex") }];
    }
    return component;
  });

const metadata = spawnSync(
  "cargo",
  ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--format-version", "1", "--locked"],
  { cwd: desktopDirectory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
assert.equal(metadata.status, 0, `cargo metadata failed:\n${metadata.stderr || metadata.stdout}`);
const cargoMetadata = JSON.parse(metadata.stdout);
const cargoComponents = (cargoMetadata.packages ?? []).map((packageInfo) => ({
  type: packageInfo.name === "fruit-truck" ? "application" : "library",
  group: "crates.io",
  name: packageInfo.name,
  version: packageInfo.version,
  "bom-ref": `pkg:cargo/${encodePurlName(packageInfo.name)}@${packageInfo.version}`,
  purl: `pkg:cargo/${encodePurlName(packageInfo.name)}@${packageInfo.version}`,
  ...(packageInfo.license ? { licenses: licenseExpression(packageInfo.license) } : {}),
}));

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: "fruit-truck",
      version: packageLock.version,
      purl: `pkg:npm/fruit-truck@${packageLock.version}`,
    },
  },
  components: [...npmComponents, ...cargoComponents],
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
console.log(`CycloneDX SBOM written to ${outputPath} (${bom.components.length} components).`);

function encodePurlName(name) {
  return encodeURIComponent(name).replaceAll("%2F", "/");
}

function licenseExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) return undefined;
  const identifiers = expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((identifier) => identifier.trim())
    .filter(Boolean);
  return identifiers.length
    ? identifiers.map((id) => ({ license: { id } }))
    : undefined;
}
