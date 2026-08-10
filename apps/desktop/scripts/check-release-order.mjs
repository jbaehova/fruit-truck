#!/usr/bin/env node

import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

function parse(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, `Invalid stable release tag: ${tag}`);
  return tag.slice(1).split(".").map(Number);
}

export function compareReleaseTags(leftTag, rightTag) {
  const left = parse(leftTag);
  const right = parse(rightTag);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const targetTag = process.argv[2];
  const latestTag = process.argv[3];
  assert.ok(
    targetTag && latestTag,
    "Usage: check-release-order.mjs TARGET_TAG LATEST_TAG",
  );
  assert.ok(
    compareReleaseTags(targetTag, latestTag) > 0,
    `Release tag ${targetTag} must be newer than current latest ${latestTag}.`,
  );
  console.log(
    `Release order is valid: ${targetTag} is newer than ${latestTag}.`,
  );
}
