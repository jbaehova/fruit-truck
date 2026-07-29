#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createCustomSkillDraft,
  createAgentState,
  exposeAgentSession,
  normalizeAgentState,
  resolveAgentDecisionFromChat,
  validateAgentState,
  validatePlanStepTransition,
  type AgentDecision,
  type AgentDecisionSemanticKey,
  type AgentHost,
  type AgentSessionState,
  type ArtifactNode,
  type PlanStep,
} from "../src/agent.ts";
import {
  buildRequest,
  type GenerationModel,
  type ReferenceAsset,
} from "../src/openrouter.ts";

type BridgeAsset = {
  id: string;
  name: string;
  kind: "image" | "video";
  mimeType: string;
  origin: "upload" | "generated" | "edited";
  createdAt: string;
  localPath?: string;
  externalUrl?: string;
  duration?: number;
  jobId?: string;
  bridgeAvailability?: "available" | "desktop_only";
};

type BridgeSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: "image" | "video";
  selectedModelIds: { image: string; video: string };
  assets: BridgeAsset[];
  agent: AgentSessionState;
  jobs?: Array<Record<string, unknown>>;
};

type Envelope = { schemaVersion: 1; revision: number; sessions: BridgeSession[] };
type ToolResult = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

const dataDirectory = process.env.OPPA_GEN_HOME
  ? resolve(process.env.OPPA_GEN_HOME)
  : join(homedir(), ".oppa-gen");
const sessionsPath = join(dataDirectory, "agent-sessions.json");
const sessionsLockPath = join(dataDirectory, ".agent-sessions.lock");
const credentialsPath = join(dataDirectory, "credentials.json");
const skillsDirectory = join(dataDirectory, "skills");
const openRouterBase = process.env.OPPA_GEN_OPENROUTER_BASE ?? "https://openrouter.ai/api/v1";
const MAX_AGENT_STORE_BYTES = 10 * 1024 * 1024;
const MAX_ACTIVITY_ITEMS = 500;
const configuredAgentHost = (() => {
  const index = process.argv.findIndex((value) => value === "--agent-host");
  const inline = process.argv.find((value) => value.startsWith("--agent-host="))?.slice("--agent-host=".length);
  const value = inline ?? (index >= 0 ? process.argv[index + 1] : undefined);
  return value === "codex" || value === "claude" || value === "hermes" ? value : undefined;
})();
let initializedClientName = "";

function detectedAgentHost(): AgentHost {
  if (configuredAgentHost) return configuredAgentHost;
  const normalized = initializedClientName.toLowerCase();
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("hermes")) return "hermes";
  return "unknown";
}

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  },
});

const BASE_TOOLS = [
  tool("create_session", "Publish a resumable session from a rough intent. The session remains in connection-waiting state until claim_session is called; this tool does not draft a plan or questions.", {
    name: { type: "string", minLength: 1, maxLength: 100 },
    intent: { type: "string", minLength: 1, maxLength: 20_000 },
    workflowSkills: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 12 },
  }, ["intent"]),
  tool("list_sessions", "List resumable Oppa Gen agent sessions and their current checkpoint.", {}),
  tool("get_session", "Read the complete structured production state for one session.", {
    sessionId: { type: "string" },
  }, ["sessionId"]),
  tool("claim_session", "Claim a connection-waiting session before planning or execution. This changes the visible Agent panel from waiting to working.", {
    sessionId: { type: "string" },
    agentName: { type: "string", minLength: 1, maxLength: 100 },
  }, ["sessionId", "agentName"]),
  tool("update_brief", "Update explicit creative brief fields. Keep user facts separate from agent assumptions in requirements.", {
    sessionId: { type: "string" },
    patch: { type: "object", additionalProperties: false, properties: {
      goal: { type: "string" }, deliverable: { type: "string" }, usage: { type: "string" },
      visualApproach: { type: "string" }, outputSpec: { type: "string" }, message: { type: "string" },
      mustInclude: { type: "array", items: { type: "string" } },
      mustAvoid: { type: "array", items: { type: "string" } },
    } },
  }, ["sessionId", "patch"]),
  tool("replace_plan", "Replace the production graph with a content-type-independent dependency graph.", {
    sessionId: { type: "string" },
    expectedRevision: { type: "integer", minimum: 0 },
    steps: { type: "array", minItems: 1, maxItems: 80, items: { type: "object", required: ["id", "title", "description", "status", "dependsOn"], properties: {
      id: { type: "string" }, title: { type: "string" }, description: { type: "string" },
      status: { enum: ["pending", "in_progress", "waiting", "completed", "failed", "skipped"] },
      dependsOn: { type: "array", items: { type: "string" } }, outputRole: { type: "string" }, checkpoint: { type: "boolean" },
    } } },
  }, ["sessionId", "steps"]),
  tool("set_step_status", "Advance, pause, fail, retry, or complete a production step while preserving resumable state.", {
    sessionId: { type: "string" }, stepId: { type: "string" },
    status: { enum: ["pending", "in_progress", "waiting", "completed", "failed", "skipped"] },
    detail: { type: "string", maxLength: 5_000 },
  }, ["sessionId", "stepId", "status"]),
  tool("upsert_requirements", "Write confirmed, assumed, or missing requirements with provenance and blocking severity.", {
    sessionId: { type: "string" },
    requirements: { type: "array", maxItems: 100, items: { type: "object", required: ["id", "label", "value", "status", "source", "blocking"], properties: {
      id: { type: "string" }, label: { type: "string" }, value: { type: "string" },
      status: { enum: ["confirmed", "assumed", "missing"] }, source: { enum: ["user", "agent", "skill"] }, blocking: { type: "boolean" },
    } } },
  }, ["sessionId", "requirements"]),
  tool("queue_decision", "Record a meaningful user approval, choice, upload, or feedback checkpoint before presenting it in agent chat.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    title: { type: "string" }, prompt: { type: "string" },
    semanticKey: { enum: ["deliverable_usage", "visual_approach", "output_spec", "identity_refs", "final_approval"] },
    kind: { enum: ["approval", "choice", "upload", "feedback"] }, blocking: { type: "boolean" },
    relatedStepId: { type: "string" }, relatedAssetIds: { type: "array", items: { type: "string" } },
    options: { type: "array", maxItems: 12, items: { type: "object", required: ["id", "label"], properties: {
      id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, recommended: { type: "boolean" },
    } } },
  }, ["sessionId", "requestKey", "title", "prompt", "kind", "blocking"]),
  tool("resolve_decision", "Record the user's explicit agent-chat reply for one pending decision and apply its state effects atomically.", {
    sessionId: { type: "string" }, decisionId: { type: "string" },
    userResponse: { type: "string", minLength: 1, maxLength: 5_000 },
    optionId: { type: "string" }, note: { type: "string", maxLength: 5_000 },
    relatedAssetIds: { type: "array", maxItems: 12, items: { type: "string" } },
  }, ["sessionId", "decisionId", "userResponse"]),
  tool("record_activity", "Append a transparent activity record, including the exact prompt, model, rationale, assets, error, or recovery action when relevant.", {
    sessionId: { type: "string" }, kind: { enum: ["plan", "decision", "generation", "evaluation", "error", "handover", "assembly", "skill"] },
    title: { type: "string" }, detail: { type: "string" }, prompt: { type: "string" },
    modelId: { type: "string" }, assetIds: { type: "array", items: { type: "string" } },
  }, ["sessionId", "kind", "title"]),
  tool("list_models", "Query current OpenRouter image or video models. Use immediately before requesting the user's first model choice for that stage.", {
    mode: { enum: ["image", "video"] },
  }, ["mode"]),
  tool("request_model_selection", "Record a compatible-model choice checkpoint, then present its candidates in agent chat. This tool never chooses for the user.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    mode: { enum: ["image", "video"] },
    candidates: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", required: ["id", "label"], properties: {
      id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, recommended: { type: "boolean" },
      compatibility: { type: "string" }, inputStructure: { type: "string" }, price: { type: "string" }, constraints: { type: "string" },
    } } },
    recommendation: { type: "string" },
  }, ["sessionId", "requestKey", "mode", "candidates", "recommendation"]),
  tool("register_asset", "Register an uploaded or generated asset and its derivation in the artifact graph. Local paths must be absolute.", {
    sessionId: { type: "string" }, name: { type: "string" }, kind: { enum: ["image", "video"] },
    mimeType: { type: "string" }, origin: { enum: ["upload", "generated", "edited"] },
    source: { type: "string" }, role: { type: "string" }, parentAssetIds: { type: "array", items: { type: "string" } },
    planStepId: { type: "string" }, prompt: { type: "string" }, modelId: { type: "string" }, duration: { type: "number", minimum: 0 },
  }, ["sessionId", "name", "kind", "mimeType", "origin", "source", "role"]),
  tool("evaluate_asset", "Record separate technical and aesthetic evaluation. Queue approval and resolve it only from the user's agent-chat reply.", {
    sessionId: { type: "string" }, assetId: { type: "string" }, technical: { type: "string" },
    aesthetic: { type: "string" }, recommendation: { type: "string" },
  }, ["sessionId", "assetId", "technical", "aesthetic", "recommendation"]),
  tool("submit_generation", "Submit image or video generation with the user-selected stage model. The server maps standard options and asset roles into the model's declared input schema.", {
    sessionId: { type: "string" }, mode: { enum: ["image", "video"] }, prompt: { type: "string" },
    options: { type: "object", additionalProperties: true },
    provider: { type: "object", additionalProperties: true },
    assetBindings: { type: "array", maxItems: 12, items: { type: "object", required: ["assetId", "role"], properties: {
      assetId: { type: "string" }, role: { enum: ["reference", "first_frame", "last_frame", "video_reference"] },
    } } },
    role: { type: "string" }, planStepId: { type: "string" },
    estimatedCostUsd: { type: "number", minimum: 0, maximum: 10000 },
  }, ["sessionId", "mode", "prompt"]),
  tool("poll_video", "Poll an asynchronous OpenRouter video job and register its result when complete.", {
    sessionId: { type: "string" }, jobId: { type: "string" },
  }, ["sessionId", "jobId"]),
  tool("propose_custom_skill", "After video production begins, extract a text-only reusable Custom Skill and queue its approval for agent chat.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string" },
  }, ["sessionId", "requestKey", "name"]),
  tool("list_custom_skills", "List locally stored text-only Custom Skills and versions.", {}),
  tool("get_custom_skill", "Read the current or historical Markdown for one Custom Skill.", {
    name: { type: "string" }, version: { type: "integer", minimum: 1 },
  }, ["name"]),
  tool("request_custom_skill_activation", "Queue activation or deactivation of a stored Custom Skill for explicit confirmation in agent chat.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    version: { type: "integer", minimum: 1 }, active: { type: "boolean" },
  }, ["sessionId", "requestKey", "name", "version", "active"]),
];

const CODEX_TOOLS = [
  tool("request_image_backend_selection", "For this Codex-controlled session, queue the one-time choice between Codex built-in image generation and OpenRouter.", {
    sessionId: { type: "string" },
    reselect: { type: "boolean" },
  }, ["sessionId"]),
  tool("register_host_image", "Copy a Codex built-in image-generation result into managed Oppa Gen storage and register complete provenance.", {
    sessionId: { type: "string" }, sourcePath: { type: "string" },
    name: { type: "string" }, mimeType: { type: "string" },
    origin: { enum: ["generated", "edited"] }, role: { type: "string" },
    parentAssetIds: { type: "array", maxItems: 12, items: { type: "string" } },
    planStepId: { type: "string" }, prompt: { type: "string", minLength: 1, maxLength: 20_000 },
  }, ["sessionId", "sourcePath", "name", "mimeType", "origin", "role", "prompt"]),
];

function availableTools() {
  return detectedAgentHost() === "codex" ? [...BASE_TOOLS, ...CODEX_TOOLS] : BASE_TOOLS;
}

function emptyEnvelope(): Envelope {
  return { schemaVersion: 1, revision: 0, sessions: [] };
}

async function readEnvelope(): Promise<Envelope> {
  if (!existsSync(sessionsPath)) return emptyEnvelope();
  const metadata = await stat(sessionsPath);
  if (metadata.size > MAX_AGENT_STORE_BYTES) {
    throw new Error("The agent session bridge file exceeds 10 MB. Archive or delete old sessions before continuing.");
  }
  const value = JSON.parse(await readFile(sessionsPath, "utf8")) as Envelope;
  if (value.schemaVersion !== 1 || !Array.isArray(value.sessions)) throw new Error("Agent session store has an unsupported schema.");
  value.sessions = value.sessions.map((session) => ({ ...session, agent: normalizeAgentState(session.agent) }));
  return value;
}

async function writeEnvelope(value: Envelope) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${sessionsPath}.${process.pid}.tmp`;
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized) > MAX_AGENT_STORE_BYTES) {
    throw new Error("The agent session bridge file would exceed 10 MB. Archive or delete old sessions before continuing.");
  }
  if (/data:(?:image|video)\//i.test(serialized) || /;base64,/i.test(serialized)) {
    throw new Error("Agent session metadata cannot contain Base64 or data URL media.");
  }
  await writeFile(temporary, serialized, { mode: 0o600 });
  await rename(temporary, sessionsPath);
}

async function withSessionStoreLock<T>(action: () => Promise<T>): Promise<T> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = await open(sessionsLockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = await stat(sessionsLockPath)
        .then((metadata) => Date.now() - metadata.mtimeMs > 30_000)
        .catch(() => false);
      if (stale) await unlink(sessionsLockPath).catch(() => undefined);
      else await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  if (!handle) throw new Error("The shared agent session store is busy. Reload the session and try again.");
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(sessionsLockPath).catch(() => undefined);
  }
}

function requiredString(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function assertAgentHost(session: BridgeSession) {
  const connectedHost = session.agent.connection.agentHost;
  const currentHost = detectedAgentHost();
  if (connectedHost && connectedHost !== "unknown" && connectedHost !== currentHost) {
    throw new Error(`This session belongs to the ${connectedHost} agent host, but the current MCP server is ${currentHost}.`);
  }
}

function assertClaimedSessionOwner(session: BridgeSession) {
  if (session.agent.connection.status !== "claimed") {
    throw new Error("Claim this session before changing agent-owned state.");
  }
  assertAgentHost(session);
}

type MutationContext = {
  onRollback: (action: () => Promise<void>) => void;
};

async function mutateSession(
  sessionId: string,
  update: (session: BridgeSession, transaction: MutationContext) => void | Promise<void>,
  options: {
    expectedRevision?: number;
    requireOwnership?: boolean;
  } = {},
) {
  return withSessionStoreLock(async () => {
    const envelope = await readEnvelope();
    const index = envelope.sessions.findIndex((item) => item.id === sessionId);
    if (index < 0) throw new Error(`Session ${sessionId} does not exist.`);
    const session = envelope.sessions[index];
    if (options.requireOwnership !== false) assertClaimedSessionOwner(session);
    const currentRevision = session.agent.revision;
    if (options.expectedRevision != null && options.expectedRevision !== currentRevision) {
      throw new Error(`AGENT_SESSION_CONFLICT: expected revision ${options.expectedRevision}, but the shared session is at revision ${currentRevision}. Reload before saving.`);
    }
    const rollbacks: Array<() => Promise<void>> = [];
    try {
      await update(session, { onRollback: (action) => rollbacks.push(action) });
      const errors = validateAgentState(session.agent);
      const assetIds = new Set(session.assets.map((asset) => asset.id));
      for (const artifact of session.agent.artifacts) {
        if (!assetIds.has(artifact.assetId)) errors.push(`Artifact ${artifact.assetId} points to a missing session asset.`);
        if (artifact.parentAssetIds.some((id) => !assetIds.has(id))) errors.push(`Artifact ${artifact.assetId} has a missing parent session asset.`);
      }
      for (const decision of session.agent.decisions) {
        if (decision.relatedAssetIds.some((id) => !assetIds.has(id))) errors.push(`Decision ${decision.id} points to a missing session asset.`);
      }
      if (session.agent.assembly.clips.some((clip) => !assetIds.has(clip.assetId))) errors.push("Assembly points to a missing session asset.");
      if (errors.length) throw new Error(`Agent state is invalid: ${errors.join(" ")}`);
      session.agent.revision += 1;
      session.agent.updatedAt = new Date().toISOString();
      session.updatedAt = session.agent.updatedAt;
      envelope.sessions[index] = session;
      envelope.revision += 1;
      await writeEnvelope(envelope);
      return session;
    } catch (error) {
      for (const rollback of rollbacks.reverse()) await rollback().catch(() => undefined);
      throw error;
    }
  });
}

function assertExecutionAllowed(session: BridgeSession, action: string) {
  assertAgentHost(session);
  if (session.agent.controlMode !== "agent") {
    throw new Error(`${action} is blocked while Human control is active. Hand control back to Agent and resume the run before trying again.`);
  }
  if (session.agent.runStatus !== "working") {
    throw new Error(`${action} is blocked while the run is ${session.agent.runStatus}. Resolve blocking decisions if any, then resume the Agent run before trying again.`);
  }
  if (session.agent.decisions.some((item) => item.status === "pending" && item.blocking)) {
    throw new Error(`${action} is blocked by a pending user checkpoint. Resolve every blocking decision before resuming generation.`);
  }
}

async function openRouter(path: string, method: "GET" | "POST" = "GET", body?: unknown) {
  if (!existsSync(credentialsPath)) throw new Error("Add an OpenRouter API key in Oppa Gen Settings first.");
  const credential = JSON.parse(await readFile(credentialsPath, "utf8")) as { openrouter_api_key?: string };
  if (!credential.openrouter_api_key) throw new Error("The Oppa Gen credentials file has no API key.");
  const response = await fetch(`${openRouterBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${credential.openrouter_api_key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://oppa-gen.local",
      "X-Title": "Oppa Gen Agent Kit",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const message = (await response.text()).slice(0, 2_000);
    throw new Error(`OpenRouter ${response.status}: ${message || "Request failed"}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

function appendActivity(session: BridgeSession, input: Omit<AgentSessionState["activity"][number], "id" | "createdAt" | "actor"> & { actor?: "agent" | "user" | "runtime" }) {
  session.agent.activity.push({
    id: `activity-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    actor: input.actor ?? "agent",
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    prompt: input.prompt,
    modelId: input.modelId,
    generationBackend: input.generationBackend,
    assetIds: input.assetIds,
  });
  if (session.agent.activity.length > MAX_ACTIVITY_ITEMS) {
    session.agent.activity.splice(0, session.agent.activity.length - MAX_ACTIVITY_ITEMS);
  }
}

function skillSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom-production";
}

function safeGeneratedName(name: string, mimeType: string) {
  const extension = extname(name).toLowerCase();
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov"]);
  const fallback = mimeType.includes("webm") ? ".webm"
    : mimeType.startsWith("video/") ? ".mp4"
      : mimeType.includes("jpeg") ? ".jpg"
        : mimeType.includes("webp") ? ".webp"
          : ".png";
  const stem = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "generated";
  return `${stem}-${crypto.randomUUID()}${allowed.has(extension) ? extension : fallback}`;
}

async function writeGeneratedBytes(name: string, mimeType: string, bytes: Uint8Array) {
  const limit = mimeType.startsWith("video/") ? 700 * 1024 * 1024 : 30 * 1024 * 1024;
  if (!bytes.length || bytes.length > limit) throw new Error(`Generated ${mimeType.startsWith("video/") ? "video" : "image"} exceeds the local safety limit.`);
  const directory = join(dataDirectory, "generated");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, safeGeneratedName(name, mimeType));
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

async function materializeGeneratedSource(source: string, name: string, fallbackMimeType: string) {
  if (source.startsWith("data:")) {
    const match = source.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) throw new Error("Generated media contains an invalid data URL.");
    const mimeType = match[1].toLowerCase();
    if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) throw new Error("Generated data URL is not image or video media.");
    return writeGeneratedBytes(name, mimeType, Buffer.from(match[2], "base64"));
  }
  if (!/^https?:\/\//i.test(source)) return source;
  const response = await fetch(source, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not preserve generated media locally (HTTP ${response.status}).`);
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || fallbackMimeType;
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) throw new Error("Generated URL did not return image or video media.");
  return writeGeneratedBytes(name, mimeType, new Uint8Array(await response.arrayBuffer()));
}

function customSkillVersion(markdown: string) {
  return Number(markdown.match(/^version:\s*(\d+)/m)?.[1] ?? 1);
}

async function readStoredCustomSkill(name: string, version?: number) {
  const directory = join(skillsDirectory, skillSlug(name));
  const path = version == null ? join(directory, "SKILL.md") : join(directory, "versions", `${version}.md`);
  if (!existsSync(path)) throw new Error("Custom Skill version does not exist.");
  const markdown = await readFile(path, "utf8");
  return { name, version: customSkillVersion(markdown), markdown, path };
}

function validateCustomSkillText(markdown: string) {
  if (!markdown.trim() || markdown.length > 200_000) {
    throw new Error("Custom Skill text must be between 1 and 200000 characters.");
  }
  const lower = markdown.toLowerCase();
  const containsBoundId = markdown.split(/\s+/).some((value) => {
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    return ((value.startsWith("asset-") || value.startsWith("session-")) && value.length > 16) || uuidLike;
  });
  if (
    lower.includes("file://")
    || lower.includes("/users/")
    || lower.includes("/home/")
    || lower.includes("~/")
    || lower.includes("api_key")
    || lower.includes("api-key")
    || lower.includes("access_token")
    || lower.includes("begin rsa private key")
    || lower.includes("begin openssh private key")
    || lower.includes("begin ec private key")
    || lower.includes("sk-or-")
    || lower.includes("sk-proj-")
    || containsBoundId
    || markdown.split("\n").some((line) => /^[A-Za-z]:[\\/]/.test(line.trim()))
  ) {
    throw new Error("Custom Skill text contains a local path or secret-like value.");
  }
}

async function saveStoredCustomSkill(name: string, markdown: string) {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 100) {
    throw new Error("Custom Skill name must be between 1 and 100 characters.");
  }
  validateCustomSkillText(markdown);
  const directory = join(skillsDirectory, skillSlug(trimmedName));
  const versionsDirectory = join(directory, "versions");
  await mkdir(versionsDirectory, { recursive: true, mode: 0o700 });
  const path = join(directory, "SKILL.md");
  const currentExisted = existsSync(path);
  const current = currentExisted ? await readFile(path, "utf8") : "";
  const version = current ? customSkillVersion(current) + 1 : 1;
  let replaced = false;
  const normalized = markdown.split("\n").map((line) => {
    if (!replaced && line.startsWith("version:")) {
      replaced = true;
      return `version: ${version}`;
    }
    return line;
  }).join("\n");
  const withVersion = replaced ? normalized : `version: ${version}\n${normalized}`;
  const historyPath = join(versionsDirectory, `${version}.md`);
  const previousHistory = existsSync(historyPath) ? await readFile(historyPath, "utf8") : undefined;
  const temporary = join(directory, `.skill-${process.pid}-${crypto.randomUUID()}.tmp`);
  const restore = async () => {
    if (currentExisted) await writeFile(path, current, { mode: 0o600 });
    else await unlink(path).catch(() => undefined);
    if (previousHistory !== undefined) await writeFile(historyPath, previousHistory, { mode: 0o600 });
    else await unlink(historyPath).catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  };
  try {
    await writeFile(temporary, withVersion, { mode: 0o600 });
    await rename(temporary, path);
    await writeFile(historyPath, withVersion, { mode: 0o600 });
  } catch (error) {
    await restore().catch(() => undefined);
    throw error;
  }
  return { name: trimmedName, version, markdown: withVersion, path, rollback: restore };
}

async function downloadGeneratedVideo(jobId: string, fallbackSource: string) {
  const credential = JSON.parse(await readFile(credentialsPath, "utf8")) as { openrouter_api_key?: string };
  const response = await fetch(`${openRouterBase}/videos/${encodeURIComponent(jobId)}/content?index=0`, {
    headers: { Authorization: `Bearer ${credential.openrouter_api_key ?? ""}` },
  });
  if (response.ok) {
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "video/mp4";
    return writeGeneratedBytes(`agent-video-${jobId}`, mimeType, new Uint8Array(await response.arrayBuffer()));
  }
  if (fallbackSource) return materializeGeneratedSource(fallbackSource, `agent-video-${jobId}.mp4`, "video/mp4");
  throw new Error(`Video job completed, but its content could not be preserved locally (HTTP ${response.status}).`);
}

function bridgeAsset(session: BridgeSession, input: Record<string, unknown>) {
  const id = `asset-${crypto.randomUUID()}`;
  const source = requiredString(input, "source");
  if (!source.startsWith("data:") && !source.startsWith("http://") && !source.startsWith("https://") && !isAbsolute(source)) {
    throw new Error("Asset sources must be an absolute path, public URL, or data URL.");
  }
  const asset: BridgeAsset = {
    id,
    name: requiredString(input, "name"),
    kind: input.kind === "video" ? "video" : "image",
    mimeType: requiredString(input, "mimeType"),
    origin: input.origin === "upload" || input.origin === "edited" ? input.origin : "generated",
    createdAt: new Date().toISOString(),
    localPath: isAbsolute(source) ? source : undefined,
    externalUrl: /^https?:\/\//i.test(source) ? source : undefined,
    duration: typeof input.duration === "number" ? input.duration : undefined,
  };
  session.assets.push(asset);
  const artifact: ArtifactNode = {
    assetId: id,
    role: requiredString(input, "role"),
    parentAssetIds: Array.isArray(input.parentAssetIds) ? input.parentAssetIds.filter((item): item is string => typeof item === "string") : [],
    planStepId: typeof input.planStepId === "string" ? input.planStepId : undefined,
    prompt: typeof input.prompt === "string" ? input.prompt : undefined,
    modelId: typeof input.modelId === "string" ? input.modelId : undefined,
    generationBackend: input.generationBackend === "codex_builtin" ? "codex_builtin"
      : input.generationBackend === "openrouter" ? "openrouter"
        : undefined,
    approval: "unreviewed",
  };
  session.agent.artifacts.push(artifact);
  return asset;
}

function configuredLocalAssetRoots() {
  const explicit = (process.env.OPPA_GEN_ALLOWED_ASSET_DIRS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));
  return [join(dataDirectory, "assets"), join(dataDirectory, "generated"), ...explicit];
}

function isInsideDirectory(path: string, directory: string) {
  const pathFromRoot = relative(directory, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

async function validateLocalAssetSource(source: string) {
  if (!isAbsolute(source)) {
    throw new Error("Asset sources must be an absolute path, public URL, or data URL.");
  }
  const canonical = await realpath(source).catch(() => {
    throw new Error("The local asset does not exist or cannot be read.");
  });
  const roots = await Promise.all(configuredLocalAssetRoots().map(async (root) =>
    realpath(root).catch(() => resolve(root))
  ));
  if (!roots.some((root) => isInsideDirectory(canonical, root))) {
    throw new Error(
      "Local assets must be inside Oppa Gen's assets/generated directories or a directory explicitly allowed with OPPA_GEN_ALLOWED_ASSET_DIRS.",
    );
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error("The local asset source must be a regular file.");
  if (metadata.size > 30 * 1024 * 1024) {
    throw new Error("The local asset exceeds the 30 MB generation input limit.");
  }
  return canonical;
}

async function validateCodexImageSource(source: string, mimeType: string) {
  if (detectedAgentHost() !== "codex") throw new Error("Codex built-in image registration is available only to the Codex agent host.");
  if (!mimeType.toLowerCase().startsWith("image/")) throw new Error("Codex built-in generation can register only image media.");
  if (!isAbsolute(source)) throw new Error("The Codex image output path must be absolute.");
  const canonical = await realpath(source).catch(() => {
    throw new Error("The Codex image output does not exist or cannot be read.");
  });
  const codexDirectory = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
  const allowedRoots = [join(codexDirectory, "generated_images"), join(dataDirectory, "generated")];
  const canonicalRoots = await Promise.all(allowedRoots.map(async (root) => realpath(root).catch(() => resolve(root))));
  if (!canonicalRoots.some((root) => isInsideDirectory(canonical, root))) {
    throw new Error("Codex image outputs must come from the Codex generated_images directory or Oppa Gen managed generated storage.");
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error("The Codex image output must be a regular file.");
  if (!metadata.size || metadata.size > 30 * 1024 * 1024) throw new Error("The Codex image output exceeds the 30 MB safety limit.");
  return canonical;
}

async function hydrateGenerationAssets(
  session: BridgeSession,
  bindings: Array<{ assetId: string; role: ReferenceAsset["role"] }>,
): Promise<ReferenceAsset[]> {
  if (bindings.length > 12) throw new Error("At most 12 asset bindings are allowed.");
  return Promise.all(bindings.map(async (binding, index) => {
    const asset = session.assets.find((item) => item.id === binding.assetId);
    const source = asset?.localPath ?? asset?.externalUrl;
    if (!asset || !source) throw new Error(`Asset ${binding.assetId} has no readable source.`);
    let dataUrl = source;
    if (!/^(?:data:|https?:\/\/)/i.test(dataUrl)) {
      const path = await validateLocalAssetSource(dataUrl);
      const metadata = await stat(path);
      if (metadata.size > 30 * 1024 * 1024) throw new Error(`${asset.name} exceeds the 30 MB generation input limit.`);
      const bytes = await readFile(path);
      dataUrl = `data:${asset.mimeType};base64,${bytes.toString("base64")}`;
    }
    return {
      id: asset.id,
      name: asset.name,
      mediaType: asset.mimeType,
      dataUrl,
      role: binding.role,
      slot: index + 1,
    };
  }));
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (new Set([
    "record_user_model_selection",
    "set_control_mode",
    "set_session_limits",
    "configure_assembly",
    "render_assembly",
    "save_custom_skill",
    "rollback_custom_skill",
    "export_custom_skill",
    "import_custom_skill",
  ]).has(name)) {
    throw new Error(`${name} is not agent-accessible. Record an explicit chat decision for supported session actions.`);
  }
  if (name === "await_decision") {
    throw new Error("Decision input moved to agent chat. Update the Oppa Gen Agent Skill, ask the user in chat, then call resolve_decision with their reply.");
  }
  if (name === "create_session") {
    const intent = requiredString(args, "intent");
    const createdAt = new Date().toISOString();
    const agent = exposeAgentSession(createAgentState(intent), intent);
    for (const skill of Array.isArray(args.workflowSkills) ? args.workflowSkills : []) {
      if (typeof skill === "string" && skill.trim()) agent.appliedSkills.push({ name: skill.trim(), version: "user-selected", source: "workflow" });
    }
    const id = `session-${crypto.randomUUID()}`;
    const session: BridgeSession = {
      id,
      name: typeof args.name === "string" && args.name.trim() ? args.name.trim() : intent.slice(0, 54),
      createdAt,
      updatedAt: createdAt,
      mode: /video|reel|shorts|film|clip|영상|릴스|쇼츠|동영상/i.test(intent) ? "video" : "image",
      selectedModelIds: { image: "", video: "" },
      assets: [],
      agent,
      jobs: [],
    };
    await withSessionStoreLock(async () => {
      const envelope = await readEnvelope();
      envelope.sessions.push(session);
      envelope.revision += 1;
      await writeEnvelope(envelope);
    });
    return session;
  }
  if (name === "list_sessions") {
    const envelope = await readEnvelope();
    return envelope.sessions.map((session) => ({
      id: session.id, name: session.name, updatedAt: session.updatedAt,
      runStatus: session.agent.runStatus, controlMode: session.agent.controlMode,
      currentStepId: session.agent.currentStepId,
      pendingDecisions: session.agent.decisions.filter((item) => item.status === "pending").length,
    }));
  }
  if (name === "get_session") {
    const id = requiredString(args, "sessionId");
    const session = (await readEnvelope()).sessions.find((item) => item.id === id);
    if (!session) throw new Error(`Session ${id} does not exist.`);
    return session;
  }
  if (name === "claim_session") {
    const claimed = await mutateSession(requiredString(args, "sessionId"), (session) => {
      if (session.agent.connection.status === "claimed") {
        throw new Error(`Session is already claimed by ${session.agent.connection.claimedBy ?? "another agent"}.`);
      }
      if (session.agent.connection.status !== "waiting") {
        throw new Error("Session must be published in connection-waiting state before it can be claimed.");
      }
      const claimedAt = new Date().toISOString();
      session.agent.connection = {
        status: "claimed",
        claimedAt,
        claimedBy: requiredString(args, "agentName"),
        agentHost: detectedAgentHost(),
      };
      session.agent.imageGeneration = detectedAgentHost() === "codex"
        ? { status: "unselected" }
        : { status: "selected", backend: "openrouter", selectedBy: "policy", selectedAt: claimedAt };
      session.agent.controlMode = "agent";
      session.agent.runStatus = "working";
      session.agent.pausedReason = undefined;
      appendActivity(session, {
        kind: "handover",
        title: `Session claimed by ${session.agent.connection.claimedBy}`,
      });
    }, { requireOwnership: false });
    return {
      sessionId: claimed.id,
      connection: claimed.agent.connection,
      imageGeneration: claimed.agent.imageGeneration,
      runStatus: claimed.agent.runStatus,
      revision: claimed.agent.revision,
    };
  }
  if (name === "update_brief") {
    return mutateSession(requiredString(args, "sessionId"), (session) => {
      if (!args.patch || typeof args.patch !== "object" || Array.isArray(args.patch)) throw new Error("patch must be an object.");
      session.agent.brief = { ...session.agent.brief, ...(args.patch as Partial<AgentSessionState["brief"]>) };
      appendActivity(session, { kind: "plan", title: "Updated creative brief", detail: "Brief fields changed by the agent from explicit user direction." });
    });
  }
  if (name === "replace_plan") {
    return mutateSession(requiredString(args, "sessionId"), (session) => {
      if (!Array.isArray(args.steps) || !args.steps.length) throw new Error("steps must be a non-empty array.");
      session.agent.plan = args.steps as PlanStep[];
      session.agent.currentStepId = session.agent.plan.find((item) => ["in_progress", "waiting"].includes(item.status))?.id ?? session.agent.plan[0]?.id;
      appendActivity(session, { kind: "plan", title: "Revised production graph", detail: `${session.agent.plan.length} steps` });
    }, { expectedRevision: typeof args.expectedRevision === "number" ? args.expectedRevision : undefined });
  }
  if (name === "set_step_status") {
    return mutateSession(requiredString(args, "sessionId"), (session) => {
      const stepId = requiredString(args, "stepId");
      const step = session.agent.plan.find((item) => item.id === stepId);
      if (!step) throw new Error(`Plan step ${stepId} does not exist.`);
      const status = args.status as PlanStep["status"];
      const transitionError = validatePlanStepTransition(session.agent, stepId, status);
      if (transitionError) throw new Error(transitionError);
      const wasFailed = step.status === "failed";
      step.status = status;
      if (wasFailed && step.status === "in_progress") session.agent.execution.retryCount += 1;
      if (step.status === "failed") session.agent.execution.lastError = typeof args.detail === "string" ? args.detail : `${step.title} failed.`;
      session.agent.currentStepId = ["in_progress", "waiting", "failed"].includes(step.status) ? step.id : session.agent.plan.find((item) => item.status === "pending")?.id;
      appendActivity(session, { kind: step.status === "failed" ? "error" : "plan", title: `${step.title}: ${step.status.replaceAll("_", " ")}`, detail: typeof args.detail === "string" ? args.detail : undefined });
    });
  }
  if (name === "upsert_requirements") {
    return mutateSession(requiredString(args, "sessionId"), (session) => {
      if (!Array.isArray(args.requirements)) throw new Error("requirements must be an array.");
      for (const incoming of args.requirements as AgentSessionState["requirements"]) {
        const index = session.agent.requirements.findIndex((item) => item.id === incoming.id);
        if (index >= 0) session.agent.requirements[index] = incoming;
        else session.agent.requirements.push(incoming);
      }
    });
  }
  if (name === "request_image_backend_selection") {
    if (detectedAgentHost() !== "codex") throw new Error("Image backend selection is available only to Codex.");
    let decisionId = "";
    const updated = await mutateSession(requiredString(args, "sessionId"), (session) => {
      assertAgentHost(session);
      if (session.agent.connection.agentHost !== "codex") throw new Error("This session was not claimed by Codex.");
      const pending = session.agent.decisions.find((item) =>
        item.semanticKey === "image_generation_backend" && item.status === "pending"
      );
      if (pending) {
        decisionId = pending.id;
        return;
      }
      if (session.agent.imageGeneration.status === "selected" && args.reselect !== true) {
        decisionId = session.agent.imageGeneration.decisionId ?? "";
        return;
      }
      const item: AgentDecision = {
        id: `decision-${crypto.randomUUID()}`,
        semanticKey: "image_generation_backend",
        title: "Choose image generation backend",
        prompt: "Choose how this Codex-controlled session should generate and edit images.",
        kind: "choice",
        status: "pending",
        blocking: true,
        relatedAssetIds: [],
        options: [{
          id: "codex_builtin",
          label: "Codex built-in image generation",
          description: "Use Codex imagegen and Codex usage limits without the OpenRouter image API.",
          recommended: true,
        }, {
          id: "openrouter",
          label: "OpenRouter image generation",
          description: "Choose an OpenRouter image model and use the API key configured in Oppa Gen.",
        }],
        createdAt: new Date().toISOString(),
      };
      decisionId = item.id;
      session.agent.decisions.push(item);
      session.agent.runStatus = "waiting";
      appendActivity(session, { kind: "decision", title: `Requested: ${item.title}`, detail: item.prompt });
    });
    return {
      decisionId: decisionId || undefined,
      imageGeneration: updated.agent.imageGeneration,
      revision: updated.agent.revision,
    };
  }
  if (name === "queue_decision" || name === "request_model_selection") {
    const requestKey = requiredString(args, "requestKey");
    let decisionId = "";
    const updated = await mutateSession(requiredString(args, "sessionId"), (session) => {
      const existing = session.agent.decisions.find((item) => item.requestKey === requestKey);
      if (existing) {
        decisionId = existing.id;
        return;
      }
      const modelMode = name === "request_model_selection" ? (args.mode as "image" | "video") : undefined;
      const semanticKey = modelMode
        ? `model_selection_${modelMode}` as AgentDecisionSemanticKey
        : typeof args.semanticKey === "string"
          ? args.semanticKey as AgentDecisionSemanticKey
          : undefined;
      const item: AgentDecision = {
        id: `decision-${crypto.randomUUID()}`,
        requestKey,
        semanticKey,
        title: name === "request_model_selection" ? `Choose ${modelMode} model` : requiredString(args, "title"),
        prompt: name === "request_model_selection" ? requiredString(args, "recommendation") : requiredString(args, "prompt"),
        kind: name === "request_model_selection" ? "choice" : args.kind as AgentDecision["kind"],
        status: "pending",
        blocking: name === "request_model_selection" ? true : args.blocking === true,
        relatedStepId: typeof args.relatedStepId === "string" ? args.relatedStepId : undefined,
        relatedAssetIds: Array.isArray(args.relatedAssetIds) ? args.relatedAssetIds.filter((item): item is string => typeof item === "string") : [],
        options: (name === "request_model_selection" ? args.candidates : args.options) as AgentDecision["options"] ?? [],
        createdAt: new Date().toISOString(),
      };
      decisionId = item.id;
      session.agent.decisions.push(item);
      if (item.blocking && session.agent.controlMode === "agent" && session.agent.runStatus === "working") {
        session.agent.runStatus = "waiting";
      }
      if (modelMode) session.agent.modelSelections[modelMode] = { status: "pending_user", recommendation: item.prompt };
      appendActivity(session, { kind: "decision", title: `Requested: ${item.title}`, detail: item.prompt });
    });
    return { decisionId, revision: updated.agent.revision };
  }
  if (name === "resolve_decision") {
    const sessionId = requiredString(args, "sessionId");
    const decisionId = requiredString(args, "decisionId");
    const updated = await mutateSession(sessionId, async (session, transaction) => {
      assertAgentHost(session);
      const target = session.agent.decisions.find((item) => item.id === decisionId);
      if (!target) throw new Error(`Decision ${decisionId} does not exist.`);
      const optionId = typeof args.optionId === "string" ? args.optionId : undefined;
      if (target.semanticKey === "image_generation_backend"
        && optionId === "codex_builtin"
        && session.agent.connection.agentHost !== "codex") {
        throw new Error("Codex built-in image generation can be selected only in a Codex-controlled session.");
      }
      const previousRevision = session.agent.revision;
      const previousUpdatedAt = session.agent.updatedAt;
      const resolved = resolveAgentDecisionFromChat(
        session.agent,
        decisionId,
        requiredString(args, "userResponse"),
        optionId,
        typeof args.note === "string" ? args.note : undefined,
        Array.isArray(args.relatedAssetIds) ? args.relatedAssetIds.filter((item): item is string => typeof item === "string") : [],
      );
      let savedSkill: Awaited<ReturnType<typeof saveStoredCustomSkill>> | undefined;
      if (target.semanticKey === "custom_skill_approval" && optionId === "approve") {
        if (!session.agent.customSkill) throw new Error("There is no proposed Custom Skill to save.");
        savedSkill = await saveStoredCustomSkill(session.agent.customSkill.name, session.agent.customSkill.markdown);
        transaction.onRollback(savedSkill.rollback);
      }
      session.agent = { ...resolved, revision: previousRevision, updatedAt: previousUpdatedAt };
      if (target.semanticKey === "model_selection_image" && optionId) session.selectedModelIds.image = optionId;
      if (target.semanticKey === "model_selection_video" && optionId) session.selectedModelIds.video = optionId;
      if (savedSkill && session.agent.customSkill) {
        session.agent.customSkill = {
          ...session.agent.customSkill,
          version: savedSkill.version,
          markdown: savedSkill.markdown,
          status: "saved",
        };
        session.agent.appliedSkills = [
          ...session.agent.appliedSkills.filter((skill) => skill.source !== "custom" || skill.name !== savedSkill.name),
          { name: savedSkill.name, version: String(savedSkill.version), source: "custom" },
        ];
        appendActivity(session, { kind: "skill", title: `Saved and activated Custom Skill: ${savedSkill.name}`, detail: `Version ${savedSkill.version}` });
      }
      if (target.semanticKey === "custom_skill_activation" && target.customSkillAction && optionId === "approve") {
        const action = target.customSkillAction;
        session.agent.appliedSkills = action.active
          ? [
            ...session.agent.appliedSkills.filter((skill) => skill.source !== "custom" || skill.name !== action.name),
            { name: action.name, version: String(action.version), source: "custom" },
          ]
          : session.agent.appliedSkills.filter((skill) => skill.source !== "custom" || skill.name !== action.name);
        appendActivity(session, {
          kind: "skill",
          title: `${action.active ? "Activated" : "Deactivated"} Custom Skill: ${action.name}`,
          detail: `Version ${action.version}`,
        });
      }
    });
    const decision = updated.agent.decisions.find((item) => item.id === decisionId);
    return {
      status: decision?.status,
      decisionId,
      resolution: decision?.resolution,
      imageGeneration: updated.agent.imageGeneration,
      revision: updated.agent.revision,
    };
  }
  if (name === "record_activity") {
    return mutateSession(requiredString(args, "sessionId"), (session) => {
      appendActivity(session, {
        kind: args.kind as AgentSessionState["activity"][number]["kind"],
        title: requiredString(args, "title"),
        detail: typeof args.detail === "string" ? args.detail : undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        modelId: typeof args.modelId === "string" ? args.modelId : undefined,
        assetIds: Array.isArray(args.assetIds) ? args.assetIds.filter((item): item is string => typeof item === "string") : undefined,
      });
    });
  }
  if (name === "request_custom_skill_activation") {
    const sessionId = requiredString(args, "sessionId");
    const requestKey = requiredString(args, "requestKey");
    const skillName = requiredString(args, "name");
    const version = typeof args.version === "number" ? args.version : 0;
    if (!Number.isInteger(version) || version < 1) throw new Error("A valid Custom Skill version is required.");
    await readStoredCustomSkill(skillName, version);
    let decisionId = "";
    const updated = await mutateSession(sessionId, (session) => {
      const existing = session.agent.decisions.find((item) => item.requestKey === requestKey);
      if (existing) {
        decisionId = existing.id;
        return;
      }
      const active = args.active === true;
      const item: AgentDecision = {
        id: `decision-${crypto.randomUUID()}`,
        requestKey,
        semanticKey: "custom_skill_activation",
        title: `${active ? "Activate" : "Deactivate"} Custom Skill`,
        prompt: `${active ? "Activate" : "Deactivate"} ${skillName} v${version} for this session?`,
        kind: "approval",
        status: "pending",
        blocking: true,
        relatedAssetIds: [],
        customSkillAction: { name: skillName, version, active },
        options: [
          { id: "approve", label: active ? "Activate" : "Deactivate", recommended: true },
          { id: "cancel", label: "Keep current Skills" },
        ],
        createdAt: new Date().toISOString(),
      };
      decisionId = item.id;
      session.agent.decisions.push(item);
      session.agent.runStatus = "waiting";
      appendActivity(session, { kind: "decision", title: `Requested: ${item.title}`, detail: item.prompt });
    });
    return { decisionId, revision: updated.agent.revision };
  }
  if (name === "list_models") {
    const mode = args.mode === "video" ? "video" : "image";
    const path = mode === "image" ? "/images/models" : "/videos/models";
    const result = await openRouter(path);
    const models = Array.isArray(result.data) ? result.data : [];
    return models.map((model) => {
      const value = model as Record<string, unknown>;
      return {
        id: value.id, name: value.name, description: value.description,
        pricing: value.pricing, supportedParameters: value.supported_parameters,
        inputModalities: value.input_modalities ?? (value.architecture as Record<string, unknown> | undefined)?.input_modalities,
        outputModalities: value.output_modalities ?? (value.architecture as Record<string, unknown> | undefined)?.output_modalities,
        duration: value.duration, aspectRatios: value.aspect_ratios, maxImages: value.max_images,
      };
    });
  }
  if (name === "register_asset") {
    const sessionId = requiredString(args, "sessionId");
    const source = requiredString(args, "source");
    const normalizedSource = source.startsWith("data:")
      ? await materializeGeneratedSource(source, requiredString(args, "name"), requiredString(args, "mimeType"))
      : /^(?:https?:\/\/)/i.test(source)
        ? source
        : await validateLocalAssetSource(source);
    const normalizedArgs = {
      ...args,
      source: normalizedSource,
    };
    return mutateSession(sessionId, (session) => {
      const asset = bridgeAsset(session, normalizedArgs);
      appendActivity(session, { kind: "generation", title: `Registered ${asset.name}`, assetIds: [asset.id], modelId: typeof args.modelId === "string" ? args.modelId : undefined, prompt: typeof args.prompt === "string" ? args.prompt : undefined });
    });
  }
  if (name === "register_host_image") {
    if (detectedAgentHost() !== "codex") throw new Error("Codex built-in image registration is available only to Codex.");
    const sessionId = requiredString(args, "sessionId");
    const mimeType = requiredString(args, "mimeType").toLowerCase();
    const source = await validateCodexImageSource(requiredString(args, "sourcePath"), mimeType);
    const sourceBytes = await readFile(source);
    const parentAssetIds = Array.isArray(args.parentAssetIds)
      ? args.parentAssetIds.filter((item): item is string => typeof item === "string")
      : [];
    if (args.origin === "edited" && !parentAssetIds.length) {
      throw new Error("A Codex image edit must record at least one parent asset.");
    }
    return mutateSession(sessionId, async (session, transaction) => {
      assertExecutionAllowed(session, "Codex image registration");
      if (session.agent.connection.agentHost !== "codex"
        || session.agent.imageGeneration.status !== "selected"
        || session.agent.imageGeneration.backend !== "codex_builtin") {
        throw new Error("This session has not selected Codex built-in image generation.");
      }
      if (session.agent.execution.generationLimit != null
        && session.agent.execution.generationCount >= session.agent.execution.generationLimit) {
        throw new Error("The user-confirmed generation limit has been reached.");
      }
      const currentAssetIds = new Set(session.assets.map((asset) => asset.id));
      const missingParent = parentAssetIds.find((id) => !currentAssetIds.has(id));
      if (missingParent) {
        throw new Error(`Parent asset ${missingParent} does not exist in this session.`);
      }
      const managedSource = await writeGeneratedBytes(requiredString(args, "name"), mimeType, sourceBytes);
      transaction.onRollback(async () => {
        await unlink(managedSource).catch(() => undefined);
      });
      const asset = bridgeAsset(session, {
        ...args,
        source: managedSource,
        kind: "image",
        modelId: "codex/imagegen",
        generationBackend: "codex_builtin",
        parentAssetIds,
      });
      session.agent.execution.generationCount += 1;
      appendActivity(session, {
        kind: "generation",
        title: `${args.origin === "edited" ? "Edited" : "Generated"} image with Codex`,
        detail: "Codex built-in image generation",
        prompt: requiredString(args, "prompt"),
        modelId: "codex/imagegen",
        generationBackend: "codex_builtin",
        assetIds: [asset.id],
      });
    });
  }
  if (name === "evaluate_asset") {
    if (args.approval !== undefined || args.confirmedByUser !== undefined) {
      throw new Error("Artifact approval must come from an explicit agent-chat decision. Record evaluation, queue approval, then call resolve_decision after the user replies.");
    }
    return mutateSession(requiredString(args, "sessionId"), (session) => {
      const id = requiredString(args, "assetId");
      const artifact = session.agent.artifacts.find((item) => item.assetId === id);
      if (!artifact) throw new Error(`Artifact ${id} does not exist.`);
      artifact.evaluation = {
        technical: requiredString(args, "technical"),
        aesthetic: requiredString(args, "aesthetic"),
        recommendation: requiredString(args, "recommendation"),
      };
      appendActivity(session, { kind: "evaluation", title: `Evaluated ${session.assets.find((item) => item.id === id)?.name ?? id}`, detail: artifact.evaluation.recommendation, assetIds: [id] });
    });
  }
  if (name === "submit_generation") {
    const sessionId = requiredString(args, "sessionId");
    const mode = args.mode === "video" ? "video" : "image";
    const prompt = requiredString(args, "prompt");
    const envelope = await readEnvelope();
    const current = envelope.sessions.find((item) => item.id === sessionId);
    if (!current) throw new Error(`Session ${sessionId} does not exist.`);
    assertExecutionAllowed(current, "Generation submission");
    if (mode === "image" && (
      current.agent.imageGeneration.status !== "selected"
      || current.agent.imageGeneration.backend !== "openrouter"
    )) {
      throw new Error("This session has not selected OpenRouter for image generation.");
    }
    const selection = current.agent.modelSelections[mode];
    if (selection.status !== "selected" || !selection.modelId || selection.selectedBy !== "user") {
      throw new Error(`The user must select the ${mode} model immediately before its first use.`);
    }
    const estimatedCost = typeof args.estimatedCostUsd === "number" ? args.estimatedCostUsd : 0;
    if (current.agent.execution.generationLimit != null
      && current.agent.execution.generationCount >= current.agent.execution.generationLimit) {
      throw new Error("The user-confirmed generation limit has been reached. Request a new limit before continuing.");
    }
    if (current.agent.execution.budgetUsd != null
      && current.agent.execution.spentUsd + estimatedCost > current.agent.execution.budgetUsd) {
      throw new Error("This request would exceed the user-confirmed session budget. Request approval for a new limit or choose a lower-cost model.");
    }
    const bindingInputs = Array.isArray(args.assetBindings) ? args.assetBindings as Array<Record<string, unknown>> : [];
    const bindings = bindingInputs.map((binding) => ({
      assetId: String(binding.assetId ?? ""),
      role: binding.role as ReferenceAsset["role"],
    }));
    if (mode === "video") {
      const unapprovedImage = bindings.find((binding) => {
        const asset = current.assets.find((item) => item.id === binding.assetId);
        const artifact = current.agent.artifacts.find((item) => item.assetId === binding.assetId);
        return asset?.kind === "image" && artifact?.approval !== "approved";
      });
      if (unapprovedImage) {
        throw new Error("Image-to-video generation requires explicit approval of every bound image artifact. Approve the selected keyframe, then resume the Agent run.");
      }
    }
    const modelResponse = await openRouter(mode === "image" ? "/images/models" : "/videos/models");
    const models = Array.isArray(modelResponse.data) ? modelResponse.data as GenerationModel[] : [];
    const model = models.find((item) => item.id === selection.modelId);
    if (!model) throw new Error(`The selected ${mode} model is no longer in the current catalog.`);
    const references = await hydrateGenerationAssets(current, bindings);
    const workflow = bindings.some((binding) => binding.role === "video_reference") ? "edit" : "generate";
    const payload = buildRequest({
      mode,
      videoWorkflow: workflow,
      model: selection.modelId,
      prompt,
      assets: references,
      options: args.options && typeof args.options === "object" && !Array.isArray(args.options)
        ? args.options as Record<string, string | number | boolean | undefined>
        : {},
      providerJson: args.provider && typeof args.provider === "object" && !Array.isArray(args.provider)
        ? JSON.stringify(args.provider)
        : "",
    }, model);
    const referenceBindings = bindings.filter((binding) => binding.role === "reference" || binding.role === "video_reference");
    const frameBindings = bindings.filter((binding) => binding.role === "first_frame" || binding.role === "last_frame");
    if (mode === "video" && referenceBindings.length && frameBindings.length) {
      throw new Error("The selected video model input must use either general references or frame images for one request, not both.");
    }
    const sentReferences = Array.isArray(payload.input_references) ? payload.input_references.length : 0;
    const sentFrames = Array.isArray(payload.frame_images) ? payload.frame_images.length : 0;
    if (sentReferences !== referenceBindings.length || sentFrames !== frameBindings.length) {
      throw new Error("One or more bound assets are incompatible with the user-selected model. Request a new model choice or compatible inputs.");
    }
    const response = await openRouter(mode === "image" ? "/images" : "/videos", "POST", payload);
    const usage = response.usage && typeof response.usage === "object" ? response.usage as Record<string, unknown> : {};
    const recordedCost = typeof usage.cost === "number" ? usage.cost : estimatedCost;
    const preservedImages = mode === "image"
      ? await Promise.all((Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : []).map(async (item, index) => {
        const source = typeof item.url === "string"
          ? item.url
          : typeof item.b64_json === "string"
            ? `data:${typeof item.media_type === "string" ? item.media_type : "image/png"};base64,${item.b64_json}`
            : "";
        if (!source) return "";
        return materializeGeneratedSource(source, `agent-image-${Date.now()}-${index + 1}.png`, "image/png");
      }))
      : [];
    return mutateSession(sessionId, (session) => {
      assertExecutionAllowed(session, "Generation result recording");
      if (session.agent.modelSelections[mode].modelId !== selection.modelId) {
        throw new Error(`AGENT_SESSION_CONFLICT: the selected ${mode} model changed while this request was running. Reload before recording its result.`);
      }
      const inputAssetIds = bindings.map((binding) => binding.assetId);
      if (mode === "image") {
        const data = Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : [];
        const assets = data.flatMap((_item, index) => {
          const source = preservedImages[index] ?? "";
          if (!source) return [];
          return [bridgeAsset(session, {
            name: `agent-image-${Date.now()}-${index + 1}.png`, kind: "image", mimeType: "image/png",
            origin: "generated", source, role: typeof args.role === "string" ? args.role : "generated_image",
            parentAssetIds: inputAssetIds, planStepId: args.planStepId, prompt, modelId: selection.modelId,
            generationBackend: "openrouter",
          })];
        });
        if (!assets.length) throw new Error("OpenRouter returned no image data.");
        appendActivity(session, { kind: "generation", title: `Generated ${assets.length} image candidate(s)`, prompt, modelId: selection.modelId, generationBackend: "openrouter", assetIds: assets.map((asset) => asset.id) });
      } else {
        const jobId = typeof response.id === "string" ? response.id : typeof response.job_id === "string" ? response.job_id : "";
        if (!jobId) throw new Error("OpenRouter returned no video job ID.");
        session.jobs ??= [];
        session.jobs.push({ jobId, status: response.status ?? "pending", prompt, modelId: selection.modelId, inputAssetIds, role: args.role, planStepId: args.planStepId, submittedAt: new Date().toISOString() });
        session.agent.execution.currentJobIds.push(jobId);
        appendActivity(session, { kind: "generation", title: "Submitted video generation", detail: jobId, prompt, modelId: selection.modelId, assetIds: inputAssetIds });
      }
      session.agent.execution.generationCount += 1;
      session.agent.execution.spentUsd += recordedCost;
    });
  }
  if (name === "poll_video") {
    const sessionId = requiredString(args, "sessionId");
    const jobId = requiredString(args, "jobId");
    const response = await openRouter(`/videos/${encodeURIComponent(jobId)}`);
    const currentSession = (await readEnvelope()).sessions.find((item) => item.id === sessionId);
    const currentJob = currentSession?.jobs?.find((item) => item.jobId === jobId);
    if (!currentJob) throw new Error(`Video job ${jobId} is not registered in this session.`);
    const urls = Array.isArray(response.unsigned_urls) ? response.unsigned_urls : [];
    const data = Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : [];
    const remoteSource = typeof urls[0] === "string" ? urls[0] : typeof data[0]?.url === "string" ? data[0].url : "";
    const preservedSource = response.status === "completed" && !currentJob.assetId
      ? await downloadGeneratedVideo(jobId, remoteSource)
      : "";
    return mutateSession(sessionId, (session) => {
      const job = session.jobs?.find((item) => item.jobId === jobId);
      if (!job) throw new Error(`Video job ${jobId} is not registered in this session.`);
      Object.assign(job, { status: response.status ?? "in_progress", progress: response.progress, error: response.error });
      if (response.status === "completed" || response.status === "failed") {
        session.agent.execution.currentJobIds = session.agent.execution.currentJobIds.filter((id) => id !== jobId);
      }
      if (response.status === "failed") {
        session.agent.execution.lastError = typeof response.error === "string" ? response.error : "Video generation failed.";
      }
      if (response.status === "completed" && preservedSource && !job.assetId) {
        const asset = bridgeAsset(session, {
          name: `agent-video-${jobId}.mp4`, kind: "video", mimeType: "video/mp4",
          origin: "generated", source: preservedSource, role: typeof job.role === "string" ? job.role : "video_shot",
          parentAssetIds: job.inputAssetIds, planStepId: job.planStepId, prompt: job.prompt, modelId: job.modelId,
          generationBackend: "openrouter",
        });
        job.assetId = asset.id;
        appendActivity(session, { kind: "generation", title: "Video generation completed", detail: jobId, modelId: String(job.modelId ?? ""), generationBackend: "openrouter", assetIds: [asset.id] });
      }
    });
  }
  if (name === "propose_custom_skill") {
    const requestKey = requiredString(args, "requestKey");
    let decisionId = "";
    const updated = await mutateSession(requiredString(args, "sessionId"), (session) => {
      const existing = session.agent.decisions.find((item) => item.requestKey === requestKey);
      if (existing) {
        decisionId = existing.id;
        return;
      }
      session.agent.customSkill = createCustomSkillDraft(session.agent, requiredString(args, "name"));
      const decision: AgentDecision = {
        id: `decision-${crypto.randomUUID()}`,
        requestKey,
        semanticKey: "custom_skill_approval",
        title: "Approve Custom Skill",
        prompt: `Save and activate the proposed Custom Skill “${session.agent.customSkill.name}” for this session?`,
        kind: "approval",
        status: "pending",
        blocking: true,
        relatedAssetIds: [],
        options: [
          { id: "approve", label: "Save and activate", recommended: true },
          { id: "reject", label: "Reject proposal" },
        ],
        createdAt: new Date().toISOString(),
      };
      decisionId = decision.id;
      session.agent.decisions.push(decision);
      session.agent.runStatus = "waiting";
      appendActivity(session, { kind: "skill", title: `Proposed Custom Skill: ${session.agent.customSkill.name}` });
    });
    return { decisionId, customSkill: updated.agent.customSkill, revision: updated.agent.revision };
  }
  if (name === "list_custom_skills") {
    if (!existsSync(skillsDirectory)) return [];
    const entries = await readdir(skillsDirectory, { withFileTypes: true });
    const values = await Promise.all(entries.filter((item) => item.isDirectory()).map(async (item) => {
      const path = join(skillsDirectory, item.name, "SKILL.md");
      if (!existsSync(path)) return null;
      const markdown = await readFile(path, "utf8");
      return {
        name: markdown.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? item.name,
        version: customSkillVersion(markdown),
        path,
        versions: existsSync(join(skillsDirectory, item.name, "versions"))
          ? (await readdir(join(skillsDirectory, item.name, "versions")))
            .flatMap((file) => /^\d+\.md$/.test(file) ? [Number(file.replace(/\.md$/, ""))] : [])
            .sort((left, right) => right - left)
          : [customSkillVersion(markdown)],
      };
    }));
    return values.filter(Boolean);
  }
  if (name === "get_custom_skill") {
    return readStoredCustomSkill(requiredString(args, "name"), typeof args.version === "number" ? args.version : undefined);
  }
  throw new Error(`Unknown tool: ${name}`);
}

function response(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorResponse(id: unknown, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestChain = Promise.resolve();
input.on("line", (line) => {
  if (!line.trim()) return;
  requestChain = requestChain.then(async () => {
    let request: Record<string, unknown>;
    try { request = JSON.parse(line) as Record<string, unknown>; }
    catch { errorResponse(null, new Error("Invalid JSON-RPC message.")); return; }
    const id = request.id;
    if (request.method === "initialize") {
      const params = request.params as { clientInfo?: { name?: string } } | undefined;
      initializedClientName = typeof params?.clientInfo?.name === "string" ? params.clientInfo.name : "";
      response(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "oppa-gen", version: "1.0.0" },
        instructions: `This server is connected as ${detectedAgentHost()}. Claim a session before work. Queue every user-owned choice, present it in agent chat, and call resolve_decision only after the user explicitly replies. Codex sessions must choose one image backend per session before their first image task.`,
      });
      return;
    }
    if (request.method === "ping") { response(id, {}); return; }
    if (request.method === "tools/list") { response(id, { tools: availableTools() }); return; }
    if (request.method === "tools/call") {
      try {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) throw new Error("Tool name is required.");
        const result = await handleTool(params.name, params.arguments ?? {});
        response(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response(id, { content: [{ type: "text", text: message }], isError: true });
      }
      return;
    }
    if (id !== undefined) errorResponse(id, new Error(`Unsupported method: ${String(request.method)}`));
  }).catch((error) => errorResponse(null, error));
});
