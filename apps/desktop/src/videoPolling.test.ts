import test from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_POLL_TIMEOUT_MS,
  VIDEO_POLL_INTERVAL_MS,
  createLocalVideoCancelIntent,
  createRemoteVideoRecoveryApi,
  createResilientPollScheduler,
  applyVideoPollDecision,
  decideVideoPollError,
  decideVideoPollResult,
  formatElapsedClock,
  hasVideoPollingTimedOut,
  isVideoPollDue,
  localVideoCancelTransition,
  videoPollRetryDelayMs,
} from "./videoPolling.ts";
import type { GenerationAttempt } from "./studio.ts";

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

test("stop/start does not let an old in-flight poll rearm or duplicate the new generation", async () => {
  const timers = fakeTimers();
  let resolveRun: (() => void) | undefined;
  let cycles = 0;
  const scheduler = createResilientPollScheduler({
    run: () => new Promise<void>((resolve) => {
      cycles += 1;
      resolveRun = resolve;
    }),
    heartbeatMs: 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  scheduler.start();
  timers.fireNext();
  scheduler.stop();
  scheduler.start();
  assert.equal(timers.fireNext(), 0);
  assert.equal(cycles, 1);
  assert.equal(timers.pending.size, 1);
  resolveRun?.();
  await flushAsyncTick();
  assert.equal(timers.pending.size, 1);
  assert.equal(timers.fireNext(), 1_000);
  await flushAsyncTick();
  assert.equal(cycles, 2);
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

test("poll timeout keeps a remote job recoverable instead of making it terminal", () => {
  const now = Date.parse("2026-08-08T10:30:00.000Z");
  const submittedAt = new Date(now - VIDEO_POLL_TIMEOUT_MS).toISOString();
  const decision = decideVideoPollResult({ status: "in_progress", progress: 41 }, submittedAt, now);
  assert.equal(decision.action, "recovery_required");
  assert.equal(decision.shouldAutoPoll, false);
  assert.equal(decision.preserveRemoteJob, true);
  assert.equal(decision.recoveryAction, "requery_remote_status");
  assert.equal(decision.status, "in_progress");

  const terminal = decideVideoPollResult({ status: "completed", progress: 100 }, submittedAt, now);
  assert.equal(terminal.action, "terminal");
  assert.equal(terminal.status, "completed");
  const retry = decideVideoPollError(submittedAt, 2, now);
  assert.equal(retry.action, "recovery_required");
  assert.equal(retry.reason, "transport_timeout");
  const applied = applyVideoPollDecision({
    id: "attempt-1",
    status: "in_progress",
    draftRevision: 0,
    createdAt: submittedAt,
    updatedAt: submittedAt,
    inputAssetIds: [],
    assetIds: [],
    jobId: "job-1",
  } satisfies GenerationAttempt, retry, new Date(now).toISOString());
  assert.equal(applied.status, "in_progress");
  assert.equal(applied.jobId, "job-1");
  assert.equal(applied.errorAction, "requery_remote_status");
  assert.equal(applied.nextPollAt, undefined);
});

test("non-terminal remote polling uses deterministic backoff and preserves status", () => {
  const now = Date.parse("2026-08-08T10:30:00.000Z");
  const decision = decideVideoPollResult({ status: "pending", error: "warming up" }, new Date(now).toISOString(), now);
  assert.equal(decision.action, "continue");
  assert.equal(decision.status, "pending");
  assert.equal(decision.nextPollAt, new Date(now + VIDEO_POLL_INTERVAL_MS).toISOString());
  assert.equal(decision.error, "warming up");
});

test("local cancellation stops tracking while preserving honest remote semantics", () => {
  const local = createLocalVideoCancelIntent("job-1");
  assert.equal(local.localPollingStopped, true);
  assert.equal(local.remoteCancellationRequested, false);
  assert.equal(local.remoteMayContinue, true);
  assert.equal(localVideoCancelTransition("2026-08-08T10:30:00.000Z").errorCode, "local_cancelled");
  assert.equal(localVideoCancelTransition("2026-08-08T10:30:00.000Z").remoteMayContinue, true);
});

test("remote status recovery coalesces duplicate queries and downloads completed results", async () => {
  let queries = 0;
  let downloads = 0;
  let release: ((result: { kind: "video"; jobId: string; status: "completed" }) => void) | undefined;
  const api = createRemoteVideoRecoveryApi({
    queryStatus: () => {
      queries += 1;
      if (queries > 1) return Promise.resolve({ kind: "video", jobId: "job-1", status: "completed" });
      return new Promise((resolve) => { release = resolve; });
    },
    downloadResult: async (jobId: string) => {
      downloads += 1;
      return `file://${jobId}`;
    },
  });
  const first = api.requery(" job-1 ");
  const second = api.requery("job-1");
  assert.equal(first, second);
  assert.equal(queries, 1);
  release?.({ kind: "video", jobId: "job-1", status: "completed" });
  const result = await first;
  assert.equal(result.status, "completed");
  const recovered = await api.recover("job-1");
  assert.equal(recovered.content, "file://job-1");
  assert.equal(downloads, 1);
  assert.equal(queries, 2);
});
