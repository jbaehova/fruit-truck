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
import { coreRequest } from "../scripts/core-client.ts";
import { resolveAgentDecisionFromDesktop, type AgentHost, type AgentSessionState } from "./agent.ts";
import { materializeAgentSession, serializeAgentSessionForBridge, type AgentBridgeSession } from "./agentBridge.ts";
import { canonicalAgentSession } from "./agentCompat.ts";
import { createSession, type GenerationThread } from "./studio.ts";

type BridgeAsset = {
  id: string;
  kind?: "image" | "video";
  localPath?: string;
  externalUrl?: string;
  duration?: number;
  jobId?: string;
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
  writeFileSync(indexPath, JSON.stringify({ schemaVersion: 4, revision: envelope.revision, sessionFiles }, null, 2));
}

function storedEnvelopeText(dataDirectory: string) {
  return JSON.stringify(readStoredEnvelope(dataDirectory));
}

function spawnMcp(
  dataDirectory: string,
  host: AgentHost,
  codexHome?: string,
  openRouterBase?: string,
  toolProfile: "legacy" | "fast" = "legacy",
  coreMode: "off" | "shadow" | "canonical" = "off",
) {
  const child = spawn(
    process.execPath,
    host === "unknown"
      ? ["scripts/mcp-server.ts", "--tool-profile", toolProfile]
      : ["scripts/mcp-server.ts", "--agent-host", host, "--tool-profile", toolProfile],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FRUIT_TRUCK_HOME: dataDirectory,
        FRUIT_TRUCK_VIDEO_POLL_INTERVAL_MS: "100",
        FRUIT_TRUCK_CORE_MODE: coreMode,
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        ...(openRouterBase ? { FRUIT_TRUCK_OPENROUTER_BASE: openRouterBase } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let nextId = 1;
  const waiting = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line) as { id?: number };
    if (value.id != null) {
      waiting.get(value.id)?.resolve(value as Record<string, unknown>);
      waiting.delete(value.id);
    }
  });
  const rejectPending = (reason: string) => {
    for (const pending of waiting.values()) pending.reject(new Error(reason));
    waiting.clear();
  };
  child.once("error", (error) => rejectPending(`MCP process failed: ${error.message}`));
  child.once("exit", (code, signal) => rejectPending(`MCP process exited before replying (code=${code ?? "none"}, signal=${signal ?? "none"}).`));
  const request = (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    if (child.exitCode != null || child.signalCode != null) {
      return Promise.reject(new Error("MCP process is not running."));
    }
    const result = new Promise<Record<string, unknown>>((resolve, reject) => waiting.set(id, { resolve, reject }));
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

function stopCore(dataDirectory: string) {
  const lock = join(dataDirectory, "run", "core.lock");
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, "utf8"));
  if (Number.isInteger(pid) && pid > 1) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
  }
}

async function stopCoreAndWait(dataDirectory: string, previousPid: number) {
  stopCore(dataDirectory);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(previousPid, 0);
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail("Core did not exit after shutdown");
}

test("MCP shadow mode replays state to Core without exposing private telemetry fields", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-shadow-"));
  const server = spawnMcp(dataDirectory, "claude", undefined, undefined, "legacy", "shadow");
  context.after(() => {
    stopMcp(server.child);
    stopCore(dataDirectory);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await server.request("initialize", { clientInfo: { name: "Claude" } });
  const created = await server.call("create_session", { intent: "private shadow intent", name: "Shadow fixture" });
  const sessionId = (created.value as BridgeSession).id;
  await server.call("claim_session", { sessionId, agentName: "shadow-agent" });
  await server.call("update_brief", { sessionId, patch: { goal: "private shadow goal" } });

  const core = await coreRequest(dataDirectory, "session.read", { sessionId, view: "recovery" }) as {
    projection: BridgeSession;
  };
  assert.equal(core.projection.agent.brief.goal, "private shadow goal");
  assert.equal(core.projection.agent.connection.status, "claimed");

  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  const telemetry = readFileSync(join(dataDirectory, "telemetry", "mcp-spans.jsonl"), "utf8");
  assert.doesNotMatch(telemetry, /private shadow intent|private shadow goal|shadow-agent|session-/);
  const comparison = telemetry.trim().split("\n").map((line) => JSON.parse(line) as { name?: string; fields?: { semanticMismatch?: boolean } })
    .filter((item) => item.name === "core.shadow_compare");
  assert.ok(comparison.length >= 3);
  assert.ok(comparison.every((item) => item.fields?.semanticMismatch === false));
});

test("canonical MCP mode imports legacy state and leaves Core as the only new writer", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-canonical-"));
  const legacySession = await serializeAgentSessionForBridge(createSession("Legacy canonical fixture"));
  legacySession.agent = {
    ...legacySession.agent,
    connection: { status: "waiting" },
    runStatus: "idle",
    brief: { ...legacySession.agent.brief, originalIntent: "legacy intent", goal: "legacy goal" },
    revision: 17,
  };
  writeFileSync(join(dataDirectory, "agent-sessions.json"), JSON.stringify({
    schemaVersion: 4,
    revision: 29,
    sessions: [legacySession],
  }, null, 2));

  const server = spawnMcp(dataDirectory, "claude", undefined, undefined, "legacy", "canonical");
  context.after(() => {
    stopMcp(server.child);
    stopCore(dataDirectory);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await server.request("initialize", { clientInfo: { name: "Claude" } });
  const imported = await server.call("get_session", { sessionId: legacySession.id });
  assert.equal(imported.isError, false);
  assert.equal((imported.value as BridgeSession).agent.brief.goal, "legacy goal");
  assert.equal((imported.value as BridgeSession).agent.revision, 1);

  const claimed = await server.call("claim_session", { sessionId: legacySession.id, agentName: "canonical-agent" });
  assert.equal(claimed.isError, false);
  const updated = await server.call("update_brief", {
    sessionId: legacySession.id,
    patch: { goal: "Core canonical goal" },
  });
  assert.equal(updated.isError, false);
  assert.equal((updated.value as BridgeSession).agent.revision, 3);

  const core = await coreRequest(dataDirectory, "session.read", { sessionId: legacySession.id, view: "recovery" }) as {
    revision: number;
    projection: BridgeSession;
  };
  assert.equal(core.revision, 3);
  assert.equal(core.projection.agent.brief.goal, "Core canonical goal");
  assert.ok(existsSync(join(dataDirectory, "core.sqlite3")));
  assert.ok(existsSync(join(dataDirectory, "legacy-backup-v4", "agent-sessions.json")));
  const recovery = readStoredEnvelope(dataDirectory);
  assert.equal(recovery.sessions[0].agent.brief.goal, "Core canonical goal");
  assert.equal(recovery.sessions[0].agent.revision, 3);
});

test("canonical MCP mode preserves concurrent commands for different sessions", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-core-concurrency-"));
  const first = spawnMcp(dataDirectory, "claude", undefined, undefined, "legacy", "canonical");
  const second = spawnMcp(dataDirectory, "claude", undefined, undefined, "legacy", "canonical");
  context.after(() => {
    stopMcp(first.child);
    stopMcp(second.child);
    stopCore(dataDirectory);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await Promise.all([
    first.request("initialize", { clientInfo: { name: "Claude" } }),
    second.request("initialize", { clientInfo: { name: "Claude" } }),
  ]);
  const createAndClaim = async (server: ReturnType<typeof spawnMcp>, intent: string) => {
    const created = await server.call("create_session", { intent });
    const id = (created.value as BridgeSession).id;
    const claimed = await server.call("claim_session", { sessionId: id, agentName: `agent-${intent}` });
    assert.equal(claimed.isError, false);
    return id;
  };
  const firstId = await createAndClaim(first, "first");
  const secondId = await createAndClaim(second, "second");
  const [firstUpdate, secondUpdate] = await Promise.all([
    first.call("update_brief", { sessionId: firstId, patch: { goal: "first concurrent goal" } }),
    second.call("update_brief", { sessionId: secondId, patch: { goal: "second concurrent goal" } }),
  ]);
  assert.equal(firstUpdate.isError, false);
  assert.equal(secondUpdate.isError, false);
  const envelope = await coreRequest(dataDirectory, "session.read_all", {}) as StoredEnvelope;
  assert.equal(envelope.sessions.find((item) => item.id === firstId)?.agent.brief.goal, "first concurrent goal");
  assert.equal(envelope.sessions.find((item) => item.id === secondId)?.agent.brief.goal, "second concurrent goal");
});

test("canonical MCP rejects mutation from a different agent host", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-wrong-host-"));
  const claude = spawnMcp(dataDirectory, "claude", undefined, undefined, "legacy", "canonical");
  const codex = spawnMcp(dataDirectory, "codex", undefined, undefined, "legacy", "canonical");
  context.after(() => {
    stopMcp(claude.child);
    stopMcp(codex.child);
    stopCore(dataDirectory);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await Promise.all([
    claude.request("initialize", { clientInfo: { name: "Claude" } }),
    codex.request("initialize", { clientInfo: { name: "Codex" } }),
  ]);
  const created = await claude.call("create_session", { intent: "Protect host ownership" });
  const sessionId = (created.value as BridgeSession).id;
  const claimed = await claude.call("claim_session", { sessionId, agentName: "claude-owner" });
  assert.equal(claimed.isError, false, String(claimed.value));

  const rejected = await codex.call("update_brief", {
    sessionId,
    patch: { goal: "Must not be written by another host" },
  });
  assert.equal(rejected.isError, true);
  assert.match(String(rejected.value), /belongs to the claude agent host/i);
  const core = await coreRequest(dataDirectory, "session.read", { sessionId, view: "recovery" }) as {
    projection: BridgeSession;
  };
  assert.notEqual(core.projection.agent.brief.goal, "Must not be written by another host");
});

test("canonical fast MCP rebases concurrent typed commands for one session", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-core-same-session-"));
  const first = spawnMcp(dataDirectory, "claude", undefined, undefined, "fast", "canonical");
  const second = spawnMcp(dataDirectory, "claude", undefined, undefined, "fast", "canonical");
  context.after(() => {
    stopMcp(first.child);
    stopMcp(second.child);
    stopCore(dataDirectory);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await Promise.all([
    first.request("initialize", { clientInfo: { name: "Claude" } }),
    second.request("initialize", { clientInfo: { name: "Claude" } }),
  ]);
  const opened = await first.call("session_open", {
    requestKey: "same-session-open",
    intent: "Preserve concurrent typed updates",
    agentName: "same-session-agent",
  });
  assert.equal(opened.isError, false, String(opened.value));
  const sessionId = (opened.value as { sessionId: string }).sessionId;

  const [brief, requirement] = await Promise.all([
    first.call("session_commit", {
      sessionId,
      requestKey: "same-session-brief",
      baseRevision: 1,
      ops: [{ type: "update_brief", patch: { goal: "Concurrent goal" } }],
    }),
    second.call("session_commit", {
      sessionId,
      requestKey: "same-session-requirement",
      baseRevision: 1,
      ops: [{
        type: "upsert_requirements",
        requirements: [{ id: "duration", label: "Duration", value: "8 seconds", status: "confirmed", source: "user", blocking: false }],
      }],
    }),
  ]);
  assert.equal(brief.isError, false, String(brief.value));
  assert.equal(requirement.isError, false, String(requirement.value));

  const read = await first.call("session_read", { sessionId, view: "recovery" });
  assert.equal(read.isError, false, String(read.value));
  const projection = (read.value as { projection: BridgeSession }).projection;
  assert.equal(projection.agent.brief.goal, "Concurrent goal");
  assert.equal(projection.agent.requirements.find((item) => item.id === "duration")?.value, "8 seconds");
  assert.equal(projection.agent.revision, 3);

  const queued = await first.call("session_commit", {
    sessionId,
    requestKey: "same-session-decision",
    baseRevision: 3,
    ops: [{
      type: "queue_decision",
      requestKey: "same-session-decision-entity",
      title: "Approve concurrency result",
      prompt: "Approve?",
      kind: "approval",
      channel: "agent_chat",
      blocking: true,
      options: [{ id: "approve", label: "Approve" }, { id: "revise", label: "Revise" }],
    }],
  });
  assert.equal(queued.isError, false, String(queued.value));
  const withDecision = await first.call("session_read", { sessionId, view: "recovery" });
  const decisionId = ((withDecision.value as { projection: BridgeSession }).projection.agent.decisions)
    .find((item) => item.requestKey === "same-session-decision-entity")!.id;
  const resolutions = await Promise.all([
    first.call("session_commit", {
      sessionId,
      requestKey: "same-session-resolution-one",
      baseRevision: 4,
      ops: [{ type: "resolve_decision", decisionId, userResponse: "Approved", optionId: "approve" }],
    }),
    second.call("session_commit", {
      sessionId,
      requestKey: "same-session-resolution-two",
      baseRevision: 4,
      ops: [{ type: "resolve_decision", decisionId, userResponse: "Also approved", optionId: "approve" }],
    }),
  ]);
  assert.equal(resolutions.filter((item) => !item.isError).length, 1);
  assert.equal(resolutions.filter((item) => item.isError).length, 1);
  assert.match(String(resolutions.find((item) => item.isError)?.value), /already resolved/i);
});

test("canonical fast MCP restarts Core after the cached daemon exits", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-core-restart-"));
  const server = spawnMcp(dataDirectory, "claude", undefined, undefined, "fast", "canonical");
  context.after(() => {
    stopMcp(server.child);
    stopCore(dataDirectory);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await server.request("initialize", { clientInfo: { name: "Claude" } });
  const opened = await server.call("session_open", {
    requestKey: "restart-open",
    name: "Restart fixture",
    intent: "Survive a Core restart",
    agentName: "restart-agent",
  });
  assert.equal(opened.isError, false, String(opened.value));
  const sessionId = (opened.value as { sessionId: string }).sessionId;
  const firstPid = Number(readFileSync(join(dataDirectory, "run", "core.lock"), "utf8"));

  await stopCoreAndWait(dataDirectory, firstPid);
  const read = await server.call("session_read", { sessionId, view: "resume" });

  assert.equal(read.isError, false, String(read.value));
  assert.equal((read.value as { projection: { identity: { id: string } } }).projection.identity.id, sessionId);
  const secondPid = Number(readFileSync(join(dataDirectory, "run", "core.lock"), "utf8"));
  assert.notEqual(secondPid, firstPid);
});

test("fast session_open supports publish then claim without weakening creation idempotency", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-fast-open-"));
  const server = spawnMcp(dataDirectory, "claude", undefined, undefined, "fast", "canonical");
  context.after(() => {
    stopMcp(server.child);
    stopCore(dataDirectory);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const initialized = await server.request("initialize", { clientInfo: { name: "Claude" } });
  assert.match(String((initialized.result as { instructions?: string }).instructions), /session_open/);
  const published = await server.call("session_open", {
    requestKey: "publish-then-claim",
    name: "Publish then claim",
    intent: "Wait for the desktop before claiming",
  });
  assert.equal(published.isError, false, String(published.value));
  const publishedValue = published.value as {
    sessionId: string;
    revision: number;
    receipt: { changed: string[]; replayed: boolean; eventCursor: number };
    projection: { connection: { status: string } };
  };
  assert.equal(publishedValue.revision, 1);
  assert.deepEqual(publishedValue.receipt.changed, ["session"]);
  assert.equal(publishedValue.receipt.replayed, false);
  assert.ok(publishedValue.receipt.eventCursor >= 1);
  assert.equal(publishedValue.projection.connection.status, "waiting");

  const claimed = await server.call("session_open", {
    sessionId: publishedValue.sessionId,
    requestKey: "publish-then-claim",
    agentName: "claiming-agent",
  });
  assert.equal(claimed.isError, false, String(claimed.value));
  const claimedValue = claimed.value as {
    revision: number;
    receipt: { changed: string[]; replayed: boolean; eventCursor: number };
    projection: { connection: { status: string } };
  };
  assert.equal(claimedValue.revision, 2);
  assert.deepEqual(claimedValue.receipt.changed, ["connection"]);
  assert.equal(claimedValue.receipt.replayed, false);
  assert.ok(claimedValue.receipt.eventCursor >= publishedValue.receipt.eventCursor);
  assert.equal(
    claimedValue.projection.connection.status,
    "claimed",
  );

  const mismatched = await server.call("session_open", {
    sessionId: publishedValue.sessionId,
    requestKey: "publish-then-claim",
    intent: "A conflicting replacement intent",
  });
  assert.equal(mismatched.isError, true);
  assert.match(String(mismatched.value), /IDEMPOTENCY_KEY_REUSED/);
});

test("fast MCP profile batches local operations atomically and keeps receipts compact", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-fast-"));
  const server = spawnMcp(dataDirectory, "claude", undefined, undefined, "fast");
  context.after(() => {
    stopMcp(server.child);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await server.request("initialize", { clientInfo: { name: "Claude" } });
  const listed = await server.request("tools/list", {});
  const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(tools.map((item) => item.name), [
    "session_open", "session_read", "session_commit", "task_wait",
    "ensure_desktop", "list_models", "run_generation_threads",
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(tools)) < 5 * 1024);

  const opened = await server.call("session_open", {
    requestKey: "open-fast-fixture",
    name: "Fast fixture",
    intent: "Create a two-shot product film",
    agentName: "fast-test-agent",
  });
  assert.equal(opened.isError, false);
  const openValue = opened.value as {
    sessionId: string;
    revision: number;
    receipt: { replayed: boolean };
    projection: { runStatus: string };
  };
  assert.equal(openValue.receipt.replayed, false);
  assert.equal(openValue.revision, 1);
  assert.equal(openValue.projection.runStatus, "working");
  const resumedOpen = await server.call("session_open", {
    sessionId: openValue.sessionId,
    requestKey: "open-fast-fixture",
    agentName: "fast-test-agent",
  });
  assert.equal(resumedOpen.isError, false, String(resumedOpen.value));
  assert.equal((resumedOpen.value as { receipt: { replayed: boolean } }).receipt.replayed, true);
  const mismatchedOpen = await server.call("session_open", {
    sessionId: openValue.sessionId,
    requestKey: "open-fast-fixture",
    intent: "A different production",
  });
  assert.equal(mismatchedOpen.isError, true);
  assert.match(String(mismatchedOpen.value), /IDEMPOTENCY_KEY_REUSED/);

  const ops = [{
    type: "update_brief",
    patch: { goal: "A restrained two-shot product film" },
  }, {
    type: "upsert_requirements",
    requirements: [{ id: "duration", label: "Duration", value: "8 seconds", status: "confirmed", source: "user", blocking: false }],
  }, {
    type: "replace_plan",
    steps: [{ id: "shot-one", title: "Generate hero shot", description: "Create shot one", status: "in_progress", dependsOn: [] }],
  }, {
    type: "create_thread",
    requestKey: "thread-fast-one",
    mode: "video",
    name: "Hero shot",
    outputRole: "hero_video",
    planStepId: "shot-one",
  }, {
    type: "queue_decision",
    requestKey: "decision-fast-one",
    title: "Approve direction",
    prompt: "Choose whether to continue.",
    kind: "approval",
    channel: "fruit_truck_ui",
    blocking: true,
    planStepId: "shot-one",
    options: [{ id: "approve", label: "Approve" }, { id: "revise", label: "Revise" }],
  }];
  const committed = await server.call("session_commit", {
    sessionId: openValue.sessionId,
    requestKey: "commit-fast-one",
    baseRevision: openValue.revision,
    ops,
  });
  assert.equal(committed.isError, false);
  const receipt = committed.value as { revision: number; replayed: boolean; changed: string[] };
  assert.equal(receipt.revision, 2);
  assert.equal(receipt.replayed, false);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 1024);

  const replay = await server.call("session_commit", {
    sessionId: openValue.sessionId,
    requestKey: "commit-fast-one",
    baseRevision: openValue.revision,
    ops,
  });
  assert.equal(replay.isError, false);
  assert.equal((replay.value as { revision: number; replayed: boolean }).revision, 2);
  assert.equal((replay.value as { replayed: boolean }).replayed, true);

  const reused = await server.call("session_commit", {
    sessionId: openValue.sessionId,
    requestKey: "commit-fast-one",
    baseRevision: openValue.revision,
    ops: [{ type: "update_brief", patch: { goal: "Different payload" } }],
  });
  assert.equal(reused.isError, true);
  assert.match(String(reused.value), /IDEMPOTENCY_KEY_REUSED/);

  const rejected = await server.call("session_commit", {
    sessionId: openValue.sessionId,
    requestKey: "commit-fast-rollback",
    baseRevision: 2,
    ops: [
      { type: "update_brief", patch: { goal: "Must roll back" } },
      { type: "mark_step", stepId: "missing-step", status: "completed" },
    ],
  });
  assert.equal(rejected.isError, true);
  const read = await server.call("session_read", { sessionId: openValue.sessionId, view: "resume" });
  assert.equal(read.isError, false);
  const readValue = read.value as { revision: number; projection: { brief: { goal: string } } };
  assert.equal(readValue.revision, 2);
  assert.equal(readValue.projection.brief.goal, "A restrained two-shot product film");
  assert.ok(Buffer.byteLength(JSON.stringify(read.value)) < 8 * 1024);

  const stored = readStoredEnvelope(dataDirectory).sessions[0];
  const decisionId = stored.agent.decisions.find((item) => item.requestKey === "decision-fast-one")!.id;
  const wait = server.call("task_wait", {
    sessionId: openValue.sessionId,
    afterEvent: 2,
    decisionIds: [decisionId],
    timeoutMs: 300,
  });
  const ping = await Promise.race([
    server.request("ping", {}),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ping was blocked behind task_wait")), 150)),
  ]);
  assert.deepEqual(ping.result, {});
  const waited = await wait;
  assert.equal(waited.isError, false);
  assert.equal((waited.value as { status: string }).status, "pending");
  const storedAfterWait = readStoredEnvelope(dataDirectory).sessions[0];
  assert.equal(storedAfterWait.agent.decisions.length, stored.agent.decisions.length);
  assert.equal(
    [...storedAfterWait.threads.image, ...storedAfterWait.threads.video].flatMap((thread) => thread.attempts).length,
    0,
  );
});

test("legacy JSON, v1 Core adapter, and v2 fast path preserve the same workflow semantics", async (context) => {
  type CompatibilityLane = {
    name: string;
    dataDirectory: string;
    server: ReturnType<typeof spawnMcp>;
    calls: number;
  };
  const lanes: CompatibilityLane[] = [
    { name: "legacy-json", dataDirectory: mkdtempSync(join(tmpdir(), "fruit-truck-compat-json-")), server: undefined as never, calls: 0 },
    { name: "v1-core", dataDirectory: mkdtempSync(join(tmpdir(), "fruit-truck-compat-v1-")), server: undefined as never, calls: 0 },
    { name: "v2-core", dataDirectory: mkdtempSync(join(tmpdir(), "fruit-truck-compat-v2-")), server: undefined as never, calls: 0 },
  ];
  lanes[0].server = spawnMcp(lanes[0].dataDirectory, "claude", undefined, undefined, "legacy", "off");
  lanes[1].server = spawnMcp(lanes[1].dataDirectory, "claude", undefined, undefined, "legacy", "canonical");
  lanes[2].server = spawnMcp(lanes[2].dataDirectory, "claude", undefined, undefined, "fast", "canonical");
  context.after(() => {
    for (const lane of lanes) {
      stopMcp(lane.server.child);
      stopCore(lane.dataDirectory);
      rmSync(lane.dataDirectory, { recursive: true, force: true });
    }
  });
  await Promise.all(lanes.map((lane) => lane.server.request("initialize", { clientInfo: { name: "Claude" } })));

  const intent = "Create a restrained product film";
  const name = "Compatibility fixture";
  const agentName = "compatibility-agent";
  const briefPatch = { goal: "Create one restrained eight-second hero shot", outputSpec: "16:9, 1080p" };
  const requirements = [{
    id: "duration",
    label: "Duration",
    value: "8 seconds",
    status: "confirmed",
    source: "user",
    blocking: false,
  }];
  const steps = [{
    id: "hero-shot",
    title: "Create hero shot",
    description: "Generate and review the hero shot",
    status: "in_progress",
    dependsOn: [],
  }];
  const decision = {
    requestKey: "compat-direction-v1",
    title: "Approve direction",
    prompt: "Approve this restrained hero direction?",
    kind: "approval",
    channel: "agent_chat",
    presentation: "form",
    selectionMode: "single",
    allowNote: true,
    blocking: true,
    options: [{ id: "approve", label: "Approve" }, { id: "revise", label: "Revise" }],
  };

  const call = async (lane: CompatibilityLane, toolName: string, args: Record<string, unknown>) => {
    lane.calls += 1;
    const result = await lane.server.call(toolName, args);
    assert.equal(result.isError, false, `${lane.name}:${toolName} failed: ${String(result.value)}`);
    return result.value;
  };

  const runLegacyLane = async (lane: CompatibilityLane) => {
    const created = await call(lane, "create_session", { intent, name }) as AgentBridgeSession;
    await call(lane, "claim_session", { sessionId: created.id, agentName });
    await call(lane, "update_brief", { sessionId: created.id, patch: briefPatch });
    await call(lane, "upsert_requirements", { sessionId: created.id, requirements });
    await call(lane, "replace_plan", { sessionId: created.id, steps });
    const queued = await call(lane, "queue_decision", {
      sessionId: created.id,
      ...decision,
      relatedStepId: "hero-shot",
    }) as { decisionId: string };
    const pending = await call(lane, "get_session", { sessionId: created.id }) as AgentBridgeSession;
    await call(lane, "resolve_decision", {
      sessionId: created.id,
      decisionId: queued.decisionId,
      userResponse: "Approved direction",
      optionId: "approve",
      note: "Keep the pace restrained.",
    });
    const resolved = await call(lane, "get_session", { sessionId: created.id }) as AgentBridgeSession;
    return [canonicalAgentSession(pending), canonicalAgentSession(resolved)];
  };

  const runFastLane = async (lane: CompatibilityLane) => {
    const opened = await call(lane, "session_open", {
      requestKey: "compat-open-v1",
      intent,
      name,
      agentName,
    }) as { sessionId: string; revision: number };
    await call(lane, "session_commit", {
      sessionId: opened.sessionId,
      requestKey: "compat-setup-v1",
      baseRevision: opened.revision,
      ops: [
        { type: "update_brief", patch: briefPatch },
        { type: "upsert_requirements", requirements },
        { type: "replace_plan", steps },
        { type: "queue_decision", ...decision, planStepId: "hero-shot" },
      ],
    });
    const pendingRead = await call(lane, "session_read", {
      sessionId: opened.sessionId,
      view: "recovery",
    }) as { revision: number; projection: AgentBridgeSession };
    const decisionId = pendingRead.projection.agent.decisions.find((item) => item.requestKey === decision.requestKey)?.id;
    assert.ok(decisionId, "v2-core did not persist the compatibility decision");
    await call(lane, "session_commit", {
      sessionId: opened.sessionId,
      requestKey: "compat-resolve-v1",
      baseRevision: pendingRead.revision,
      ops: [{
        type: "resolve_decision",
        decisionId,
        userResponse: "Approved direction",
        optionId: "approve",
        note: "Keep the pace restrained.",
      }],
    });
    const resolvedRead = await call(lane, "session_read", {
      sessionId: opened.sessionId,
      view: "recovery",
    }) as { projection: AgentBridgeSession };
    return [canonicalAgentSession(pendingRead.projection), canonicalAgentSession(resolvedRead.projection)];
  };

  const [legacy, v1Core, v2Core] = await Promise.all([
    runLegacyLane(lanes[0]),
    runLegacyLane(lanes[1]),
    runFastLane(lanes[2]),
  ]);
  assert.deepEqual(v1Core, legacy);
  assert.deepEqual(v2Core, legacy);
  assert.ok(lanes[2].calls <= 12, `v2 scenario used ${lanes[2].calls} tool calls`);
  assert.ok(lanes[2].calls < lanes[0].calls, "v2 fast path did not reduce tool round trips");
});

function stopMcp(child: ChildProcessWithoutNullStreams) {
  child.stdin.end();
  child.kill();
}

async function stopMcpAndWait(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  stopMcp(child);
  await exited;
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

test("MCP startup durably removes legacy video edit threads and jobs", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-mcp-edit-migration-"));
  const session = createSession("Legacy edit migration");
  const serialized = await serializeAgentSessionForBridge(session);
  const editThread = {
    ...structuredClone(serialized.threads!.video[0]),
    id: "legacy-edit-thread",
    videoWorkflow: "edit",
    attempts: [{
      id: "legacy-edit-attempt",
      status: "in_progress",
      backend: "openrouter",
      draftRevision: 0,
      requestedBy: "agent",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputAssetIds: [],
      assetIds: [],
      jobId: "legacy-edit-job",
    }],
  };
  serialized.threads!.video = [editThread as GenerationThread];
  serialized.activeThreadIds!.video = editThread.id;
  serialized.agent.execution.currentJobIds = ["legacy-edit-job", "generate-job"];
  writeFileSync(join(dataDirectory, "agent-sessions.json"), JSON.stringify({
    schemaVersion: 4,
    revision: 7,
    sessions: [serialized],
  }, null, 2));

  const server = spawnMcp(dataDirectory, "claude");
  context.after(() => {
    stopMcp(server.child);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const initialized = await server.request("initialize", {});
  assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, "fruit-truck");

  const migrated = readStoredEnvelope(dataDirectory);
  assert.equal(migrated.revision, 8);
  assert.equal(migrated.sessions[0].threads.video.length, 1);
  assert.notEqual(migrated.sessions[0].threads.video[0].id, editThread.id);
  assert.deepEqual(migrated.sessions[0].threads.video[0].attempts, []);
  assert.deepEqual(migrated.sessions[0].agent.execution.currentJobIds, ["generate-job"]);
  assert.doesNotMatch(JSON.stringify(migrated), /videoWorkflow|video_reference|videoEdit|legacy-edit-job/);
});

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
  const listedTools = (listed.result as { tools: Array<{ name: string }> }).tools;
  const toolNames = listedTools.map((item) => item.name);
  assert.ok(toolNames.includes("claim_session"));
  assert.ok(toolNames.includes("ensure_desktop"));
  assert.ok(toolNames.includes("resolve_decision"));
  assert.equal(toolNames.includes("await_decision"), true);
  assert.ok(toolNames.includes("import_remote_asset"));
  assert.ok(toolNames.includes("propose_assembly"));
  assert.equal(toolNames.includes("request_image_backend_selection"), false);
  assert.equal(toolNames.includes("register_host_image"), false);
  assert.doesNotMatch(JSON.stringify(listedTools), /videoWorkflow|video_reference|videoEdit/);

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

  const duplicateAssembly = await server.call("queue_decision", {
    sessionId: createdSession.id,
    requestKey: "duplicate-assembly-v1",
    title: "Duplicate assembly review",
    prompt: "This must be rejected in favor of propose_assembly.",
    kind: "feedback",
    blocking: true,
    channel: "fruit_truck_ui",
    presentation: "assembly_review",
  });
  assert.equal(duplicateAssembly.isError, true);
  assert.match(String(duplicateAssembly.value), /propose_assembly/i);

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

  await stopMcpAndWait(server.child);
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

test("propose_assembly assigns render-safe IDs to agent-supplied clips", async (context) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "fruit-truck-assembly-mcp-"));
  const generatedDirectory = join(dataDirectory, "generated");
  const generatedVideo = join(generatedDirectory, "shot.mp4");
  mkdirSync(generatedDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(generatedVideo, Buffer.from("video-fixture"), { mode: 0o600 });

  const server = spawnMcp(dataDirectory, "hermes");
  context.after(() => {
    stopMcp(server.child);
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  await server.request("initialize", {});
  const created = await server.call("create_session", {
    name: "Assembly IDs",
    intent: "Assemble one approved video shot.",
  });
  const sessionId = (created.value as BridgeSession).id;
  await server.call("claim_session", { sessionId, agentName: "assembly-test" });
  const registered = await server.call("register_asset", {
    sessionId,
    name: "shot.mp4",
    kind: "video",
    mimeType: "video/mp4",
    origin: "generated",
    source: generatedVideo,
    role: "shot",
  });
  const assetId = (registered.value as BridgeSession).assets.at(-1)?.id;
  assert.ok(assetId);
  const approval = await server.call("queue_decision", {
    sessionId,
    requestKey: "approve-shot-v1",
    title: "Approve shot",
    prompt: "Approve the generated shot.",
    kind: "approval",
    blocking: true,
    relatedAssetIds: [assetId],
    options: [{ id: "approve", label: "Approve" }, { id: "revise", label: "Revise" }],
  });
  await server.call("resolve_decision", {
    sessionId,
    decisionId: (approval.value as { decisionId: string }).decisionId,
    userResponse: "Approve it.",
    optionId: "approve",
  });
  const proposed = await server.call("propose_assembly", {
    sessionId,
    requestKey: "assembly-v1",
    clips: [{ assetId, startSeconds: 0, endSeconds: 3, order: 0 }],
  });
  assert.equal(proposed.isError, false, String(proposed.value));
  const proposedClip = (proposed.value as { assembly: BridgeSession["agent"]["assembly"] }).assembly.clips[0];
  assert.match(proposedClip.id, /^assembly-/);
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

  await stopMcpAndWait(server.child);
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
    if (request.method === "GET" && request.url === "/videos/models") return sendJson(200, { data: [{ id: "test/video", name: "Test video", input_reference_types: ["image"], max_input_references: 2, supported_durations: [4], pricing_skus: { standard: "$0.25" } }] });
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
  maskThread.draft.imageEditTarget = "@1";
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
    const result = await server.call("update_generation_thread", { sessionId, threadId: target.id, expectedThreadRevision: fresh.revision, patch: { prompt: `Video ${target.id}`, enhancePrompt: false, options: { duration: 4 } } });
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
  await stopMcpAndWait(server.child);
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
  const generatedVideos = finalSession.assets.filter((asset) => asset.kind === "video" && asset.jobId?.startsWith("job-"));
  assert.equal(generatedVideos.length, 2);
  assert.ok(generatedVideos.every((asset) => asset.duration === 4));
  assert.ok(finalSession.agent.artifacts.filter((artifact) => generatedVideos.some((asset) => asset.id === artifact.assetId)).every((artifact) => Boolean(artifact.prompt)));
  assert.equal(((finalSession as unknown as { jobs?: unknown[] }).jobs ?? []).length, 0);

  await stopMcpAndWait(server.child);
  const timedOutEnvelope = readStoredEnvelope(dataDirectory);
  const timedOutSession = timedOutEnvelope.sessions.find((item) => item.id === sessionId)!;
  const timedOutThread = timedOutSession.threads.video[0];
  const timedOutAttemptId = "attempt-timeout-on-poll-error";
  timedOutThread.attempts.push({
    id: timedOutAttemptId,
    status: "in_progress",
    backend: "openrouter",
    draftRevision: timedOutThread.revision,
    requestedBy: "agent",
    createdAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    submittedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    modelId: "test/video",
    inputAssetIds: [],
    assetIds: [],
    jobId: "job-timeout-error",
  });
  timedOutSession.agent.execution.currentJobIds.push("job-timeout-error");
  timedOutEnvelope.revision += 1;
  writeStoredEnvelope(dataDirectory, timedOutEnvelope);
  server = spawnMcp(dataDirectory, "claude", undefined, base);
  await server.request("initialize", {});
  const timedOut = await server.call("await_generation_threads", { sessionId, attemptIds: [timedOutAttemptId], timeoutMs: 1_000 });
  assert.equal(timedOut.isError, false, String(timedOut.value));
  assert.equal((timedOut.value as { status: string; outcome: string }).status, "terminal");
  assert.equal((timedOut.value as { outcome: string }).outcome, "failed");
  const afterTimeout = (await server.call("get_session", { sessionId })).value as BridgeSession;
  const failedAfterPollError = afterTimeout.threads.video[0].attempts.find((attempt) => attempt.id === timedOutAttemptId);
  assert.equal(failedAfterPollError?.status, "failed");
  assert.match(failedAfterPollError?.error ?? "", /within 30 minutes/i);
  assert.equal(afterTimeout.agent.execution.currentJobIds.includes("job-timeout-error"), false);

  await stopMcpAndWait(server.child);
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

  await stopMcpAndWait(server.child);
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
