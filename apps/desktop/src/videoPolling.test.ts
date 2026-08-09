import test from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_POLL_TIMEOUT_MS,
  createResilientPollScheduler,
  formatElapsedClock,
  hasVideoPollingTimedOut,
  isVideoPollDue,
  videoPollRetryDelayMs,
} from "./videoPolling.ts";

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
      assert.ok(entry, "expected a scheduled timer");
      pending.delete(entry[0]);
      entry[1].callback();
      return entry[1].delay;
    },
  };
}

async function flushAsyncTick() {
  await Promise.resolve();
  await Promise.resolve();
}

test("poll scheduler always rearms after an empty or successful cycle", async () => {
  const timers = fakeTimers();
  let cycles = 0;
  const scheduler = createResilientPollScheduler({
    run: async () => { cycles += 1; },
    heartbeatMs: 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.start();
  assert.equal(timers.fireNext(), 0);
  await flushAsyncTick();
  assert.equal(cycles, 1);
  assert.equal(timers.fireNext(), 1_000);
  await flushAsyncTick();
  assert.equal(cycles, 2);
  assert.equal(timers.pending.size, 1);
  scheduler.stop();
  assert.equal(timers.pending.size, 0);
});

test("poll scheduler survives failures and observer failures", async () => {
  const timers = fakeTimers();
  let cycles = 0;
  const scheduler = createResilientPollScheduler({
    run: async () => {
      cycles += 1;
      throw new Error("temporary failure");
    },
    onError: () => { throw new Error("observer failure"); },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.start();
  timers.fireNext();
  await flushAsyncTick();
  assert.equal(cycles, 1);
  assert.equal(timers.pending.size, 1);
  scheduler.stop();
});

test("wake during an active poll does not duplicate the request", async () => {
  const timers = fakeTimers();
  let resolveRun: (() => void) | undefined;
  let cycles = 0;
  const scheduler = createResilientPollScheduler({
    run: () => new Promise<void>((resolve) => {
      cycles += 1;
      resolveRun = resolve;
    }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.start();
  timers.fireNext();
  scheduler.wake();
  assert.equal(cycles, 1);
  assert.equal(timers.pending.size, 0);
  resolveRun?.();
  await flushAsyncTick();
  assert.equal(timers.pending.size, 1);
  scheduler.stop();
});

test("video poll timing handles due, retry, timeout, and elapsed display", () => {
  const now = Date.parse("2026-08-08T10:30:00.000Z");
  assert.equal(isVideoPollDue(undefined, now), true);
  assert.equal(isVideoPollDue("invalid", now), true);
  assert.equal(isVideoPollDue("2026-08-08T10:30:01.000Z", now), false);
  assert.equal(isVideoPollDue("2026-08-08T10:29:59.000Z", now), true);
  assert.equal(hasVideoPollingTimedOut(new Date(now - VIDEO_POLL_TIMEOUT_MS + 1).toISOString(), now), false);
  assert.equal(hasVideoPollingTimedOut(new Date(now - VIDEO_POLL_TIMEOUT_MS).toISOString(), now), true);
  assert.equal(videoPollRetryDelayMs(0), 4_000);
  assert.equal(videoPollRetryDelayMs(4), 60_000);
  assert.equal(videoPollRetryDelayMs(99), 60_000);
  assert.equal(formatElapsedClock("2026-08-08T10:26:54.500Z", now), "3:05");
  assert.equal(formatElapsedClock("2026-08-08T09:27:57.000Z", now), "1:02:03");
});
