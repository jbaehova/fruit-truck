import assert from "node:assert/strict";
import test from "node:test";
import { createRetryableCheck } from "./updateCheck.ts";

test("coalesces concurrent update checks", async () => {
  let calls = 0;
  const check = createRetryableCheck(async () => {
    calls += 1;
    return "available";
  });

  const first = check();
  const second = check();

  assert.equal(first, second);
  assert.equal(await first, "available");
  assert.equal(calls, 1);
});

test("allows another update check after a failed attempt", async () => {
  let calls = 0;
  const check = createRetryableCheck(async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return "available";
  });

  await assert.rejects(check(), /offline/);
  assert.equal(await check(), "available");
  assert.equal(calls, 2);
});
