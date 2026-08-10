import type { AgentBridgeSession } from "./agentBridge.ts";

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const identifier = /^(?:session|thread|attempt|decision|activity|asset|artifact|assembly|job|requirement)-[A-Za-z0-9_-]+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;

function aliasValues(value: unknown) {
  const aliases = new Map<string, string>();
  const walk = (item: unknown, key = ""): unknown => {
    if (Array.isArray(item)) return item.map((entry) => walk(entry));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entry]) => [entryKey, walk(entry, entryKey)]));
    }
    if (typeof item !== "string") return item;
    if (timestamp.test(item)) return "<time>";
    if (key.toLowerCase().includes("path") && item.startsWith("/")) return "<managed-path>";
    if (identifier.test(item)) {
      const kind = item.includes("-") ? item.split("-")[0] : "id";
      if (!aliases.has(item)) aliases.set(item, `<${kind}-${aliases.size + 1}>`);
      return aliases.get(item);
    }
    return item;
  };
  return walk(value);
}

export function canonicalAgentSession(session: AgentBridgeSession) {
  const threads = ["image", "video"].flatMap((mode) => (session.threads?.[mode as "image" | "video"] ?? []).map((thread) => ({
    id: thread.id,
    requestKey: thread.requestKey,
    name: thread.name,
    mode: thread.mode,
    outputRole: thread.outputRole,
    archived: Boolean(thread.archivedAt),
    modelOverrideId: thread.modelOverrideId,
    draft: thread.draft,
    attempts: thread.attempts.map((attempt) => ({
      id: attempt.id,
      requestKey: attempt.requestKey,
      status: attempt.status,
      backend: attempt.backend,
      modelId: attempt.modelId,
      snapshot: attempt.snapshot,
      inputAssetIds: attempt.inputAssetIds,
      assetIds: attempt.assetIds,
      jobId: attempt.jobId,
      actualCostUsd: attempt.actualCostUsd,
      error: attempt.error,
    })),
  })));
  return aliasValues({
    identity: { id: session.id, name: session.name, mode: session.mode },
    connection: {
      status: session.agent.connection.status,
      claimedBy: session.agent.connection.claimedBy,
      agentHost: session.agent.connection.agentHost,
    },
    controlMode: session.agent.controlMode,
    runStatus: session.agent.runStatus,
    brief: session.agent.brief,
    requirements: session.agent.requirements,
    plan: session.agent.plan,
    currentStepIds: session.agent.currentStepIds,
    decisions: session.agent.decisions.map((decision) => ({
      id: decision.id,
      requestKey: decision.requestKey,
      semanticKey: decision.semanticKey,
      title: decision.title,
      prompt: decision.prompt,
      kind: decision.kind,
      channel: decision.channel,
      presentation: decision.presentation,
      selectionMode: decision.selectionMode,
      status: decision.status,
      blocking: decision.blocking,
      relatedStepId: decision.relatedStepId,
      relatedAssetIds: decision.relatedAssetIds,
      relatedThreadIds: decision.relatedThreadIds,
      options: decision.options,
      resolution: decision.resolution && {
        channel: decision.resolution.channel,
        optionId: decision.resolution.optionId,
        selectedAssetIds: decision.resolution.selectedAssetIds,
        note: decision.resolution.note,
        userResponse: decision.resolution.userResponse,
      },
    })),
    activity: session.agent.activity.map((item) => ({
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      prompt: item.prompt,
      modelId: item.modelId,
      generationBackend: item.generationBackend,
      assetIds: item.assetIds,
    })),
    imageGeneration: session.agent.imageGeneration,
    modelSelections: session.agent.modelSelections,
    generationDefaults: session.generationDefaults,
    threads,
    assets: session.assets,
    artifacts: session.agent.artifacts,
    assembly: session.agent.assembly,
    execution: {
      currentJobIds: session.agent.execution.currentJobIds,
      generationCount: session.agent.execution.generationCount,
      costLedger: session.agent.execution.costLedger,
      spentUsd: session.agent.execution.spentUsd,
      retryCount: session.agent.execution.retryCount,
      lastError: session.agent.execution.lastError,
    },
  });
}
