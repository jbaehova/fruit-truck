import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRangeValue } from "./optionValues.ts";

test("range options clamp out-of-range values and omit invalid input", () => {
  assert.equal(normalizeRangeValue("2", 1, 1), 1);
  assert.equal(normalizeRangeValue("-4", 0, 100), 0);
  assert.equal(normalizeRangeValue("64", 0, 100), 64);
  assert.equal(normalizeRangeValue("", 1, 4), undefined);
  assert.equal(normalizeRangeValue("not-a-number", 1, 4), undefined);
});
