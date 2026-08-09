import { invoke } from "@tauri-apps/api/core";
import { normalizeAgentState, validateAgentState, type AgentSessionState } from "./agent.ts";
import {
  createSession,
  materializeLegacyAssetForBridge,
  type GenerationDefaults,
  type GenerationThread,
  type SessionAsset,
  type StudioSession,
} from "./studio.ts";
import { isTauriRuntime, type GenerationMode } from "./openrouter.ts";

export type AgentBridgeSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode?: GenerationMode;
  selectedModelIds?: Partial<Record<GenerationMode, string>>;
  generationDefaults?: GenerationDefaults;
  threads?: Record<GenerationMode, GenerationThread[]>;
  activeThreadIds?: Record<GenerationMode, string>;
  assets?: SessionAsset[];
  agent: AgentSessionState;
};

export type AgentBridgeEnvelope = {
  schemaVersion: 1 | 2 | 3 | 4;
  revision: number;
  sessions: AgentBridgeSession[];
  migrationSessionIds?: string[];
};

function stableBridgeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableBridgeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableBridgeValue(item)]));
  }
  return value;
}

function bridgeValuesEqual(left: unknown, right: unknown) {
  return JSON.stringify(stableBridgeValue(left)) === JSON.stringify(stableBridgeValue(right));
}

export function validBridgeSession(value: unknown): value is AgentBridgeSession {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentBridgeSession>;
  if (typeof item.id !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
    || typeof item.name !== "string"
    || typeof item.createdAt !== "string"
    || typeof item.updatedAt !== "string"
    || !item.agent
    || (item.agent.schemaVersion !== 1 && item.agent.schemaVersion !== 2 && item.agent.schemaVersion !== 3 && item.agent.schemaVersion !== 4)) {
    return false;
  }
  const agent = normalizeAgentState(item.agent);
  return validateAgentState(agent).length === 0
    && validSessionAssetReferences({ agent, assets: item.assets, threads: item.threads });
}

export function recoverBridgeGenerationState(value: AgentBridgeSession): AgentBridgeSession {
  type LegacyWorkflow = "generate" | "edit";
  type LegacyThread = GenerationThread & { videoWorkflow?: LegacyWorkflow; videoWorkflowStates?: unknown };
  type LegacyDefaults = GenerationDefaults & {
    options: GenerationDefaults["options"] & { videoGenerate?: GenerationDefaults["options"]["video"]; videoEdit?: GenerationDefaults["options"]["video"] };
    providerJson: GenerationDefaults["providerJson"] & { videoGenerate?: string; videoEdit?: string };
  };
  type LegacyJob = { jobId?: string; workflow?: LegacyWorkflow; threadId?: string };
  const legacyValue = value as AgentBridgeSession & Partial<{
    videoWorkflow: LegacyWorkflow;
    drafts: unknown;
    activeVideoJobs: LegacyJob[];
    jobs: LegacyJob[];
  }>;
  const base = createSession(value.name || "Recovered agent session");
  const assets = Array.isArray(value.assets) ? value.assets : [];
  const assetIds = new Set(assets.map((asset) => asset.id));
  const attemptStatuses = new Set(["queued", "enhancing", "awaiting_host", "submitting", "in_progress", "completed", "failed", "uncertain", "canceled"]);
  const legacyEditJobIds = new Set<string>();
  const recoverThreads = (mode: GenerationMode): GenerationThread[] => {
    const source = (Array.isArray(value.threads?.[mode]) ? value.threads[mode] : []) as LegacyThread[];
    const recovered = source.flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string") return [];
      if (mode === "video" && candidate.videoWorkflow === "edit") {
        for (const attempt of candidate.attempts ?? []) {
          if (attempt.jobId) legacyEditJobIds.add(attempt.jobId);
        }
        return [];
      }
      const fallback = base.threads[mode][0];
      const draft = candidate.draft && typeof candidate.draft === "object" ? candidate.draft : fallback.draft;
      const { videoWorkflow: _workflow, videoWorkflowStates: _workflowStates, ...canonical } = candidate;
      return [{
        ...fallback,
        ...canonical,
        mode,
        name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name : `${mode === "image" ? "Image" : "Video"} ${index + 1}`,
        revision: Number.isInteger(candidate.revision) && candidate.revision >= 0 ? candidate.revision : 0,
        optionOverrides: candidate.optionOverrides && typeof candidate.optionOverrides === "object" ? candidate.optionOverrides : {},
        draft: {
          ...fallback.draft,
          ...draft,
          references: Array.isArray(draft.references) ? draft.references.filter((reference) =>
            reference && assetIds.has(reference.assetId) && (reference.role as string) !== "video_reference"
          ) : [],
        },
        attempts: Array.isArray(candidate.attempts) ? candidate.attempts.flatMap((attempt) => {
          if (!attempt || typeof attempt !== "object" || typeof attempt.id !== "string") return [];
          const legacySnapshot = attempt.snapshot as (NonNullable<typeof attempt.snapshot> & { videoWorkflow?: LegacyWorkflow }) | undefined;
          const legacyEditAttempt = mode === "video" && (candidate.videoWorkflow === "edit"
            || legacySnapshot?.videoWorkflow === "edit"
            || legacySnapshot?.assetBindings?.some((binding) => (binding.role as string) === "video_reference"));
          if (legacyEditAttempt) {
            if (attempt.jobId) legacyEditJobIds.add(attempt.jobId);
            return [];
          }
          const status = attemptStatuses.has(attempt.status) ? attempt.status : "uncertain";
          const request = attempt.request && !/data:(?:image|video)\/|;base64,/i.test(JSON.stringify(attempt.request)) ? attempt.request : undefined;
          const snapshot = legacySnapshot && Array.isArray(legacySnapshot.assetBindings)
            ? (() => {
              const { videoWorkflow: _snapshotWorkflow, ...canonicalSnapshot } = legacySnapshot;
              return {
                ...canonicalSnapshot,
                assetBindings: canonicalSnapshot.assetBindings.filter((binding) =>
                  assetIds.has(binding.assetId) && (binding.role as string) !== "video_reference"
                ),
              };
            })()
            : undefined;
          return [{
            ...attempt,
            status,
            request,
            error: status === "uncertain" && !attemptStatuses.has(attempt.status) ? "Recovered an unsupported attempt status; review before retrying." : attempt.error,
            inputAssetIds: Array.isArray(attempt.inputAssetIds) ? attempt.inputAssetIds.filter((id) => assetIds.has(id)) : [],
            assetIds: Array.isArray(attempt.assetIds) ? attempt.assetIds.filter((id) => assetIds.has(id)) : [],
            snapshot,
          }];
        }) : [],
        enhancementAttempts: Array.isArray(candidate.enhancementAttempts) ? candidate.enhancementAttempts : [],
      } satisfies GenerationThread];
    });
    return recovered.length ? recovered : base.threads[mode];
  };
  const legacyEditThreadIds = new Set(((value.threads?.video ?? []) as LegacyThread[])
    .filter((thread) => thread.videoWorkflow === "edit")
    .map((thread) => thread.id));
  for (const job of [...(legacyValue.activeVideoJobs ?? []), ...(legacyValue.jobs ?? [])]) {
    const legacyEditJob = job.workflow === "edit" || (job.threadId ? legacyEditThreadIds.has(job.threadId) : false);
    if (legacyEditJob && job.jobId) legacyEditJobIds.add(job.jobId);
  }
  const threads = { image: recoverThreads("image"), video: recoverThreads("video") };
  const agent = normalizeAgentState(value.agent);
  agent.execution.currentJobIds = agent.execution.currentJobIds.filter((jobId) => !legacyEditJobIds.has(jobId));
  const legacyDefaults = value.generationDefaults as LegacyDefaults | undefined;
  const generationDefaults = legacyDefaults && typeof legacyDefaults === "object"
    ? {
      modelIds: { ...base.generationDefaults.modelIds, ...legacyDefaults.modelIds },
      options: {
        image: legacyDefaults.options?.image ?? base.generationDefaults.options.image,
        video: legacyDefaults.options?.video ?? legacyDefaults.options?.videoGenerate ?? base.generationDefaults.options.video,
      },
      providerJson: {
        image: legacyDefaults.providerJson?.image ?? base.generationDefaults.providerJson.image,
        video: legacyDefaults.providerJson?.video ?? legacyDefaults.providerJson?.videoGenerate ?? base.generationDefaults.providerJson.video,
      },
    }
    : base.generationDefaults;
  const {
    videoWorkflow: _sessionWorkflow,
    drafts: _drafts,
    activeVideoJobs: _activeVideoJobs,
    jobs: _jobs,
    ...canonicalValue
  } = legacyValue;
  return {
    ...canonicalValue,
    assets,
    agent,
    generationDefaults,
    threads,
    activeThreadIds: {
      image: threads.image.some((thread) => thread.id === value.activeThreadIds?.image) ? value.activeThreadIds!.image : threads.image[0].id,
      video: threads.video.some((thread) => thread.id === value.activeThreadIds?.video) ? value.activeThreadIds!.video : threads.video[0].id,
    },
  };
}

export function recoverAgentBridgeEnvelope(value: AgentBridgeEnvelope): AgentBridgeEnvelope {
  if ((value?.schemaVersion !== 1 && value?.schemaVersion !== 2 && value?.schemaVersion !== 3 && value?.schemaVersion !== 4) || !Array.isArray(value.sessions)) {
    throw new Error("The external agent bridge returned an unsupported schema.");
  }
  const sessions = value.sessions.map(recoverBridgeGenerationState);
  const migrationSessionIds = sessions.flatMap((session, index) =>
    bridgeValuesEqual(value.sessions[index], session) ? [] : [session.id]
  );
  const recovered = {
    ...value,
    sessions,
    ...(migrationSessionIds.length ? { migrationSessionIds } : {}),
  };
  const invalid = (recovered.sessions as unknown[]).find((session) => !validBridgeSession(session));
  const invalidId = invalid && typeof invalid === "object" && "id" in invalid && typeof invalid.id === "string" ? invalid.id : "unknown";
  if (invalid) throw new Error(`The external agent bridge contains a malformed session (${invalidId}). Its data was left untouched for recovery.`);
  return recovered;
}

function validSessionAssetReferences(session: Pick<AgentBridgeSession, "assets" | "agent" | "threads">) {
  try {
    const assets = Array.isArray(session.assets) ? session.assets : [];
    const validAssets = assets.every((asset) =>
      !!asset
      && typeof asset === "object"
      && !asset.blobKey
      && (!asset.externalUrl || /^https?:\/\//i.test(asset.externalUrl))
      && (!asset.localPath || /^(?:\/|[A-Za-z]:[\\/])/.test(asset.localPath))
    );
    if (!validAssets) return false;

    const assetIds = new Set(assets.map((asset) => asset.id));
    const imageThreads = Array.isArray(session.threads?.image) ? session.threads.image : [];
    const videoThreads = Array.isArray(session.threads?.video) ? session.threads.video : [];
    const threads = [...imageThreads, ...videoThreads];
    const terminalStatuses = new Set(["queued", "enhancing", "awaiting_host", "submitting", "in_progress", "completed", "failed", "uncertain", "canceled"]);
    const threadIds: string[] = [];
    const attemptIds: string[] = [];

    for (const thread of threads) {
      if (!thread || typeof thread !== "object") return false;
      if (typeof thread.id !== "string") return false;
      if (thread.mode !== "image" && thread.mode !== "video") return false;
      if (!Number.isInteger(thread.revision)) return false;
      if (thread.enhancementAttempts != null && !Array.isArray(thread.enhancementAttempts)) return false;
      if (!thread.draft || typeof thread.draft !== "object" || !Array.isArray(thread.draft.references)) return false;
      if (!Array.isArray(thread.attempts)) return false;
      if (!thread.draft.references.every((reference) => reference && assetIds.has(reference.assetId))) return false;

      threadIds.push(thread.id);
      for (const attempt of thread.attempts) {
        if (!attempt || typeof attempt !== "object" || typeof attempt.id !== "string") return false;
        if (!terminalStatuses.has(attempt.status)) return false;
        if (!Array.isArray(attempt.inputAssetIds) || !attempt.inputAssetIds.every((id) => assetIds.has(id))) return false;
        if (!Array.isArray(attempt.assetIds) || !attempt.assetIds.every((id) => assetIds.has(id))) return false;
        if (attempt.snapshot) {
          if (typeof attempt.snapshot !== "object" || !Array.isArray(attempt.snapshot.assetBindings)) return false;
          if (!attempt.snapshot.assetBindings.every((binding) => binding && assetIds.has(binding.assetId))) return false;
        }
        if (attempt.request && /data:(?:image|video)\/|;base64,/i.test(JSON.stringify(attempt.request))) return false;
        attemptIds.push(attempt.id);
      }
    }

    if (new Set(threadIds).size !== threadIds.length || new Set(attemptIds).size !== attemptIds.length) return false;
    if (!session.agent || typeof session.agent !== "object") return false;
    if (!Array.isArray(session.agent.artifacts) || !Array.isArray(session.agent.decisions) || !session.agent.assembly || !Array.isArray(session.agent.assembly.clips)) {
      return false;
    }

    return session.agent.artifacts.every((artifact) =>
      artifact && assetIds.has(artifact.assetId) && Array.isArray(artifact.parentAssetIds) && artifact.parentAssetIds.every((id) => assetIds.has(id))
    )
      && session.agent.decisions.every((decision) =>
        decision
        && Array.isArray(decision.relatedAssetIds)
        && Array.isArray(decision.options)
        && decision.relatedAssetIds.every((id) => assetIds.has(id))
        && decision.options.every((option) => !option?.assetId || assetIds.has(option.assetId))
      )
      && session.agent.assembly.clips.every((clip) => clip && assetIds.has(clip.assetId));
  } catch {
    return false;
  }
}

export async function readAgentBridge(): Promise<AgentBridgeEnvelope> {
  const value = await invoke<AgentBridgeEnvelope>("read_agent_sessions");
  return recoverAgentBridgeEnvelope(value);
}

export async function waitForAgentBridge(
  afterRevision: number,
  timeoutMs = 20_000,
): Promise<AgentBridgeEnvelope> {
  const value = await invoke<AgentBridgeEnvelope>("wait_for_agent_sessions", {
    afterRevision,
    timeoutMs,
  });
  return recoverAgentBridgeEnvelope(value);
}

export function materializeAgentSession(value: AgentBridgeSession): StudioSession {
  const base = createSession(value.name || "Agent session");
  const threads = value.threads ? {
    image: value.threads.image.map((thread) => ({ ...thread, attempts: thread.attempts ?? [], enhancementAttempts: thread.enhancementAttempts ?? [] })),
    video: value.threads.video.map((thread) => ({ ...thread, attempts: thread.attempts ?? [], enhancementAttempts: thread.enhancementAttempts ?? [] })),
  } : base.threads;
  return {
    ...base,
    id: value.id,
    name: value.name || base.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    mode: value.mode === "video" ? "video" : "image",
    generationDefaults: value.generationDefaults ?? {
      ...base.generationDefaults,
      modelIds: {
        image: value.selectedModelIds?.image ?? value.agent.modelSelections.image.modelId ?? "",
        video: value.selectedModelIds?.video ?? value.agent.modelSelections.video.modelId ?? "",
      },
    },
    threads,
    activeThreadIds: value.activeThreadIds ?? base.activeThreadIds,
    assets: Array.isArray(value.assets) ? value.assets : [],
    agent: normalizeAgentState(value.agent),
    agentBridge: true,
  };
}

function serializeAgentSession(session: StudioSession): AgentBridgeSession {
  const stateErrors = validateAgentState(session.agent);
  if (stateErrors.length) throw new Error(`Agent state is invalid: ${stateErrors.join(" ")}`);
  if (!validSessionAssetReferences(session)) {
    throw new Error("Agent state references an asset that is missing from the session.");
  }
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    mode: session.mode,
    generationDefaults: session.generationDefaults,
    threads: {
      image: session.threads.image.map(compactThreadHistory),
      video: session.threads.video.map(compactThreadHistory),
    },
    activeThreadIds: session.activeThreadIds,
    assets: session.assets.map((asset) => ({
      ...asset,
      blobKey: undefined,
      fingerprint: undefined,
      bridgeAvailability: asset.localPath || asset.externalUrl ? "available" : "desktop_only",
    })),
    agent: session.agent,
  };
}

function compactThreadHistory(thread: GenerationThread): GenerationThread {
  const terminal = new Set(["completed", "failed", "uncertain", "canceled"]);
  return {
    ...thread,
    attempts: [
      ...thread.attempts.filter((attempt) => !terminal.has(attempt.status)),
      ...thread.attempts.filter((attempt) => terminal.has(attempt.status)).slice(-100),
    ],
    enhancementAttempts: [
      ...thread.enhancementAttempts.filter((attempt) => attempt.status === "in_progress"),
      ...thread.enhancementAttempts.filter((attempt) => attempt.status !== "in_progress").slice(-100),
    ],
  };
}

export async function serializeAgentSessionForBridge(session: StudioSession): Promise<AgentBridgeSession> {
  const serialized = serializeAgentSession(session);
  const assets = await Promise.all(session.assets.map(async (asset) => {
    if (!asset.blobKey && !asset.externalUrl?.startsWith("data:")) {
      return serialized.assets?.find((item) => item.id === asset.id) ?? asset;
    }
    const materialized = await materializeLegacyAssetForBridge(asset);
    return {
      ...materialized,
      blobKey: undefined,
      fingerprint: undefined,
      bridgeAvailability: "available" as const,
    };
  }));
  return { ...serialized, assets };
}

export async function writeSerializedAgentBridgeSession(
  session: AgentBridgeSession,
  expectedRevision?: number,
): Promise<AgentBridgeEnvelope> {
  return invoke<AgentBridgeEnvelope>("upsert_agent_session", {
    session,
    expectedRevision,
  });
}

export type SavedCustomSkill = {
  name: string;
  version: number;
  markdown: string;
  path: string;
};

export type CustomSkillSummary = {
  name: string;
  version: number;
  path: string;
  versions: number[];
};

export async function listCustomSkills(): Promise<CustomSkillSummary[]> {
  if (!isTauriRuntime()) return [];
  return invoke<CustomSkillSummary[]>("list_custom_skills");
}

export async function readCustomSkill(name: string, version?: number): Promise<SavedCustomSkill> {
  return invoke<SavedCustomSkill>("read_custom_skill", { name, version });
}

export async function importCustomSkill(name: string, markdown: string): Promise<SavedCustomSkill> {
  return invoke<SavedCustomSkill>("import_custom_skill_text", { name, markdown });
}

export async function rollbackCustomSkill(name: string, version: number): Promise<SavedCustomSkill> {
  return invoke<SavedCustomSkill>("rollback_custom_skill", { name, version });
}
