import { invoke } from "@tauri-apps/api/core";
import { normalizeAgentState, validateAgentState, type AgentSessionState } from "@/agent";
import {
  createSession,
  materializeLegacyAssetForBridge,
  type SessionAsset,
  type StudioSession,
} from "@/studio";
import { isTauriRuntime, type GenerationMode } from "@/openrouter";

export type AgentBridgeSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode?: GenerationMode;
  selectedModelIds?: Partial<Record<GenerationMode, string>>;
  assets?: SessionAsset[];
  agent: AgentSessionState;
};

export type AgentBridgeEnvelope = {
  schemaVersion: 1;
  revision: number;
  sessions: AgentBridgeSession[];
};

function validBridgeSession(value: unknown): value is AgentBridgeSession {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AgentBridgeSession>;
  if (typeof item.id !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
    || typeof item.name !== "string"
    || typeof item.createdAt !== "string"
    || typeof item.updatedAt !== "string"
    || !item.agent
    || item.agent.schemaVersion !== 1) {
    return false;
  }
  const agent = normalizeAgentState(item.agent);
  return validateAgentState(agent).length === 0
    && validSessionAssetReferences({ agent, assets: item.assets });
}

function validSessionAssetReferences(session: Pick<AgentBridgeSession, "assets" | "agent">) {
  const validAssets = (session.assets ?? []).every((asset) =>
    !asset.blobKey
    && (!asset.externalUrl || /^https?:\/\//i.test(asset.externalUrl))
    && (!asset.localPath || /^(?:\/|[A-Za-z]:[\\/])/.test(asset.localPath))
  );
  const assetIds = new Set((session.assets ?? []).map((asset) => asset.id));
  return validAssets && session.agent.artifacts.every((artifact) =>
    assetIds.has(artifact.assetId) && artifact.parentAssetIds.every((id) => assetIds.has(id))
  )
    && session.agent.decisions.every((decision) => decision.relatedAssetIds.every((id) => assetIds.has(id)))
    && session.agent.assembly.clips.every((clip) => assetIds.has(clip.assetId));
}

export async function readAgentBridge(): Promise<AgentBridgeEnvelope> {
  const value = await invoke<AgentBridgeEnvelope>("read_agent_sessions");
  if (value?.schemaVersion !== 1 || !Array.isArray(value.sessions)) {
    throw new Error("The external agent bridge returned an unsupported schema.");
  }
  return { ...value, sessions: value.sessions.filter(validBridgeSession) };
}

export async function waitForAgentBridge(
  afterRevision: number,
  timeoutMs = 20_000,
): Promise<AgentBridgeEnvelope> {
  const value = await invoke<AgentBridgeEnvelope>("wait_for_agent_sessions", {
    afterRevision,
    timeoutMs,
  });
  if (value?.schemaVersion !== 1 || !Array.isArray(value.sessions)) {
    throw new Error("The external agent bridge returned an unsupported schema.");
  }
  return { ...value, sessions: value.sessions.filter(validBridgeSession) };
}

export function materializeAgentSession(value: AgentBridgeSession): StudioSession {
  const base = createSession(value.name || "Agent session");
  return {
    ...base,
    id: value.id,
    name: value.name || base.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    mode: value.mode === "video" ? "video" : "image",
    selectedModelIds: {
      image: value.selectedModelIds?.image ?? value.agent.modelSelections.image.modelId ?? "",
      video: value.selectedModelIds?.video ?? value.agent.modelSelections.video.modelId ?? "",
    },
    assets: Array.isArray(value.assets) ? value.assets : [],
    agent: normalizeAgentState(value.agent),
    agentBridge: true,
  };
}

export function serializeAgentSession(session: StudioSession): AgentBridgeSession {
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
    selectedModelIds: session.selectedModelIds,
    assets: session.assets.map((asset) => ({
      ...asset,
      blobKey: undefined,
      fingerprint: undefined,
      bridgeAvailability: asset.localPath || asset.externalUrl ? "available" : "desktop_only",
    })),
    agent: session.agent,
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

export async function saveCustomSkill(name: string, markdown: string): Promise<SavedCustomSkill> {
  return invoke<SavedCustomSkill>("save_custom_skill_text", { name, markdown });
}

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
