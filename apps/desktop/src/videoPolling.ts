import type { VideoResult, VideoStatus } from "./openrouter.ts";
import type { GenerationAttempt } from "./studio.ts";

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
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number,
  clearTimer = (handle) => globalThis.clearTimeout(handle),
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
  let generation = 0;
  let timer: TimerHandle | undefined;

  const clearScheduled = () => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };
  const schedule = (delay: number, token = generation) => {
    if (!active || token !== generation) return;
    clearScheduled();
    timer = setTimer(() => {
      timer = undefined;
      if (!active || token !== generation) return;
      void tick(token);
    }, Math.max(0, delay));
  };
  const tick = async (token: number) => {
    if (!active || token !== generation) return;
    if (running) {
      // A stop/start can leave the previous request in flight. Keep the new
      // generation alive without issuing a duplicate request.
      schedule(heartbeatMs, token);
      return;
    }
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
      schedule(heartbeatMs, token);
    }
  };

  return {
    start() {
      if (active) return;
      active = true;
      generation += 1;
      schedule(initialDelayMs, generation);
    },
    stop() {
      active = false;
      generation += 1;
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

export type VideoPollDecision =
  | {
      action: "continue";
      status: "pending" | "in_progress";
      nextPollAt: string;
      shouldAutoPoll: true;
      preserveRemoteJob: true;
      progress?: number;
      error?: string;
    }
  | {
      action: "terminal";
      status: "completed" | "failed" | "cancelled" | "expired";
      shouldAutoPoll: false;
      preserveRemoteJob: true;
      progress?: number;
      error?: string;
      actualCostUsd?: number;
    }
  | {
      action: "recovery_required";
      status: "pending" | "in_progress";
      shouldAutoPoll: false;
      preserveRemoteJob: true;
      reason: "poll_timeout" | "transport_timeout";
      /** A recovery action must requery the durable job id before retrying. */
      recoveryAction: "requery_remote_status";
      progress?: number;
      error?: string;
    };

const TERMINAL_VIDEO_STATUSES = ["completed", "failed", "cancelled", "expired"] as const satisfies readonly VideoStatus[];

/**
 * Convert one remote response into a durable state transition.
 *
 * A wall-clock timeout is deliberately not a terminal failure. The provider
 * can keep processing a job after the app's polling budget, so callers must
 * retain the job id and expose a manual status-recovery action.
 */
export function decideVideoPollResult(
  result: Pick<VideoResult, "status" | "progress" | "error" | "actualCostUsd">,
  submittedAt: string,
  nowMs = Date.now(),
): VideoPollDecision {
  if (TERMINAL_VIDEO_STATUSES.includes(result.status as (typeof TERMINAL_VIDEO_STATUSES)[number])) {
    const terminalStatus = result.status as (typeof TERMINAL_VIDEO_STATUSES)[number];
    return {
      action: "terminal",
      status: terminalStatus,
      shouldAutoPoll: false,
      preserveRemoteJob: true,
      progress: result.progress,
      error: result.error,
      actualCostUsd: result.actualCostUsd,
    };
  }
  if (hasVideoPollingTimedOut(submittedAt, nowMs)) {
    return {
      action: "recovery_required",
      status: result.status === "pending" ? "pending" : "in_progress",
      shouldAutoPoll: false,
      preserveRemoteJob: true,
      reason: "poll_timeout",
      recoveryAction: "requery_remote_status",
      progress: result.progress,
      error: result.error,
    };
  }
  return {
    action: "continue",
    status: result.status === "pending" ? "pending" : "in_progress",
    nextPollAt: new Date(nowMs + VIDEO_POLL_INTERVAL_MS).toISOString(),
    shouldAutoPoll: true,
    preserveRemoteJob: true,
    progress: result.progress,
    error: result.error,
  };
}

export function decideVideoPollError(
  submittedAt: string,
  previousAttempts: number,
  nowMs = Date.now(),
): VideoPollDecision {
  if (hasVideoPollingTimedOut(submittedAt, nowMs)) {
    return {
      action: "recovery_required",
      status: "in_progress",
      shouldAutoPoll: false,
      preserveRemoteJob: true,
      reason: "transport_timeout",
      recoveryAction: "requery_remote_status",
    };
  }
  return {
    action: "continue",
    status: "in_progress",
    nextPollAt: new Date(nowMs + videoPollRetryDelayMs(previousAttempts)).toISOString(),
    shouldAutoPoll: true,
    preserveRemoteJob: true,
  };
}

/** Apply a polling decision while retaining the remote id for every branch. */
export function applyVideoPollDecision(
  attempt: GenerationAttempt,
  decision: VideoPollDecision,
  now = new Date().toISOString(),
): GenerationAttempt {
  const base: GenerationAttempt = {
    ...attempt,
    updatedAt: now,
    jobId: attempt.jobId,
  };
  if (decision.action === "continue") {
    return {
      ...base,
      status: "in_progress",
      progress: decision.progress,
      error: decision.error,
      nextPollAt: decision.nextPollAt,
      completedAt: undefined,
    };
  }
  if (decision.action === "recovery_required") {
    return {
      ...base,
      status: "in_progress",
      progress: decision.progress,
      error: decision.error ?? "Remote video polling timed out; the job remains available for status recovery.",
      errorCode: decision.reason,
      errorAction: decision.recoveryAction,
      nextPollAt: undefined,
      completedAt: undefined,
    };
  }
  return {
    ...base,
    status: decision.status === "cancelled" ? "canceled" : decision.status === "expired" ? "failed" : decision.status,
    progress: decision.progress ?? (decision.status === "completed" ? 100 : attempt.progress),
    error: decision.error,
    actualCostUsd: decision.actualCostUsd ?? attempt.actualCostUsd,
    nextPollAt: undefined,
    completedAt: now,
  };
}

export type VideoCancelIntent = {
  scope: "local";
  jobId?: string;
  localPollingStopped: boolean;
  remoteCancellationRequested: boolean;
  remoteMayContinue: boolean;
  recoveryAction: "requery_remote_status" | "none";
};

/** Stop local polling while retaining a remote job for later recovery. */
export function createLocalVideoCancelIntent(jobId?: string): VideoCancelIntent {
  return {
    scope: "local",
    jobId: jobId?.trim() || undefined,
    localPollingStopped: true,
    remoteCancellationRequested: false,
    remoteMayContinue: Boolean(jobId?.trim()),
    recoveryAction: jobId?.trim() ? "requery_remote_status" : "none",
  };
}

export type VideoCancelTransition = {
  attemptStatus: "canceled";
  cancelRequestedAt: string;
  errorCode: "local_cancelled";
  remoteMayContinue: true;
  recoveryAction: "requery_remote_status";
};

/**
 * Map a cancel action to attempt metadata. A local cancel is terminal only in
 * the local history; its job id remains recoverable and is never represented
 * as a provider cancellation.
 */
export function localVideoCancelTransition(
  now = new Date().toISOString(),
): VideoCancelTransition {
  return {
    attemptStatus: "canceled",
    cancelRequestedAt: now,
    errorCode: "local_cancelled",
    remoteMayContinue: true,
    recoveryAction: "requery_remote_status",
  };
}

export type RemoteVideoRecoveryClient<TContent = unknown> = {
  queryStatus: (jobId: string) => Promise<VideoResult>;
  downloadResult?: (jobId: string) => Promise<TContent>;
};

export type RemoteVideoRecoveryResult<TContent = unknown> = {
  jobId: string;
  status: VideoStatus;
  result: VideoResult;
  content?: TContent;
};

export type RemoteVideoRecoveryApi<TContent = unknown> = {
  requery: (jobId: string) => Promise<VideoResult>;
  recover: (jobId: string) => Promise<RemoteVideoRecoveryResult<TContent>>;
};

/**
 * Build a coalescing status/download API for attempt-history recovery. It is
 * transport agnostic so the browser fallback and native bridge can provide
 * their own query/download implementations. OpenRouter does not expose a
 * provider cancellation contract here, so this API deliberately has none.
 */
export function createRemoteVideoRecoveryApi<TContent = unknown>(
  client: RemoteVideoRecoveryClient<TContent>,
): RemoteVideoRecoveryApi<TContent> {
  const inFlightQueries = new Map<string, Promise<VideoResult>>();
  const requery = (jobId: string) => {
    const normalized = normalizeJobId(jobId);
    const existing = inFlightQueries.get(normalized);
    if (existing) return existing;
    const request = client.queryStatus(normalized).finally(() => {
      if (inFlightQueries.get(normalized) === request) inFlightQueries.delete(normalized);
    });
    inFlightQueries.set(normalized, request);
    return request;
  };
  return {
    requery,
    async recover(jobId) {
      const result = await requery(jobId);
      const content = result.status === "completed" && client.downloadResult
        ? await client.downloadResult(normalizeJobId(jobId))
        : undefined;
      return { jobId: normalizeJobId(jobId), status: result.status, result, content };
    },
  };
}

function normalizeJobId(jobId: string): string {
  const normalized = jobId.trim();
  if (!normalized) throw new Error("A remote video job id is required.");
  return normalized;
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
