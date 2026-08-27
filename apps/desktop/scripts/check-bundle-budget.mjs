#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

const desktopDirectory = resolve(import.meta.dirname, "..");
const distIndex = process.argv.indexOf("--dist");
const distDirectory = resolve(
  distIndex === -1 ? resolve(desktopDirectory, "dist") : process.argv[distIndex + 1] ?? "",
);
const maxBytes = Number.parseInt(process.env.FRUIT_TRUCK_MAX_JS_BYTES ?? "900000", 10);
const maxGzipBytes = Number.parseInt(process.env.FRUIT_TRUCK_MAX_JS_GZIP_BYTES ?? "300000", 10);

assert.ok(existsSync(distDirectory), `Vite output directory does not exist: ${distDirectory}`);
assert.ok(Number.isInteger(maxBytes) && maxBytes > 0, "FRUIT_TRUCK_MAX_JS_BYTES must be a positive integer.");
assert.ok(Number.isInteger(maxGzipBytes) && maxGzipBytes > 0, "FRUIT_TRUCK_MAX_JS_GZIP_BYTES must be a positive integer.");

const javascriptFiles = [];
function collect(directory) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) collect(path);
    else if (name.endsWith(".js")) javascriptFiles.push(path);
  }
}
collect(distDirectory);
assert.ok(javascriptFiles.length > 0, `No JavaScript assets found below ${distDirectory}`);

const totalBytes = javascriptFiles.reduce((sum, path) => sum + readFileSync(path).byteLength, 0);
const totalGzipBytes = javascriptFiles.reduce((sum, path) => sum + gzipSync(readFileSync(path)).byteLength, 0);
const largest = javascriptFiles
  .map((path) => ({ path, bytes: readFileSync(path).byteLength }))
  .sort((left, right) => right.bytes - left.bytes)[0];

assert.ok(
  totalBytes <= maxBytes,
  `JavaScript bundle budget exceeded: ${totalBytes} bytes > ${maxBytes} bytes (${largest.bytes} bytes largest chunk).`,
);
assert.ok(
  totalGzipBytes <= maxGzipBytes,
  `Gzip JavaScript bundle budget exceeded: ${totalGzipBytes} bytes > ${maxGzipBytes} bytes.`,
);

console.log(
  `JavaScript bundle budget passed: ${totalBytes} bytes (${totalGzipBytes} gzip) across ${javascriptFiles.length} chunks; largest ${largest.bytes} bytes.`,
);
