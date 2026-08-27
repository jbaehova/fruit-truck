import type {
  GenerationAttempt,
  GenerationAttemptStatus,
  GenerationThread,
  StudioSession,
  StudioState,
} from "./studio.ts";

/** Attempt states which no longer block a thread from being used. */
export const TERMINAL_ATTEMPT_STATUSES = [
  "completed",
  "failed",
  "uncertain",
  "canceled",
] as const satisfies readonly GenerationAttemptStatus[];

export type AttemptRecoveryAction =
  | "none"
  | "resume_remote_poll"
  | "mark_submission_uncertain"
  | "mark_enhancement_interrupted";

export type AttemptRecoveryClassification =
  | "terminal"
  | "video_job_resumable"
  | "submission_uncertain"
  | "enhancement_interrupted";

export type AttemptRecoveryPlan = {
  attemptId: string;
  previousStatus: GenerationAttemptStatus;
  nextStatus: GenerationAttemptStatus;
  action: AttemptRecoveryAction;
  classification: AttemptRecoveryClassification;
  reason: string;
  remoteJobId?: string;
  shouldResumePolling: boolean;
  requiresUserConfirmation: boolean;
  duplicateChargeRisk: boolean;
  retrySnapshotAvailable: boolean;
};

export function isTerminalAttemptStatus(status: GenerationAttemptStatus): boolean {
  return (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(status);
}

export function isAttemptRecoverable(attempt: Pick<GenerationAttempt, "status" | "jobId">): boolean {
  // A local cancellation or an old timeout is terminal in the local ledger,
  // but its durable remote job id still provides a recovery path.
  return Boolean(attempt.jobId) && attempt.status !== "completed";
}

/**
 * Decide what to do with one attempt left in a non-terminal state at startup.
 *
 * A job id is an explicit handoff to the remote video queue. An attempt with
 * no job id is deliberately not retried: the provider may have accepted the
 * paid request even when the response was lost.
 */
export function planPersistedAttemptRecovery(attempt: Pick<
  GenerationAttempt,
  "id" | "status" | "jobId" | "snapshot"
>): AttemptRecoveryPlan {
  const base = {
    attemptId: attempt.id,
    previousStatus: attempt.status,
    remoteJobId: attempt.jobId,
    shouldResumePolling: false,
    requiresUserConfirmation: false,
    duplicateChargeRisk: false,
    retrySnapshotAvailable: Boolean(attempt.snapshot),
  };

  if (isTerminalAttemptStatus(attempt.status)) {
    return {
      ...base,
      nextStatus: attempt.status,
      action: "none",
      classification: "terminal",
      reason: "Attempt is already terminal.",
    };
  }

  if (attempt.status === "enhancing") {
    return {
      ...base,
      nextStatus: "failed",
      action: "mark_enhancement_interrupted",
      classification: "enhancement_interrupted",
      reason: "Prompt enhancement stopped before a generation request was submitted.",
      requiresUserConfirmation: false,
    };
  }

  if (attempt.jobId) {
    return {
      ...base,
      nextStatus: "in_progress",
      action: "resume_remote_poll",
      classification: "video_job_resumable",
      reason: "The remote video job id is durable and can be queried again.",
      shouldResumePolling: true,
    };
  }

  return {
    ...base,
    nextStatus: "uncertain",
    action: "mark_submission_uncertain",
    classification: "submission_uncertain",
    reason: "The request may have been accepted, but no durable remote job id was recorded.",
    requiresUserConfirmation: true,
    duplicateChargeRisk: true,
  };
}

export function applyPersistedAttemptRecovery(
  attempt: GenerationAttempt,
  plan = planPersistedAttemptRecovery(attempt),
  now = new Date().toISOString(),
): GenerationAttempt {
  if (plan.action === "none") return attempt;

  const updated: GenerationAttempt = { ...attempt, updatedAt: now };
  if (plan.action === "resume_remote_poll") {
    return {
      ...updated,
      status: "in_progress",
      nextPollAt: now,
      error: undefined,
      errorCode: undefined,
      errorAction: undefined,
      errorDetails: undefined,
    };
  }

  if (plan.action === "mark_enhancement_interrupted") {
    return {
      ...updated,
      status: "failed",
      completedAt: now,
      nextPollAt: undefined,
      error: "Prompt enhancement was interrupted before generation. Retry the saved snapshot to continue.",
      errorCode: "enhancement_interrupted",
      errorAction: "retry_snapshot",
      errorDetails: plan.reason,
    };
  }

  return {
    ...updated,
    status: "uncertain",
    completedAt: now,
    nextPollAt: undefined,
    error: "The request may have been accepted before the connection was lost. Check its remote status before retrying.",
    errorCode: "submission_uncertain",
    errorAction: "requery_remote_or_retry_with_confirmation",
    errorDetails: plan.reason,
  };
}

export type AttemptRecoveryMetadata = {
  classification: Exclude<AttemptRecoveryClassification, "terminal">;
  previousStatus: GenerationAttemptStatus;
  classifiedAt: string;
  resumable: boolean;
  retryable: boolean;
};

export function recoveryMetadataForPlan(
  plan: AttemptRecoveryPlan,
  classifiedAt = new Date().toISOString(),
): AttemptRecoveryMetadata | undefined {
  if (plan.classification === "terminal") return undefined;
  return {
    classification: plan.classification,
    previousStatus: plan.previousStatus,
    classifiedAt,
    resumable: plan.classification === "video_job_resumable",
    retryable: plan.classification === "enhancement_interrupted",
  };
}

export type ReconciledAttempt = {
  sessionId: string;
  threadId: string;
  plan: AttemptRecoveryPlan;
  attempt: GenerationAttempt;
};

export type StudioReconciliation = {
  state: StudioState;
  changes: ReconciledAttempt[];
};

/** Reconcile every persisted attempt without performing network or storage I/O. */
export function reconcilePersistedAttempts(
  state: StudioState,
  now = new Date().toISOString(),
): StudioReconciliation {
  const changes: ReconciledAttempt[] = [];
  const sessions = state.sessions.map((session) => {
    const threadsByMode = {
      image: session.threads.image.map((thread) => reconcileThread(session.id, thread, now, changes)),
      video: session.threads.video.map((thread) => reconcileThread(session.id, thread, now, changes)),
    };
    return { ...session, threads: threadsByMode };
  });
  return {
    state: changes.length ? { ...state, sessions } : state,
    changes,
  };
}

function reconcileThread(
  sessionId: string,
  thread: GenerationThread,
  now: string,
  changes: ReconciledAttempt[],
): GenerationThread {
  let changed = false;
  const attempts = thread.attempts.map((attempt) => {
    const plan = planPersistedAttemptRecovery(attempt);
    if (plan.action === "none") return attempt;
    changed = true;
    const next = applyPersistedAttemptRecovery(attempt, plan, now);
    changes.push({ sessionId, threadId: thread.id, plan, attempt: next });
    return next;
  });
  return changed ? { ...thread, attempts, updatedAt: now } : thread;
}

export type RecoverableRemoteAttempt = {
  sessionId: string;
  threadId: string;
  attemptId: string;
  jobId: string;
  status: GenerationAttemptStatus;
  modelId?: string;
  submittedAt?: string;
};

/**
 * Return jobs that remain addressable after a session/thread disappears.
 * Keeping terminal attempts with a job id in this list is intentional: a
 * locally canceled or previously timed-out attempt may still finish remotely.
 */
export function recoverableRemoteAttempts(
  state: Pick<StudioState, "sessions">,
): RecoverableRemoteAttempt[] {
  return state.sessions.flatMap((session) => recoverableRemoteAttemptsInSession(session));
}

export function recoverableRemoteAttemptsInSession(
  session: Pick<StudioSession, "id" | "threads">,
): RecoverableRemoteAttempt[] {
  return session.threads.video.flatMap((thread) => thread.attempts.flatMap((attempt) => {
    if (!attempt.jobId || attempt.status === "completed") return [];
    return [{
      sessionId: session.id,
      threadId: thread.id,
      attemptId: attempt.id,
      jobId: attempt.jobId,
      status: attempt.status,
      modelId: attempt.snapshot?.modelId ?? attempt.modelId,
      submittedAt: attempt.submittedAt,
    }];
  }));
}

export type SessionDeletionDecision = {
  allowed: boolean;
  blockingJobs: RecoverableRemoteAttempt[];
  reason?: "active_remote_jobs";
};

/** Session deletion must not strand a remote job or its cost ledger. */
export function sessionDeletionDecision(
  session: Pick<StudioSession, "id" | "threads">,
): SessionDeletionDecision {
  const blockingJobs = recoverableRemoteAttemptsInSession(session).filter((job) =>
    job.status === "submitting"
      || job.status === "in_progress"
      || job.status === "uncertain"
      || job.status === "canceled"
      || job.status === "failed",
  );
  return blockingJobs.length
    ? { allowed: false, blockingJobs, reason: "active_remote_jobs" }
    : { allowed: true, blockingJobs: [] };
}

/** Count every local or remote operation that must settle before relaunch. */
export function activeDurableOperationCount(state: Pick<StudioState, "sessions">): number {
  return state.sessions.reduce((total, session) => total + [
    ...session.threads.image,
    ...session.threads.video,
  ].reduce((threadTotal, thread) => threadTotal
    + thread.attempts.filter((attempt) => !isTerminalAttemptStatus(attempt.status)).length
    + (thread.enhancementAttempts ?? []).filter((attempt) => attempt.status === "in_progress").length, 0), 0);
}

export type AttemptAction =
  | "cancel_local"
  | "requery_remote_status"
  | "download_remote_result"
  | "restore_snapshot"
  | "retry_snapshot";

/** Actions available to a recovery/history surface, independent of UI. */
export function availableAttemptActions(
  attempt: Pick<GenerationAttempt, "status" | "jobId" | "snapshot" | "assetIds">,
): AttemptAction[] {
  const actions: AttemptAction[] = [];
  if (!isTerminalAttemptStatus(attempt.status)) actions.push("cancel_local");
  if (attempt.jobId) {
    actions.push("requery_remote_status", "download_remote_result");
  }
  if (attempt.snapshot) {
    actions.push("restore_snapshot");
    if (attempt.status === "failed" || attempt.status === "uncertain" || attempt.status === "canceled") {
      actions.push("retry_snapshot");
    }
  }
  return actions;
}

export type PaidRequestMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";

export type PaidRequestFailure = {
  method: PaidRequestMethod;
  attemptId?: string;
  status?: number;
  /** Explicitly true only when the transport reports that the request was accepted. */
  accepted?: boolean;
  /** Set when the failure is a timeout, connection drop, abort, or unknown response. */
  transportFailure?: boolean;
  error?: unknown;
  idempotencyGuaranteed?: boolean;
};

export type PaidRequestRetryDecision = {
  action: "retry" | "fail" | "mark_uncertain";
  automatic: boolean;
  reason: string;
  idempotencyKey?: string;
};

export function stableAttemptIdempotencyKey(attemptId: string): string {
  const normalized = attemptId.trim();
  if (!normalized) throw new Error("An attempt id is required for an idempotency key.");
  return `fruit-truck-attempt:${normalized}`;
}

export function statusFromRequestError(error: unknown): number | undefined {
  if (typeof error === "number" && Number.isInteger(error)) return error;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = message.match(/\b([45]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

export function isTransientRequestFailure(status: number | undefined, transportFailure = false): boolean {
  return transportFailure || status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

/**
 * Paid POSTs are never automatically retried unless the provider contract
 * explicitly guarantees idempotency. Unknown acceptance is surfaced as an
 * uncertain attempt so a user can requery or deliberately retry a snapshot.
 */
export function decidePaidRequestRetry(input: PaidRequestFailure): PaidRequestRetryDecision {
  const status = input.status ?? statusFromRequestError(input.error);
  const transient = isTransientRequestFailure(status, input.transportFailure === true);
  const methodIsSafe = input.method === "GET" || input.method === "HEAD" || input.method === "OPTIONS";
  if (!transient) {
    return {
      action: "fail",
      automatic: false,
      reason: input.accepted === false
        ? "The provider rejected the request before it was accepted."
        : "The request failed with a non-transient error.",
    };
  }

  if (methodIsSafe) {
    return {
      action: "retry",
      automatic: true,
      reason: "The request method is safe to retry after a transient failure.",
    };
  }

  if (input.idempotencyGuaranteed && input.attemptId) {
    return {
      action: "retry",
      automatic: true,
      reason: "The provider guarantees idempotency for the stable attempt key.",
      idempotencyKey: stableAttemptIdempotencyKey(input.attemptId),
    };
  }

  return {
    action: "mark_uncertain",
    automatic: false,
    reason: "A paid POST may have been accepted; automatic retry could create a duplicate charge.",
  };
}
