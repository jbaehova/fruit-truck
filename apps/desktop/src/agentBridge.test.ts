import assert from "node:assert/strict";
import test from "node:test";
import {
  materializeAgentSession,
  preserveLocalAssetMetadata,
  recoverAgentBridgeEnvelope,
  recoverBridgeGenerationState,
  serializeAgentSessionForBridge,
  validBridgeSession,
  type AgentBridgeSession,
} from "./agentBridge.ts";
import { createSession } from "./studio.ts";

test("Core asset updates and deletions replace durable metadata without losing local blob handles", () => {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const local = [
    {
      id: "asset-updated", name: "old.png", kind: "image" as const, mimeType: "image/png",
      origin: "generated" as const, createdAt, blobKey: "blob-local", fingerprint: "fingerprint-local",
    },
    {
      id: "asset-deleted", name: "deleted.png", kind: "image" as const, mimeType: "image/png",
      origin: "generated" as const, createdAt, blobKey: "blob-deleted",
    },
  ];
  const incoming = [{
    id: "asset-updated", name: "canonical.png", kind: "image" as const, mimeType: "image/png",
    origin: "generated" as const, createdAt, localPath: "/managed/canonical.png",
  }];

  const merged = preserveLocalAssetMetadata(incoming, local);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "canonical.png");
  assert.equal(merged[0].localPath, "/managed/canonical.png");
  assert.equal(merged[0].blobKey, "blob-local");
  assert.equal(merged[0].fingerprint, "fingerprint-local");
});

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

  const concurrentAttempts = structuredClone(validBridge);
  const createdAt = "2026-01-01T00:00:00.000Z";
  concurrentAttempts.threads.image[0].attempts = ["one", "two"].map((id) => ({
    id: `attempt-${id}`,
    status: "queued" as const,
    backend: "openrouter" as const,
    draftRevision: 0,
    requestedBy: "agent" as const,
    createdAt,
    updatedAt: createdAt,
    inputAssetIds: [],
    assetIds: [],
  }));
  assert.equal(validBridgeSession(concurrentAttempts), false);

  const malformedDraft = structuredClone(validBridge);
  (malformedDraft.threads.image[0] as { draft?: unknown }).draft = null;
  assert.equal(validBridgeSession(malformedDraft), false);
});

test("bridge recovery drops legacy video edit state and retains its media asset", () => {
  const session = createSession("Legacy bridge cleanup");
  const generated = session.threads.video[0];
  generated.draft.prompt = "Generate a fresh shot";
  session.assets.push({
    id: "legacy-source",
    name: "source.mp4",
    kind: "video",
    mimeType: "video/mp4",
    origin: "generated",
    createdAt: new Date().toISOString(),
    localPath: "/Users/test/.fruit-truck/generated/source.mp4",
  });
  const edit = {
    ...structuredClone(generated),
    id: "legacy-edit",
    videoWorkflow: "edit" as const,
    draft: {
      ...structuredClone(generated.draft),
      references: [{ assetId: "legacy-source", slot: 1, role: "video_reference" }],
    },
  };
  const bridge = {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    mode: "video" as const,
    generationDefaults: {
      modelIds: { image: "", video: "legacy/video" },
      options: { image: {}, videoGenerate: { duration: 6 }, videoEdit: { duration: 10 } },
      providerJson: { image: "", videoGenerate: "{\"mode\":\"generate\"}", videoEdit: "" },
    },
    threads: { image: session.threads.image, video: [generated, edit] },
    activeThreadIds: { image: session.activeThreadIds.image, video: edit.id },
    assets: session.assets,
    agent: session.agent,
  } as unknown as AgentBridgeSession;

  const recovered = recoverBridgeGenerationState(bridge);
  assert.deepEqual(recovered.threads?.video.map((thread) => thread.id), [generated.id]);
  assert.equal(recovered.activeThreadIds?.video, generated.id);
  assert.equal(recovered.assets?.some((asset) => asset.id === "legacy-source"), true);
  assert.deepEqual(recovered.generationDefaults?.options.video, { duration: 6 });
  assert.doesNotMatch(JSON.stringify(recovered), /videoWorkflow|video_reference|videoEdit/);
});

test("bridge recovery removes a submitted legacy video edit attempt and its job", () => {
  const session = createSession("Legacy bridge in-flight edit");
  const edit = {
    ...structuredClone(session.threads.video[0]),
    id: "legacy-edit-in-flight",
    videoWorkflow: "edit" as const,
    attempts: [{
      id: "legacy-edit-attempt",
      status: "in_progress" as const,
      backend: "openrouter" as const,
      draftRevision: 0,
      requestedBy: "agent" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
      modelId: "legacy/video",
      request: { model: "legacy/video" },
      inputAssetIds: [],
      assetIds: [],
      jobId: "legacy-edit-job",
      pollAttempts: 4,
    }],
  };
  const bridge = {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    mode: "video" as const,
    generationDefaults: session.generationDefaults,
    threads: { image: session.threads.image, video: [edit] },
    activeThreadIds: { image: session.activeThreadIds.image, video: edit.id },
    assets: [],
    agent: {
      ...session.agent,
      execution: { ...session.agent.execution, currentJobIds: ["legacy-edit-job", "generate-job"] },
    },
  } as unknown as AgentBridgeSession;

  const recovered = recoverBridgeGenerationState(bridge);
  assert.notEqual(recovered.threads?.video[0].id, edit.id);
  assert.deepEqual(recovered.threads?.video[0].attempts, []);
  assert.deepEqual(recovered.agent.execution.currentJobIds, ["generate-job"]);
  assert.doesNotMatch(JSON.stringify(recovered), /videoWorkflow|video_reference|videoEdit/);

  const envelope = recoverAgentBridgeEnvelope({ schemaVersion: 4, revision: 7, sessions: [bridge] });
  assert.deepEqual(envelope.migrationSessionIds, [bridge.id]);
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
