import assert from "node:assert/strict";
import test from "node:test";
import {
  activeDurableOperationCount,
  applyPersistedAttemptRecovery,
  availableAttemptActions,
  decidePaidRequestRetry,
  planPersistedAttemptRecovery,
  reconcilePersistedAttempts,
  recoveryMetadataForPlan,
  sessionDeletionDecision,
  stableAttemptIdempotencyKey,
} from "./attemptRecovery.ts";
import { createSession, type GenerationAttempt, type StudioState } from "./studio.ts";

const NOW = "2026-08-27T12:00:00.000Z";

function attempt(overrides: Partial<GenerationAttempt> = {}): GenerationAttempt {
  return {
    id: "attempt-1",
    status: "in_progress",
    draftRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    modelId: "provider/video",
    inputAssetIds: [],
    assetIds: [],
    snapshot: {
      mode: "video",
      modelId: "provider/video",
      prompt: "secret prompt",
      enhancePrompt: false,
      enhancedPrompt: "",
      options: {},
      providerJson: "",
      assetBindings: [],
      imageEditMode: false,
      imageEditTarget: "",
      maskInstructions: "",
      maskStrokes: [],
    },
    ...overrides,
  };
}

function stateWithAttempts(attempts: GenerationAttempt[]): StudioState {
  const session = createSession("Recovery test");
  session.threads.video[0].attempts = attempts;
  return {
    schemaVersion: 6,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    sessions: [session],
  };
}

test("startup recovery resumes durable video jobs without clearing their id", () => {
  const source = attempt({ status: "submitting", jobId: "job-42", nextPollAt: "2020-01-01T00:00:00.000Z" });
  const plan = planPersistedAttemptRecovery(source);
  assert.equal(plan.action, "resume_remote_poll");
  assert.equal(plan.shouldResumePolling, true);
  const next = applyPersistedAttemptRecovery(source, plan, NOW);
  assert.equal(next.status, "in_progress");
  assert.equal(next.jobId, "job-42");
  assert.equal(next.nextPollAt, NOW);
  assert.equal(next.error, undefined);
  assert.deepEqual(recoveryMetadataForPlan(plan, NOW), {
    classification: "video_job_resumable",
    previousStatus: "submitting",
    classifiedAt: NOW,
    resumable: true,
    retryable: false,
  });
});

test("startup recovery marks missing submission ids uncertain instead of retrying", () => {
  const source = attempt({ status: "submitting", jobId: undefined });
  const plan = planPersistedAttemptRecovery(source);
  assert.equal(plan.action, "mark_submission_uncertain");
  assert.equal(plan.duplicateChargeRisk, true);
  const next = applyPersistedAttemptRecovery(source, plan, NOW);
  assert.equal(next.status, "uncertain");
  assert.equal(next.errorCode, "submission_uncertain");
  assert.equal(next.errorAction, "requery_remote_or_retry_with_confirmation");
});

test("interrupted enhancement becomes an explicit retryable terminal attempt", () => {
  const source = attempt({ status: "enhancing" });
  const plan = planPersistedAttemptRecovery(source);
  assert.equal(plan.action, "mark_enhancement_interrupted");
  const next = applyPersistedAttemptRecovery(source, plan, NOW);
  assert.equal(next.status, "failed");
  assert.equal(next.errorCode, "enhancement_interrupted");
  assert.equal(next.errorAction, "retry_snapshot");
  assert.equal(next.snapshot?.prompt, source.snapshot?.prompt);
});

test("reconciliation visits all sessions and leaves terminal attempts unchanged", () => {
  const completed = attempt({ status: "completed", id: "done" });
  const active = attempt({ status: "in_progress", id: "active", jobId: "job-1" });
  const uncertain = attempt({ status: "submitting", id: "uncertain" });
  const source = stateWithAttempts([completed, active, uncertain]);
  const result = reconcilePersistedAttempts(source, NOW);
  assert.equal(result.changes.length, 2);
  const nextAttempts = result.state.sessions[0].threads.video[0].attempts;
  assert.equal(nextAttempts[0].status, "completed");
  assert.equal(nextAttempts[1].status, "in_progress");
  assert.equal(nextAttempts[1].nextPollAt, NOW);
  assert.equal(nextAttempts[2].status, "uncertain");
  assert.equal(source.sessions[0].threads.video[0].attempts[1].nextPollAt, undefined);
});

test("session deletion is blocked while a remote result remains recoverable", () => {
  const active = stateWithAttempts([attempt({ jobId: "job-active" })]);
  const decision = sessionDeletionDecision(active.sessions[0]);
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.blockingJobs.map((job) => job.jobId), ["job-active"]);

  const completed = stateWithAttempts([attempt({ status: "completed", jobId: "job-done", assetIds: ["asset-1"] })]);
  assert.equal(sessionDeletionDecision(completed.sessions[0]).allowed, true);
});

test("update safety counts image, video, and enhancement operations across every session", () => {
  const source = stateWithAttempts([
    attempt({ id: "video-active", status: "in_progress", jobId: "job-active" }),
  ]);
  source.sessions[0].threads.image[0].attempts = [attempt({ id: "image-active", status: "submitting", jobId: undefined })];
  source.sessions[0].threads.image[0].enhancementAttempts = [{
    id: "enhancement-active",
    requestKey: "enhance:active",
    status: "in_progress",
    threadRevision: 1,
    originalPrompt: "prompt",
    createdAt: NOW,
    updatedAt: NOW,
  }];
  const terminalSession = createSession("Terminal session");
  terminalSession.threads.image[0].attempts = [attempt({ id: "done", status: "completed" })];
  source.sessions.push(terminalSession);
  assert.equal(activeDurableOperationCount(source), 3);
});

test("history actions expose honest local tracking and remote recovery without unsupported cancellation", () => {
  const actions = availableAttemptActions(attempt({ status: "uncertain", jobId: "job-1" }));
  assert.deepEqual(actions, [
    "requery_remote_status",
    "download_remote_result",
    "restore_snapshot",
    "retry_snapshot",
  ]);
});

test("paid POST transport failures become uncertain unless idempotency is guaranteed", () => {
  const uncertain = decidePaidRequestRetry({
    method: "POST",
    attemptId: "attempt-1",
    status: 503,
  });
  assert.equal(uncertain.action, "mark_uncertain");
  assert.equal(uncertain.automatic, false);

  const safe = decidePaidRequestRetry({
    method: "POST",
    attemptId: "attempt-1",
    transportFailure: true,
    idempotencyGuaranteed: true,
  });
  assert.equal(safe.action, "retry");
  assert.equal(safe.idempotencyKey, "fruit-truck-attempt:attempt-1");

  const rejected = decidePaidRequestRetry({ method: "POST", status: 422, accepted: false });
  assert.equal(rejected.action, "fail");
});

test("stable attempt keys are deterministic and reject missing ids", () => {
  assert.equal(stableAttemptIdempotencyKey(" attempt-7 "), "fruit-truck-attempt:attempt-7");
  assert.throws(() => stableAttemptIdempotencyKey("  "), /attempt id/);
});
