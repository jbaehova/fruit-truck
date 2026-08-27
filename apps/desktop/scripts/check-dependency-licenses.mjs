#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const desktopDirectory = resolve(import.meta.dirname, "..");
const lockfile = JSON.parse(readFileSync(resolve(desktopDirectory, "package-lock.json"), "utf8"));

// Keep this allowlist deliberately small. A new transitive license should be
// reviewed and added explicitly instead of silently entering a release.
const allowedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MPL-2.0",
  "OFL-1.1",
]);

const violations = [];
for (const [location, packageInfo] of Object.entries(lockfile.packages ?? {})) {
  if (!location.startsWith("node_modules/")) continue;
  const packageName = location.slice("node_modules/".length);
  const expression = typeof packageInfo.license === "string" ? packageInfo.license.trim() : "";
  if (!expression) {
    violations.push(`${packageName}@${packageInfo.version ?? "unknown"}: missing SPDX license`);
    continue;
  }

  // package-lock records SPDX expressions such as "Apache-2.0 OR MIT". Every
  // alternative must remain in the reviewed set; AND/parentheses are retained
  // as expression syntax and do not expand the allowlist.
  const identifiers = expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((identifier) => identifier.trim())
    .filter(Boolean);
  for (const identifier of identifiers) {
    if (!allowedLicenses.has(identifier)) {
      violations.push(`${packageName}@${packageInfo.version ?? "unknown"}: ${expression}`);
      break;
    }
  }
}

assert.deepEqual(violations, [], `Dependency license policy failed:\n${violations.join("\n")}`);

const metadata = spawnSync(
  "cargo",
  ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--format-version", "1", "--locked"],
  { cwd: desktopDirectory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
assert.equal(metadata.status, 0, `cargo metadata failed:\n${metadata.stderr || metadata.stdout}`);
const cargoMetadata = JSON.parse(metadata.stdout);

// These are the SPDX identifiers present in the locked Rust graph. Keep this
// list explicit so a new transitive license fails CI for review.
const allowedCargoLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "LGPL-2.1-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OpenSSL",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "Zlib",
]);

const cargoViolations = [];
for (const packageInfo of cargoMetadata.packages ?? []) {
  // The application package is not redistributed as a crate. Its own license
  // is tracked by the product/legal documentation, while every dependency is
  // required to expose a reviewed SPDX expression for the release SBOM.
  if (packageInfo.name === "fruit-truck") continue;
  const expression = typeof packageInfo.license === "string" ? packageInfo.license.trim() : "";
  if (!expression) {
    cargoViolations.push(`${packageInfo.name}@${packageInfo.version}: missing SPDX license`);
    continue;
  }

  for (const identifier of cargoLicenseIdentifiers(expression)) {
    if (!allowedCargoLicenses.has(identifier)) {
      cargoViolations.push(`${packageInfo.name}@${packageInfo.version}: ${expression}`);
      break;
    }
  }
}

assert.deepEqual(cargoViolations, [], `Cargo dependency license policy failed:\n${cargoViolations.join("\n")}`);
console.log(
  `Dependency license policy passed for ${Object.keys(lockfile.packages ?? {}).filter((name) => name.startsWith("node_modules/")).length} npm packages and ${(cargoMetadata.packages ?? []).filter(({ name }) => name !== "fruit-truck").length} Cargo dependencies.`,
);

function cargoLicenseIdentifiers(expression) {
  return expression
    .replace(/\s+WITH\s+[A-Za-z0-9.-]+/gi, "")
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+|\s*\/\s*/i)
    .map((identifier) => identifier.trim())
    .filter(Boolean);
}
