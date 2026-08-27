import assert from "node:assert/strict";
import test from "node:test";
import {
  UPDATE_CHECK_TTL_MS,
  createRetryableCheck,
  createUpdateCheckController,
  evaluateUpdateInstallGate,
  isUpdateCheckDue,
  prepareUpdateInstall,
} from "./updateCheck.ts";

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

function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  return {
    pending,
    setTimer(callback: () => void, delay: number) {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id: number) {
      pending.delete(id);
    },
    fireNext() {
      const entry = pending.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
      assert.ok(entry);
      pending.delete(entry[0]);
      entry[1].callback();
      return entry[1].delay;
    },
  };
}

async function flush() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test("caches an up-to-date result for the TTL and lets manual checks bypass it", async () => {
  let nowMs = 10_000;
  let calls = 0;
  const controller = createUpdateCheckController({
    check: async () => { calls += 1; return null; },
    now: () => nowMs,
    ttlMs: 1_000,
  });
  assert.equal(await controller.check(), null);
  assert.equal(controller.getState().status, "current");
  assert.equal(calls, 1);
  nowMs += 500;
  assert.equal(await controller.check(), null);
  assert.equal(calls, 1);
  assert.equal(controller.isDue(), false);
  nowMs += 500;
  assert.equal(isUpdateCheckDue(controller.getState().lastCheckedAt, nowMs, 1_000), true);
  await controller.manualCheck();
  assert.equal(calls, 2);
  assert.equal(UPDATE_CHECK_TTL_MS > 0, true);
  controller.dispose();
});

test("offline startup waits for an online lifecycle event", async () => {
  let online = false;
  let calls = 0;
  const controller = createUpdateCheckController({
    check: async () => { calls += 1; return { version: "next" }; },
    isOnline: () => online,
  });
  assert.equal(await controller.check(), null);
  assert.equal(controller.getState().status, "offline");
  online = true;
  const available = await controller.onOnline();
  assert.deepEqual(available, { version: "next" });
  assert.equal(controller.getState().status, "available");
  assert.equal(calls, 1);
  controller.dispose();
});

test("bounded retry state remains manually retryable after scheduled failures", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const controller = createUpdateCheckController({
    check: async () => {
      calls += 1;
      if (calls < 3) throw new Error(`failure-${calls}`);
      return "available";
    },
    retryDelaysMs: [10],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await assert.rejects(controller.check(), /failure-1/);
  assert.equal(timers.pending.size, 1);
  assert.equal(timers.fireNext(), 10);
  await flush();
  assert.match(String(controller.getState().lastError), /failure-2/);
  assert.equal(timers.pending.size, 0);
  assert.equal(controller.getState().status, "error");
  assert.equal(await controller.manualCheck(), "available");
  assert.equal(calls, 3);
  controller.dispose();
});

test("install policy blocks active attempts and flushes pending durable state", async () => {
  assert.deepEqual(evaluateUpdateInstallGate({ activeAttemptCount: 2, durableSavePending: true }).blockers, [
    "active_attempts",
    "durable_save_pending",
  ]);
  assert.equal(evaluateUpdateInstallGate({ activeAttemptCount: 0, durableSavePending: false }).allowed, true);

  let pending = true;
  let flushes = 0;
  const allowed = await prepareUpdateInstall({
    getActiveAttemptCount: () => 0,
    isDurableSavePending: () => pending,
    flushDurableSave: async () => { flushes += 1; pending = false; },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(flushes, 1);

  const blocked = await prepareUpdateInstall({
    getActiveAttemptCount: () => 1,
    isDurableSavePending: () => false,
  });
  assert.deepEqual(blocked.blockers, ["active_attempts"]);
});
