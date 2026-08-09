export const VIDEO_POLL_HEARTBEAT_MS = 1_000;
export const VIDEO_POLL_INTERVAL_MS = 10_000;
export const VIDEO_POLL_TIMEOUT_MS = 30 * 60_000;

type TimerHandle = number;

export type PollScheduler = {
  start: () => void;
  stop: () => void;
  wake: () => void;
};

export function createResilientPollScheduler({
  run,
  onError,
  heartbeatMs = VIDEO_POLL_HEARTBEAT_MS,
  initialDelayMs = 0,
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (handle) => window.clearTimeout(handle),
}: {
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
  heartbeatMs?: number;
  initialDelayMs?: number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}): PollScheduler {
  let active = false;
  let running = false;
  let timer: TimerHandle | undefined;

  const clearScheduled = () => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };
  const schedule = (delay: number) => {
    if (!active) return;
    clearScheduled();
    timer = setTimer(() => {
      timer = undefined;
      void tick();
    }, Math.max(0, delay));
  };
  const tick = async () => {
    if (!active) return;
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        // An observer must never be able to stop the scheduler.
      }
    } finally {
      running = false;
      schedule(heartbeatMs);
    }
  };

  return {
    start() {
      if (active) return;
      active = true;
      schedule(initialDelayMs);
    },
    stop() {
      active = false;
      clearScheduled();
    },
    wake() {
      if (!active) return;
      if (running) return;
      schedule(0);
    },
  };
}

export function isVideoPollDue(nextPollAt: string | undefined, nowMs = Date.now()): boolean {
  if (!nextPollAt) return true;
  const next = Date.parse(nextPollAt);
  return !Number.isFinite(next) || next <= nowMs;
}

export function hasVideoPollingTimedOut(submittedAt: string, nowMs = Date.now()): boolean {
  const submitted = Date.parse(submittedAt);
  return Number.isFinite(submitted) && nowMs - submitted >= VIDEO_POLL_TIMEOUT_MS;
}

export function videoPollRetryDelayMs(previousAttempts: number): number {
  return Math.min(60_000, 4_000 * 2 ** Math.min(4, Math.max(0, previousAttempts)));
}

export function formatElapsedClock(startedAt: string | undefined, nowMs = Date.now()): string {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const totalSeconds = Number.isFinite(started) ? Math.max(0, Math.floor((nowMs - started) / 1_000)) : 0;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
