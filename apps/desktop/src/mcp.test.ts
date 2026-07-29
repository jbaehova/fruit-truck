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
import test from "node:test";
import type { AgentHost, AgentSessionState } from "./agent.ts";

type BridgeAsset = {
  id: string;
  localPath?: string;
  externalUrl?: string;
};

type BridgeSession = {
  id: string;
  selectedModelIds: { image: string; video: string };
  assets: BridgeAsset[];
  agent: AgentSessionState;
};

type CallResult = { value: unknown; isError: boolean };

function spawnMcp(dataDirectory: string, host: AgentHost, codexHome?: string) {
  const child = spawn(
    process.execPath,
    host === "unknown"
      ? ["scripts/mcp-server.ts"]
      : ["scripts/mcp-server.ts", "--agent-host", host],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPEN_GEN_UI_HOME: dataDirectory,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
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

test("MCP resolves user choices in agent chat and resumes them durably", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "open-gen-ui-mcp-"));
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
  assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, "open-gen-ui");
  const listed = await server.request("tools/list", {});
  const toolNames = (listed.result as { tools: Array<{ name: string }> }).tools.map((item) => item.name);
  assert.ok(toolNames.includes("claim_session"));
  assert.ok(toolNames.includes("resolve_decision"));
  assert.equal(toolNames.includes("await_decision"), false);
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

  const legacyAwait = await server.call("await_decision", {
    sessionId: createdSession.id,
    decisionId,
  });
  assert.equal(legacyAwait.isError, true);
  assert.match(String(legacyAwait.value), /moved to agent chat/i);

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
  assert.equal(selectedModel.isError, false);
  const restoredSession = await server.call("get_session", { sessionId: createdSession.id });
  assert.equal((restoredSession.value as BridgeSession).agent.modelSelections.image.modelId, "test/image");
  assert.equal((restoredSession.value as BridgeSession).selectedModelIds.image, "test/image");

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

  const outside = join(tmpdir(), `open-gen-ui-outside-${process.pid}-${Date.now()}.png`);
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

  const stored = readFileSync(join(dataDirectory, "agent-sessions.json"), "utf8");
  assert.equal(/data:(?:image|video)\//i.test(stored), false);
  assert.equal(/;base64,/i.test(stored), false);
});

test("Codex selects an image backend per session and registers built-in outputs", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "open-gen-ui-codex-mcp-"));
  const codexHome = mkdtempSync(join(tmpdir(), "open-gen-ui-codex-home-"));
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
  assert.equal(backendResolution.isError, false);
  assert.equal(
    (backendResolution.value as { imageGeneration: { backend: string } }).imageGeneration.backend,
    "codex_builtin",
  );

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
  assert.equal(registeredSession.agent.execution.generationCount, 1);
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
