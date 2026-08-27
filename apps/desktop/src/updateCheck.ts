export const UPDATE_CHECK_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

/** A successful `null` result is cached just like an available update. */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60_000;

export function createRetryableCheck<T>(check: () => Promise<T>) {
  let current: Promise<T> | null = null;

  return () => {
    if (current === null) {
      const attempt = Promise.resolve().then(check);
      current = attempt;
      void attempt.catch(() => {
        if (current === attempt) current = null;
      });
    }
    return current;
  };
}

export type UpdateCheckTrigger = "startup" | "focus" | "online" | "manual" | "retry";

export type UpdateCheckStatus = "idle" | "checking" | "available" | "current" | "offline" | "error";

export type UpdateCheckState<T> = {
  status: UpdateCheckStatus;
  value: T | null;
  lastCheckedAt: number | null;
  lastAttemptAt: number | null;
  consecutiveFailures: number;
  nextRetryAt: number | null;
  lastTrigger: UpdateCheckTrigger | null;
  lastError?: unknown;
};

type TimerHandle = number;

export type UpdateCheckController<T> = {
  check: (options?: { force?: boolean; trigger?: UpdateCheckTrigger }) => Promise<T | null>;
  manualCheck: () => Promise<T | null>;
  onFocus: () => Promise<T | null>;
  onOnline: () => Promise<T | null>;
  isDue: (nowMs?: number) => boolean;
  getState: () => UpdateCheckState<T>;
  subscribe: (listener: (state: UpdateCheckState<T>) => void) => () => void;
  dispose: () => void;
};

export type UpdateCheckControllerOptions<T> = {
  check: () => Promise<T | null>;
  ttlMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  isOnline?: () => boolean;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export function isUpdateCheckDue(
  lastCheckedAt: number | null | undefined,
  nowMs = Date.now(),
  ttlMs = UPDATE_CHECK_TTL_MS,
): boolean {
  if (lastCheckedAt == null || !Number.isFinite(lastCheckedAt)) return true;
  const ttl = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : UPDATE_CHECK_TTL_MS;
  return nowMs - lastCheckedAt >= ttl;
}

/**
 * A lifecycle-aware update checker. It coalesces requests, caches both
 * available and up-to-date results, retries transient failures on a bounded
 * schedule, and remains manually retryable after the schedule is exhausted.
 */
export function createUpdateCheckController<T>({
  check,
  ttlMs = UPDATE_CHECK_TTL_MS,
  retryDelaysMs = UPDATE_CHECK_RETRY_DELAYS_MS,
  now = () => Date.now(),
  isOnline = () => true,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
  clearTimer = (handle) => globalThis.clearTimeout(handle),
}: UpdateCheckControllerOptions<T>): UpdateCheckController<T> {
  let state: UpdateCheckState<T> = {
    status: "idle",
    value: null,
    lastCheckedAt: null,
    lastAttemptAt: null,
    consecutiveFailures: 0,
    nextRetryAt: null,
    lastTrigger: null,
  };
  let current: Promise<T | null> | null = null;
  let retryTimer: TimerHandle | undefined;
  let disposed = false;
  const listeners = new Set<(next: UpdateCheckState<T>) => void>();

  const publish = (next: UpdateCheckState<T>) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // Observers must not affect the check state machine.
      }
    }
  };
  const clearRetry = () => {
    if (retryTimer === undefined) return;
    clearTimer(retryTimer);
    retryTimer = undefined;
  };
  const scheduleRetry = (failureCount: number) => {
    const delay = retryDelaysMs[Math.max(0, failureCount - 1)];
    if (delay === undefined || disposed) {
      publish({ ...state, nextRetryAt: null });
      return;
    }
    const nextRetryAt = now() + Math.max(0, delay);
    publish({ ...state, nextRetryAt });
    clearRetry();
    retryTimer = setTimer(() => {
      retryTimer = undefined;
      void runCheck({ force: true, trigger: "retry" }).catch(() => undefined);
    }, Math.max(0, delay));
  };
  const runCheck = ({ force = false, trigger = "startup" as UpdateCheckTrigger } = {}): Promise<T | null> => {
    if (disposed) return Promise.resolve(state.value);
    if (current) return current;
    const nowMs = now();
    if (!force && !isUpdateCheckDue(state.lastCheckedAt, nowMs, ttlMs)) return Promise.resolve(state.value);
    if (!force && state.nextRetryAt != null && nowMs < state.nextRetryAt) return Promise.resolve(state.value);
    if (!isOnline()) {
      publish({ ...state, status: "offline", lastTrigger: trigger, nextRetryAt: null });
      return Promise.resolve(state.value);
    }
    if (trigger === "manual") clearRetry();
    publish({ ...state, status: "checking", lastAttemptAt: nowMs, lastTrigger: trigger, nextRetryAt: null, lastError: undefined });
    const attempt = Promise.resolve().then(check);
    current = attempt;
    const settled = attempt.then((value) => {
      if (current === settled) current = null;
      if (disposed) return value;
      clearRetry();
      publish({
        ...state,
        status: value == null ? "current" : "available",
        value,
        lastCheckedAt: now(),
        consecutiveFailures: 0,
        nextRetryAt: null,
        lastError: undefined,
      });
      return value;
    }, (error: unknown) => {
      if (current === settled) current = null;
      if (disposed) throw error;
      const failures = state.consecutiveFailures + 1;
      publish({
        ...state,
        status: isOnline() ? "error" : "offline",
        consecutiveFailures: failures,
        lastError: error,
      });
      scheduleRetry(failures);
      throw error;
    });
    current = settled;
    return settled;
  };
  const checkNow = (trigger: UpdateCheckTrigger, force = false) => runCheck({ trigger, force });
  const maybeCheck = (trigger: "focus" | "online") => {
    if (!isOnline()) {
      publish({ ...state, status: "offline", lastTrigger: trigger });
      return Promise.resolve(state.value);
    }
    return checkNow(trigger).catch(() => state.value);
  };

  return {
    check: (options) => runCheck(options),
    manualCheck: () => checkNow("manual", true),
    onFocus: () => maybeCheck("focus"),
    onOnline: () => maybeCheck("online"),
    isDue: (nowMs = now()) => isUpdateCheckDue(state.lastCheckedAt, nowMs, ttlMs),
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearRetry();
      listeners.clear();
    },
  };
}

export type UpdateCheckEventSource = {
  addEventListener: (type: "focus" | "online", listener: () => void) => void;
  removeEventListener: (type: "focus" | "online", listener: () => void) => void;
};

/** Attach focus/online lifecycle events without requiring a browser in tests. */
export function bindUpdateCheckLifecycle(
  controller: Pick<UpdateCheckController<unknown>, "onFocus" | "onOnline">,
  source: UpdateCheckEventSource,
): () => void {
  const onFocus = () => { void controller.onFocus(); };
  const onOnline = () => { void controller.onOnline(); };
  source.addEventListener("focus", onFocus);
  source.addEventListener("online", onOnline);
  return () => {
    source.removeEventListener("focus", onFocus);
    source.removeEventListener("online", onOnline);
  };
}

export type UpdateInstallBlocker = "active_attempts" | "durable_save_pending" | "durable_save_failed";

export type UpdateInstallGate = {
  allowed: boolean;
  activeAttemptCount: number;
  blockers: UpdateInstallBlocker[];
  requiresDurableFlush: boolean;
  reason?: UpdateInstallBlocker;
};

export type UpdateInstallSnapshot = {
  activeAttemptCount: number;
  durableSavePending: boolean;
  durableSaveError?: unknown;
};

export function evaluateUpdateInstallGate(snapshot: UpdateInstallSnapshot): UpdateInstallGate {
  const activeAttemptCount = Number.isFinite(snapshot.activeAttemptCount)
    ? Math.max(0, Math.floor(snapshot.activeAttemptCount))
    : 0;
  const blockers: UpdateInstallBlocker[] = [];
  if (activeAttemptCount > 0) blockers.push("active_attempts");
  if (snapshot.durableSaveError != null) blockers.push("durable_save_failed");
  else if (snapshot.durableSavePending) blockers.push("durable_save_pending");
  return {
    allowed: blockers.length === 0,
    activeAttemptCount,
    blockers,
    requiresDurableFlush: snapshot.durableSavePending,
    reason: blockers[0],
  };
}

export type PrepareUpdateInstallOptions = {
  getActiveAttemptCount: () => number;
  isDurableSavePending: () => boolean;
  flushDurableSave?: () => Promise<void>;
  getDurableSaveError?: () => unknown;
};

/**
 * Check the install gates immediately before download/relaunch. A save flush
 * is awaited and the active-attempt count is checked again to avoid racing a
 * generation that starts while an update dialog is open.
 */
export async function prepareUpdateInstall({
  getActiveAttemptCount,
  isDurableSavePending,
  flushDurableSave,
  getDurableSaveError,
}: PrepareUpdateInstallOptions): Promise<UpdateInstallGate> {
  const initial = evaluateUpdateInstallGate({
    activeAttemptCount: getActiveAttemptCount(),
    durableSavePending: isDurableSavePending(),
    durableSaveError: getDurableSaveError?.(),
  });
  if (initial.blockers.includes("active_attempts") || initial.blockers.includes("durable_save_failed")) return initial;
  if (initial.blockers.includes("durable_save_pending")) {
    if (!flushDurableSave) return initial;
    try {
      await flushDurableSave();
    } catch (error) {
      return evaluateUpdateInstallGate({
        activeAttemptCount: getActiveAttemptCount(),
        durableSavePending: true,
        durableSaveError: error,
      });
    }
  }
  return evaluateUpdateInstallGate({
    activeAttemptCount: getActiveAttemptCount(),
    durableSavePending: isDurableSavePending(),
    durableSaveError: getDurableSaveError?.(),
  });
}
