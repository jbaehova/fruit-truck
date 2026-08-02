import assert from "node:assert/strict";
import test from "node:test";
import {
  materializeAgentSession,
  recoverBridgeGenerationState,
  serializeAgentSessionForBridge,
  validBridgeSession,
  type AgentBridgeSession,
} from "./agentBridge.ts";
import { createSession } from "./studio.ts";

test("bridge generation recovery preserves a session while isolating malformed optional state", () => {
  const session = createSession("Recovery");
  const thread = session.threads.image[0];
  const now = new Date().toISOString();
  thread.draft.references = [{ assetId: "missing", slot: 1, role: "reference" }];
  thread.attempts.push({
    id: "attempt-malformed",
    status: "failed",
    backend: "openrouter",
    draftRevision: 0,
    requestedBy: "agent",
    createdAt: now,
    updatedAt: now,
    inputAssetIds: ["missing"],
    assetIds: ["missing"],
    request: { input: "data:image/png;base64,AAAA" },
  });
  const bridge = {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    mode: session.mode,
    generationDefaults: session.generationDefaults,
    threads: session.threads,
    activeThreadIds: { image: "missing-thread", video: session.activeThreadIds.video },
    assets: [],
    agent: session.agent,
  } as AgentBridgeSession;
  (bridge.threads!.image[0].attempts[0] as unknown as { status: string }).status = "future-status";

  const recovered = recoverBridgeGenerationState(bridge);
  const recoveredThread = recovered.threads!.image[0];
  const recoveredAttempt = recoveredThread.attempts[0];
  assert.equal(recovered.activeThreadIds!.image, recoveredThread.id);
  assert.deepEqual(recoveredThread.draft.references, []);
  assert.equal(recoveredAttempt.status, "uncertain");
  assert.match(recoveredAttempt.error ?? "", /unsupported attempt status/i);
  assert.deepEqual(recoveredAttempt.inputAssetIds, []);
  assert.deepEqual(recoveredAttempt.assetIds, []);
  assert.equal(recoveredAttempt.request, undefined);
});

test("validBridgeSession rejects duplicate and malformed thread state", () => {
  const session = createSession("Validation");
  const validBridge = {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    mode: session.mode,
    generationDefaults: session.generationDefaults,
    threads: session.threads,
    activeThreadIds: session.activeThreadIds,
    assets: session.assets,
    agent: session.agent,
  } satisfies AgentBridgeSession;

  assert.equal(validBridgeSession(validBridge), true);

  const duplicateThreads = structuredClone(validBridge);
  duplicateThreads.threads.image.push({ ...duplicateThreads.threads.image[0] });
  assert.equal(validBridgeSession(duplicateThreads), false);

  const malformedAttempts = structuredClone(validBridge);
  (malformedAttempts.threads.video[0] as { attempts?: unknown }).attempts = null;
  assert.equal(validBridgeSession(malformedAttempts), false);

  const malformedDraft = structuredClone(validBridge);
  (malformedDraft.threads.image[0] as { draft?: unknown }).draft = null;
  assert.equal(validBridgeSession(malformedDraft), false);
});

test("serializeAgentSessionForBridge preserves in-progress video attempt polling metadata without legacy jobs", async () => {
  const session = createSession("Round trip");
  const now = new Date().toISOString();
  const nextPollAt = new Date(Date.now() + 15_000).toISOString();
  session.mode = "video";
  session.threads.video[0].attempts.push({
    id: "attempt-in-progress",
    status: "in_progress",
    backend: "openrouter",
    draftRevision: 0,
    requestedBy: "agent",
    createdAt: now,
    updatedAt: now,
    submittedAt: now,
    modelId: "openrouter/video-model",
    inputAssetIds: [],
    assetIds: [],
    jobId: "job-round-trip",
    progress: 42,
    pollAttempts: 3,
    lastPolledAt: now,
    nextPollAt,
    request: { model: "openrouter/video-model" },
  });

  const serialized = await serializeAgentSessionForBridge(session);
  assert.equal("jobs" in serialized, false);
  assert.equal("activeVideoJobs" in serialized, false);

  const attempt = serialized.threads?.video[0]?.attempts.find((item) => item.id === "attempt-in-progress");
  assert.ok(attempt);
  assert.equal(attempt.status, "in_progress");
  assert.equal(attempt.jobId, "job-round-trip");
  assert.equal(attempt.progress, 42);
  assert.equal(attempt.pollAttempts, 3);
  assert.equal(attempt.lastPolledAt, now);
  assert.equal(attempt.nextPollAt, nextPollAt);

  const materialized = materializeAgentSession(serialized);
  assert.equal("jobs" in materialized, false);
  assert.equal("activeVideoJobs" in materialized, false);
  const roundTripped = materialized.threads.video[0].attempts.find((item) => item.id === "attempt-in-progress");
  assert.ok(roundTripped);
  assert.equal(roundTripped.status, "in_progress");
  assert.equal(roundTripped.jobId, "job-round-trip");
  assert.equal(roundTripped.progress, 42);
  assert.equal(roundTripped.pollAttempts, 3);
  assert.equal(roundTripped.lastPolledAt, now);
  assert.equal(roundTripped.nextPollAt, nextPollAt);
});
