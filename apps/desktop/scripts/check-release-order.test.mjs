import assert from "node:assert/strict";
import test from "node:test";
import { compareReleaseTags } from "./check-release-order.mjs";

test("release ordering compares semantic core versions", () => {
  assert.equal(compareReleaseTags("v0.6.2", "v0.6.1"), 1);
  assert.equal(compareReleaseTags("v0.6.1", "v0.6.1"), 0);
  assert.equal(compareReleaseTags("v0.5.9", "v0.6.1"), -1);
});

test("rejects tags that the latest-release workflow does not support", () => {
  assert.throws(
    () => compareReleaseTags("v0.7.0-beta.1", "v0.6.1"),
    /Invalid stable release tag/,
  );
  assert.throws(
    () => compareReleaseTags("0.7.0", "v0.6.1"),
    /Invalid stable release tag/,
  );
});
