#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = dirname(root);
const compatibility = JSON.parse(await readFile(join(root, "compatibility.json"), "utf8"));
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const desktopManifest = JSON.parse(await readFile(join(repository, "apps", "desktop", "package.json"), "utf8"));

const numeric = (value) => value.split(".").map((item) => Number(item));
const compare = (left, right) => {
  const a = numeric(left);
  const b = numeric(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
};

if (packageManifest.version !== compatibility.agentKitVersion) {
  throw new Error(`Agent Kit package ${packageManifest.version} does not match compatibility manifest ${compatibility.agentKitVersion}.`);
}
if (compare(desktopManifest.version, compatibility.desktop.minimum) < 0
  || compare(desktopManifest.version, compatibility.desktop.maximumExclusive) >= 0) {
  throw new Error(`Desktop ${desktopManifest.version} is outside the supported Agent Kit range.`);
}
if (compatibility.desktop.bridgeSchemaVersion !== 1) {
  throw new Error("This Agent Kit build supports only bridge schema version 1.");
}
process.stdout.write(`Agent Kit ${packageManifest.version} is compatible with desktop ${desktopManifest.version}.\n`);
