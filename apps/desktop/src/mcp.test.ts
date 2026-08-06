import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import test from "node:test";
import { resolveAgentDecisionFromDesktop, type AgentHost, type AgentSessionState } from "./agent.ts";
import { materializeAgentSession, serializeAgentSessionForBridge, type AgentBridgeSession } from "./agentBridge.ts";
import type { GenerationThread } from "./studio.ts";

type BridgeAsset = {
  id: string;
  localPath?: string;
  externalUrl?: string;
};

type BridgeSession = {
  id: string;
  assets: BridgeAsset[];
  threads: { image: GenerationThread[]; video: GenerationThread[] };
  generationDefaults: { modelIds: { image: string; video: string } };
  agent: AgentSessionState;
};

type CallResult = { value: unknown; isError: boolean };
type StoredEnvelope = { schemaVersion?: number; revision: number; sessions: BridgeSession[] };

function readStoredEnvelope(dataDirectory: string): StoredEnvelope {
  const indexPath = join(dataDirectory, "agent-sessions.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as StoredEnvelope & { sessionFiles?: Array<{ id: string; file: string }> };
  if (Array.isArray(index.sessions)) return index;
  const sessions = (index.sessionFiles ?? []).map(({ file }) =>
    JSON.parse(readFileSync(join(dataDirectory, "agent-sessions", file), "utf8")) as BridgeSession
  );
  return { schemaVersion: index.schemaVersion, revision: index.revision, sessions };
}

function writeStoredEnvelope(dataDirectory: string, envelope: StoredEnvelope) {
  const indexPath = join(dataDirectory, "agent-sessions.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as StoredEnvelope & { sessionFiles?: Array<{ id: string; file: string }> };
  if (!Array.isArray(index.sessionFiles)) {
    writeFileSync(indexPath, JSON.stringify(envelope, null, 2));
    return;
  }
  const root = join(dataDirectory, "agent-sessions");
  const sessionFiles = envelope.sessions.map((session) => {
    const existing = index.sessionFiles?.find((item) => item.id === session.id);
    const file = existing?.file ?? `${session.id}-${envelope.revision}.json`;
    writeFileSync(join(root, file), JSON.stringify(session, null, 2));
    return { id: session.id, file };
  });
  writeFileSync(indexPath, JSON.stringify({ schemaVersion: 3, revision: envelope.revision, sessionFiles }, null, 2));
}

function storedEnvelopeText(dataDirectory: string) {
  return JSON.stringify(readStoredEnvelope(dataDirectory));
}

function spawnMcp(dataDirectory: string, host: AgentHost, codexHome?: string, openRouterBase?: string) {
  const child = spawn(
    process.execPath,
    host === "unknown"
      ? ["scripts/mcp-server.ts"]
      : ["scripts/mcp-server.ts", "--agent-host", host],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FRUIT_TRUCK_HOME: dataDirectory,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        ...(openRouterBase ? { FRUIT_TRUCK_OPENROUTER_BASE: openRouterBase } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let nextId = 1;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line) as { id?: number };
    if (value.id != null) {
      waiting.get(value.id)?.(value as Record<string, unknown>);
      waiting.delete(value.id);
    }
  });
  const request = (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    const result = new Promise<Record<string, unknown>>((resolve) => waiting.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
    const message = await request("tools/call", { name, arguments: args });
    const result = message.result as { content: Array<{ text: string }>; isError?: boolean };
    const responseText = result.content[0]?.text ?? "";
    return {
      value: result.isError ? responseText : JSON.parse(responseText),
      isError: Boolean(result.isError),
    };
  };
  return { child, request, call };
}

function stopMcp(child: ChildProcessWithoutNullStreams) {
  child.stdin.end();
  child.kill();
}

function resolveInFruitTruck(
  dataDirectory: string,
  sessionId: string,
  decisionId: string,
  optionId: string,
) {
  const envelope = readStoredEnvelope(dataDirectory);
  const session = envelope.sessions.find((item) => item.id === sessionId);
  assert.ok(session);
  session.agent = resolveAgentDecisionFromDesktop(session.agent, decisionId, [optionId]);
  const decision = session.agent.decisions.find((item) => item.id === decisionId);
  const mode = decision?.semanticKey === "model_selection_image" ? "image" : decision?.semanticKey === "model_selection_video" ? "video" : undefined;
  if (mode) {
    const relatedThreadIds = decision?.relatedThreadIds ?? [];
    if (relatedThreadIds.length) {
      for (const thread of session.threads[mode]) {
        if (relatedThreadIds.includes(thread.id)) thread.modelOverrideId = optionId;
      }
    } else {
      session.generationDefaults.modelIds[mode] = optionId;
    }
  }
  envelope.revision += 1;
  writeStoredEnvelope(dataDirectory, envelope);
}

test("MCP resolves user choices in agent chat and resumes them durably", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-"));
  const generatedDirectory = join(dataDirectory, "generated");
  const generatedImage = join(generatedDirectory, "registered.png");
  mkdirSync(generatedDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(generatedImage, Buffer.from("\x89PNG\r\n\x1a\nfixture", "binary"), { mode: 0o600 });

  let server = spawnMcp(dataDirectory, "claude");
  context.after(() => {
    stopMcp(server.child);
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  const initialized = await server.request("initialize", {});
  assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, "fruit-truck");
  const listed = await server.request("tools/list", {});
  const toolNames = (listed.result as { tools: Array<{ name: string }> }).tools.map((item) => item.name);
  assert.ok(toolNames.includes("claim_session"));
  assert.ok(toolNames.includes("ensure_desktop"));
  assert.ok(toolNames.includes("resolve_decision"));
  assert.equal(toolNames.includes("await_decision"), true);
  assert.ok(toolNames.includes("import_remote_asset"));
  assert.ok(toolNames.includes("propose_assembly"));
  assert.equal(toolNames.includes("request_image_backend_selection"), false);
  assert.equal(toolNames.includes("register_host_image"), false);

  const created = await server.call("create_session", {
    name: "Rainy perfume reel",
    intent: "비 오는 밤 향수 가게를 발견하는 짧은 영상",
  });
  assert.equal(created.isError, false);
  const createdSession = created.value as BridgeSession;
  assert.equal(createdSession.agent.connection.status, "waiting");
  const beforeClaim = await server.call("update_brief", {
    sessionId: createdSession.id,
    patch: { goal: "This must not be accepted before claim." },
  });
  assert.equal(beforeClaim.isError, true);
  assert.match(String(beforeClaim.value), /Claim this session/i);

  const claimed = await server.call("claim_session", {
    sessionId: createdSession.id,
    agentName: "integration-test-agent",
  });
  assert.equal(claimed.isError, false);
  assert.deepEqual((claimed.value as { connection: { agentHost: string } }).connection.agentHost, "claude");
  assert.deepEqual((claimed.value as { imageGeneration: unknown }).imageGeneration, {
    status: "selected",
    backend: "openrouter",
    selectedBy: "policy",
    selectedAt: (claimed.value as { imageGeneration: { selectedAt: string } }).imageGeneration.selectedAt,
  });

  const queued = await server.call("queue_decision", {
    sessionId: createdSession.id,
    requestKey: "finish-choice-v1",
    title: "Choose a finish",
    prompt: "Choose the visual finish in this chat.",
    kind: "choice",
    blocking: true,
    options: [
      { id: "warm", label: "Warm", recommended: true },
      { id: "cool", label: "Cool" },
    ],
  });
  assert.equal(queued.isError, false);
  const decisionId = (queued.value as { decisionId: string }).decisionId;
  const invalidResolution = await server.call("resolve_decision", {
    sessionId: createdSession.id,
    decisionId,
    userResponse: "Use something else.",
    optionId: "missing",
  });
  assert.equal(invalidResolution.isError, true);
  assert.match(String(invalidResolution.value), /not valid for decision/i);

  const resolved = await server.call("resolve_decision", {
    sessionId: createdSession.id,
    decisionId,
    userResponse: "Warm으로 진행해 주세요.",
    optionId: "warm",
  });
  assert.equal(resolved.isError, false);
  const chatResolution = (resolved.value as {
    resolution: { optionId: string; userResponse: string; channel: string; resolvedAt: string };
  }).resolution;
  assert.equal(chatResolution.optionId, "warm");
  assert.equal(chatResolution.userResponse, "Warm으로 진행해 주세요.");
  assert.equal(chatResolution.channel, "agent_chat");
  assert.ok(chatResolution.resolvedAt);
  const resumed = await server.call("get_session", { sessionId: createdSession.id });
  assert.equal((resumed.value as BridgeSession).agent.runStatus, "working");

  const chatAwait = await server.call("await_decision", {
    sessionId: createdSession.id,
    decisionId,
  });
  assert.equal(chatAwait.isError, true);
  assert.match(String(chatAwait.value), /Only Fruit Truck UI decisions/i);

  const modelChoice = await server.call("request_model_selection", {
    sessionId: createdSession.id,
    requestKey: "image-model-v1",
    mode: "image",
    candidates: [
      { id: "test/image", label: "Test image", recommended: true },
      { id: "test/other", label: "Other" },
    ],
    recommendation: "Test image best matches the requested finish.",
  });
  const modelDecisionId = (modelChoice.value as { decisionId: string }).decisionId;
  const retriedModelChoice = await server.call("request_model_selection", {
    sessionId: createdSession.id,
    requestKey: "image-model-v1",
    mode: "image",
    candidates: [{ id: "ignored/retry", label: "Ignored retry payload" }],
    recommendation: "This retry must return the original decision.",
  });
  assert.equal((retriedModelChoice.value as { decisionId: string }).decisionId, modelDecisionId);
  const afterRetry = await server.call("get_session", { sessionId: createdSession.id });
  assert.equal(
    (afterRetry.value as BridgeSession).agent.decisions.filter((item) => item.requestKey === "image-model-v1").length,
    1,
  );

  stopMcp(server.child);
  server = spawnMcp(dataDirectory, "claude");
  await server.request("initialize", {});
  const restoredPending = await server.call("get_session", { sessionId: createdSession.id });
  assert.equal(
    (restoredPending.value as BridgeSession).agent.decisions.find((item) => item.id === modelDecisionId)?.status,
    "pending",
  );
  const selectedModel = await server.call("resolve_decision", {
    sessionId: createdSession.id,
    decisionId: modelDecisionId,
    userResponse: "추천한 Test image 모델을 선택할게요.",
    optionId: "test/image",
  });
  assert.equal(selectedModel.isError, true);
  assert.match(String(selectedModel.value), /completed in Fruit Truck/i);
  resolveInFruitTruck(dataDirectory, createdSession.id, modelDecisionId, "test/image");
  const awaitedModel = await server.call("await_decision", {
    sessionId: createdSession.id,
    decisionId: modelDecisionId,
    timeoutMs: 100,
  });
  assert.equal(awaitedModel.isError, false);
  assert.equal((awaitedModel.value as { status: string }).status, "resolved");
  const restoredSession = await server.call("get_session", { sessionId: createdSession.id });
  assert.equal((restoredSession.value as BridgeSession).agent.modelSelections.image.modelId, "test/image");
  assert.equal((restoredSession.value as BridgeSession).generationDefaults.modelIds.image, "test/image");

  const registered = await server.call("register_asset", {
    sessionId: createdSession.id,
    name: "registered.png",
    kind: "image",
    mimeType: "image/png",
    origin: "generated",
    source: generatedImage,
    role: "keyframe",
  });
  assert.equal(registered.isError, false);
  const asset = (registered.value as BridgeSession).assets.at(-1);
  assert.equal(asset?.localPath, realpathSync(generatedImage));
  assert.equal(asset?.externalUrl, undefined);

  const outside = join(tmpdir(), `fruit-truck-outside-${process.pid}-${Date.now()}.png`);
  writeFileSync(outside, Buffer.from("\x89PNG\r\n\x1a\noutside", "binary"));
  const outsideRejected = await server.call("register_asset", {
    sessionId: createdSession.id,
    name: "outside.png",
    kind: "image",
    mimeType: "image/png",
    origin: "upload",
    source: outside,
    role: "reference",
  });
  assert.equal(outsideRejected.isError, true);
  rmSync(outside, { force: true });

  const videoBrief = await server.call("update_brief", {
    sessionId: createdSession.id,
    patch: { deliverable: "Video" },
  });
  assert.equal(videoBrief.isError, false);
  const productionPlan = await server.call("replace_plan", {
    sessionId: createdSession.id,
    steps: [{
      id: "production",
      title: "Produce image and video",
      description: "Generate the approved production assets.",
      status: "in_progress",
      dependsOn: [],
    }],
  });
  assert.equal(productionPlan.isError, false);
  const assemblyActivity = await server.call("record_activity", {
    sessionId: createdSession.id,
    kind: "assembly",
    title: "Prepared an assembly review",
  });
  assert.equal(assemblyActivity.isError, false);
  const proposedSkill = await server.call("propose_custom_skill", {
    sessionId: createdSession.id,
    requestKey: "rainy-skill-proposal-v1",
    name: "Rainy perfume workflow",
  });
  assert.equal(proposedSkill.isError, false, String(proposedSkill.value));
  const skillDecisionId = (proposedSkill.value as { decisionId: string }).decisionId;
  const approvedSkill = await server.call("resolve_decision", {
    sessionId: createdSession.id,
    decisionId: skillDecisionId,
    userResponse: "이 워크플로 스킬을 저장하고 이번 세션에 적용해 주세요.",
    optionId: "approve",
  });
  assert.equal(approvedSkill.isError, false, String(approvedSkill.value));
  const withSkill = await server.call("get_session", { sessionId: createdSession.id });
  const savedSkill = (withSkill.value as BridgeSession).agent.customSkill;
  assert.equal(savedSkill?.status, "saved");
  assert.ok((withSkill.value as BridgeSession).agent.appliedSkills.some((skill) =>
    skill.name === "Rainy perfume workflow" && skill.source === "custom"
  ));
  const listedSkills = await server.call("list_custom_skills", {});
  const listedSkill = (listedSkills.value as Array<{ name: string; version: unknown }>)
    .find((skill) => skill.name === "Rainy perfume workflow");
  assert.equal(typeof listedSkill?.version, "number");

  const deactivate = await server.call("request_custom_skill_activation", {
    sessionId: createdSession.id,
    requestKey: "rainy-skill-deactivate-v1",
    name: "Rainy perfume workflow",
    version: savedSkill?.version,
    active: false,
  });
  assert.equal(deactivate.isError, false);
  const deactivated = await server.call("resolve_decision", {
    sessionId: createdSession.id,
    decisionId: (deactivate.value as { decisionId: string }).decisionId,
    userResponse: "이번 세션에서는 이 스킬을 비활성화해 주세요.",
    optionId: "approve",
  });
  assert.equal(deactivated.isError, false);
  const withoutSkill = await server.call("get_session", { sessionId: createdSession.id });
  assert.equal((withoutSkill.value as BridgeSession).agent.appliedSkills.some((skill) =>
    skill.name === "Rainy perfume workflow" && skill.source === "custom"
  ), false);

  const stored = storedEnvelopeText(dataDirectory);
  assert.equal(/data:(?:image|video)\//i.test(stored), false);
  assert.equal(/;base64,/i.test(stored), false);
});

test("Codex selects an image backend per session and registers built-in outputs", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-codex-mcp-"));
  const codexHome = mkdtempSync(join(tmpdir(), "fruit-truck-codex-home-"));
  const codexGeneratedDirectory = join(codexHome, "generated_images");
  const codexImage = join(codexGeneratedDirectory, "codex-result.png");
  mkdirSync(codexGeneratedDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(codexImage, Buffer.from("\x89PNG\r\n\x1a\ncodex", "binary"), { mode: 0o600 });

  let server = spawnMcp(dataDirectory, "codex", codexHome);
  context.after(() => {
    stopMcp(server.child);
    rmSync(dataDirectory, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  await server.request("initialize", {});
  const listed = await server.request("tools/list", {});
  const toolNames = (listed.result as { tools: Array<{ name: string }> }).tools.map((item) => item.name);
  assert.ok(toolNames.includes("request_image_backend_selection"));
  assert.ok(toolNames.includes("register_host_image"));

  const created = await server.call("create_session", {
    name: "Codex still",
    intent: "고요한 향수 제품 이미지를 만들어 주세요.",
  });
  const sessionId = (created.value as BridgeSession).id;
  const claimed = await server.call("claim_session", {
    sessionId,
    agentName: "codex-integration-test",
  });
  assert.deepEqual((claimed.value as { imageGeneration: unknown }).imageGeneration, { status: "unselected" });

  const backendRequest = await server.call("request_image_backend_selection", { sessionId });
  assert.equal(backendRequest.isError, false);
  const backendDecisionId = (backendRequest.value as { decisionId: string }).decisionId;
  const backendResolution = await server.call("resolve_decision", {
    sessionId,
    decisionId: backendDecisionId,
    userResponse: "Codex 내장 이미지 생성을 사용해 주세요.",
    optionId: "codex_builtin",
  });
  assert.equal(backendResolution.isError, true);
  resolveInFruitTruck(dataDirectory, sessionId, backendDecisionId, "codex_builtin");

  const withDefaultThreads = await server.call("get_session", { sessionId });
  const firstThread = (withDefaultThreads.value as BridgeSession).threads.image[0];
  const preparedFirst = await server.call("update_generation_thread", {
    sessionId,
    threadId: firstThread.id,
    expectedThreadRevision: firstThread.revision,
    patch: { name: "Hero bottle", prompt: "A quiet perfume bottle at blue hour.", outputRole: "hero_still" },
  });
  assert.equal(preparedFirst.isError, false, String(preparedFirst.value));
  const createdThread = await server.call("create_generation_thread", {
    sessionId,
    requestKey: "create-detail-thread-v1",
    mode: "image",
    name: "Bottle detail",
    outputRole: "detail_still",
  });
  assert.equal(createdThread.isError, false, String(createdThread.value));
  const secondThread = (createdThread.value as { thread: GenerationThread }).thread;
  const preparedSecond = await server.call("update_generation_thread", {
    sessionId,
    threadId: secondThread.id,
    expectedThreadRevision: secondThread.revision,
    patch: { prompt: "A macro detail of the perfume bottle cap." },
  });
  assert.equal(preparedSecond.isError, false, String(preparedSecond.value));

  const started = await server.call("run_generation_threads", {
    sessionId,
    requestKey: "codex-parallel-stills-v1",
    threadIds: [firstThread.id, secondThread.id],
  });
  assert.equal(started.isError, false, String(started.value));
  const batch = started.value as {
    attempts: Array<{ threadId: string; attemptId: string; status: string }>;
    hostActions: Array<{ threadId: string; attemptId: string; prompt: string; outputRole: string }>;
  };
  assert.equal(batch.attempts.length, 2);
  assert.equal(batch.hostActions.length, 2);
  assert.ok(batch.attempts.every((attempt) => attempt.status === "awaiting_host"));

  const retriedBatch = await server.call("run_generation_threads", {
    sessionId,
    requestKey: "codex-parallel-stills-v1",
    threadIds: [firstThread.id, secondThread.id],
  });
  assert.equal(retriedBatch.isError, false);
  assert.deepEqual(
    (retriedBatch.value as typeof batch).attempts.map((attempt) => attempt.attemptId),
    batch.attempts.map((attempt) => attempt.attemptId),
  );
  assert.equal((retriedBatch.value as typeof batch).hostActions.length, 2);

  for (const action of batch.hostActions) {
    const completed = await server.call("register_host_image", {
      sessionId,
      threadId: action.threadId,
      attemptId: action.attemptId,
      sourcePath: codexImage,
      name: `${action.outputRole}.png`,
      mimeType: "image/png",
      origin: "generated",
      role: action.outputRole,
      prompt: action.prompt,
    });
    assert.equal(completed.isError, false, String(completed.value));
  }
  const awaitedBatch = await server.call("await_generation_threads", {
    sessionId,
    attemptIds: batch.attempts.map((attempt) => attempt.attemptId),
    timeoutMs: 100,
  });
  assert.equal(awaitedBatch.isError, false, String(awaitedBatch.value));
  assert.ok((awaitedBatch.value as { attempts: Array<{ status: string }> }).attempts.every((attempt) => attempt.status === "completed"));

  const registered = await server.call("register_host_image", {
    sessionId,
    sourcePath: codexImage,
    name: "quiet-perfume.png",
    mimeType: "image/png",
    origin: "generated",
    role: "keyframe",
    prompt: "A quiet perfume bottle at blue hour.",
  });
  assert.equal(registered.isError, false);
  const registeredSession = registered.value as BridgeSession;
  const registeredAsset = registeredSession.assets.at(-1);
  assert.ok(registeredAsset?.localPath);
  assert.notEqual(registeredAsset?.localPath, realpathSync(codexImage));
  assert.ok(existsSync(registeredAsset?.localPath ?? ""));
  const artifact = registeredSession.agent.artifacts.find((item) => item.assetId === registeredAsset?.id);
  assert.equal(artifact?.generationBackend, "codex_builtin");
  assert.equal(artifact?.modelId, "codex/imagegen");
  assert.equal(registeredSession.agent.execution.generationCount, 3);
  assert.equal(registeredSession.agent.execution.spentUsd, 0);

  const generatedFilesBeforeInvalidEdit = readdirSync(join(dataDirectory, "generated")).length;
  const invalidEdit = await server.call("register_host_image", {
    sessionId,
    sourcePath: codexImage,
    name: "invalid-edit.png",
    mimeType: "image/png",
    origin: "edited",
    role: "edited_keyframe",
    prompt: "Make the background warmer.",
  });
  assert.equal(invalidEdit.isError, true);
  assert.match(String(invalidEdit.value), /parent asset/i);
  assert.equal(readdirSync(join(dataDirectory, "generated")).length, generatedFilesBeforeInvalidEdit);

  const invalidStateRegistration = await server.call("register_host_image", {
    sessionId,
    sourcePath: codexImage,
    name: "invalid-state.png",
    mimeType: "image/png",
    origin: "generated",
    role: "keyframe",
    planStepId: "missing-step",
    prompt: "This registration must roll its managed copy back.",
  });
  assert.equal(invalidStateRegistration.isError, true);
  assert.match(String(invalidStateRegistration.value), /unknown plan step/i);
  assert.equal(readdirSync(join(dataDirectory, "generated")).length, generatedFilesBeforeInvalidEdit);

  const secondCreated = await server.call("create_session", {
    name: "Second Codex still",
    intent: "또 다른 제품 이미지",
  });
  const secondSessionId = (secondCreated.value as BridgeSession).id;
  const secondClaimed = await server.call("claim_session", {
    sessionId: secondSessionId,
    agentName: "codex-integration-test",
  });
  assert.deepEqual((secondClaimed.value as { imageGeneration: unknown }).imageGeneration, { status: "unselected" });

  const outside = join(tmpdir(), `codex-image-outside-${process.pid}-${Date.now()}.png`);
  writeFileSync(outside, Buffer.from("\x89PNG\r\n\x1a\noutside", "binary"));
  const outsideRejected = await server.call("register_host_image", {
    sessionId,
    sourcePath: outside,
    name: "outside.png",
    mimeType: "image/png",
    origin: "generated",
    role: "keyframe",
    prompt: "Outside root.",
  });
  assert.equal(outsideRejected.isError, true);
  assert.match(String(outsideRejected.value), /generated_images directory/i);
  rmSync(outside, { force: true });

  stopMcp(server.child);
  server = spawnMcp(dataDirectory, "claude", codexHome);
  await server.request("initialize", {});
  const wrongHost = await server.call("register_host_image", {
    sessionId,
    sourcePath: codexImage,
    name: "wrong-host.png",
    mimeType: "image/png",
    origin: "generated",
    role: "keyframe",
    prompt: "Wrong host.",
  });
  assert.equal(wrongHost.isError, true);
  assert.match(String(wrongHost.value), /only to Codex/i);
  const wrongHostMutation = await server.call("update_brief", {
    sessionId,
    patch: { goal: "Claude must not mutate a Codex-owned session." },
  });
  assert.equal(wrongHostMutation.isError, true);
  assert.match(String(wrongHostMutation.value), /belongs to the codex agent host/i);
});

test("OpenRouter thread batches persist media-free attempts and resume independent video polling", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-openrouter-batch-"));
  const assetsDirectory = join(dataDirectory, "assets");
  mkdirSync(assetsDirectory, { recursive: true, mode: 0o700 });
  const referencePath = join(assetsDirectory, "reference.png");
  writeFileSync(referencePath, readFileSync(join(process.cwd(), "public", "fruit-truck-icon.png")), { mode: 0o600 });
  writeFileSync(join(dataDirectory, "credentials.json"), JSON.stringify({ openrouter_api_key: "test-key" }), { mode: 0o600 });

  let imageActive = 0;
  let maxImageActive = 0;
  let imageCalls = 0;
  const imagePrompts: string[] = [];
  const imagePayloads: Record<string, unknown>[] = [];
  let enhancementCalls = 0;
  let enhancementImageParts = 0;
  let retry429Calls = 0;
  let delayImageCatalog = false;
  let nextJob = 1;
  const videoPolls = new Map<string, number>();
  const mock = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
    const sendJson = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/images/models") {
      if (delayImageCatalog) await new Promise((resolve) => setTimeout(resolve, 100));
      return sendJson(200, { data: [{ id: "test/image", name: "Test image", supported_parameters: { input_references: { type: "range", min: 0, max: 2 } }, pricing: [{ billable: "image", unit: "image", cost_usd: 0.04 }] }] });
    }
    if (request.method === "GET" && request.url === "/images/models/test/image/endpoints") {
      return sendJson(200, { endpoints: [{
        provider_name: "Test provider",
        provider_slug: "test",
        supported_parameters: { input_references: { type: "range", min: 0, max: 2 } },
        pricing: [
          { billable: "output_image", unit: "image", cost_usd: 0.04 },
          { billable: "input_reference", unit: "image", cost_usd: 0.01 },
        ],
      }] });
    }
    if (request.method === "GET" && request.url === "/videos/models") return sendJson(200, { data: [{ id: "test/video", name: "Test video", input_reference_types: ["image"], max_input_references: 2, pricing_skus: { standard: "$0.25" } }] });
    if (request.method === "POST" && request.url === "/chat/completions") {
      enhancementCalls += 1;
      const messages = body.messages as Array<{ content?: string | Array<{ type?: string; text?: string }> }>;
      const content = messages.at(-1)?.content;
      const userText = typeof content === "string"
        ? content
        : content?.find((part) => part.type === "text")?.text ?? "";
      enhancementImageParts += Array.isArray(content) ? content.filter((part) => part.type === "image_url").length : 0;
      const original = userText.match(/User prompt:\n([\s\S]*?)(?:\n\n(?:Mask instructions|Available numbered references|Visual inputs)|$)/)?.[1] ?? "enhanced";
      return sendJson(200, { choices: [{ message: { content: `${original} enhanced` } }] });
    }
    if (request.method === "POST" && request.url === "/images") {
      imageCalls += 1;
      imagePrompts.push(String(body.prompt ?? ""));
      imagePayloads.push(body);
      imageActive += 1;
      maxImageActive = Math.max(maxImageActive, imageActive);
      await new Promise((resolve) => setTimeout(resolve, 40));
      imageActive -= 1;
      if (String(body.prompt).includes("RETRY_429")) {
        retry429Calls += 1;
        if (retry429Calls === 1) {
          response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
          return response.end(JSON.stringify({ error: "rate limited once" }));
        }
      }
      if (String(body.prompt).includes("FAIL_ONE")) return sendJson(400, { error: "intentional image failure" });
      return sendJson(200, { data: [{ b64_json: Buffer.from(`image-${imageCalls}`).toString("base64"), media_type: "image/png" }], usage: { cost: 0.05 } });
    }
    if (request.method === "POST" && request.url === "/videos") {
      const id = `job-${nextJob++}`;
      videoPolls.set(id, 0);
      return sendJson(202, { id, status: "pending" });
    }
    const videoMatch = request.url?.match(/^\/videos\/(job-\d+)$/);
    if (request.method === "GET" && videoMatch) {
      const id = videoMatch[1];
      const polls = (videoPolls.get(id) ?? 0) + 1;
      videoPolls.set(id, polls);
      return sendJson(200, polls < 2 ? { id, status: "in_progress", progress: 50 } : { id, status: "completed", unsigned_urls: [`http://127.0.0.1/unused/${id}`], usage: { cost: 0.3 } });
    }
    const contentMatch = request.url?.match(/^\/videos\/(job-\d+)\/content\?index=0$/);
    if (request.method === "GET" && contentMatch) {
      response.writeHead(200, { "content-type": "video/mp4" });
      return response.end(Buffer.from("video-fixture"));
    }
    sendJson(404, { error: `Unhandled ${request.method} ${request.url}` });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let server = spawnMcp(dataDirectory, "claude", undefined, base);
  context.after(() => {
    stopMcp(server.child);
    mock.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await server.request("initialize", {});
  const listedImages = await server.call("list_models", { mode: "image" });
  assert.equal(listedImages.isError, false, String(listedImages.value));
  assert.deepEqual(
    ((listedImages.value as Array<{ pricing?: Array<{ billable: string }> }>)[0]?.pricing ?? []).map((item) => item.billable),
    ["output_image", "input_reference"],
  );

  const created = await server.call("create_session", { name: "Batch", intent: "Parallel media batch" });
  const sessionId = (created.value as BridgeSession).id;
  await server.call("claim_session", { sessionId, agentName: "batch-test" });
  let current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const imageOne = current.threads.image[0];
  const imageTwoResult = await server.call("create_generation_thread", { sessionId, requestKey: "image-two", mode: "image", name: "Image two" });
  const imageTwo = (imageTwoResult.value as { thread: GenerationThread }).thread;
  const registered = await server.call("register_asset", { sessionId, name: "reference.png", kind: "image", mimeType: "image/png", origin: "upload", source: referencePath, role: "reference" });
  const assetId = ((registered.value as BridgeSession).assets.at(-1) as BridgeAsset).id;
  for (const [target, prompt] of [[imageOne, "First image"], [imageTwo, "Second image"]] as const) {
    const result = await server.call("update_generation_thread", { sessionId, threadId: target.id, expectedThreadRevision: target.revision, patch: { prompt, enhancePrompt: false, assetBindings: [{ assetId, role: "reference" }] } });
    assert.equal(result.isError, false, String(result.value));
  }
  const imageThreeResult = await server.call("create_generation_thread", { sessionId, requestKey: "image-three", mode: "image", name: "Image three" });
  const imageThree = (imageThreeResult.value as { thread: GenerationThread }).thread;
  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const priorImageDefault = current.generationDefaults.modelIds.image;
  const priorImageSelection = structuredClone(current.agent.modelSelections.image);
  const modelDecision = await server.call("request_model_selection", { sessionId, requestKey: "image-choice", mode: "image", candidates: [{ id: "test/image", label: "Test image" }], recommendation: "Use test image", threadIds: [imageOne.id, imageTwo.id] });
  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  assert.deepEqual(current.agent.modelSelections.image, priorImageSelection);
  assert.equal(current.generationDefaults.modelIds.image, priorImageDefault);
  resolveInFruitTruck(dataDirectory, sessionId, (modelDecision.value as { decisionId: string }).decisionId, "test/image");
  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  assert.deepEqual(current.agent.modelSelections.image, priorImageSelection);
  assert.equal(current.generationDefaults.modelIds.image, priorImageDefault);
  assert.equal(current.threads.image.find((item) => item.id === imageOne.id)?.modelOverrideId, "test/image");
  assert.equal(current.threads.image.find((item) => item.id === imageTwo.id)?.modelOverrideId, "test/image");
  assert.equal(current.threads.image.find((item) => item.id === imageThree.id)?.modelOverrideId, undefined);
  const started = await server.call("run_generation_threads", { sessionId, requestKey: "image-batch", threadIds: [imageOne.id, imageTwo.id] });
  assert.equal(started.isError, false, String(started.value));
  const imageAttemptIds = (started.value as { attempts: Array<{ attemptId: string }> }).attempts.map((item) => item.attemptId);
  const imageDone = await server.call("await_generation_threads", { sessionId, attemptIds: imageAttemptIds, timeoutMs: 5_000 });
  assert.equal(imageDone.isError, false, String(imageDone.value));
  assert.equal((imageDone.value as { status: string; outcome: string }).status, "terminal");
  assert.equal((imageDone.value as { outcome: string }).outcome, "completed");
  assert.ok((imageDone.value as { attempts: Array<{ estimatedCostUsd?: number }> }).attempts.every((attempt) => attempt.estimatedCostUsd === 0.05));
  assert.ok(maxImageActive >= 2, `expected parallel image submissions, observed ${maxImageActive}`);
  const persisted = storedEnvelopeText(dataDirectory);
  assert.doesNotMatch(persisted, /;base64,|data:image\//i);
  assert.match(persisted, /"assetBindings"/);
  const persistedIndex = JSON.parse(readFileSync(join(dataDirectory, "agent-sessions.json"), "utf8")) as { sessions?: unknown[]; sessionFiles?: Array<{ file: string }> };
  assert.equal(persistedIndex.sessions, undefined);
  assert.equal(persistedIndex.sessionFiles?.length, 1);
  assert.ok(existsSync(join(dataDirectory, "agent-sessions", persistedIndex.sessionFiles![0].file)));
  const retry = await server.call("run_generation_threads", { sessionId, requestKey: "image-batch", threadIds: [imageOne.id, imageTwo.id] });
  assert.deepEqual((retry.value as { attempts: Array<{ attemptId: string }> }).attempts.map((item) => item.attemptId), imageAttemptIds);
  const wrongReuse = await server.call("run_generation_threads", { sessionId, requestKey: "image-batch", threadIds: [imageOne.id] });
  assert.equal(wrongReuse.isError, true);

  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  for (const [threadId, prompt] of [[imageOne.id, "Successful follow-up"], [imageTwo.id, "FAIL_ONE"]] as const) {
    const fresh = current.threads.image.find((item) => item.id === threadId)!;
    const updated = await server.call("update_generation_thread", { sessionId, threadId, expectedThreadRevision: fresh.revision, patch: { prompt, enhancePrompt: false } });
    assert.equal(updated.isError, false, String(updated.value));
    current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  }
  const partial = await server.call("run_generation_threads", { sessionId, requestKey: "image-partial", threadIds: [imageOne.id, imageTwo.id] });
  const partialIds = (partial.value as { attempts: Array<{ attemptId: string }> }).attempts.map((item) => item.attemptId);
  const partialDone = await server.call("await_generation_threads", { sessionId, attemptIds: partialIds, timeoutMs: 5_000 });
  assert.equal(partialDone.isError, false, String(partialDone.value));
  assert.equal((partialDone.value as { status: string; outcome: string }).status, "terminal");
  assert.equal((partialDone.value as { outcome: string }).outcome, "partial_failure");

  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const allFailTarget = current.threads.image.find((item) => item.id === imageOne.id)!;
  const allFailUpdate = await server.call("update_generation_thread", { sessionId, threadId: imageOne.id, expectedThreadRevision: allFailTarget.revision, patch: { prompt: "FAIL_ONE too", enhancePrompt: false } });
  assert.equal(allFailUpdate.isError, false, String(allFailUpdate.value));
  const allFailed = await server.call("run_generation_threads", { sessionId, requestKey: "image-all-failed", threadIds: [imageOne.id, imageTwo.id] });
  const allFailedIds = (allFailed.value as { attempts: Array<{ attemptId: string }> }).attempts.map((item) => item.attemptId);
  const allFailedDone = await server.call("await_generation_threads", { sessionId, attemptIds: allFailedIds, timeoutMs: 5_000 });
  assert.equal((allFailedDone.value as { status: string; outcome: string }).status, "terminal");
  assert.equal((allFailedDone.value as { outcome: string }).outcome, "failed");

  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const retryTarget = current.threads.image.find((item) => item.id === imageOne.id)!;
  const retryUpdate = await server.call("update_generation_thread", { sessionId, threadId: imageOne.id, expectedThreadRevision: retryTarget.revision, patch: { prompt: "RETRY_429 then succeed", enhancePrompt: false } });
  assert.equal(retryUpdate.isError, false, String(retryUpdate.value));
  const retried429 = await server.call("run_generation_threads", { sessionId, requestKey: "retry-429", threadIds: [imageOne.id] });
  const retry429Id = (retried429.value as { attempts: Array<{ attemptId: string }> }).attempts[0].attemptId;
  const retry429Done = await server.call("await_generation_threads", { sessionId, attemptIds: [retry429Id], timeoutMs: 5_000 });
  assert.equal((retry429Done.value as { outcome: string }).outcome, "completed");
  assert.equal(retry429Calls, 2);

  const maskEnvelope = readStoredEnvelope(dataDirectory);
  const maskSession = maskEnvelope.sessions.find((item) => item.id === sessionId)!;
  const maskThread = maskSession.threads.image.find((item) => item.id === imageOne.id)!;
  maskThread.draft.prompt = "";
  maskThread.draft.imageEditMode = true;
  maskThread.draft.imageEditTarget = "#1";
  maskThread.draft.maskInstructions = "Turn the selected feathers black.";
  maskThread.draft.maskStrokes = [{ points: [{ x: 0.25, y: 0.25 }, { x: 0.5, y: 0.5 }], size: 0.08, operation: "paint" }];
  maskThread.draft.enhancePrompt = false;
  maskThread.revision += 1;
  maskEnvelope.revision += 1;
  writeStoredEnvelope(dataDirectory, maskEnvelope);
  const maskOnly = await server.call("run_generation_threads", { sessionId, requestKey: "mask-only", threadIds: [imageOne.id] });
  assert.equal(maskOnly.isError, false, String(maskOnly.value));
  const maskAttemptId = (maskOnly.value as { attempts: Array<{ attemptId: string }> }).attempts[0].attemptId;
  const maskDone = await server.call("await_generation_threads", { sessionId, attemptIds: [maskAttemptId], timeoutMs: 5_000 });
  assert.equal((maskDone.value as { outcome: string }).outcome, "completed", JSON.stringify(maskDone.value));
  assert.match(imagePrompts.at(-1) ?? "", /\[MASK INSTRUCTIONS\]\nTurn the selected feathers black\./);
  assert.doesNotMatch(imagePrompts.at(-1) ?? "", /\[USER PROMPT\]/);
  const maskedReferences = imagePayloads.at(-1)?.input_references as Array<{ image_url?: { url?: string } }>;
  const maskedUrl = maskedReferences[0]?.image_url?.url ?? "";
  assert.match(maskedUrl, /^data:image\/png;base64,/);
  const maskedPng = Buffer.from(maskedUrl.split(",", 2)[1] ?? "", "base64");
  assert.deepEqual(maskedPng.subarray(0, 8), Buffer.from("\x89PNG\r\n\x1a\n", "binary"));
  assert.equal(maskedPng[25], 6, "masked PNG should use RGBA color type");

  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const racingThread = current.threads.image.find((item) => item.id === imageOne.id)!;
  delayImageCatalog = true;
  const racingRun = server.call("run_generation_threads", { sessionId, requestKey: "revision-race", threadIds: [imageOne.id] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const racingEnvelope = readStoredEnvelope(dataDirectory);
  const racingSession = racingEnvelope.sessions.find((item) => item.id === sessionId)!;
  const concurrentlyChanged = racingSession.threads.image.find((item) => item.id === imageOne.id)!;
  concurrentlyChanged.revision = racingThread.revision + 1;
  concurrentlyChanged.draft.prompt = "Changed during preflight";
  racingEnvelope.revision += 1;
  writeStoredEnvelope(dataDirectory, racingEnvelope);
  const raced = await racingRun;
  delayImageCatalog = false;
  assert.equal(raced.isError, true);
  assert.match(String(raced.value), /changed during batch preflight/i);
  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  assert.equal(current.threads.image.flatMap((item) => item.attempts).some((attempt) => attempt.requestKey === "revision-race"), false);

  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const enhancedOnce = await server.call("enhance_generation_threads", { sessionId, requestKey: "enhance-once", threadIds: [imageOne.id] });
  assert.equal(enhancedOnce.isError, false, String(enhancedOnce.value));
  const enhancedRetry = await server.call("enhance_generation_threads", { sessionId, requestKey: "enhance-once", threadIds: [imageOne.id] });
  assert.equal(enhancedRetry.isError, false, String(enhancedRetry.value));
  assert.equal(enhancementCalls, 1);
  assert.equal(enhancementImageParts, 1);

  const archived = await server.call("archive_generation_thread", { sessionId, threadId: imageTwo.id });
  assert.equal(archived.isError, false, String(archived.value));
  const restored = await server.call("restore_generation_thread", { sessionId, threadId: imageTwo.id });
  assert.equal(restored.isError, false, String(restored.value));
  assert.equal((restored.value as BridgeSession).threads.image.find((item) => item.id === imageTwo.id)?.archivedAt, undefined);

  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const videoOne = current.threads.video[0];
  const videoTwo = (await server.call("create_generation_thread", { sessionId, requestKey: "video-two", mode: "video", name: "Video two" })).value as { thread: GenerationThread };
  for (const target of [videoOne, videoTwo.thread]) {
    const fresh = ((await server.call("get_session", { sessionId })).value as BridgeSession).threads.video.find((item) => item.id === target.id)!;
    const result = await server.call("update_generation_thread", { sessionId, threadId: target.id, expectedThreadRevision: fresh.revision, patch: { prompt: `Video ${target.id}`, enhancePrompt: false } });
    assert.equal(result.isError, false, String(result.value));
  }
  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const priorVideoDefault = current.generationDefaults.modelIds.video;
  const priorVideoSelection = structuredClone(current.agent.modelSelections.video);
  const videoDecision = await server.call("request_model_selection", { sessionId, requestKey: "video-choice", mode: "video", candidates: [{ id: "test/video", label: "Test video" }], recommendation: "Use test video", threadIds: [videoOne.id, videoTwo.thread.id] });
  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  assert.deepEqual(current.agent.modelSelections.video, priorVideoSelection);
  assert.equal(current.generationDefaults.modelIds.video, priorVideoDefault);
  resolveInFruitTruck(dataDirectory, sessionId, (videoDecision.value as { decisionId: string }).decisionId, "test/video");
  current = (await server.call("get_session", { sessionId })).value as BridgeSession;
  assert.deepEqual(current.agent.modelSelections.video, priorVideoSelection);
  assert.equal(current.generationDefaults.modelIds.video, priorVideoDefault);
  assert.equal(current.threads.video.find((item) => item.id === videoOne.id)?.modelOverrideId, "test/video");
  assert.equal(current.threads.video.find((item) => item.id === videoTwo.thread.id)?.modelOverrideId, "test/video");
  const videos = await server.call("run_generation_threads", { sessionId, requestKey: "video-batch", threadIds: [videoOne.id, videoTwo.thread.id] });
  assert.equal(videos.isError, false, String(videos.value));
  const videoAttemptIds = (videos.value as { attempts: Array<{ attemptId: string }> }).attempts.map((item) => item.attemptId);
  await new Promise((resolve) => setTimeout(resolve, 150));
  stopMcp(server.child);
  const roundTrip = readStoredEnvelope(dataDirectory);
  const roundTripIndex = roundTrip.sessions.findIndex((item) => item.id === sessionId);
  assert.notEqual(roundTripIndex, -1);
  const desktopSession = materializeAgentSession(roundTrip.sessions[roundTripIndex] as unknown as AgentBridgeSession);
  roundTrip.sessions[roundTripIndex] = await serializeAgentSessionForBridge(desktopSession) as unknown as BridgeSession;
  writeStoredEnvelope(dataDirectory, roundTrip);
  server = spawnMcp(dataDirectory, "claude", undefined, base);
  await server.request("initialize", {});
  const videoDone = await server.call("await_generation_threads", { sessionId, attemptIds: videoAttemptIds, timeoutMs: 5_000 });
  assert.equal(videoDone.isError, false, String(videoDone.value));
  assert.equal((videoDone.value as { status: string; outcome: string }).status, "terminal");
  assert.equal((videoDone.value as { outcome: string }).outcome, "completed");
  const finalSession = (await server.call("get_session", { sessionId })).value as BridgeSession;
  assert.equal(finalSession.threads.video.flatMap((thread) => thread.attempts).filter((attempt) => videoAttemptIds.includes(attempt.id) && attempt.status === "completed").length, 2);
  assert.equal(((finalSession as unknown as { jobs?: unknown[] }).jobs ?? []).length, 0);

  stopMcp(server.child);
  const uncertainEnvelope = readStoredEnvelope(dataDirectory);
  const uncertainSession = uncertainEnvelope.sessions.find((item) => item.id === sessionId)!;
  const uncertainThread = uncertainSession.threads.image[0];
  const sourceAttempt = uncertainThread.attempts.find((attempt) => attempt.snapshot)!;
  const uncertainId = "attempt-forced-uncertain";
  uncertainThread.attempts.push({
    ...structuredClone(sourceAttempt),
    id: uncertainId,
    requestKey: "forced-uncertain",
    status: "submitting",
    assetIds: [],
    jobId: undefined,
    submittedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
  });
  uncertainEnvelope.revision += 1;
  writeStoredEnvelope(dataDirectory, uncertainEnvelope);
  server = spawnMcp(dataDirectory, "claude", undefined, base);
  await server.request("initialize", {});
  const uncertain = await server.call("await_generation_threads", { sessionId, attemptIds: [uncertainId], timeoutMs: 100 });
  assert.equal(uncertain.isError, false, String(uncertain.value));
  assert.equal((uncertain.value as { status: string; outcome: string }).status, "terminal");
  assert.equal((uncertain.value as { outcome: string }).outcome, "uncertain");

  stopMcp(server.child);
  const cancelEnvelope = readStoredEnvelope(dataDirectory);
  const cancelThread = cancelEnvelope.sessions.find((item) => item.id === sessionId)!.threads.image[0];
  const cancelId = "attempt-forced-cancel";
  cancelThread.attempts.push({
    ...structuredClone(sourceAttempt),
    id: cancelId,
    requestKey: "forced-cancel",
    status: "queued",
    assetIds: [],
    submittedAt: undefined,
    completedAt: undefined,
    error: undefined,
  });
  cancelEnvelope.revision += 1;
  writeStoredEnvelope(dataDirectory, cancelEnvelope);
  server = spawnMcp(dataDirectory, "claude", undefined, base);
  await server.request("initialize", {});
  const canceled = await server.call("cancel_generation_threads", { sessionId, attemptIds: [cancelId] });
  assert.equal(canceled.isError, false, String(canceled.value));
  assert.deepEqual((canceled.value as { canceled: string[] }).canceled, [cancelId]);
  const canceledAwait = await server.call("await_generation_threads", { sessionId, attemptIds: [cancelId], timeoutMs: 100 });
  assert.equal((canceledAwait.value as { status: string; outcome: string }).status, "terminal");
  assert.equal((canceledAwait.value as { outcome: string }).outcome, "canceled");
});
