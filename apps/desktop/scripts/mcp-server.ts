#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PNG } from "pngjs";
import {
  createCustomSkillDraft,
  createAgentState,
  exposeAgentSession,
  normalizeAgentState,
  recordActualCost,
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
  applyImageModelEndpoints,
  buildRequest,
  estimateGenerationCost,
  productSystemInstruction,
  promptEnhancementUserContent,
  promptEnhancerInstruction,
  normalizeVideoStatus,
  validateEnhancedPrompt,
  type DraftOptions,
  type GenerationModel,
  type ImageModel,
  type ImageModelEndpoint,
  type PromptEnhancementVisual,
  type ReferenceAsset,
} from "../src/openrouter.ts";
import { composeEditPrompt, hasGenerationInstructions } from "../src/mask.ts";
import { hasVideoPollingTimedOut, isVideoPollDue, videoPollRetryDelayMs } from "../src/videoPolling.ts";
import type {
  GenerationAttempt,
  GenerationAttemptSnapshot,
  GenerationDefaults,
  GenerationDraftState,
  GenerationThread,
  MaskStroke,
  PromptEnhancementAttempt,
} from "../src/studio.ts";

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
  sourceUrl?: string;
  sourcePageUrl?: string;
  license?: string;
};

type BridgeSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: "image" | "video";
  generationDefaults: GenerationDefaults;
  threads: { image: GenerationThread[]; video: GenerationThread[] };
  activeThreadIds: { image: string; video: string };
  assets: BridgeAsset[];
  agent: AgentSessionState;
};

type Envelope = { schemaVersion: 1 | 2 | 3 | 4; revision: number; sessions: BridgeSession[] };
type ToolResult = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

const dataDirectory = process.env.FRUIT_TRUCK_HOME
  ? resolve(process.env.FRUIT_TRUCK_HOME)
  : join(homedir(), ".fruit-truck");
const sessionsPath = join(dataDirectory, "agent-sessions.json");
const sessionsDirectory = join(dataDirectory, "agent-sessions");
const sessionsLockPath = join(dataDirectory, ".agent-sessions.lock");
const credentialsPath = join(dataDirectory, "credentials.json");
const runtimePath = join(dataDirectory, "desktop-runtime.json");
const skillsDirectory = join(dataDirectory, "skills");
const openRouterBase = process.env.FRUIT_TRUCK_OPENROUTER_BASE ?? "https://openrouter.ai/api/v1";
const videoPollIntervalMs = Math.max(100, Number(process.env.FRUIT_TRUCK_VIDEO_POLL_INTERVAL_MS) || 10_000);
const MAX_AGENT_STORE_BYTES = 10 * 1024 * 1024;
const MAX_AGENT_READ_BYTES = 50 * 1024 * 1024;
const MAX_AGENT_SESSION_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVITY_ITEMS = 500;
const threadExecutions = new Map<string, Promise<void>>();
const enhancementExecutions = new Set<string>();
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
  tool("list_sessions", "List resumable Fruit Truck agent sessions and their current checkpoint.", {}),
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
  tool("ensure_desktop", "Ensure Fruit Truck is running without stealing focus. On macOS the app is launched in the background when installed.", {
    sessionId: { type: "string" },
  }, ["sessionId"]),
  tool("queue_decision", "Record a meaningful chat or Fruit Truck UI checkpoint.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    title: { type: "string" }, prompt: { type: "string" },
    semanticKey: { enum: ["deliverable_usage", "visual_approach", "output_spec", "identity_refs", "final_approval"] },
    kind: { enum: ["approval", "choice", "upload", "feedback"] }, blocking: { type: "boolean" },
    channel: { enum: ["agent_chat", "fruit_truck_ui"] },
    presentation: { enum: ["form", "media_grid", "model_picker", "upload", "assembly_review"] },
    selectionMode: { enum: ["none", "single", "multiple", "one_per_group"] },
    minSelections: { type: "integer", minimum: 0, maximum: 24 },
    maxSelections: { type: "integer", minimum: 1, maximum: 24 },
    allowNote: { type: "boolean" },
    relatedStepId: { type: "string" }, relatedAssetIds: { type: "array", items: { type: "string" } },
    relatedThreadIds: { type: "array", maxItems: 64, items: { type: "string" } },
    options: { type: "array", maxItems: 24, items: { type: "object", required: ["id", "label"], properties: {
      id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, recommended: { type: "boolean" },
      assetId: { type: "string" }, groupId: { type: "string" },
    } } },
  }, ["sessionId", "requestKey", "title", "prompt", "kind", "blocking"]),
  tool("resolve_decision", "Record the user's explicit agent-chat reply for one pending decision and apply its state effects atomically.", {
    sessionId: { type: "string" }, decisionId: { type: "string" },
    userResponse: { type: "string", minLength: 1, maxLength: 5_000 },
    optionId: { type: "string" }, note: { type: "string", maxLength: 5_000 },
    relatedAssetIds: { type: "array", maxItems: 12, items: { type: "string" } },
  }, ["sessionId", "decisionId", "userResponse"]),
  tool("await_decision", "Wait briefly for a Fruit Truck UI decision. Reuse the same decision ID after a timeout; this never duplicates a checkpoint.", {
    sessionId: { type: "string" }, decisionId: { type: "string" },
    timeoutMs: { type: "integer", minimum: 100, maximum: 25_000 },
  }, ["sessionId", "decisionId"]),
  tool("record_activity", "Append a transparent activity record, including the exact prompt, model, rationale, assets, error, or recovery action when relevant.", {
    sessionId: { type: "string" }, kind: { enum: ["plan", "decision", "generation", "evaluation", "error", "handover", "assembly", "skill"] },
    title: { type: "string" }, detail: { type: "string" }, prompt: { type: "string" },
    modelId: { type: "string" }, assetIds: { type: "array", items: { type: "string" } },
  }, ["sessionId", "kind", "title"]),
  tool("list_models", "Query current OpenRouter image or video models. Use immediately before requesting the user's first model choice for that stage.", {
    mode: { enum: ["image", "video"] },
    threadIds: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string" } },
  }, ["mode"]),
  tool("request_model_selection", "Record a compatible-model choice checkpoint, then present its candidates in agent chat. This tool never chooses for the user.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    mode: { enum: ["image", "video"] },
    candidates: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", required: ["id", "label"], properties: {
      id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, recommended: { type: "boolean" },
      compatibility: { type: "string" }, inputStructure: { type: "string" }, price: { type: "string" }, constraints: { type: "string" },
    } } },
    recommendation: { type: "string" },
    threadIds: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string" } },
  }, ["sessionId", "requestKey", "mode", "candidates", "recommendation"]),
  tool("register_asset", "Register an uploaded or generated asset and its derivation in the artifact graph. Local paths must be absolute.", {
    sessionId: { type: "string" }, name: { type: "string" }, kind: { enum: ["image", "video"] },
    mimeType: { type: "string" }, origin: { enum: ["upload", "generated", "edited"] },
    source: { type: "string" }, role: { type: "string" }, parentAssetIds: { type: "array", items: { type: "string" } },
    planStepId: { type: "string" }, prompt: { type: "string" }, modelId: { type: "string" }, duration: { type: "number", minimum: 0 },
  }, ["sessionId", "name", "kind", "mimeType", "origin", "source", "role"]),
  tool("import_remote_asset", "Download a public web reference into Fruit Truck managed storage and retain its source provenance.", {
    sessionId: { type: "string" }, name: { type: "string" }, sourceUrl: { type: "string" },
    sourcePageUrl: { type: "string" }, license: { type: "string" }, role: { type: "string" },
  }, ["sessionId", "name", "sourceUrl", "role"]),
  tool("evaluate_asset", "Record separate technical and aesthetic evaluation. Queue approval and resolve it only from the user's agent-chat reply.", {
    sessionId: { type: "string" }, assetId: { type: "string" }, technical: { type: "string" },
    aesthetic: { type: "string" }, recommendation: { type: "string" },
  }, ["sessionId", "assetId", "technical", "aesthetic", "recommendation"]),
  tool("create_generation_thread", "Create a visible, mode-scoped generation workspace. Workflow Skills own its semantic meaning; Fruit Truck stores only the free-form name and generation state.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    mode: { enum: ["image", "video"] }, name: { type: "string", minLength: 1, maxLength: 100 },
    outputRole: { type: "string", minLength: 1, maxLength: 100 },
  }, ["sessionId", "requestKey", "mode", "name"]),
  tool("update_generation_thread", "Write the prompt, inputs, settings, and free-form output role for one generation thread before execution.", {
    sessionId: { type: "string" }, threadId: { type: "string" }, expectedThreadRevision: { type: "integer", minimum: 0 },
    patch: { type: "object", additionalProperties: false, properties: {
      name: { type: "string", minLength: 1, maxLength: 100 }, prompt: { type: "string", maxLength: 20_000 },
      outputRole: { type: "string", minLength: 1, maxLength: 100 },
      modelOverrideId: { type: "string" }, useModeDefaultModel: { type: "boolean" }, enhancePrompt: { type: "boolean" },
      options: { type: "object", additionalProperties: true }, provider: { type: "object", additionalProperties: true },
      assetBindings: { type: "array", maxItems: 12, items: { type: "object", required: ["assetId", "role"], properties: {
        assetId: { type: "string" }, role: { enum: ["reference", "first_frame", "last_frame"] },
      } } },
    } },
  }, ["sessionId", "threadId", "patch"]),
  tool("archive_generation_thread", "Archive an idle generation thread without deleting its assets or attempt provenance.", {
    sessionId: { type: "string" }, threadId: { type: "string" },
  }, ["sessionId", "threadId"]),
  tool("restore_generation_thread", "Restore an archived generation thread and its complete attempt provenance.", {
    sessionId: { type: "string" }, threadId: { type: "string" },
  }, ["sessionId", "threadId"]),
  tool("cancel_generation_threads", "Cancel queued generation attempts before provider submission. Submitted jobs remain tracked because OpenRouter exposes no video cancellation endpoint.", {
    sessionId: { type: "string" }, attemptIds: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string" } },
  }, ["sessionId", "attemptIds"]),
  tool("enhance_generation_threads", "Enhance prompts for several prepared threads concurrently and persist each independent result.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    threadIds: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string" } },
  }, ["sessionId", "requestKey", "threadIds"]),
  tool("run_generation_threads", "Atomically validate and start the selected threads without an application concurrency cap. OpenRouter work starts in parallel; Codex built-in image threads return host actions for parallel imagegen calls in the current Codex session.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    threadIds: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string" } },
  }, ["sessionId", "requestKey", "threadIds"]),
  tool("await_generation_threads", "Wait briefly for several generation attempts and return terminal or partial states. Repeat with the same attempt IDs after a timeout.", {
    sessionId: { type: "string" }, attemptIds: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string" } },
    timeoutMs: { type: "integer", minimum: 100, maximum: 25_000 },
  }, ["sessionId", "attemptIds"]),
  tool("submit_generation", "Submit image or video generation with the user-selected stage model. The server maps standard options and asset roles into the model's declared input schema.", {
    sessionId: { type: "string" }, mode: { enum: ["image", "video"] }, prompt: { type: "string" },
    options: { type: "object", additionalProperties: true },
    provider: { type: "object", additionalProperties: true },
    assetBindings: { type: "array", maxItems: 12, items: { type: "object", required: ["assetId", "role"], properties: {
      assetId: { type: "string" }, role: { enum: ["reference", "first_frame", "last_frame"] },
    } } },
    role: { type: "string" }, planStepId: { type: "string" },
    estimatedCostUsd: { type: "number", minimum: 0, maximum: 10000 },
  }, ["sessionId", "mode", "prompt"]),
  tool("poll_video", "Poll an asynchronous OpenRouter video job and register its result when complete.", {
    sessionId: { type: "string" }, jobId: { type: "string" },
  }, ["sessionId", "jobId"]),
  tool("propose_assembly", "Populate the final-video editor with approved clips and queue Fruit Truck UI review before the user renders.", {
    sessionId: { type: "string" }, requestKey: { type: "string", minLength: 1, maxLength: 200 },
    clips: { type: "array", minItems: 1, maxItems: 24, items: { type: "object", required: ["assetId", "startSeconds", "endSeconds", "order"], properties: {
      assetId: { type: "string" }, startSeconds: { type: "number", minimum: 0 },
      endSeconds: { type: "number", exclusiveMinimum: 0 }, order: { type: "integer", minimum: 0 },
    } } },
  }, ["sessionId", "requestKey", "clips"]),
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
  tool("register_host_image", "Copy a Codex built-in image-generation result into managed Fruit Truck storage and register complete provenance.", {
    sessionId: { type: "string" }, sourcePath: { type: "string" },
    threadId: { type: "string" }, attemptId: { type: "string" },
    name: { type: "string" }, mimeType: { type: "string" },
    origin: { enum: ["generated", "edited"] }, role: { type: "string" },
    parentAssetIds: { type: "array", maxItems: 12, items: { type: "string" } },
    planStepId: { type: "string" }, prompt: { type: "string", minLength: 1, maxLength: 20_000 },
  }, ["sessionId", "sourcePath", "name", "mimeType", "origin", "role", "prompt"]),
  tool("fail_host_generation", "Record failure of a Codex-host imagegen attempt so that the thread can be retried safely.", {
    sessionId: { type: "string" }, threadId: { type: "string" }, attemptId: { type: "string" }, error: { type: "string", minLength: 1, maxLength: 5_000 },
  }, ["sessionId", "threadId", "attemptId", "error"]),
];

function availableTools() {
  return detectedAgentHost() === "codex" ? [...BASE_TOOLS, ...CODEX_TOOLS] : BASE_TOOLS;
}

function emptyThreadDraft(): GenerationDraftState {
  return {
    prompt: "", references: [], options: {}, providerJson: "", enhancePrompt: false,
    enhancedPrompt: "", enhancedPromptDirty: false, enhancedVisualCount: 0, imageEditMode: false,
    imageEditTarget: "", maskInstructions: "", maskStrokes: [],
  };
}

function newBridgeThread(mode: "image" | "video", index = 1): GenerationThread {
  const createdAt = new Date().toISOString();
  return {
    id: `thread-${crypto.randomUUID()}`,
    name: `${mode === "image" ? "Image" : "Video"} ${index}`,
    mode,
    createdAt,
    updatedAt: createdAt,
    revision: 0,
    outputRole: mode === "image" ? "generated_image" : "generated_video",
    optionOverrides: {},
    draft: emptyThreadDraft(),
    attempts: [],
    enhancementAttempts: [],
  };
}

function normalizeBridgeSession(value: BridgeSession): BridgeSession {
  type LegacyWorkflow = "generate" | "edit";
  type LegacyThread = GenerationThread & { videoWorkflow?: LegacyWorkflow; videoWorkflowStates?: unknown };
  type LegacyDefaults = GenerationDefaults & {
    options: GenerationDefaults["options"] & { videoGenerate?: DraftOptions; videoEdit?: DraftOptions };
    providerJson: GenerationDefaults["providerJson"] & { videoGenerate?: string; videoEdit?: string };
  };
  const legacy = value as BridgeSession & {
    videoWorkflow?: LegacyWorkflow;
    selectedModelIds?: { image: string; video: string };
    jobs?: Array<Record<string, unknown>>;
    activeVideoJobs?: Array<Record<string, unknown>>;
    drafts?: unknown;
    generationDefaults?: LegacyDefaults;
  };
  const imageThread = newBridgeThread("image");
  const videoThread = newBridgeThread("video");
  const storedDefaults = legacy.generationDefaults;
  const defaults: GenerationDefaults = {
    modelIds: {
      image: storedDefaults?.modelIds.image ?? legacy.selectedModelIds?.image ?? "",
      video: storedDefaults?.modelIds.video ?? legacy.selectedModelIds?.video ?? "",
    },
    options: {
      image: storedDefaults?.options.image ?? {},
      video: storedDefaults?.options.video ?? storedDefaults?.options.videoGenerate ?? {},
    },
    providerJson: {
      image: storedDefaults?.providerJson.image ?? "",
      video: storedDefaults?.providerJson.video ?? storedDefaults?.providerJson.videoGenerate ?? "",
    },
  };
  const legacyEditJobIds = new Set<string>();
  const normalizeThread = (thread: LegacyThread, mode: "image" | "video"): GenerationThread => {
    const { videoWorkflow: _workflow, videoWorkflowStates: _workflowStates, ...canonical } = thread;
    return {
      ...canonical,
      mode,
      draft: {
        ...canonical.draft,
        references: (canonical.draft?.references ?? []).filter((reference) => (reference.role as string) !== "video_reference"),
      },
      attempts: (canonical.attempts ?? []).flatMap((attempt) => {
        const legacySnapshot = attempt.snapshot as (GenerationAttemptSnapshot & { videoWorkflow?: LegacyWorkflow }) | undefined;
        const legacyEditAttempt = mode === "video" && (thread.videoWorkflow === "edit"
          || legacySnapshot?.videoWorkflow === "edit"
          || legacySnapshot?.assetBindings?.some((binding) => (binding.role as string) === "video_reference"));
        if (legacyEditAttempt) {
          if (attempt.jobId) legacyEditJobIds.add(attempt.jobId);
          return [];
        }
        if (!legacySnapshot) return [{ ...attempt }];
        const { videoWorkflow: _snapshotWorkflow, ...snapshot } = legacySnapshot;
        return [{ ...attempt, snapshot: { ...snapshot, assetBindings: (snapshot.assetBindings ?? []).filter((binding) => (binding.role as string) !== "video_reference") } }];
      }),
      enhancementAttempts: canonical.enhancementAttempts ?? [],
    };
  };
  const image = value.threads?.image?.length
    ? value.threads.image.map((thread) => normalizeThread(thread as LegacyThread, "image"))
    : [imageThread];
  const legacyEditThreadIds = new Set((value.threads?.video ?? [])
    .filter((thread) => (thread as LegacyThread).videoWorkflow === "edit")
    .map((thread) => thread.id));
  for (const thread of (value.threads?.video ?? []) as LegacyThread[]) {
    if (thread.videoWorkflow !== "edit") continue;
    for (const attempt of thread.attempts ?? []) {
      if (attempt.jobId) legacyEditJobIds.add(attempt.jobId);
    }
  }
  const video = value.threads?.video?.length
    ? value.threads.video
      .filter((thread) => (thread as LegacyThread).videoWorkflow !== "edit")
      .map((thread) => normalizeThread(thread as LegacyThread, "video"))
    : [];
  if (!video.length) video.push(videoThread);
  for (const job of [...(legacy.jobs ?? []), ...(legacy.activeVideoJobs ?? [])]) {
    const legacyEditJob = job.workflow === "edit" || (typeof job.threadId === "string" && legacyEditThreadIds.has(job.threadId));
    if (legacyEditJob) {
      if (typeof job.jobId === "string") legacyEditJobIds.add(job.jobId);
      continue;
    }
    const jobId = typeof job.jobId === "string" ? job.jobId : "";
    if (!jobId || video.some((thread) => thread.attempts.some((attempt) => attempt.jobId === jobId))) continue;
    const target = typeof job.threadId === "string" ? video.find((thread) => thread.id === job.threadId) : undefined;
    const thread = target ?? newBridgeThread("video", video.length + 1);
    if (!target) video.push(thread);
    const now = typeof job.submittedAt === "string" ? job.submittedAt : new Date().toISOString();
    const modelId = typeof job.modelId === "string" ? job.modelId : typeof job.model === "string" ? job.model : defaults.modelIds.video;
    const inputAssetIds = Array.isArray(job.inputAssetIds) ? job.inputAssetIds.filter((id): id is string => typeof id === "string") : [];
    thread.attempts.push({
      id: typeof job.attemptId === "string" ? job.attemptId : `attempt-${crypto.randomUUID()}`,
      status: job.status === "completed" || job.status === "failed" ? job.status : "in_progress",
      backend: "openrouter",
      draftRevision: thread.revision,
      requestedBy: "agent",
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
      modelId,
      inputAssetIds,
      assetIds: typeof job.assetId === "string" ? [job.assetId] : [],
      jobId,
      progress: typeof job.progress === "number" ? job.progress : undefined,
      error: typeof job.error === "string" ? job.error : undefined,
      pollAttempts: typeof job.pollAttempts === "number" ? job.pollAttempts : undefined,
      lastPolledAt: typeof job.lastPolledAt === "string" ? job.lastPolledAt : undefined,
      nextPollAt: typeof job.nextPollAt === "string" ? job.nextPollAt : undefined,
    });
  }
  const agent = normalizeAgentState(value.agent);
  agent.execution.currentJobIds = agent.execution.currentJobIds.filter((jobId) => !legacyEditJobIds.has(jobId));
  const {
    videoWorkflow: _videoWorkflow,
    selectedModelIds: _selectedModelIds,
    jobs: _jobs,
    activeVideoJobs: _activeVideoJobs,
    drafts: _drafts,
    ...canonical
  } = legacy;
  return {
    ...canonical,
    generationDefaults: defaults,
    threads: { image, video },
    activeThreadIds: {
      image: image.some((thread) => thread.id === value.activeThreadIds?.image) ? value.activeThreadIds.image : image[0].id,
      video: video.some((thread) => thread.id === value.activeThreadIds?.video) ? value.activeThreadIds.video : video[0].id,
    },
    assets: value.assets ?? [],
    agent,
  };
}

function resolvedThreadDraft(session: BridgeSession, thread: GenerationThread): GenerationDraftState {
  return {
    ...thread.draft,
    options: { ...session.generationDefaults.options[thread.mode], ...thread.optionOverrides },
    providerJson: thread.providerJsonOverride ?? session.generationDefaults.providerJson[thread.mode],
  };
}

function resolvedThreadModel(session: BridgeSession, thread: GenerationThread) {
  return thread.modelOverrideId ?? session.generationDefaults.modelIds[thread.mode];
}

function runningThreadAttempt(thread: GenerationThread) {
  return thread.attempts.findLast((attempt) => !["completed", "failed", "uncertain", "canceled"].includes(attempt.status));
}

const TERMINAL_ATTEMPT_STATUSES = new Set(["completed", "failed", "uncertain", "canceled"]);

function snapshotForThread(session: BridgeSession, thread: GenerationThread): GenerationAttemptSnapshot {
  const draft = resolvedThreadDraft(session, thread);
  return {
    mode: thread.mode,
    modelId: resolvedThreadModel(session, thread),
    outputRole: thread.outputRole,
    prompt: draft.prompt,
    enhancePrompt: draft.enhancePrompt,
    enhancedPrompt: draft.enhancedPrompt,
    options: structuredClone(draft.options),
    providerJson: draft.providerJson,
    assetBindings: draft.references.map((reference) => ({ ...reference })),
    imageEditMode: draft.imageEditMode,
    imageEditTarget: draft.imageEditTarget,
    maskInstructions: draft.maskInstructions,
    maskStrokes: structuredClone(draft.maskStrokes),
  };
}

function sanitizedRequestSnapshot(payload: Record<string, unknown>, snapshot: GenerationAttemptSnapshot) {
  const clean = structuredClone(payload);
  delete clean.input_references;
  delete clean.frame_images;
  return {
    ...clean,
    assetBindings: snapshot.assetBindings.map(({ assetId, slot, role }) => ({ assetId, slot, role })),
  };
}

function emptyEnvelope(): Envelope {
  return { schemaVersion: 4, revision: 0, sessions: [] };
}

function stableEnvelopeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableEnvelopeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableEnvelopeValue(item)]));
  }
  return value;
}

function envelopeValuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(stableEnvelopeValue(left)) === JSON.stringify(stableEnvelopeValue(right));
}

async function readEnvelope(options: { persistMigration?: boolean } = {}): Promise<Envelope> {
  if (!existsSync(sessionsPath)) return emptyEnvelope();
  const metadata = await stat(sessionsPath);
  if (metadata.size > MAX_AGENT_READ_BYTES) {
    throw new Error("The agent session bridge file exceeds the 50 MB recovery limit.");
  }
  const stored = JSON.parse(await readFile(sessionsPath, "utf8")) as Envelope & { sessionFiles?: Array<{ id: string; file: string }> };
  if (stored.schemaVersion !== 1 && stored.schemaVersion !== 2 && stored.schemaVersion !== 3 && stored.schemaVersion !== 4) throw new Error("Agent session store has an unsupported schema.");
  let value: Envelope;
  if (Array.isArray(stored.sessions)) {
    value = stored;
  } else if (Array.isArray(stored.sessionFiles)) {
    const sessions = await Promise.all(stored.sessionFiles.map(async ({ id, file }) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^[A-Za-z0-9_.-]+\.json$/.test(file)) throw new Error("Agent session index contains an invalid file reference.");
      const path = join(sessionsDirectory, file);
      const metadata = await stat(path);
      if (metadata.size > MAX_AGENT_SESSION_BYTES) throw new Error(`Agent session ${id} exceeds the 50 MB per-session limit.`);
      const session = JSON.parse(await readFile(path, "utf8")) as BridgeSession;
      if (session.id !== id) throw new Error(`Agent session file ${file} does not match index ID ${id}.`);
      return session;
    }));
    value = { schemaVersion: 4, revision: stored.revision, sessions };
  } else {
    throw new Error("Agent session store has an unsupported schema.");
  }
  const sourceSessions = value.sessions;
  const sessions = sourceSessions.map(normalizeBridgeSession);
  const requiresMigration = stored.schemaVersion !== 4
    || Array.isArray(stored.sessions)
    || sessions.some((session, index) => !envelopeValuesEqual(session, sourceSessions[index]));
  value.sessions = sessions;
  value.schemaVersion = 4;
  if (options.persistMigration && requiresMigration) {
    value.revision += 1;
    await writeEnvelope(value);
  }
  return value;
}

async function writeEnvelope(value: Envelope) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  const compacted: Envelope = {
    ...value,
    sessions: value.sessions.map((session) => ({
      ...session,
      threads: {
        image: session.threads.image.map(compactThreadHistory),
        video: session.threads.video.map(compactThreadHistory),
      },
      agent: { ...session.agent, activity: session.agent.activity.slice(-MAX_ACTIVITY_ITEMS) },
    })),
  };
  const sessionFiles: Array<{ id: string; file: string }> = [];
  for (const session of compacted.sessions) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error(`Agent session ID ${session.id} is invalid.`);
    const file = `${session.id}-${compacted.revision}.json`;
    const path = join(sessionsDirectory, file);
    const temporary = `${path}.${process.pid}.tmp`;
    const serialized = JSON.stringify(session, null, 2);
    if (Buffer.byteLength(serialized) > MAX_AGENT_SESSION_BYTES) throw new Error(`Agent session ${session.id} would exceed the 50 MB per-session limit.`);
    if (/data:(?:image|video)\//i.test(serialized) || /;base64,/i.test(serialized)) throw new Error("Agent session metadata cannot contain Base64 or data URL media.");
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, path);
    sessionFiles.push({ id: session.id, file });
  }
  const index = JSON.stringify({ schemaVersion: 4, revision: compacted.revision, sessionFiles }, null, 2);
  if (Buffer.byteLength(index) > MAX_AGENT_STORE_BYTES) throw new Error("The agent session index exceeds 10 MB.");
  const temporaryIndex = `${sessionsPath}.${process.pid}.tmp`;
  await writeFile(temporaryIndex, index, { mode: 0o600 });
  await rename(temporaryIndex, sessionsPath);
  const retained = new Set(sessionFiles.map((item) => item.file));
  for (const file of await readdir(sessionsDirectory)) {
    if (file.endsWith(".json") && !retained.has(file)) await unlink(join(sessionsDirectory, file)).catch(() => undefined);
  }
}

function compactThreadHistory(thread: GenerationThread): GenerationThread {
  const active = thread.attempts.filter((attempt) => !TERMINAL_ATTEMPT_STATUSES.has(attempt.status));
  const terminal = thread.attempts.filter((attempt) => TERMINAL_ATTEMPT_STATUSES.has(attempt.status)).slice(-100);
  const activeEnhancements = (thread.enhancementAttempts ?? []).filter((attempt) => attempt.status === "in_progress");
  const terminalEnhancements = (thread.enhancementAttempts ?? []).filter((attempt) => attempt.status !== "in_progress").slice(-100);
  return { ...thread, attempts: [...active, ...terminal], enhancementAttempts: [...activeEnhancements, ...terminalEnhancements] };
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
        if (decision.options.some((option) => option.assetId && !assetIds.has(option.assetId))) errors.push(`Decision ${decision.id} has an option for a missing session asset.`);
      }
      const allThreads = [...session.threads.image, ...session.threads.video];
      const threadIds = allThreads.map((thread) => thread.id);
      const attemptIds = allThreads.flatMap((thread) => thread.attempts.map((attempt) => attempt.id));
      if (new Set(threadIds).size !== threadIds.length) errors.push("Generation thread IDs must be unique.");
      if (new Set(attemptIds).size !== attemptIds.length) errors.push("Generation attempt IDs must be unique.");
      for (const thread of allThreads) {
        if (thread.draft.references.some((reference) => !assetIds.has(reference.assetId))) errors.push(`Generation thread ${thread.id} points to a missing input asset.`);
        if (thread.attempts.some((attempt) => attempt.inputAssetIds.some((id) => !assetIds.has(id)) || attempt.assetIds.some((id) => !assetIds.has(id)))) {
          errors.push(`Generation thread ${thread.id} has attempt provenance for a missing asset.`);
        }
        if (thread.attempts.some((attempt) => attempt.snapshot?.assetBindings.some((binding) => !assetIds.has(binding.assetId)))) errors.push(`Generation thread ${thread.id} has a snapshot for a missing asset.`);
        if (thread.attempts.some((attempt) => attempt.request && /data:(?:image|video)\/|;base64,/i.test(JSON.stringify(attempt.request)))) errors.push(`Generation thread ${thread.id} contains embedded media in request metadata.`);
        if (thread.attempts.filter((attempt) => !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)).length > 1) errors.push(`Generation thread ${thread.id} has more than one active attempt.`);
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

function assertExecutionAllowed(session: BridgeSession, action: string, threadIds: string[] = []) {
  assertAgentHost(session);
  if (session.agent.controlMode !== "agent") {
    throw new Error(`${action} is blocked while Human control is active. Hand control back to Agent and resume the run before trying again.`);
  }
  if (session.agent.runStatus !== "working") {
    throw new Error(`${action} is blocked while the run is ${session.agent.runStatus}. Resolve blocking decisions if any, then resume the Agent run before trying again.`);
  }
  if (session.agent.decisions.some((item) => {
    if (item.status !== "pending" || !item.blocking) return false;
    const related = item.relatedThreadIds ?? [];
    return !related.length || !threadIds.length || related.some((id) => threadIds.includes(id));
  })) {
    throw new Error(`${action} is blocked by a pending user checkpoint. Resolve every blocking decision before resuming generation.`);
  }
}

async function openRouter(path: string, method: "GET" | "POST" = "GET", body?: unknown) {
  if (!existsSync(credentialsPath)) throw new Error("Add an OpenRouter API key in Fruit Truck Settings first.");
  const credential = JSON.parse(await readFile(credentialsPath, "utf8")) as { openrouter_api_key?: string };
  if (!credential.openrouter_api_key) throw new Error("The Fruit Truck credentials file has no API key.");
  for (let retry = 0; ; retry += 1) {
    const response = await fetch(`${openRouterBase}${path}`, {
      method,
      signal: AbortSignal.timeout(180_000),
      headers: {
        Authorization: `Bearer ${credential.openrouter_api_key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://fruit-truck.local",
        "X-Title": "Fruit Truck Agent Kit",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) return response.json() as Promise<Record<string, unknown>>;
    const message = (await response.text()).slice(0, 2_000);
    if (![429, 503].includes(response.status) || retry >= 3) {
      throw new Error(`OpenRouter ${response.status}: ${message || "Request failed"}`);
    }
    const retryAfter = response.headers.get("retry-after")?.trim() ?? "";
    const seconds = Number(retryAfter);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    const delay = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000
      : Number.isFinite(dateDelay) && dateDelay > 0
        ? dateDelay
        : 500 * 2 ** retry + Math.floor(Math.random() * 200);
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(30_000, delay)));
  }
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

function extensionForMime(mimeType: string) {
  return mimeType.includes("webm") ? ".webm"
    : mimeType.startsWith("video/") ? ".mp4"
      : mimeType.includes("jpeg") ? ".jpg"
        : mimeType.includes("webp") ? ".webp"
          : mimeType.includes("gif") ? ".gif"
          : ".png";
}

function safeGeneratedName(name: string, mimeType: string) {
  const stem = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "generated";
  return `${stem}-${crypto.randomUUID()}${extensionForMime(mimeType)}`;
}

function displayGeneratedName(name: string, mimeType: string) {
  return `${name.replace(/\.[^.]+$/, "")}${extensionForMime(mimeType)}`;
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

async function writeReferenceBytes(name: string, mimeType: string, bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error("Reference media exceeds the 30 MB safety limit.");
  const directory = join(dataDirectory, "assets");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, safeGeneratedName(name, mimeType));
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

function privateAddress(address: string) {
  if (address === "::1" || address === "0.0.0.0" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

async function validatePublicUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Remote assets must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Remote asset URLs cannot contain credentials.");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) {
    throw new Error("Remote asset URLs must resolve only to public network addresses.");
  }
  return url;
}

async function downloadPublicReference(raw: string, name: string) {
  let url = await validatePublicUrl(raw);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("Remote reference exceeded the redirect limit.");
      url = await validatePublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Could not download the web reference (HTTP ${response.status}).`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 30 * 1024 * 1024) throw new Error("Remote reference exceeds the 30 MB safety limit.");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) {
      throw new Error("Remote reference did not return image or video media.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { path: await writeReferenceBytes(name, mimeType, bytes), mimeType, finalUrl: url.toString() };
  }
  throw new Error("Could not download the web reference.");
}

type DesktopRuntime = {
  pid?: number;
  version?: string;
  heartbeatAt?: string;
  heartbeatAtMs?: number;
  activeSessionId?: string;
};

async function readDesktopRuntime(): Promise<DesktopRuntime | null> {
  if (!existsSync(runtimePath)) return null;
  try {
    const value = JSON.parse(await readFile(runtimePath, "utf8")) as DesktopRuntime;
    const heartbeat = typeof value.heartbeatAtMs === "number" ? value.heartbeatAtMs : Date.parse(value.heartbeatAt ?? "");
    if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 8_000) return null;
    if (typeof value.pid === "number") {
      try { process.kill(value.pid, 0); } catch { return null; }
    }
    return value;
  } catch {
    return null;
  }
}

async function credentialConfigured() {
  if (!existsSync(credentialsPath)) return false;
  try {
    const value = JSON.parse(await readFile(credentialsPath, "utf8")) as { openrouter_api_key?: string };
    return Boolean(value.openrouter_api_key?.trim());
  } catch {
    return false;
  }
}

async function launchDesktop() {
  if (platform() !== "darwin") return false;
  return new Promise<boolean>((resolveLaunch) => {
    const child = spawn("open", ["-g", "-b", "ui.fruittruck.desktop"], { stdio: "ignore" });
    child.once("error", () => resolveLaunch(false));
    child.once("exit", (code) => resolveLaunch(code === 0));
  });
}

async function materializeGeneratedMedia(source: string, name: string, fallbackMimeType: string) {
  if (source.startsWith("data:")) {
    const match = source.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) throw new Error("Generated media contains an invalid data URL.");
    const mimeType = match[1].toLowerCase();
    if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) throw new Error("Generated data URL is not image or video media.");
    return { source: await writeGeneratedBytes(name, mimeType, Buffer.from(match[2], "base64")), mimeType };
  }
  if (!/^https?:\/\//i.test(source)) return { source, mimeType: fallbackMimeType };
  const response = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Could not preserve generated media locally (HTTP ${response.status}).`);
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || fallbackMimeType;
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) throw new Error("Generated URL did not return image or video media.");
  return { source: await writeGeneratedBytes(name, mimeType, new Uint8Array(await response.arrayBuffer())), mimeType };
}

async function materializeGeneratedSource(source: string, name: string, fallbackMimeType: string) {
  return (await materializeGeneratedMedia(source, name, fallbackMimeType)).source;
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
    signal: AbortSignal.timeout(180_000),
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
    sourceUrl: typeof input.sourceUrl === "string" ? input.sourceUrl : undefined,
    sourcePageUrl: typeof input.sourcePageUrl === "string" ? input.sourcePageUrl : undefined,
    license: typeof input.license === "string" ? input.license : undefined,
  };
  session.assets.push(asset);
  const artifact: ArtifactNode = {
    assetId: id,
    role: requiredString(input, "role"),
    parentAssetIds: Array.isArray(input.parentAssetIds) ? input.parentAssetIds.filter((item): item is string => typeof item === "string") : [],
    planStepId: typeof input.planStepId === "string" ? input.planStepId : undefined,
    threadId: typeof input.threadId === "string" ? input.threadId : undefined,
    attemptId: typeof input.attemptId === "string" ? input.attemptId : undefined,
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
  const explicit = (process.env.FRUIT_TRUCK_ALLOWED_ASSET_DIRS ?? "")
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
      "Local assets must be inside Fruit Truck's assets/generated directories or a directory explicitly allowed with FRUIT_TRUCK_ALLOWED_ASSET_DIRS.",
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
    throw new Error("Codex image outputs must come from the Codex generated_images directory or Fruit Truck managed generated storage.");
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile()) throw new Error("The Codex image output must be a regular file.");
  if (!metadata.size || metadata.size > 30 * 1024 * 1024) throw new Error("The Codex image output exceeds the 30 MB safety limit.");
  return canonical;
}

async function hydrateGenerationAssets(
  session: BridgeSession,
  bindings: Array<{ assetId: string; role: ReferenceAsset["role"]; slot?: number }>,
  mask?: { targetSlot: number; strokes: MaskStroke[] },
): Promise<ReferenceAsset[]> {
  if (bindings.length > 12) throw new Error("At most 12 asset bindings are allowed.");
  return Promise.all(bindings.map(async (binding, index) => {
    const asset = session.assets.find((item) => item.id === binding.assetId);
    const source = asset?.localPath ?? asset?.externalUrl;
    if (!asset || !source) throw new Error(`Asset ${binding.assetId} has no readable source.`);
    const slot = binding.slot ?? index + 1;
    let dataUrl = source;
    let name = asset.name;
    let mediaType = asset.mimeType;
    if (mask && slot === mask.targetSlot) {
      dataUrl = await renderAgentAlphaMask(asset, mask.strokes);
      name = `${asset.name} (transparent edit mask)`;
      mediaType = "image/png";
    } else if (!/^(?:data:|https?:\/\/)/i.test(dataUrl)) {
      const path = await validateLocalAssetSource(dataUrl);
      const metadata = await stat(path);
      if (metadata.size > 30 * 1024 * 1024) throw new Error(`${asset.name} exceeds the 30 MB generation input limit.`);
      const bytes = await readFile(path);
      dataUrl = `data:${asset.mimeType};base64,${bytes.toString("base64")}`;
    }
    return {
      id: asset.id,
      name,
      mediaType,
      dataUrl,
      role: binding.role,
      slot,
    };
  }));
}

function maskCanvasDimensions(width: number, height: number, maxEdge = 2048) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("The edit image has invalid dimensions.");
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function rasterizeAgentMask(strokes: MaskStroke[], width: number, height: number) {
  const pixels = Buffer.alloc(width * height);
  const fillCircle = (centerX: number, centerY: number, radius: number, value: number) => {
    const left = Math.max(0, Math.floor(centerX - radius));
    const right = Math.min(width - 1, Math.ceil(centerX + radius));
    const top = Math.max(0, Math.floor(centerY - radius));
    const bottom = Math.min(height - 1, Math.ceil(centerY + radius));
    const radiusSquared = radius * radius;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const dx = x - centerX;
        const dy = y - centerY;
        if (dx * dx + dy * dy <= radiusSquared) pixels[y * width + x] = value;
      }
    }
  };
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    const value = stroke.operation === "erase" ? 0 : 255;
    const radius = Math.max(1, stroke.size * Math.min(width, height) / 2);
    const points = stroke.points.map((point) => ({
      x: Math.max(0, Math.min(width - 1, point.x * width)),
      y: Math.max(0, Math.min(height - 1, point.y * height)),
    }));
    fillCircle(points[0].x, points[0].y, radius, value);
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius / 2)));
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        fillCircle(
          start.x + (end.x - start.x) * progress,
          start.y + (end.y - start.y) * progress,
          radius,
          value,
        );
      }
    }
  }
  if (!pixels.includes(255)) throw new Error("The edit mask contains no painted selection.");
  return pixels;
}

async function materializeAgentMaskSource(asset: BridgeAsset, work: string) {
  const source = asset.localPath ?? asset.externalUrl;
  if (!source) throw new Error(`${asset.name} has no readable mask source.`);
  if (!/^(?:data:|https?:\/\/)/i.test(source)) {
    return { path: await validateLocalAssetSource(source), cleanup: false };
  }
  if (/^https?:\/\//i.test(source)) {
    const downloaded = await downloadPublicReference(source, asset.name);
    if (!downloaded.mimeType.startsWith("image/")) {
      await unlink(downloaded.path).catch(() => undefined);
      throw new Error("The edit mask target must be an image.");
    }
    return { path: downloaded.path, cleanup: true };
  }
  const match = source.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error("The edit image contains an invalid data URL.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error("The edit image exceeds the 30 MB safety limit.");
  const path = join(work, "source-image");
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, cleanup: false };
}

async function convertMaskSourceToPng(source: string, destination: string) {
  await new Promise<void>((resolveConversion, rejectConversion) => {
    const child = spawn("/usr/bin/sips", ["-s", "format", "png", source, "--out", destination], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const diagnostics: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectConversion(error);
      else resolveConversion();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Image conversion timed out while preparing the edit mask."));
    }, 60_000);
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics.push(Buffer.from(chunk));
      while (diagnostics.reduce((total, item) => total + item.length, 0) > 2_000) diagnostics.shift();
    });
    child.once("error", (error) => finish(new Error(`Could not launch the macOS image converter: ${error.message}`)));
    child.once("close", (code) => finish(code === 0
      ? undefined
      : new Error(`Could not convert the edit image to PNG${diagnostics.length ? `: ${Buffer.concat(diagnostics).toString("utf8").trim()}` : "."}`)));
  });
}

function assertSafePng(bytes: Buffer) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))) {
    throw new Error("The edit image is not a valid PNG.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16_384 || height > 16_384 || width * height > 32_000_000) {
    throw new Error("The edit image dimensions exceed the mask safety limit.");
  }
}

async function readAgentMaskPng(source: string, work: string) {
  let bytes = await readFile(source);
  try {
    assertSafePng(bytes);
    return PNG.sync.read(bytes);
  } catch (error) {
    if (bytes.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))) throw error;
  }
  const converted = join(work, "source.png");
  await convertMaskSourceToPng(source, converted);
  const metadata = await stat(converted);
  if (!metadata.size || metadata.size > 160 * 1024 * 1024) throw new Error("The converted edit image exceeds the mask safety limit.");
  bytes = await readFile(converted);
  assertSafePng(bytes);
  return PNG.sync.read(bytes);
}

async function renderAgentAlphaMask(asset: BridgeAsset, strokes: MaskStroke[]) {
  if (asset.kind !== "image") throw new Error("Only image assets can receive an edit mask.");
  const work = await mkdtemp(join(dataDirectory, "mask-work-"));
  let cleanupSource: string | undefined;
  try {
    const source = await materializeAgentMaskSource(asset, work);
    if (source.cleanup) cleanupSource = source.path;
    const png = await readAgentMaskPng(source.path, work);
    const maskDimensions = maskCanvasDimensions(png.width, png.height);
    const maskPixels = rasterizeAgentMask(strokes, maskDimensions.width, maskDimensions.height);
    for (let y = 0; y < png.height; y += 1) {
      const maskY = Math.min(maskDimensions.height - 1, Math.floor(y * maskDimensions.height / png.height));
      for (let x = 0; x < png.width; x += 1) {
        const maskX = Math.min(maskDimensions.width - 1, Math.floor(x * maskDimensions.width / png.width));
        if (maskPixels[maskY * maskDimensions.width + maskX] > 0) png.data[(y * png.width + x) * 4 + 3] = 0;
      }
    }
    const output = PNG.sync.write(png, { colorType: 6, inputColorType: 6 });
    if (!output.length || output.length > 30 * 1024 * 1024) {
      throw new Error("The masked edit image exceeds the 30 MB generation input limit.");
    }
    return `data:image/png;base64,${output.toString("base64")}`;
  } finally {
    if (cleanupSource) await unlink(cleanupSource).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}

function findGenerationThread(session: BridgeSession, threadId: string) {
  return [...session.threads.image, ...session.threads.video].find((thread) => thread.id === threadId);
}

function updateThreadAttempt(session: BridgeSession, threadId: string, attemptId: string, patch: Partial<GenerationAttempt>) {
  const thread = findGenerationThread(session, threadId);
  const attempt = thread?.attempts.find((item) => item.id === attemptId);
  if (!thread || !attempt) throw new Error(`Generation attempt ${attemptId} does not exist in thread ${threadId}.`);
  Object.assign(attempt, patch, { updatedAt: new Date().toISOString() });
  thread.updatedAt = attempt.updatedAt;
  return { thread, attempt };
}

async function promptImageSource(asset: BridgeAsset) {
  const source = asset.localPath ?? asset.externalUrl;
  if (!source) throw new Error(`${asset.name} has no readable prompt enhancement source.`);
  if (/^(?:data:|https?:\/\/)/i.test(source)) return source;
  const path = await validateLocalAssetSource(source);
  const metadata = await stat(path);
  if (!metadata.size || metadata.size > 30 * 1024 * 1024) {
    throw new Error(`${asset.name} exceeds the 30 MB prompt enhancement input limit.`);
  }
  return `data:${asset.mimeType};base64,${(await readFile(path)).toString("base64")}`;
}

async function hydrateAgentPromptVisuals(
  session: BridgeSession,
  thread: GenerationThread,
  draft: GenerationDraftState,
): Promise<PromptEnhancementVisual[]> {
  const visuals: PromptEnhancementVisual[] = [];
  for (const reference of draft.references.toSorted((left, right) => left.slot - right.slot)) {
    const asset = session.assets.find((item) => item.id === reference.assetId);
    if (!asset) throw new Error(`Asset ${reference.assetId} does not exist in this session.`);
    if (asset.kind === "video") continue;
    const editTarget = thread.mode === "image"
      && draft.imageEditMode
      && `@${reference.slot}` === draft.imageEditTarget.trim();
    visuals.push({
      id: asset.id,
      kind: editTarget ? "edit_target" : "reference",
      source: await promptImageSource(asset),
      slot: reference.slot,
      name: asset.name,
      role: reference.role,
    });
  }
  return visuals;
}

function hasUserApprovedThreadModel(session: BridgeSession, thread: GenerationThread, modelId: string) {
  const globalSelection = session.agent.modelSelections[thread.mode];
  if (globalSelection.status === "selected" && globalSelection.modelId === modelId && globalSelection.selectedBy === "user") return true;
  const semanticKey = `model_selection_${thread.mode}`;
  return session.agent.decisions.some((decision) =>
    decision.semanticKey === semanticKey
    && decision.status === "resolved"
    && (decision.relatedThreadIds ?? []).includes(thread.id)
    && (decision.resolution?.optionId === modelId || decision.resolution?.selectedOptionIds?.includes(modelId)),
  );
}

function validatePreparedThread(
  session: BridgeSession,
  thread: GenerationThread,
  models: GenerationModel[],
  backend: "openrouter" | "codex_builtin",
) {
  if (thread.archivedAt) throw new Error(`${thread.name} is archived.`);
  if (runningThreadAttempt(thread)) throw new Error(`${thread.name} already has an active generation.`);
  const draft = resolvedThreadDraft(session, thread);
  const hasMask = thread.mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0;
  if (!hasGenerationInstructions({ prompt: draft.prompt, hasMask, maskInstructions: draft.maskInstructions })) {
    throw new Error(`${thread.name} has no generation instructions.`);
  }
  const assetIds = new Set(session.assets.map((asset) => asset.id));
  const missing = draft.references.find((reference) => !assetIds.has(reference.assetId));
  if (missing) throw new Error(`${thread.name} references a missing asset.`);
  if (thread.mode === "video" && draft.references.some((reference) =>
    session.assets.find((asset) => asset.id === reference.assetId)?.kind === "video"
  )) {
    throw new Error(`${thread.name} accepts image inputs only.`);
  }
  if (backend === "codex_builtin") {
    if (thread.mode !== "image") throw new Error("Codex built-in generation supports image threads only.");
    return { draft, model: undefined, modelId: "codex/imagegen" };
  }
  const modelId = resolvedThreadModel(session, thread);
  const model = models.find((item) => item.id === modelId);
  if (!model) throw new Error(`${thread.name} does not have a compatible selected model.`);
  if (!hasUserApprovedThreadModel(session, thread, modelId)) {
    throw new Error(`The user must select ${modelId} before running ${thread.name}.`);
  }
  return { draft, model, modelId };
}

function estimateCatalogCost(
  mode: "image" | "video",
  model: GenerationModel | undefined,
  options: DraftOptions,
  context: { imageInputCount?: number } = {},
) {
  return model ? estimateGenerationCost(mode, model, options, context) : undefined;
}

async function hydrateImageCatalogPricing(models: ImageModel[], selectedIds?: Set<string>) {
  const targets = models.filter((model) => !selectedIds || selectedIds.has(model.id));
  const hydrated = new Map<string, ImageModel>();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < targets.length) {
      const model = targets[nextIndex++];
      const [author, ...slugParts] = model.id.split("/");
      if (!author || !slugParts.length) continue;
      try {
        const response = await openRouter(`/images/models/${encodeURIComponent(author)}/${encodeURIComponent(slugParts.join("/"))}/endpoints`);
        const endpoints = Array.isArray(response.endpoints) ? response.endpoints as ImageModelEndpoint[] : [];
        hydrated.set(model.id, applyImageModelEndpoints(model, endpoints));
      } catch {
        // Pricing is advisory; discovery and generation remain available.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
  return models.map((model) => hydrated.get(model.id) ?? model);
}

async function enhanceThreadText(
  session: BridgeSession,
  thread: GenerationThread,
  draft: GenerationDraftState,
  onActualCost?: (actualCostUsd: number) => Promise<void>,
) {
  const references = draft.references.flatMap((reference) => {
    const asset = session.assets.find((item) => item.id === reference.assetId);
    return asset ? [{ slot: reference.slot, name: asset.name, mediaType: asset.mimeType, role: reference.role }] : [];
  });
  const hasMask = thread.mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0;
  const visuals = await hydrateAgentPromptVisuals(session, thread, draft);
  const input = {
    promptModel: "openai/gpt-5.6-luna",
    mode: thread.mode,
    editMode: draft.imageEditMode,
    editTarget: draft.imageEditTarget,
    prompt: draft.prompt,
    maskInstructions: draft.maskInstructions,
    hasMask,
    references,
    visuals,
  };
  const response = await openRouter("/chat/completions", "POST", {
    model: "openai/gpt-5.6-luna",
    reasoning: { effort: "xhigh" },
    messages: [
      { role: "system", content: productSystemInstruction(input) },
      { role: "system", content: promptEnhancerInstruction(visuals.map((visual) => visual.kind)) },
      { role: "user", content: promptEnhancementUserContent(input) },
    ],
  });
  const actualCostUsd = responseCost(response);
  if (actualCostUsd != null) await onActualCost?.(actualCostUsd);
  const choices = Array.isArray(response.choices) ? response.choices as Array<Record<string, unknown>> : [];
  const message = choices[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : "").join("") : "";
  const originalIntent = [draft.prompt.trim(), hasMask ? draft.maskInstructions.trim() : ""].filter(Boolean).join("\n");
  const validationError = validateEnhancedPrompt(
    originalIntent,
    text,
    draft.imageEditTarget,
    draft.references.map((reference) => reference.slot),
  );
  if (validationError) throw new Error(validationError);
  return { text: text.trim(), visualCount: visuals.length };
}

function responseCost(response: Record<string, unknown>) {
  const usage = response.usage && typeof response.usage === "object" ? response.usage as Record<string, unknown> : {};
  return typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
}

function recordAttemptCost(session: BridgeSession, threadId: string, attemptId: string, cost: number | undefined) {
  if (cost == null) return;
  const recordedAt = new Date().toISOString();
  updateThreadAttempt(session, threadId, attemptId, { actualCostUsd: cost, costRecordedAt: recordedAt });
  session.agent = recordActualCost(session.agent, {
    id: `generation:${attemptId}`,
    category: "generation",
    actualCostUsd: cost,
    recordedAt,
  });
}

async function executeOpenRouterThread(sessionId: string, threadId: string, attemptId: string) {
  try {
    let session = (await readEnvelope()).sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error(`Session ${sessionId} does not exist.`);
    assertExecutionAllowed(session, "Generation submission", [threadId]);
    const thread = findGenerationThread(session, threadId);
    const attempt = thread?.attempts.find((item) => item.id === attemptId);
    if (!thread || !attempt?.snapshot) throw new Error(`Generation attempt ${attemptId} has no immutable request snapshot.`);
    const snapshot = structuredClone(attempt.snapshot);
    let prompt = snapshot.enhancedPrompt.trim() || snapshot.prompt.trim();
    const hasMask = snapshot.mode === "image" && snapshot.imageEditMode && snapshot.maskStrokes.length > 0;
    if (!hasGenerationInstructions({ prompt: snapshot.prompt, hasMask, maskInstructions: snapshot.maskInstructions })) {
      throw new Error("The generation instructions are empty.");
    }
    if (snapshot.enhancePrompt && !snapshot.enhancedPrompt.trim()) {
      await mutateSession(sessionId, (current) => { updateThreadAttempt(current, threadId, attemptId, { status: "enhancing" }); });
      const draft: GenerationDraftState = {
        prompt: snapshot.prompt,
        references: snapshot.assetBindings,
        options: snapshot.options,
        providerJson: snapshot.providerJson,
        enhancePrompt: true,
        enhancedPrompt: "",
        enhancedPromptDirty: false,
        enhancedVisualCount: 0,
        imageEditMode: snapshot.imageEditMode,
        imageEditTarget: snapshot.imageEditTarget,
        maskInstructions: snapshot.maskInstructions,
        maskStrokes: snapshot.maskStrokes,
      };
      prompt = (await enhanceThreadText(session, thread, draft, async (actualCostUsd) => {
        await mutateSession(sessionId, (current) => {
          current.agent = recordActualCost(current.agent, {
            id: `prompt-enhancement:${attemptId}`,
            category: "prompt_enhancement",
            actualCostUsd,
          });
        });
      })).text;
      await mutateSession(sessionId, (current) => {
        const currentAttempt = findGenerationThread(current, threadId)?.attempts.find((item) => item.id === attemptId);
        if (!currentAttempt || currentAttempt.status === "canceled") throw new Error("Generation was canceled before provider submission.");
        updateThreadAttempt(current, threadId, attemptId, { status: "submitting", enhancedPrompt: prompt });
      });
    }
    if (snapshot.mode === "image" && snapshot.imageEditMode) {
      prompt = composeEditPrompt({
        prompt,
        target: snapshot.imageEditTarget.trim(),
        hasMask,
        maskInstructions: snapshot.maskInstructions,
      });
    }
    const modelResponse = await openRouter(snapshot.mode === "image" ? "/images/models" : "/videos/models");
    const models = Array.isArray(modelResponse.data) ? modelResponse.data as GenerationModel[] : [];
    const model = models.find((item) => item.id === snapshot.modelId);
    if (!model) throw new Error(`The selected ${snapshot.mode} model is no longer available.`);
    const bindings = snapshot.assetBindings.map(({ assetId, role, slot }) => ({ assetId, role, slot }));
    const targetSlot = Number(snapshot.imageEditTarget.match(/^@(\d+)$/)?.[1]);
    const references = await hydrateGenerationAssets(session, bindings, hasMask && Number.isInteger(targetSlot)
      ? { targetSlot, strokes: snapshot.maskStrokes }
      : undefined);
    const payload = buildRequest({
      mode: snapshot.mode,
      model: snapshot.modelId,
      prompt,
      assets: references,
      options: snapshot.options,
      providerJson: snapshot.providerJson,
    }, model);
    await mutateSession(sessionId, (current) => {
      const currentAttempt = findGenerationThread(current, threadId)?.attempts.find((item) => item.id === attemptId);
      if (!currentAttempt || currentAttempt.status === "canceled") throw new Error("Generation was canceled before provider submission.");
      updateThreadAttempt(current, threadId, attemptId, {
        status: "submitting",
        request: sanitizedRequestSnapshot(payload, snapshot),
        submittedAt: new Date().toISOString(),
      });
    });
    const response = await openRouter(snapshot.mode === "image" ? "/images" : "/videos", "POST", payload);
    await mutateSession(sessionId, (current) => {
      recordAttemptCost(current, threadId, attemptId, responseCost(response));
    });
    if (snapshot.mode === "image") {
      const data = Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : [];
      const preserved = await Promise.all(data.map(async (item, index) => {
        const claimedMimeType = typeof item.media_type === "string" ? item.media_type : "image/png";
        const baseName = `agent-image-${Date.now()}-${index + 1}.png`;
        const source = typeof item.url === "string" ? item.url : typeof item.b64_json === "string" ? `data:${typeof item.media_type === "string" ? item.media_type : "image/png"};base64,${item.b64_json}` : "";
        if (!source) return null;
        const preservedImage = await materializeGeneratedMedia(source, baseName, claimedMimeType);
        return { ...preservedImage, name: displayGeneratedName(baseName, preservedImage.mimeType) };
      }));
      await mutateSession(sessionId, (current) => {
        const currentThread = findGenerationThread(current, threadId)!;
        const assets = preserved.flatMap((preservedImage) => preservedImage ? [bridgeAsset(current, {
          name: preservedImage.name, kind: "image", mimeType: preservedImage.mimeType, origin: "generated", source: preservedImage.source,
          role: snapshot.outputRole, parentAssetIds: bindings.map((binding) => binding.assetId), prompt, modelId: snapshot.modelId,
          generationBackend: "openrouter", threadId, attemptId,
        })] : []);
        if (!assets.length) throw new Error("OpenRouter returned no image data.");
        updateThreadAttempt(current, threadId, attemptId, { status: "completed", assetIds: assets.map((asset) => asset.id), completedAt: new Date().toISOString() });
        current.agent.execution.generationCount += 1;
        appendActivity(current, { kind: "generation", title: `Generated ${currentThread.name}`, prompt, modelId: snapshot.modelId, generationBackend: "openrouter", assetIds: assets.map((asset) => asset.id) });
      });
    } else {
      const jobId = typeof response.id === "string" ? response.id : typeof response.job_id === "string" ? response.job_id : "";
      if (!jobId) throw new Error("OpenRouter returned no video job ID.");
      await mutateSession(sessionId, (current) => {
        const currentThread = findGenerationThread(current, threadId)!;
        if (!current.agent.execution.currentJobIds.includes(jobId)) current.agent.execution.currentJobIds.push(jobId);
        current.agent.execution.generationCount += 1;
        updateThreadAttempt(current, threadId, attemptId, { status: "in_progress", jobId, progress: typeof response.progress === "number" ? response.progress : undefined });
        appendActivity(current, { kind: "generation", title: `Submitted ${currentThread.name}`, detail: jobId, prompt, modelId: snapshot.modelId, assetIds: bindings.map((binding) => binding.assetId) });
      });
    }
  } catch (error) {
    await mutateSession(sessionId, (session) => {
      const found = findGenerationThread(session, threadId)?.attempts.find((item) => item.id === attemptId);
      if (found && !TERMINAL_ATTEMPT_STATUSES.has(found.status)) updateThreadAttempt(session, threadId, attemptId, { status: "failed", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
    }).catch(() => undefined);
  } finally {
    threadExecutions.delete(attemptId);
  }
}

async function pollThreadVideoAttempts(sessionId: string, attemptIds: string[]) {
  const session = (await readEnvelope()).sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(`Session ${sessionId} does not exist.`);
  const nowMs = Date.now();
  const pending = session.threads.video.flatMap((thread) => thread.attempts
    .filter((attempt) => attemptIds.includes(attempt.id)
      && attempt.jobId
      && attempt.status === "in_progress"
      && (hasVideoPollingTimedOut(attempt.submittedAt ?? attempt.createdAt, nowMs) || isVideoPollDue(attempt.nextPollAt, nowMs)))
    .map((attempt) => ({ threadId: thread.id, attempt })));
  await Promise.all(pending.map(async ({ threadId, attempt }) => {
    const jobId = attempt.jobId!;
    try {
      const response = await openRouter(`/videos/${encodeURIComponent(jobId)}`);
      await mutateSession(sessionId, (current) => {
        recordAttemptCost(current, threadId, attempt.id, responseCost(response));
      });
      const status = normalizeVideoStatus(response.status);
      const urls = Array.isArray(response.unsigned_urls) ? response.unsigned_urls : [];
      const data = Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : [];
      const remoteSource = typeof urls[0] === "string" ? urls[0] : typeof data[0]?.url === "string" ? data[0].url : "";
      const preservedSource = status === "completed" && !attempt.assetIds.length ? await downloadGeneratedVideo(jobId, remoteSource) : "";
      await mutateSession(sessionId, (current) => {
        const currentThread = findGenerationThread(current, threadId);
        const currentAttempt = currentThread?.attempts.find((item) => item.id === attempt.id);
        if (!currentThread || !currentAttempt || currentAttempt.status !== "in_progress") return;
        const now = new Date().toISOString();
        const polling = { pollAttempts: (currentAttempt.pollAttempts ?? 0) + 1, lastPolledAt: now, nextPollAt: undefined };
        if (status === "failed" || status === "cancelled" || status === "expired") {
          updateThreadAttempt(current, threadId, attempt.id, { ...polling, status: status === "cancelled" ? "canceled" : "failed", error: String(response.error ?? `Video generation ${status}.`), completedAt: now });
          current.agent.execution.currentJobIds = current.agent.execution.currentJobIds.filter((id) => id !== jobId);
        } else if (status === "completed" && preservedSource && !currentAttempt.assetIds.length) {
          const snapshot = currentAttempt.snapshot;
          const asset = bridgeAsset(current, {
            name: `agent-video-${jobId}.mp4`, kind: "video", mimeType: "video/mp4", origin: "generated", source: preservedSource,
            role: snapshot?.outputRole ?? currentThread.outputRole,
            parentAssetIds: currentAttempt.inputAssetIds,
            prompt: currentAttempt.enhancedPrompt ?? snapshot?.enhancedPrompt ?? snapshot?.prompt,
            modelId: snapshot?.modelId ?? currentAttempt.modelId,
            generationBackend: "openrouter", threadId, attemptId: attempt.id,
          });
          updateThreadAttempt(current, threadId, attempt.id, { ...polling, status: "completed", assetIds: [asset.id], progress: 100, completedAt: now });
          current.agent.execution.currentJobIds = current.agent.execution.currentJobIds.filter((id) => id !== jobId);
        } else if (hasVideoPollingTimedOut(currentAttempt.submittedAt ?? currentAttempt.createdAt)) {
          const message = "Video generation did not reach a terminal state within 30 minutes.";
          updateThreadAttempt(current, threadId, attempt.id, { ...polling, status: "failed", error: message, completedAt: now });
          current.agent.execution.currentJobIds = current.agent.execution.currentJobIds.filter((id) => id !== jobId);
          current.agent.execution.lastError = message;
        } else {
          updateThreadAttempt(current, threadId, attempt.id, { ...polling, status: "in_progress", progress: typeof response.progress === "number" ? response.progress : undefined, nextPollAt: new Date(Date.now() + videoPollIntervalMs).toISOString() });
        }
      });
    } catch (error) {
      await mutateSession(sessionId, (current) => {
        const currentAttempt = findGenerationThread(current, threadId)?.attempts.find((item) => item.id === attempt.id);
        if (!currentAttempt || currentAttempt.status !== "in_progress") return;
        const now = new Date().toISOString();
        const timedOut = hasVideoPollingTimedOut(currentAttempt.submittedAt ?? currentAttempt.createdAt, Date.parse(now));
        const message = timedOut
          ? "Video generation did not reach a terminal state within 30 minutes."
          : error instanceof Error ? error.message : String(error);
        if (timedOut) {
          updateThreadAttempt(current, threadId, attempt.id, {
            status: "failed",
            error: message,
            pollAttempts: (currentAttempt.pollAttempts ?? 0) + 1,
            lastPolledAt: now,
            nextPollAt: undefined,
            completedAt: now,
          });
          current.agent.execution.currentJobIds = current.agent.execution.currentJobIds.filter((id) => id !== jobId);
          current.agent.execution.lastError = message;
        } else {
          updateThreadAttempt(current, threadId, attempt.id, {
            status: "in_progress",
            error: message,
            pollAttempts: (currentAttempt.pollAttempts ?? 0) + 1,
            lastPolledAt: now,
            nextPollAt: new Date(Date.now() + videoPollRetryDelayMs(currentAttempt.pollAttempts ?? 0)).toISOString(),
            completedAt: currentAttempt.completedAt,
          });
        }
      });
    }
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
    throw new Error(`${name} is not agent-accessible.`);
  }
  if (name === "create_session") {
    const intent = requiredString(args, "intent");
    const createdAt = new Date().toISOString();
    const agent = exposeAgentSession(createAgentState(intent), intent);
    for (const skill of Array.isArray(args.workflowSkills) ? args.workflowSkills : []) {
      if (typeof skill === "string" && skill.trim()) agent.appliedSkills.push({ name: skill.trim(), version: "user-selected", source: "workflow" });
    }
    const id = `session-${crypto.randomUUID()}`;
    const imageThread = newBridgeThread("image");
    const videoThread = newBridgeThread("video");
    const session: BridgeSession = {
      id,
      name: typeof args.name === "string" && args.name.trim() ? args.name.trim() : intent.slice(0, 54),
      createdAt,
      updatedAt: createdAt,
      mode: /video|reel|shorts|film|clip|영상|릴스|쇼츠|동영상/i.test(intent) ? "video" : "image",
      generationDefaults: {
        modelIds: { image: "", video: "" },
        options: { image: {}, video: {} },
        providerJson: { image: "", video: "" },
      },
      threads: { image: [imageThread], video: [videoThread] },
      activeThreadIds: { image: imageThread.id, video: videoThread.id },
      assets: [],
      agent,
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
      currentStepIds: session.agent.currentStepIds,
      pendingDecisions: session.agent.decisions.filter((item) => item.status === "pending").length,
    }));
  }
  if (name === "ensure_desktop") {
    const sessionId = requiredString(args, "sessionId");
    await mutateSession(sessionId, (session) => {
      session.agent.uiAttention = { requestedAt: new Date().toISOString() };
    }, { requireOwnership: false });
    let runtime = await readDesktopRuntime();
    let launched = false;
    if (!runtime) {
      launched = await launchDesktop();
      if (launched) {
        const deadline = Date.now() + 8_000;
        while (!runtime && Date.now() < deadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
          runtime = await readDesktopRuntime();
        }
      }
    }
    return runtime
      ? {
        status: "ready",
        launched,
        version: runtime.version,
        credentialConfigured: await credentialConfigured(),
        sessionId,
      }
      : {
        status: "user_action_required",
        launched,
        sessionId,
        message: platform() === "darwin"
          ? "Fruit Truck could not be opened automatically. Ask the user to open Fruit Truck, then call ensure_desktop again."
          : "Automatic launch is currently available on macOS. Ask the user to open Fruit Truck, then call ensure_desktop again.",
      };
  }
  if (name === "get_session") {
    const id = requiredString(args, "sessionId");
    const session = (await readEnvelope()).sessions.find((item) => item.id === id);
    if (!session) throw new Error(`Session ${id} does not exist.`);
    return session;
  }
  if (name === "await_decision") {
    const sessionId = requiredString(args, "sessionId");
    const decisionId = requiredString(args, "decisionId");
    const timeoutMs = typeof args.timeoutMs === "number" ? Math.min(25_000, Math.max(100, args.timeoutMs)) : 20_000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const session = (await readEnvelope()).sessions.find((item) => item.id === sessionId);
      if (!session) throw new Error(`Session ${sessionId} does not exist.`);
      assertAgentHost(session);
      const decision = session.agent.decisions.find((item) => item.id === decisionId);
      if (!decision) throw new Error(`Decision ${decisionId} does not exist.`);
      if ((decision.channel ?? "agent_chat") !== "fruit_truck_ui") {
        throw new Error("Only Fruit Truck UI decisions can be awaited. Ask chat decisions in the current agent conversation.");
      }
      if (decision.status === "resolved") {
        return { status: "resolved", decisionId, resolution: decision.resolution, revision: session.agent.revision };
      }
      if (Date.now() >= deadline) return { status: "pending", decisionId, revision: session.agent.revision };
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
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
      session.agent.currentStepIds = session.agent.plan.filter((item) => ["in_progress", "waiting"].includes(item.status)).map((item) => item.id);
      session.agent.currentStepId = session.agent.currentStepIds[0];
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
      session.agent.currentStepIds = session.agent.plan.filter((item) => ["in_progress", "waiting"].includes(item.status)).map((item) => item.id);
      session.agent.currentStepId = session.agent.currentStepIds[0];
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
        channel: "fruit_truck_ui",
        presentation: "model_picker",
        selectionMode: "single",
        minSelections: 1,
        maxSelections: 1,
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
          description: "Choose an OpenRouter image model and use the API key configured in Fruit Truck.",
        }],
        createdAt: new Date().toISOString(),
      };
      decisionId = item.id;
      session.agent.decisions.push(item);
      session.agent.runStatus = "waiting";
      session.agent.uiAttention = { requestedAt: new Date().toISOString(), decisionId: item.id };
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
      const relatedThreadInput = Array.isArray(args.threadIds) ? args.threadIds : Array.isArray(args.relatedThreadIds) ? args.relatedThreadIds : [];
      const item: AgentDecision = {
        id: `decision-${crypto.randomUUID()}`,
        requestKey,
        semanticKey,
        title: name === "request_model_selection" ? `Choose ${modelMode} model` : requiredString(args, "title"),
        prompt: name === "request_model_selection" ? requiredString(args, "recommendation") : requiredString(args, "prompt"),
        kind: name === "request_model_selection" ? "choice" : args.kind as AgentDecision["kind"],
        channel: name === "request_model_selection"
          ? "fruit_truck_ui"
          : args.channel === "fruit_truck_ui" ? "fruit_truck_ui" : "agent_chat",
        presentation: name === "request_model_selection"
          ? "model_picker"
          : (typeof args.presentation === "string" ? args.presentation : undefined) as AgentDecision["presentation"],
        selectionMode: name === "request_model_selection"
          ? "single"
          : (typeof args.selectionMode === "string" ? args.selectionMode : undefined) as AgentDecision["selectionMode"],
        minSelections: name === "request_model_selection" ? 1 : typeof args.minSelections === "number" ? args.minSelections : undefined,
        maxSelections: name === "request_model_selection" ? 1 : typeof args.maxSelections === "number" ? args.maxSelections : undefined,
        allowNote: args.allowNote === true,
        status: "pending",
        blocking: name === "request_model_selection" ? true : args.blocking === true,
        relatedStepId: typeof args.relatedStepId === "string" ? args.relatedStepId : undefined,
        relatedAssetIds: Array.isArray(args.relatedAssetIds) ? args.relatedAssetIds.filter((item): item is string => typeof item === "string") : [],
        relatedThreadIds: relatedThreadInput.filter((item): item is string => typeof item === "string"),
        options: (name === "request_model_selection" ? args.candidates : args.options) as AgentDecision["options"] ?? [],
        createdAt: new Date().toISOString(),
      };
      decisionId = item.id;
      session.agent.decisions.push(item);
      if (item.blocking && !(item.relatedThreadIds?.length) && session.agent.controlMode === "agent" && session.agent.runStatus === "working") {
        session.agent.runStatus = "waiting";
      }
      if (item.channel === "fruit_truck_ui") {
        session.agent.uiAttention = { requestedAt: new Date().toISOString(), decisionId: item.id };
      }
      if (modelMode && !(item.relatedThreadIds?.length)) {
        session.agent.modelSelections[modelMode] = { status: "pending_user", recommendation: item.prompt };
      }
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
      if ((target.channel ?? "agent_chat") === "fruit_truck_ui") {
        throw new Error("This decision must be completed in Fruit Truck.");
      }
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
      const modelMode = target.semanticKey === "model_selection_image" ? "image" : target.semanticKey === "model_selection_video" ? "video" : undefined;
      if (modelMode && optionId) {
        const relatedThreadIds = target.relatedThreadIds ?? [];
        if (relatedThreadIds.length) {
          for (const threadId of relatedThreadIds) {
            const thread = findGenerationThread(session, threadId);
            if (!thread || thread.mode !== modelMode) throw new Error(`Model decision thread ${threadId} is missing or has the wrong mode.`);
            thread.modelOverrideId = optionId;
          }
        } else {
          session.generationDefaults.modelIds[modelMode] = optionId;
        }
      }
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
        channel: "agent_chat",
        presentation: "form",
        selectionMode: "single",
        minSelections: 1,
        maxSelections: 1,
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
  if (name === "create_generation_thread") {
    const sessionId = requiredString(args, "sessionId");
    const requestKey = requiredString(args, "requestKey");
    let threadId = "";
    const updated = await mutateSession(sessionId, (session) => {
      const existing = [...session.threads.image, ...session.threads.video].find((thread) => thread.requestKey === requestKey);
      if (existing) { threadId = existing.id; return; }
      const mode = args.mode === "video" ? "video" : "image";
      const thread = newBridgeThread(mode, session.threads[mode].length + 1);
      thread.requestKey = requestKey;
      thread.name = requiredString(args, "name");
      thread.outputRole = typeof args.outputRole === "string" && args.outputRole.trim() ? args.outputRole.trim() : thread.outputRole;
      threadId = thread.id;
      session.threads[mode].push(thread);
      session.activeThreadIds[mode] = thread.id;
      appendActivity(session, { kind: "plan", title: `Created generation thread: ${thread.name}` });
    });
    const created = findGenerationThread(updated, threadId)!;
    return { thread: created, revision: updated.agent.revision };
  }
  if (name === "update_generation_thread") {
    const sessionId = requiredString(args, "sessionId");
    const threadId = requiredString(args, "threadId");
    const patch = args.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch must be an object.");
    const values = patch as Record<string, unknown>;
    const updated = await mutateSession(sessionId, (session) => {
      const thread = findGenerationThread(session, threadId);
      if (!thread) throw new Error(`Generation thread ${threadId} does not exist.`);
      if (runningThreadAttempt(thread)) throw new Error("An active generation thread cannot be edited.");
      if (typeof args.expectedThreadRevision === "number" && args.expectedThreadRevision !== thread.revision) {
        throw new Error(`GENERATION_THREAD_CONFLICT: expected revision ${args.expectedThreadRevision}, but the thread is at revision ${thread.revision}.`);
      }
      if (typeof values.name === "string" && values.name.trim()) thread.name = values.name.trim();
      if (typeof values.prompt === "string") thread.draft.prompt = values.prompt;
      if (typeof values.outputRole === "string" && values.outputRole.trim()) thread.outputRole = values.outputRole.trim();
      if (values.useModeDefaultModel === true) thread.modelOverrideId = undefined;
      else if (typeof values.modelOverrideId === "string") thread.modelOverrideId = values.modelOverrideId || undefined;
      if (typeof values.enhancePrompt === "boolean") thread.draft.enhancePrompt = values.enhancePrompt;
      if (values.options && typeof values.options === "object" && !Array.isArray(values.options)) thread.optionOverrides = values.options as GenerationThread["optionOverrides"];
      if (values.provider && typeof values.provider === "object" && !Array.isArray(values.provider)) thread.providerJsonOverride = JSON.stringify(values.provider);
      if (Array.isArray(values.assetBindings)) {
        const bindings = values.assetBindings as Array<Record<string, unknown>>;
        const assetIds = new Set(session.assets.map((asset) => asset.id));
        const missing = bindings.find((binding) => !assetIds.has(String(binding.assetId ?? "")));
        if (missing) throw new Error(`Asset ${String(missing.assetId ?? "")} does not exist in this session.`);
        thread.draft.references = bindings.map((binding, index) => ({
          assetId: String(binding.assetId ?? ""), slot: index + 1,
          role: binding.role === "first_frame" || binding.role === "last_frame" ? binding.role : "reference",
        }));
      }
      thread.draft.enhancedPrompt = "";
      thread.draft.enhancedPromptDirty = false;
      thread.draft.enhancedVisualCount = 0;
      thread.revision += 1;
      thread.updatedAt = new Date().toISOString();
    });
    return { thread: findGenerationThread(updated, threadId), revision: updated.agent.revision };
  }
  if (name === "archive_generation_thread") {
    const sessionId = requiredString(args, "sessionId");
    const threadId = requiredString(args, "threadId");
    return mutateSession(sessionId, (session) => {
      const thread = findGenerationThread(session, threadId);
      if (!thread) throw new Error(`Generation thread ${threadId} does not exist.`);
      if (runningThreadAttempt(thread)) throw new Error("An active generation thread cannot be archived.");
      if (session.threads[thread.mode].filter((item) => !item.archivedAt).length <= 1) throw new Error(`Keep at least one ${thread.mode} thread.`);
      thread.archivedAt = new Date().toISOString();
      if (session.activeThreadIds[thread.mode] === thread.id) session.activeThreadIds[thread.mode] = session.threads[thread.mode].find((item) => !item.archivedAt)?.id ?? thread.id;
    });
  }
  if (name === "restore_generation_thread") {
    const sessionId = requiredString(args, "sessionId");
    const threadId = requiredString(args, "threadId");
    return mutateSession(sessionId, (session) => {
      const thread = findGenerationThread(session, threadId);
      if (!thread) throw new Error(`Generation thread ${threadId} does not exist.`);
      thread.archivedAt = undefined;
      thread.updatedAt = new Date().toISOString();
      session.activeThreadIds[thread.mode] = thread.id;
    });
  }
  if (name === "cancel_generation_threads") {
    const sessionId = requiredString(args, "sessionId");
    const attemptIds = Array.isArray(args.attemptIds) ? args.attemptIds.filter((item): item is string => typeof item === "string") : [];
    const canceled: string[] = [];
    const retained: string[] = [];
    await mutateSession(sessionId, (session) => {
      const attempts = [...session.threads.image, ...session.threads.video].flatMap((thread) =>
        thread.attempts.filter((attempt) => attemptIds.includes(attempt.id)).map((attempt) => ({ thread, attempt })),
      );
      if (attempts.length !== attemptIds.length) throw new Error("One or more generation attempts do not exist.");
      for (const { thread, attempt } of attempts) {
        if (["queued", "enhancing", "awaiting_host"].includes(attempt.status)) {
          updateThreadAttempt(session, thread.id, attempt.id, { status: "canceled", cancelRequestedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
          canceled.push(attempt.id);
        } else retained.push(attempt.id);
      }
    });
    return { canceled, retained, remoteCancelSupported: false };
  }
  if (name === "enhance_generation_threads") {
    const sessionId = requiredString(args, "sessionId");
    const requestKey = requiredString(args, "requestKey");
    const threadIds = Array.isArray(args.threadIds) ? args.threadIds.filter((item): item is string => typeof item === "string") : [];
    if (!threadIds.length || new Set(threadIds).size !== threadIds.length) throw new Error("threadIds must contain unique generation thread IDs.");
    let work: Array<{ thread: GenerationThread; draft: GenerationDraftState; recordId: string }> = [];
    let records: Array<{ threadId: string; record: PromptEnhancementAttempt }> = [];
    const reservedSession = await mutateSession(sessionId, (session) => {
      assertExecutionAllowed(session, "Prompt enhancement", threadIds);
      const existing = [...session.threads.image, ...session.threads.video].flatMap((thread) =>
        (thread.enhancementAttempts ?? []).filter((attempt) => attempt.requestKey === requestKey).map((record) => ({ threadId: thread.id, record })),
      );
      if (existing.length) {
        if (JSON.stringify(existing.map((item) => item.threadId).toSorted()) !== JSON.stringify([...threadIds].toSorted())) {
          throw new Error("This requestKey is already bound to a different prompt enhancement thread set.");
        }
        for (const item of existing) {
          if (item.record.status === "in_progress" && !enhancementExecutions.has(item.record.id)) {
            item.record.status = "uncertain";
            item.record.error = "Fruit Truck restarted while prompt enhancement was in flight; the paid result cannot be proven, so it was not repeated.";
            item.record.updatedAt = new Date().toISOString();
          }
        }
        records = existing;
        return;
      }
      const targets = threadIds.map((id) => findGenerationThread(session, id) ?? (() => { throw new Error(`Generation thread ${id} does not exist.`); })());
      const now = new Date().toISOString();
      records = targets.map((thread) => {
        const record: PromptEnhancementAttempt = {
          id: `enhancement-${crypto.randomUUID()}`,
          requestKey,
          status: "in_progress",
          threadRevision: thread.revision,
          originalPrompt: resolvedThreadDraft(session, thread).prompt,
          createdAt: now,
          updatedAt: now,
        };
        thread.enhancementAttempts ??= [];
        thread.enhancementAttempts.push(record);
        enhancementExecutions.add(record.id);
        work.push({ thread: structuredClone(thread), draft: structuredClone(resolvedThreadDraft(session, thread)), recordId: record.id });
        return { threadId: thread.id, record };
      });
    });
    if (!work.length) return records.map(({ threadId, record }) => ({ threadId, status: record.status, enhancedPrompt: record.enhancedPrompt, error: record.error }));
    await Promise.all(work.map(async ({ thread: target, draft, recordId }) => {
      try {
        const enhanced = await enhanceThreadText(reservedSession, target, draft, async (actualCostUsd) => {
          await mutateSession(sessionId, (session) => {
            session.agent = recordActualCost(session.agent, {
              id: `prompt-enhancement:${recordId}`,
              category: "prompt_enhancement",
              actualCostUsd,
            });
          });
        });
        await mutateSession(sessionId, (session) => {
          const current = findGenerationThread(session, target.id);
          const record = current?.enhancementAttempts.find((item) => item.id === recordId);
          if (!current || !record) throw new Error(`Prompt enhancement ${recordId} no longer exists.`);
          if (current.revision !== record.threadRevision) {
            record.status = "failed";
            record.error = `${target.name} changed while its prompt was being enhanced.`;
          } else {
            record.status = "completed";
            record.enhancedPrompt = enhanced.text;
            current.draft.enhancedPrompt = enhanced.text;
            current.draft.enhancedPromptDirty = false;
            current.draft.enhancedVisualCount = enhanced.visualCount;
            current.updatedAt = new Date().toISOString();
          }
          record.updatedAt = new Date().toISOString();
        });
      } catch (error) {
        await mutateSession(sessionId, (session) => {
          const record = findGenerationThread(session, target.id)?.enhancementAttempts.find((item) => item.id === recordId);
          if (record) {
            record.status = "failed";
            record.error = error instanceof Error ? error.message : String(error);
            record.updatedAt = new Date().toISOString();
          }
        }).catch(() => undefined);
      } finally {
        enhancementExecutions.delete(recordId);
      }
    }));
    const final = (await readEnvelope()).sessions.find((item) => item.id === sessionId)!;
    return threadIds.map((threadId) => {
      const record = findGenerationThread(final, threadId)?.enhancementAttempts.find((item) => item.requestKey === requestKey);
      return { threadId, status: record?.status ?? "failed", enhancedPrompt: record?.enhancedPrompt, error: record?.error };
    });
  }
  if (name === "run_generation_threads") {
    const sessionId = requiredString(args, "sessionId");
    const requestKey = requiredString(args, "requestKey");
    const threadIds = Array.isArray(args.threadIds) ? args.threadIds.filter((item): item is string => typeof item === "string") : [];
    if (!threadIds.length || new Set(threadIds).size !== threadIds.length) throw new Error("threadIds must contain unique generation thread IDs.");
    const snapshot = (await readEnvelope()).sessions.find((item) => item.id === sessionId);
    if (!snapshot) throw new Error(`Session ${sessionId} does not exist.`);
    assertExecutionAllowed(snapshot, "Generation submission", threadIds);
    const targets = threadIds.map((id) => findGenerationThread(snapshot, id) ?? (() => { throw new Error(`Generation thread ${id} does not exist.`); })());
    const capturedRevisions = new Map(targets.map((thread) => [thread.id, thread.revision]));
    const usesCodexImage = snapshot.agent.imageGeneration.backend === "codex_builtin";
    const needsImageCatalog = targets.some((target) => target.mode === "image" && !usesCodexImage);
    const needsVideoCatalog = targets.some((target) => target.mode === "video");
    const [imageModels, videoModels] = await Promise.all([
      needsImageCatalog ? openRouter("/images/models") : Promise.resolve({ data: [] }),
      needsVideoCatalog ? openRouter("/videos/models") : Promise.resolve({ data: [] }),
    ]);
    const selectedImageModelIds = new Set(targets
      .filter((target) => target.mode === "image" && !usesCodexImage)
      .map((target) => resolvedThreadModel(snapshot, target)));
    const pricedImageModels = await hydrateImageCatalogPricing(
      Array.isArray(imageModels.data) ? imageModels.data as ImageModel[] : [],
      selectedImageModelIds,
    );
    const modelCatalogs = {
      image: pricedImageModels as GenerationModel[],
      video: Array.isArray(videoModels.data) ? videoModels.data as GenerationModel[] : [],
    };
    let attempts: Array<{ threadId: string; attempt: GenerationAttempt }> = [];
    let reused = false;
    const updated = await mutateSession(sessionId, (session) => {
      assertExecutionAllowed(session, "Generation submission", threadIds);
      const existing = [...session.threads.image, ...session.threads.video].flatMap((thread) =>
        thread.attempts.filter((attempt) => attempt.requestKey === requestKey).map((attempt) => ({ threadId: thread.id, attempt })),
      );
      if (existing.length) {
        const existingIds = existing.map((item) => item.threadId).toSorted();
        if (JSON.stringify(existingIds) !== JSON.stringify([...threadIds].toSorted())) {
          throw new Error("This requestKey is already bound to a different generation thread set.");
        }
        attempts = existing;
        reused = true;
        return;
      }
      const currentTargets = threadIds.map((id) => findGenerationThread(session, id) ?? (() => { throw new Error(`Generation thread ${id} does not exist.`); })());
      const currentUsesCodexImage = session.agent.imageGeneration.backend === "codex_builtin";
      for (const target of currentTargets) {
        if (target.revision !== capturedRevisions.get(target.id)) throw new Error(`${target.name} changed during batch preflight. Retry with its current revision.`);
        const backend = currentUsesCodexImage && target.mode === "image" ? "codex_builtin" : "openrouter";
        validatePreparedThread(session, target, modelCatalogs[target.mode], backend);
      }
      const createdAt = new Date().toISOString();
      attempts = currentTargets.map((target) => {
        const backend = currentUsesCodexImage && target.mode === "image" ? "codex_builtin" as const : "openrouter" as const;
        const requestSnapshot = snapshotForThread(session, target);
        if (backend === "codex_builtin") requestSnapshot.modelId = "codex/imagegen";
        const catalogModel = modelCatalogs[target.mode].find((model) => model.id === requestSnapshot.modelId);
        const attempt: GenerationAttempt = {
          id: `attempt-${crypto.randomUUID()}`,
          requestKey,
          status: backend === "codex_builtin" ? "awaiting_host" : "queued",
          backend,
          draftRevision: target.revision,
          requestedBy: "agent",
          createdAt,
          updatedAt: createdAt,
          modelId: requestSnapshot.modelId,
          snapshot: requestSnapshot,
          estimatedCostUsd: estimateCatalogCost(target.mode, catalogModel, requestSnapshot.options, {
            imageInputCount: requestSnapshot.assetBindings.filter((binding) =>
              session.assets.find((asset) => asset.id === binding.assetId)?.kind === "image"
            ).length,
          }),
          inputAssetIds: requestSnapshot.assetBindings.map((reference) => reference.assetId),
          assetIds: [],
        };
        target.attempts.push(attempt);
        return { threadId: target.id, attempt };
      });
    });
    const hostActions = attempts.flatMap(({ threadId, attempt }) => {
      if (attempt.backend !== "codex_builtin" || attempt.status !== "awaiting_host" || !attempt.snapshot) return [];
      return [{ threadId, attemptId: attempt.id, prompt: attempt.snapshot.enhancedPrompt.trim() || attempt.snapshot.prompt.trim(), outputRole: attempt.snapshot.outputRole, references: attempt.snapshot.assetBindings.flatMap((reference) => {
        const asset = updated.assets.find((item) => item.id === reference.assetId);
        return asset ? [{ assetId: asset.id, name: asset.name, path: asset.localPath, role: reference.role }] : [];
      }) }];
    });
    for (const { threadId, attempt } of reused ? [] : attempts) {
      if (attempt.backend !== "openrouter") continue;
      const execution = executeOpenRouterThread(sessionId, threadId, attempt.id);
      threadExecutions.set(attempt.id, execution);
      void execution;
    }
    return { attempts: attempts.map(({ threadId, attempt }) => ({ threadId, attemptId: attempt.id, status: attempt.status, backend: attempt.backend })), hostActions };
  }
  if (name === "await_generation_threads") {
    const sessionId = requiredString(args, "sessionId");
    const attemptIds = Array.isArray(args.attemptIds) ? args.attemptIds.filter((item): item is string => typeof item === "string") : [];
    const timeoutMs = typeof args.timeoutMs === "number" ? Math.min(25_000, Math.max(100, args.timeoutMs)) : 20_000;
    const deadline = Date.now() + timeoutMs;
    const initial = (await readEnvelope()).sessions.find((item) => item.id === sessionId);
    if (!initial) throw new Error(`Session ${sessionId} does not exist.`);
    const recoverable = [...initial.threads.image, ...initial.threads.video].flatMap((thread) =>
      thread.attempts
        .filter((attempt) => attemptIds.includes(attempt.id))
        .map((attempt) => ({ thread, attempt })),
    );
    const uncertain = recoverable.filter(({ attempt }) =>
      attempt.backend === "openrouter" && attempt.status === "submitting" && !threadExecutions.has(attempt.id),
    );
    if (uncertain.length) {
      await mutateSession(sessionId, (session) => {
        for (const { thread, attempt } of uncertain) {
          updateThreadAttempt(session, thread.id, attempt.id, {
            status: "uncertain",
            error: "Fruit Truck restarted after submission began, so the remote outcome cannot be proven. Review provider history before retrying.",
            completedAt: new Date().toISOString(),
          });
        }
      });
    }
    for (const { thread, attempt } of recoverable) {
      if (attempt.backend !== "openrouter" || !["queued", "enhancing"].includes(attempt.status) || threadExecutions.has(attempt.id)) continue;
      const execution = executeOpenRouterThread(sessionId, thread.id, attempt.id);
      threadExecutions.set(attempt.id, execution);
      void execution;
    }
    while (true) {
      await pollThreadVideoAttempts(sessionId, attemptIds).catch(() => undefined);
      const session = (await readEnvelope()).sessions.find((item) => item.id === sessionId);
      if (!session) throw new Error(`Session ${sessionId} does not exist.`);
      const attempts = [...session.threads.image, ...session.threads.video].flatMap((thread) => thread.attempts.filter((attempt) => attemptIds.includes(attempt.id)).map((attempt) => ({ threadId: thread.id, attempt })));
      if (attempts.length !== attemptIds.length) throw new Error("One or more generation attempts do not exist.");
      const terminal = attempts.every(({ attempt }) => TERMINAL_ATTEMPT_STATUSES.has(attempt.status));
      if (terminal || Date.now() >= deadline) {
        const statuses = attempts.map(({ attempt }) => attempt.status);
        const completed = statuses.filter((status) => status === "completed").length;
        const outcome = !terminal ? undefined
          : statuses.includes("uncertain") ? "uncertain"
            : statuses.every((status) => status === "canceled") ? "canceled"
              : completed === statuses.length ? "completed"
                : completed > 0 ? "partial_failure"
                  : "failed";
        return { status: terminal ? "terminal" : "pending", ...(outcome ? { outcome } : {}), attempts: attempts.map(({ threadId, attempt }) => ({ threadId, ...attempt })) };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  if (name === "list_models") {
    const mode = args.mode === "video" ? "video" : "image";
    const path = mode === "image" ? "/images/models" : "/videos/models";
    const result = await openRouter(path);
    const rawModels = Array.isArray(result.data) ? result.data : [];
    const models = mode === "image" ? await hydrateImageCatalogPricing(rawModels as ImageModel[]) : rawModels;
    return models.map((model) => {
      const value = model as Record<string, unknown>;
      return {
        id: value.id, name: value.name, description: value.description,
        pricing: value.pricing, pricingSkus: value.pricing_skus, supportedParameters: value.supported_parameters,
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
  if (name === "import_remote_asset") {
    const sessionId = requiredString(args, "sessionId");
    const sourceUrl = requiredString(args, "sourceUrl");
    const nameValue = requiredString(args, "name");
    const downloaded = await downloadPublicReference(sourceUrl, nameValue);
    return mutateSession(sessionId, async (session, transaction) => {
      transaction.onRollback(async () => { await unlink(downloaded.path).catch(() => undefined); });
      const asset = bridgeAsset(session, {
        name: nameValue,
        kind: downloaded.mimeType.startsWith("video/") ? "video" : "image",
        mimeType: downloaded.mimeType,
        origin: "upload",
        source: downloaded.path,
        sourceUrl: downloaded.finalUrl,
        sourcePageUrl: typeof args.sourcePageUrl === "string" ? args.sourcePageUrl : undefined,
        license: typeof args.license === "string" ? args.license : "unknown",
        role: requiredString(args, "role"),
      });
      appendActivity(session, {
        kind: "generation",
        title: `Imported web reference: ${asset.name}`,
        detail: typeof args.sourcePageUrl === "string" ? args.sourcePageUrl : downloaded.finalUrl,
        assetIds: [asset.id],
      });
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
      assertExecutionAllowed(session, "Codex image registration", typeof args.threadId === "string" ? [args.threadId] : []);
      if (session.agent.connection.agentHost !== "codex"
        || session.agent.imageGeneration.status !== "selected"
        || session.agent.imageGeneration.backend !== "codex_builtin") {
        throw new Error("This session has not selected Codex built-in image generation.");
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
      if (typeof args.threadId === "string" && typeof args.attemptId === "string") {
        const { thread, attempt } = updateThreadAttempt(session, args.threadId, args.attemptId, {
          status: "completed",
          assetIds: [asset.id],
          completedAt: new Date().toISOString(),
        });
        if (attempt.backend !== "codex_builtin" || thread.mode !== "image") throw new Error("The host attempt is not a Codex image generation.");
      }
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
  if (name === "fail_host_generation") {
    if (detectedAgentHost() !== "codex") throw new Error("Host generation failure reporting is available only to Codex.");
    return mutateSession(requiredString(args, "sessionId"), (session) => {
      const threadId = requiredString(args, "threadId");
      const attemptId = requiredString(args, "attemptId");
      const { attempt } = updateThreadAttempt(session, threadId, attemptId, {
        status: "failed",
        error: requiredString(args, "error"),
        completedAt: new Date().toISOString(),
      });
      if (attempt.backend !== "codex_builtin") throw new Error("The attempt is not owned by the Codex host.");
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
    const bindingInputs = Array.isArray(args.assetBindings) ? args.assetBindings as Array<Record<string, unknown>> : [];
    const bindings = bindingInputs.map((binding) => ({
      assetId: String(binding.assetId ?? ""),
      role: binding.role as ReferenceAsset["role"],
    }));
    const modelResponse = await openRouter(mode === "image" ? "/images/models" : "/videos/models");
    const models = Array.isArray(modelResponse.data) ? modelResponse.data as GenerationModel[] : [];
    const model = models.find((item) => item.id === selection.modelId);
    if (!model) throw new Error(`The selected ${mode} model is no longer in the current catalog.`);
    const references = await hydrateGenerationAssets(current, bindings);
    const payload = buildRequest({
      mode,
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
    const referenceBindings = bindings.filter((binding) => binding.role === "reference");
    const frameBindings = bindings.filter((binding) => binding.role === "first_frame" || binding.role === "last_frame");
    if (mode === "video" && referenceBindings.length && frameBindings.length) {
      throw new Error("The selected video model input must use either general references or frame images for one request, not both.");
    }
    const sentReferences = Array.isArray(payload.input_references) ? payload.input_references.length : 0;
    const sentFrames = Array.isArray(payload.frame_images) ? payload.frame_images.length : 0;
    if (sentReferences !== referenceBindings.length || sentFrames !== frameBindings.length) {
      throw new Error("One or more bound assets are incompatible with the user-selected model. Request a new model choice or compatible inputs.");
    }
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await openRouter(mode === "image" ? "/images" : "/videos", "POST", payload);
    const actualCost = responseCost(response);
    if (actualCost != null) {
      await mutateSession(sessionId, (session) => {
        session.agent = recordActualCost(session.agent, {
          id: `generation:${attemptId}`,
          category: "generation",
          actualCostUsd: actualCost,
        });
      });
    }
    const preservedImages = mode === "image"
      ? await Promise.all((Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : []).map(async (item, index) => {
        const claimedMimeType = typeof item.media_type === "string" ? item.media_type : "image/png";
        const baseName = `agent-image-${Date.now()}-${index + 1}.png`;
        const source = typeof item.url === "string"
          ? item.url
          : typeof item.b64_json === "string"
            ? `data:${typeof item.media_type === "string" ? item.media_type : "image/png"};base64,${item.b64_json}`
            : "";
        if (!source) return "";
        const preservedImage = await materializeGeneratedMedia(source, baseName, claimedMimeType);
        return { ...preservedImage, name: displayGeneratedName(baseName, preservedImage.mimeType) };
      }))
      : [];
    return mutateSession(sessionId, (session) => {
      assertExecutionAllowed(session, "Generation result recording");
      if (session.agent.modelSelections[mode].modelId !== selection.modelId) {
        throw new Error(`AGENT_SESSION_CONFLICT: the selected ${mode} model changed while this request was running. Reload before recording its result.`);
      }
      const inputAssetIds = bindings.map((binding) => binding.assetId);
      const thread = newBridgeThread(mode, session.threads[mode].length + 1);
      thread.modelOverrideId = selection.modelId;
      thread.outputRole = typeof args.role === "string" ? args.role : mode === "image" ? "generated_image" : "generated_video";
      thread.draft.prompt = prompt;
      thread.draft.references = bindings.map((binding, index) => ({ assetId: binding.assetId, role: binding.role, slot: index + 1 }));
      thread.optionOverrides = args.options && typeof args.options === "object" && !Array.isArray(args.options) ? args.options as GenerationThread["optionOverrides"] : {};
      thread.providerJsonOverride = args.provider && typeof args.provider === "object" && !Array.isArray(args.provider) ? JSON.stringify(args.provider) : undefined;
      const createdAt = new Date().toISOString();
      const attempt: GenerationAttempt = {
        id: attemptId,
        status: mode === "image" ? "completed" : "in_progress",
        backend: "openrouter",
        draftRevision: thread.revision,
        requestedBy: "agent",
        createdAt,
        updatedAt: createdAt,
        submittedAt: createdAt,
        completedAt: mode === "image" ? createdAt : undefined,
        modelId: selection.modelId,
        snapshot: snapshotForThread({ ...session, threads: { ...session.threads, [mode]: [...session.threads[mode], thread] } }, thread),
        request: sanitizedRequestSnapshot(payload, {
          ...snapshotForThread({ ...session, threads: { ...session.threads, [mode]: [...session.threads[mode], thread] } }, thread),
          modelId: selection.modelId!,
        }),
        inputAssetIds,
        assetIds: [],
        estimatedCostUsd: estimatedCost,
        actualCostUsd: actualCost,
        costRecordedAt: actualCost != null ? createdAt : undefined,
      };
      session.threads[mode].push(thread);
      session.activeThreadIds[mode] = thread.id;
      if (mode === "image") {
        const data = Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : [];
        const assets = data.flatMap((_item, index) => {
          const preserved = preservedImages[index];
          if (!preserved) return [];
          return [bridgeAsset(session, {
            name: preserved.name, kind: "image", mimeType: preserved.mimeType,
            origin: "generated", source: preserved.source, role: typeof args.role === "string" ? args.role : "generated_image",
            parentAssetIds: inputAssetIds, planStepId: args.planStepId, prompt, modelId: selection.modelId,
            generationBackend: "openrouter", threadId: thread.id, attemptId: attempt.id,
          })];
        });
        if (!assets.length) throw new Error("OpenRouter returned no image data.");
        attempt.assetIds = assets.map((asset) => asset.id);
        thread.attempts.push(attempt);
        appendActivity(session, { kind: "generation", title: `Generated ${assets.length} image candidate(s)`, prompt, modelId: selection.modelId, generationBackend: "openrouter", assetIds: assets.map((asset) => asset.id) });
      } else {
        const jobId = typeof response.id === "string" ? response.id : typeof response.job_id === "string" ? response.job_id : "";
        if (!jobId) throw new Error("OpenRouter returned no video job ID.");
        attempt.jobId = jobId;
        thread.attempts.push(attempt);
        session.agent.execution.currentJobIds.push(jobId);
        appendActivity(session, { kind: "generation", title: "Submitted video generation", detail: jobId, prompt, modelId: selection.modelId, assetIds: inputAssetIds });
      }
      session.agent.execution.generationCount += 1;
    });
  }
  if (name === "poll_video") {
    const sessionId = requiredString(args, "sessionId");
    const jobId = requiredString(args, "jobId");
    const response = await openRouter(`/videos/${encodeURIComponent(jobId)}`);
    const remoteStatus = normalizeVideoStatus(response.status);
    const currentSession = (await readEnvelope()).sessions.find((item) => item.id === sessionId);
    const currentMatch = currentSession?.threads.video.flatMap((thread) => thread.attempts.map((attempt) => ({ thread, attempt }))).find(({ attempt }) => attempt.jobId === jobId);
    if (!currentMatch) throw new Error(`Video job ${jobId} is not registered in this session.`);
    await mutateSession(sessionId, (session) => {
      recordAttemptCost(session, currentMatch.thread.id, currentMatch.attempt.id, responseCost(response));
    });
    const urls = Array.isArray(response.unsigned_urls) ? response.unsigned_urls : [];
    const data = Array.isArray(response.data) ? response.data as Array<Record<string, unknown>> : [];
    const remoteSource = typeof urls[0] === "string" ? urls[0] : typeof data[0]?.url === "string" ? data[0].url : "";
    const preservedSource = remoteStatus === "completed" && !currentMatch.attempt.assetIds.length
      ? await downloadGeneratedVideo(jobId, remoteSource)
      : "";
    return mutateSession(sessionId, (session) => {
      const match = session.threads.video.flatMap((thread) => thread.attempts.map((attempt) => ({ thread, attempt }))).find(({ attempt }) => attempt.jobId === jobId);
      if (!match) throw new Error(`Video job ${jobId} is not registered in this session.`);
      const { thread, attempt } = match;
      const now = new Date().toISOString();
      const terminalFailure = remoteStatus === "failed" || remoteStatus === "cancelled" || remoteStatus === "expired";
      const status = remoteStatus === "completed"
        ? "completed"
        : remoteStatus === "cancelled" ? "canceled"
          : terminalFailure ? "failed" : "in_progress";
      const error = terminalFailure
        ? String(response.error ?? `Video generation ${remoteStatus}.`)
        : typeof response.error === "string" ? response.error : undefined;
      updateThreadAttempt(session, thread.id, attempt.id, {
        status,
        progress: remoteStatus === "completed" ? 100 : typeof response.progress === "number" ? response.progress : undefined,
        error,
        pollAttempts: (attempt.pollAttempts ?? 0) + 1,
        lastPolledAt: now,
        nextPollAt: status === "in_progress" ? new Date(Date.now() + videoPollIntervalMs).toISOString() : undefined,
        completedAt: status === "in_progress" ? attempt.completedAt : now,
      });
      if (remoteStatus === "completed" || terminalFailure) {
        session.agent.execution.currentJobIds = session.agent.execution.currentJobIds.filter((id) => id !== jobId);
      }
      if (terminalFailure) {
        session.agent.execution.lastError = error;
      }
      if (remoteStatus === "completed" && preservedSource && !attempt.assetIds.length) {
        const snapshot = attempt.snapshot;
        const asset = bridgeAsset(session, {
          name: `agent-video-${jobId}.mp4`, kind: "video", mimeType: "video/mp4",
          origin: "generated", source: preservedSource, role: snapshot?.outputRole ?? thread.outputRole,
          parentAssetIds: attempt.inputAssetIds, prompt: attempt.enhancedPrompt ?? snapshot?.enhancedPrompt ?? snapshot?.prompt, modelId: snapshot?.modelId ?? attempt.modelId,
          generationBackend: "openrouter", threadId: thread.id, attemptId: attempt.id,
        });
        updateThreadAttempt(session, thread.id, attempt.id, { status: "completed", assetIds: [asset.id], completedAt: new Date().toISOString() });
        appendActivity(session, { kind: "generation", title: "Video generation completed", detail: jobId, modelId: String(snapshot?.modelId ?? attempt.modelId ?? ""), generationBackend: "openrouter", assetIds: [asset.id] });
      }
    });
  }
  if (name === "propose_assembly") {
    const sessionId = requiredString(args, "sessionId");
    const requestKey = requiredString(args, "requestKey");
    const clips = Array.isArray(args.clips) ? args.clips as AgentSessionState["assembly"]["clips"] : [];
    let decisionId = "";
    const updated = await mutateSession(sessionId, (session) => {
      const existing = session.agent.decisions.find((item) => item.requestKey === requestKey);
      if (existing) {
        decisionId = existing.id;
        return;
      }
      const assetIds = new Set(session.assets.map((asset) => asset.id));
      for (const clip of clips) {
        if (!assetIds.has(clip.assetId)) throw new Error(`Assembly asset ${clip.assetId} does not exist.`);
        if (clip.startSeconds < 0 || clip.endSeconds <= clip.startSeconds) throw new Error(`Assembly clip ${clip.assetId} has an invalid range.`);
        const artifact = session.agent.artifacts.find((item) => item.assetId === clip.assetId);
        const asset = session.assets.find((item) => item.id === clip.assetId);
        if (asset?.kind !== "video" || artifact?.approval !== "approved") {
          throw new Error("Every proposed assembly clip must be an approved video artifact.");
        }
      }
      session.agent.assembly = {
        ...session.agent.assembly,
        clips: clips.toSorted((left, right) => left.order - right.order),
        status: "ready",
        error: undefined,
      };
      const decision: AgentDecision = {
        id: `decision-${crypto.randomUUID()}`,
        requestKey,
        title: "Review final video assembly",
        prompt: "Review clip order and usable ranges in Fruit Truck, then render the final video.",
        kind: "approval",
        channel: "fruit_truck_ui",
        presentation: "assembly_review",
        selectionMode: "single",
        minSelections: 1,
        maxSelections: 1,
        status: "pending",
        blocking: true,
        relatedAssetIds: clips.map((clip) => clip.assetId),
        options: [
          { id: "rendered", label: "Render final video", recommended: true },
          { id: "revise", label: "Request a new assembly plan" },
        ],
        createdAt: new Date().toISOString(),
      };
      decisionId = decision.id;
      session.agent.decisions.push(decision);
      session.agent.runStatus = "waiting";
      session.agent.uiAttention = { requestedAt: new Date().toISOString(), decisionId: decision.id };
      appendActivity(session, { kind: "assembly", title: "Proposed final video assembly", detail: `${clips.length} clip(s)` });
    });
    return { decisionId, assembly: updated.agent.assembly, revision: updated.agent.revision };
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
        channel: "agent_chat",
        presentation: "form",
        selectionMode: "single",
        minSelections: 1,
        maxSelections: 1,
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
      if (existsSync(sessionsPath)) {
        await withSessionStoreLock(() => readEnvelope({ persistMigration: true }));
      }
      const params = request.params as { clientInfo?: { name?: string } } | undefined;
      initializedClientName = typeof params?.clientInfo?.name === "string" ? params.clientInfo.name : "";
      response(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fruit-truck", version: "2.1.0" },
        instructions: `This server is connected as ${detectedAgentHost()}. Start with create_session, background-safe ensure_desktop, then claim_session. Keep textual ambiguity in agent chat; use Fruit Truck UI decisions for media, models, uploads, assembly, and approvals. Await UI decisions and never foreground the app or duplicate a paid request.`,
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
