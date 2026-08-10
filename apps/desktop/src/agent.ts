import type { GenerationMode } from "@/openrouter";

export type ControlMode = "human" | "agent";
export type AgentHost = "codex" | "claude" | "hermes" | "unknown";
export type ImageGenerationBackend = "codex_builtin" | "openrouter";
export type AgentRunStatus = "idle" | "working" | "paused" | "waiting" | "failed" | "completed";
export type RequirementStatus = "confirmed" | "assumed" | "missing";
export type DecisionStatus = "pending" | "resolved";
export type PlanStepStatus = "pending" | "in_progress" | "waiting" | "completed" | "failed" | "skipped";
export type ArtifactApproval = "unreviewed" | "approved" | "rejected";
export type DecisionChannel = "agent_chat" | "fruit_truck_ui";
export type DecisionPresentation = "form" | "media_grid" | "model_picker" | "upload" | "assembly_review";
export type DecisionSelectionMode = "none" | "single" | "multiple" | "one_per_group";
export type AgentDecisionSemanticKey =
  | "deliverable_usage"
  | "visual_approach"
  | "output_spec"
  | "identity_refs"
  | "image_generation_backend"
  | "model_selection_image"
  | "model_selection_video"
  | "final_approval"
  | "custom_skill_approval"
  | "custom_skill_activation";

export type CreativeBrief = {
  originalIntent: string;
  goal: string;
  deliverable: string;
  usage: string;
  visualApproach: string;
  outputSpec: string;
  message: string;
  mustInclude: string[];
  mustAvoid: string[];
};

export type AgentRequirement = {
  id: string;
  label: string;
  value: string;
  status: RequirementStatus;
  source: "user" | "agent" | "skill";
  blocking: boolean;
};

export type PlanStep = {
  id: string;
  title: string;
  description: string;
  status: PlanStepStatus;
  dependsOn: string[];
  outputRole?: string;
  checkpoint?: boolean;
};

export type AgentDecisionOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  compatibility?: string;
  inputStructure?: string;
  price?: string;
  constraints?: string;
  assetId?: string;
  groupId?: string;
};

export type AgentDecision = {
  id: string;
  requestKey?: string;
  semanticKey?: AgentDecisionSemanticKey;
  title: string;
  prompt: string;
  kind: "approval" | "choice" | "upload" | "feedback";
  channel?: DecisionChannel;
  presentation?: DecisionPresentation;
  selectionMode?: DecisionSelectionMode;
  minSelections?: number;
  maxSelections?: number;
  allowNote?: boolean;
  status: DecisionStatus;
  blocking: boolean;
  relatedStepId?: string;
  relatedThreadIds?: string[];
  relatedAssetIds: string[];
  customSkillAction?: {
    name: string;
    version: number;
    active: boolean;
  };
  options: AgentDecisionOption[];
  resolution?: {
    optionId?: string;
    selectedOptionIds?: string[];
    selectedAssetIds?: string[];
    note?: string;
    userResponse?: string;
    channel?: DecisionChannel | "legacy_desktop";
    resolvedAt: string;
  };
  createdAt: string;
};

export type AgentActivity = {
  id: string;
  createdAt: string;
  actor: "agent" | "user" | "runtime";
  kind: "plan" | "decision" | "generation" | "evaluation" | "error" | "handover" | "assembly" | "skill";
  title: string;
  detail?: string;
  prompt?: string;
  modelId?: string;
  generationBackend?: ImageGenerationBackend;
  assetIds?: string[];
};

export type ArtifactNode = {
  assetId: string;
  role: string;
  parentAssetIds: string[];
  planStepId?: string;
  threadId?: string;
  attemptId?: string;
  prompt?: string;
  modelId?: string;
  generationBackend?: ImageGenerationBackend;
  approval: ArtifactApproval;
  evaluation?: {
    technical: string;
    aesthetic: string;
    recommendation: string;
  };
};

export type ModelSelection = {
  status: "unselected" | "pending_user" | "selected" | "incompatible";
  modelId?: string;
  selectedBy?: "user";
  selectedAt?: string;
  recommendation?: string;
};

export type VideoAssemblyClip = {
  id: string;
  assetId: string;
  startSeconds: number;
  endSeconds: number;
  order: number;
};

export type VideoAssembly = {
  clips: VideoAssemblyClip[];
  outputAssetId?: string;
  status: "draft" | "ready" | "rendering" | "completed" | "failed";
  error?: string;
};

export type CustomSkillDraft = {
  name: string;
  version: number;
  markdown: string;
  status: "proposed" | "approved" | "saved" | "rejected";
};

export type ActualCostEntry = {
  id: string;
  category: "generation" | "prompt_enhancement";
  actualCostUsd: number;
  recordedAt: string;
};

export type AgentSessionState = {
  schemaVersion: 1 | 2 | 3 | 4;
  connection: {
    status: "disconnected" | "waiting" | "claimed";
    claimedAt?: string;
    claimedBy?: string;
    agentHost?: AgentHost;
  };
  controlMode: ControlMode;
  runStatus: AgentRunStatus;
  brief: CreativeBrief;
  requirements: AgentRequirement[];
  plan: PlanStep[];
  decisions: AgentDecision[];
  activity: AgentActivity[];
  artifacts: ArtifactNode[];
  appliedSkills: Array<{ name: string; version: string; source: "core" | "workflow" | "custom" }>;
  imageGeneration: {
    status: "unselected" | "selected";
    backend?: ImageGenerationBackend;
    selectedBy?: "user_chat" | "user_ui" | "policy";
    selectedAt?: string;
    decisionId?: string;
  };
  modelSelections: Record<GenerationMode, ModelSelection>;
  currentStepId?: string;
  currentStepIds: string[];
  uiAttention?: {
    requestedAt: string;
    decisionId?: string;
  };
  pausedReason?: string;
  assembly: VideoAssembly;
  customSkill?: CustomSkillDraft;
  execution: {
    currentJobIds: string[];
    generationCount: number;
    costLedger: ActualCostEntry[];
    spentUsd: number;
    retryCount: number;
    lastError?: string;
  };
  revision: number;
  updatedAt: string;
};

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function createAgentState(intent = ""): AgentSessionState {
  return {
    schemaVersion: 4,
    connection: { status: "disconnected" },
    controlMode: "human",
    runStatus: "idle",
    brief: {
      originalIntent: intent,
      goal: intent,
      deliverable: "",
      usage: "",
      visualApproach: "",
      outputSpec: "",
      message: "",
      mustInclude: [],
      mustAvoid: [],
    },
    requirements: [],
    plan: [],
    decisions: [],
    activity: [],
    artifacts: [],
    appliedSkills: [{ name: "fruit-truck-agent", version: "2.0.0", source: "core" }],
    imageGeneration: { status: "unselected" },
    modelSelections: {
      image: { status: "unselected" },
      video: { status: "unselected" },
    },
    currentStepIds: [],
    assembly: { clips: [], status: "draft" },
    execution: {
      currentJobIds: [],
      generationCount: 0,
      costLedger: [],
      spentUsd: 0,
      retryCount: 0,
    },
    revision: 0,
    updatedAt: now(),
  };
}

export function normalizeAgentState(value: AgentSessionState): AgentSessionState {
  const fallback = createAgentState(value?.brief?.originalIntent ?? "");
  const resetLegacyCosts = (value.schemaVersion ?? 1) < 4;
  const costLedger = resetLegacyCosts ? [] : normalizeCostLedger(value.execution?.costLedger);
  const legacyImageGeneration = value.imageGeneration ?? (
    value.connection?.status === "claimed"
      ? {
        status: "selected" as const,
        backend: "openrouter" as const,
        selectedBy: "policy" as const,
        selectedAt: value.updatedAt,
      }
      : fallback.imageGeneration
  );
  const normalizedDecisions = (value.decisions ?? [])
    .map((item) => ({
      ...item,
      channel: item.channel ?? (item.resolution?.channel === "legacy_desktop" ? "fruit_truck_ui" : "agent_chat"),
      presentation: item.presentation ?? (
        item.kind === "upload" ? "upload"
          : item.relatedAssetIds.length ? "media_grid"
            : item.semanticKey?.startsWith("model_selection") ? "model_picker"
              : "form"
      ),
      selectionMode: item.selectionMode ?? (item.kind === "approval" ? "none" : "single"),
      allowNote: item.allowNote ?? item.kind === "feedback",
      semanticKey: item.semanticKey ?? legacyDecisionSemanticKey(item.title),
      resolution: item.resolution ? {
        channel: "legacy_desktop" as const,
        ...item.resolution,
      } : undefined,
    }));
  const decisions = normalizedDecisions.filter((item) => item.presentation !== "assembly_review" || (
    item.kind === "approval"
    && item.options.some((option) => option.id === "rendered")
    && item.options.some((option) => option.id === "revise")
  ));
  const discardedInvalidCheckpoints = decisions.length !== normalizedDecisions.length;
  const pendingBlockingDecision = decisions.some((item) => item.status === "pending" && item.blocking);
  const pendingUiDecision = decisions.findLast((item) => item.status === "pending" && item.channel === "fruit_truck_ui");
  const recoveredRunStatus = discardedInvalidCheckpoints
    && value.connection?.status === "claimed"
    && value.controlMode === "agent"
    && (value.runStatus === "waiting" || value.runStatus === "working")
    ? pendingBlockingDecision ? "waiting" as const : "working" as const
    : value.runStatus;
  const recoveredUiAttention = discardedInvalidCheckpoints
    ? pendingUiDecision
      ? { requestedAt: pendingUiDecision.createdAt, decisionId: pendingUiDecision.id }
      : undefined
    : value.uiAttention;
  const recoveredApprovals = new Map<string, ArtifactApproval>();
  for (const decision of decisions) {
    if (decision.kind !== "approval" || decision.status !== "resolved") continue;
    const selectedAssetIds = decision.resolution?.selectedAssetIds ?? [];
    const affectedAssetIds = selectedAssetIds.length ? selectedAssetIds : decision.relatedAssetIds;
    if (!affectedAssetIds.length) continue;
    const approval = decision.resolution?.optionId === "revise" || decision.resolution?.optionId === "reject"
      ? "rejected"
      : decision.resolution?.optionId === "approve" || selectedAssetIds.length
        ? "approved"
        : undefined;
    if (!approval) continue;
    for (const assetId of affectedAssetIds) recoveredApprovals.set(assetId, approval);
  }
  return {
    ...fallback,
    ...value,
    connection: { ...fallback.connection, ...value.connection },
    brief: { ...fallback.brief, ...value.brief },
    imageGeneration: { ...fallback.imageGeneration, ...legacyImageGeneration },
    modelSelections: { ...fallback.modelSelections, ...value.modelSelections },
    runStatus: recoveredRunStatus,
    uiAttention: recoveredUiAttention,
    plan: value.runStatus === "completed"
      ? (value.plan ?? []).map((item) => item.status === "skipped" ? item : { ...item, status: "completed" as const })
      : value.plan ?? [],
    decisions,
    artifacts: (value.artifacts ?? []).map((artifact) => {
      const approval = recoveredApprovals.get(artifact.assetId);
      return approval ? { ...artifact, approval } : artifact;
    }),
    assembly: {
      ...fallback.assembly,
      ...value.assembly,
      clips: (value.assembly?.clips ?? []).map((clip, index) => ({
        ...clip,
        id: typeof clip.id === "string" && clip.id
          ? clip.id
          : `assembly-${clip.assetId}-${clip.order}-${index}`,
      })),
    },
    execution: {
      currentJobIds: value.execution?.currentJobIds ?? [],
      generationCount: value.execution?.generationCount ?? 0,
      costLedger,
      spentUsd: totalActualCostUsd(costLedger),
      retryCount: value.execution?.retryCount ?? 0,
      lastError: value.execution?.lastError,
    },
    currentStepIds: value.runStatus === "completed"
      ? []
      : Array.isArray(value.currentStepIds)
        ? value.currentStepIds
        : value.currentStepId ? [value.currentStepId] : [],
    schemaVersion: 4,
  };
}

function normalizeCostLedger(value: unknown): ActualCostEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, ActualCostEntry>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Partial<ActualCostEntry>;
    if (!entry.id || (entry.category !== "generation" && entry.category !== "prompt_enhancement")) continue;
    if (typeof entry.actualCostUsd !== "number" || !Number.isFinite(entry.actualCostUsd) || entry.actualCostUsd < 0) continue;
    if (typeof entry.recordedAt !== "string" || !entry.recordedAt) continue;
    entries.set(entry.id, { ...entry } as ActualCostEntry);
  }
  return [...entries.values()];
}

function decimalParts(value: number) {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentText ?? 0);
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [whole, fractional = ""] = unsigned.split(".");
  let coefficient = BigInt(`${whole}${fractional}` || "0");
  if (negative) coefficient = -coefficient;
  let scale = fractional.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

export function totalActualCostUsd(entries: ActualCostEntry[]) {
  const parts = entries.flatMap((entry) => Number.isFinite(entry.actualCostUsd)
    ? [decimalParts(entry.actualCostUsd)]
    : []);
  const scale = parts.reduce((maximum, part) => Math.max(maximum, part.scale), 0);
  const coefficient = parts.reduce(
    (sum, part) => sum + part.coefficient * 10n ** BigInt(scale - part.scale),
    0n,
  );
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const decimal = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    : digits;
  return Number(`${negative ? "-" : ""}${decimal}`);
}

export function recordActualCost(
  state: AgentSessionState,
  entry: Omit<ActualCostEntry, "recordedAt"> & { recordedAt?: string },
): AgentSessionState {
  if (!entry.id || !Number.isFinite(entry.actualCostUsd) || entry.actualCostUsd < 0) return state;
  const costLedger = state.execution.costLedger.filter((candidate) => candidate.id !== entry.id);
  costLedger.push({
    ...entry,
    recordedAt: entry.recordedAt ?? now(),
  });
  return {
    ...state,
    execution: {
      ...state.execution,
      costLedger,
      spentUsd: totalActualCostUsd(costLedger),
    },
  };
}

function legacyDecisionSemanticKey(title: string): AgentDecisionSemanticKey | undefined {
  switch (title) {
    case "Deliverable and usage": return "deliverable_usage";
    case "Visual approach": return "visual_approach";
    case "Output specification": return "output_spec";
    case "Identity and references": return "identity_refs";
    case "Choose image generation backend": return "image_generation_backend";
    case "Choose image model": return "model_selection_image";
    case "Choose video model": return "model_selection_video";
    case "Final video approval": return "final_approval";
    default: return undefined;
  }
}

type DecisionResolutionContext = {
  userResponse?: string;
  channel?: DecisionChannel | "legacy_desktop";
  selectedOptionIds?: string[];
  selectedAssetIds?: string[];
};

export function resolveAgentDecision(
  state: AgentSessionState,
  decisionId: string,
  optionId?: string,
  note?: string,
  resolutionContext?: DecisionResolutionContext,
): AgentSessionState {
  const target = state.decisions.find((item) => item.id === decisionId);
  if (!target || target.status !== "pending") return state;
  if (
    target.semanticKey === "final_approval"
    && optionId === "approve"
    && state.decisions.some((item) => item.id !== decisionId && item.status === "pending" && item.blocking)
  ) {
    return state;
  }
  const selected = optionId ? target.options.find((item) => item.id === optionId) : undefined;
  const createdAt = now();
  const decisions = state.decisions.map((item) =>
    item.id === decisionId
      ? {
        ...item,
        status: "resolved" as const,
        resolution: {
          optionId,
          selectedOptionIds: resolutionContext?.selectedOptionIds ?? (optionId ? [optionId] : []),
          selectedAssetIds: resolutionContext?.selectedAssetIds ?? [],
          note,
          userResponse: resolutionContext?.userResponse,
          channel: resolutionContext?.channel ?? "legacy_desktop",
          resolvedAt: createdAt,
        },
      }
      : item,
  );
  const pendingBlocking = decisions.some((item) => item.status === "pending" && item.blocking);
  const approvalAssetIds = resolutionContext?.selectedAssetIds?.length
    ? resolutionContext.selectedAssetIds
    : target.relatedAssetIds;
  const approval = target.kind === "approval" && approvalAssetIds.length
    ? optionId === "revise" || optionId === "reject"
      ? "rejected" as const
      : optionId === "approve" || Boolean(resolutionContext?.selectedAssetIds?.length)
        ? "approved" as const
        : undefined
    : undefined;
  const finalApproval = target.semanticKey === "final_approval" && optionId === "approve";
  const completed = !pendingBlocking && (
    finalApproval
    || decisions.some((item) =>
      item.semanticKey === "final_approval"
      && item.status === "resolved"
      && item.resolution?.optionId === "approve"
    )
  );
  const customSkillStatus = target.semanticKey === "custom_skill_approval"
    ? optionId === "approve" ? "approved" as const : "rejected" as const
    : undefined;
  const plan = finalApproval
    ? state.plan.map((item) => item.status === "skipped" ? item : { ...item, status: "completed" as const })
    : target.relatedStepId && approval
      ? state.plan.map((item) => item.id === target.relatedStepId
        ? { ...item, status: approval === "rejected" ? "waiting" as const : "completed" as const }
        : item)
      : state.plan;
  let brief = state.brief;
  let requirements = state.requirements;
  const confirmedValue = [selected?.label, note].filter(Boolean).join(" · ") || "Confirmed";
  const confirmRequirement = (label: string, value: string) => {
    requirements = requirements.map((item) =>
      item.label === label ? { ...item, value, status: "confirmed" as const, source: "user" as const, blocking: false } : item,
    );
  };
  if (target.semanticKey === "visual_approach") {
    brief = { ...brief, visualApproach: confirmedValue };
    confirmRequirement("Visual approach", confirmedValue);
  } else if (target.semanticKey === "output_spec") {
    brief = { ...brief, outputSpec: confirmedValue };
    confirmRequirement("Output specification", confirmedValue);
  } else if (target.semanticKey === "identity_refs") {
    confirmRequirement("Identity and references", confirmedValue);
  } else if (target.semanticKey === "deliverable_usage") {
    brief = { ...brief, deliverable: selected?.label ?? brief.deliverable, usage: note?.trim() || brief.usage };
    confirmRequirement("Final deliverable", selected?.label ?? brief.deliverable);
    if (note?.trim()) confirmRequirement("Usage", note.trim());
  }
  return {
    ...state,
    brief,
    requirements,
    plan,
    decisions,
    customSkill: customSkillStatus && state.customSkill
      ? { ...state.customSkill, status: customSkillStatus }
      : state.customSkill,
    artifacts: approval
      ? state.artifacts.map((item) => approvalAssetIds.includes(item.assetId) ? { ...item, approval } : item)
      : state.artifacts,
    runStatus: completed
      ? "completed"
      : state.controlMode === "human" || state.runStatus === "paused" || state.runStatus === "idle"
        ? state.runStatus
        : pendingBlocking ? "waiting" : "working",
    currentStepIds: completed ? [] : state.currentStepIds,
    activity: [...state.activity, {
      id: uid("activity"),
      createdAt,
      actor: "user",
      kind: "decision",
      title: target.title,
      detail: [selected?.label, note].filter(Boolean).join(" · ") || "Resolved",
    }],
    revision: state.revision + 1,
    updatedAt: createdAt,
  };
}

export function resolveAgentDecisionWithModelSelection(
  state: AgentSessionState,
  decisionId: string,
  optionId?: string,
  note?: string,
  resolutionContext?: DecisionResolutionContext,
): AgentSessionState {
  const target = state.decisions.find((item) => item.id === decisionId);
  const resolved = resolveAgentDecision(state, decisionId, optionId, note, resolutionContext);
  const mode = target?.semanticKey === "model_selection_image"
    ? "image"
    : target?.semanticKey === "model_selection_video"
      ? "video"
      : undefined;
  if (resolved === state || !optionId) return resolved;
  if (target?.semanticKey === "image_generation_backend") {
    const backend = optionId === "codex_builtin" ? "codex_builtin" : optionId === "openrouter" ? "openrouter" : undefined;
    if (!backend) return resolved;
    return {
      ...resolved,
      imageGeneration: {
        status: "selected",
        backend,
        selectedBy: resolutionContext?.channel === "agent_chat"
          ? "user_chat"
          : resolutionContext?.channel === "fruit_truck_ui" ? "user_ui" : "policy",
        selectedAt: resolved.updatedAt,
        decisionId,
      },
    };
  }
  if (!mode) return resolved;
  if ((target?.relatedThreadIds ?? []).length) return resolved;
  return {
    ...resolved,
    modelSelections: {
      ...resolved.modelSelections,
      [mode]: {
        status: "selected",
        modelId: optionId,
        selectedBy: "user",
        selectedAt: resolved.updatedAt,
      },
    },
  };
}

export function resolveAgentDecisionFromDesktop(
  state: AgentSessionState,
  decisionId: string,
  selectedOptionIds: string[] = [],
  selectedAssetIds: string[] = [],
  note?: string,
): AgentSessionState {
  const target = state.decisions.find((item) => item.id === decisionId);
  if (!target) throw new Error(`Decision ${decisionId} does not exist.`);
  if (target.status !== "pending") throw new Error(`Decision ${decisionId} is already resolved.`);
  if ((target.channel ?? "agent_chat") !== "fruit_truck_ui") {
    throw new Error("This decision must be answered in the agent chat.");
  }
  const allowedOptions = new Set(target.options.map((item) => item.id));
  const invalidOption = selectedOptionIds.find((id) => !allowedOptions.has(id));
  if (invalidOption) throw new Error(`Option ${invalidOption} is not valid for decision ${decisionId}.`);
  const allowedAssets = new Set(target.kind === "upload"
    ? state.artifacts.map((item) => item.assetId)
    : [
    ...target.relatedAssetIds,
    ...target.options.flatMap((item) => item.assetId ? [item.assetId] : []),
  ]);
  const invalidAsset = selectedAssetIds.find((id) => !allowedAssets.has(id));
  if (invalidAsset) throw new Error(`Asset ${invalidAsset} is not valid for decision ${decisionId}.`);
  const count = selectedAssetIds.length || selectedOptionIds.length;
  if (target.minSelections != null && count < target.minSelections) {
    throw new Error(`Choose at least ${target.minSelections} item(s).`);
  }
  if (target.maxSelections != null && count > target.maxSelections) {
    throw new Error(`Choose no more than ${target.maxSelections} item(s).`);
  }
  if (target.selectionMode === "one_per_group") {
    const selected = target.options.filter((item) => selectedOptionIds.includes(item.id) || Boolean(item.assetId && selectedAssetIds.includes(item.assetId)));
    const expectedGroups = new Set(target.options.flatMap((item) => item.groupId ? [item.groupId] : []));
    const selectedGroups = new Set(selected.flatMap((item) => item.groupId ? [item.groupId] : []));
    if (selectedGroups.size !== expectedGroups.size) throw new Error("Choose one item from every group.");
  }
  const optionId = selectedOptionIds[0];
  return resolveAgentDecisionWithModelSelection(
    state,
    decisionId,
    optionId,
    note,
    {
      userResponse: [selectedOptionIds.join(", "), selectedAssetIds.join(", "), note].filter(Boolean).join(" · ") || "Confirmed in Fruit Truck",
      channel: "fruit_truck_ui",
      selectedOptionIds,
      selectedAssetIds,
    },
  );
}

export function resolveAgentDecisionFromChat(
  state: AgentSessionState,
  decisionId: string,
  userResponse: string,
  optionId?: string,
  note?: string,
  relatedAssetIds: string[] = [],
): AgentSessionState {
  const response = userResponse.trim();
  if (!response) throw new Error("The user's chat response is required.");
  const target = state.decisions.find((item) => item.id === decisionId);
  if (!target) throw new Error(`Decision ${decisionId} does not exist.`);
  if (target.status !== "pending") throw new Error(`Decision ${decisionId} is already resolved.`);
  if (target.channel === "fruit_truck_ui") throw new Error("This decision must be completed in Fruit Truck.");
  if (
    target.semanticKey === "final_approval"
    && optionId === "approve"
    && state.decisions.some((item) => item.id !== decisionId && item.status === "pending" && item.blocking)
  ) {
    throw new Error("Resolve every other blocking decision before approving the final result.");
  }
  if (target.options.length && !optionId) throw new Error("An option is required for this decision.");
  if (optionId && !target.options.some((item) => item.id === optionId)) {
    throw new Error(`Option ${optionId} is not valid for decision ${decisionId}.`);
  }
  const knownAssetIds = new Set(state.artifacts.map((item) => item.assetId));
  const invalidAssetId = relatedAssetIds.find((id) => !knownAssetIds.has(id));
  if (invalidAssetId) throw new Error(`Related asset ${invalidAssetId} does not exist.`);
  const withAssets = relatedAssetIds.length
    ? {
      ...state,
      decisions: state.decisions.map((item) => item.id === decisionId
        ? { ...item, relatedAssetIds: [...new Set([...item.relatedAssetIds, ...relatedAssetIds])] }
        : item),
    }
    : state;
  return resolveAgentDecisionWithModelSelection(
    withAssets,
    decisionId,
    optionId,
    note,
    { userResponse: response, channel: "agent_chat" },
  );
}

export function exposeAgentSession(
  state: AgentSessionState,
  intent: string,
): AgentSessionState {
  const createdAt = now();
  return {
    ...state,
    connection: { status: "waiting" },
    controlMode: "agent",
    runStatus: "idle",
    brief: {
      ...state.brief,
      originalIntent: intent.trim(),
      goal: intent.trim(),
    },
    pausedReason: "Waiting for an external agent to claim this session.",
    activity: [...state.activity, {
      id: uid("activity"),
      createdAt,
      actor: "user",
      kind: "handover",
      title: "Published session for agent connection",
      detail: intent.trim() || "No initial intent was provided.",
    }],
    revision: state.revision + 1,
    updatedAt: createdAt,
  };
}

export function setControlMode(state: AgentSessionState, mode: ControlMode): AgentSessionState {
  if (state.controlMode === mode) return state;
  const createdAt = now();
  return {
    ...state,
    controlMode: mode,
    connection: mode === "human" ? state.connection : state.connection.status === "disconnected"
      ? { status: "waiting" }
      : state.connection,
    runStatus: mode === "human" ? "paused" : state.decisions.some((item) => item.status === "pending" && item.blocking) ? "waiting" : "working",
    pausedReason: mode === "human" ? "User took control." : undefined,
    activity: [...state.activity, {
      id: uid("activity"),
      createdAt,
      actor: "user",
      kind: "handover",
      title: mode === "human" ? "Control handed to user" : "Control handed to agent",
    }],
    revision: state.revision + 1,
    updatedAt: createdAt,
  };
}

export function recordAgentActivity(
  state: AgentSessionState,
  activity: Omit<AgentActivity, "id" | "createdAt">,
): AgentSessionState {
  const createdAt = now();
  return {
    ...state,
    activity: [...state.activity, { ...activity, id: uid("activity"), createdAt }],
    revision: state.revision + 1,
    updatedAt: createdAt,
  };
}

export function validateAgentState(state: AgentSessionState): string[] {
  const errors: string[] = [];
  const planIds = new Set(state.plan.map((item) => item.id));
  if (planIds.size !== state.plan.length) errors.push("Plan step IDs must be unique.");
  for (const step of state.plan) {
    if (step.dependsOn.some((id) => !planIds.has(id))) errors.push(`Plan step ${step.id} has an unknown dependency.`);
    if (step.dependsOn.includes(step.id)) errors.push(`Plan step ${step.id} cannot depend on itself.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    const step = state.plan.find((item) => item.id === stepId);
    const cyclic = Boolean(step?.dependsOn.some((dependency) => planIds.has(dependency) && hasCycle(dependency)));
    visiting.delete(stepId);
    visited.add(stepId);
    return cyclic;
  };
  if (state.plan.some((step) => hasCycle(step.id))) errors.push("Plan dependencies must not contain a cycle.");
  const activeSteps = state.plan.filter((step) => step.status === "in_progress" || step.status === "waiting");
  if (state.currentStepId && !planIds.has(state.currentStepId)) errors.push("The current plan step does not exist.");
  if (state.currentStepIds.some((id) => !planIds.has(id))) errors.push("An active plan step does not exist.");
  const activeIds = new Set(activeSteps.map((step) => step.id));
  if (state.currentStepIds.some((id) => !activeIds.has(id)) || activeSteps.some((step) => !state.currentStepIds.includes(step.id))) {
    errors.push("Active plan step IDs must match in-progress and waiting steps.");
  }
  const stepById = new Map(state.plan.map((step) => [step.id, step]));
  for (const step of state.plan) {
    if (["in_progress", "waiting", "completed"].includes(step.status)) {
      const incomplete = step.dependsOn.find((id) => !["completed", "skipped"].includes(stepById.get(id)?.status ?? ""));
      if (incomplete) errors.push(`Plan step ${step.id} cannot run before dependency ${incomplete} is complete.`);
    }
  }
  const artifactIds = new Set(state.artifacts.map((item) => item.assetId));
  const requestKeys = state.decisions.flatMap((item) => item.requestKey ? [item.requestKey] : []);
  if (new Set(requestKeys).size !== requestKeys.length) errors.push("Decision request keys must be unique.");
  for (const decision of state.decisions) {
    if (decision.relatedStepId && !planIds.has(decision.relatedStepId)) errors.push(`Decision ${decision.id} points to an unknown step.`);
    if (decision.relatedAssetIds.some((id) => !artifactIds.has(id))) errors.push(`Decision ${decision.id} points to an unknown asset.`);
    if (decision.options.some((option) => option.assetId && !artifactIds.has(option.assetId))) errors.push(`Decision ${decision.id} has an option for an unknown asset.`);
    if (decision.status === "resolved" && !decision.resolution) errors.push(`Decision ${decision.id} is resolved without a resolution record.`);
    if (decision.customSkillAction && (
      !decision.customSkillAction.name.trim()
      || decision.customSkillAction.version < 1
    )) {
      errors.push(`Decision ${decision.id} has an invalid Custom Skill action.`);
    }
  }
  if (state.imageGeneration.backend === "codex_builtin" && state.connection.agentHost !== "codex") {
    errors.push("Codex built-in image generation requires a Codex agent host.");
  }
  if (artifactIds.size !== state.artifacts.length) errors.push("An asset may appear only once in the artifact graph.");
  for (const artifact of state.artifacts) {
    if (artifact.parentAssetIds.includes(artifact.assetId)) errors.push(`Artifact ${artifact.assetId} cannot derive from itself.`);
    if (artifact.parentAssetIds.some((id) => !artifactIds.has(id))) errors.push(`Artifact ${artifact.assetId} has an unknown parent asset.`);
    if (artifact.planStepId && !planIds.has(artifact.planStepId)) errors.push(`Artifact ${artifact.assetId} points to an unknown plan step.`);
  }
  for (const clip of state.assembly.clips) {
    if (clip.startSeconds < 0 || clip.endSeconds <= clip.startSeconds) errors.push(`Assembly clip ${clip.id} has an invalid time range.`);
    if (!artifactIds.has(clip.assetId)) errors.push(`Assembly clip ${clip.id} points to an unknown asset.`);
  }
  if (state.execution) {
    if (state.execution.generationCount < 0 || state.execution.retryCount < 0 || state.execution.spentUsd < 0) {
      errors.push("Execution counters and cost must be non-negative.");
    }
    const costIds = new Set(state.execution.costLedger.map((entry) => entry.id));
    if (costIds.size !== state.execution.costLedger.length) errors.push("Actual cost entry IDs must be unique.");
    if (state.execution.costLedger.some((entry) => !entry.id || !Number.isFinite(entry.actualCostUsd) || entry.actualCostUsd < 0)) {
      errors.push("Actual cost entries must contain finite non-negative USD values.");
    }
    if (state.execution.spentUsd !== totalActualCostUsd(state.execution.costLedger)) {
      errors.push("Tracked spend must equal the actual cost ledger total.");
    }
  }
  return errors;
}

export function expectedVideoDurationSeconds(state: AgentSessionState): number | undefined {
  if (!state.brief.deliverable.toLocaleLowerCase().includes("video")) return undefined;
  const normalized = state.brief.outputSpec.toLocaleLowerCase();
  const minutes = normalized.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|분)\b/);
  if (minutes) return Number(minutes[1]) * 60;
  const seconds = normalized.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s|초)\b/);
  return seconds ? Number(seconds[1]) : undefined;
}

export function assemblyDurationSeconds(clips: VideoAssemblyClip[]): number {
  return clips.reduce((sum, clip) => sum + Math.max(0, clip.endSeconds - clip.startSeconds), 0);
}

export function validateAssemblyDuration(state: AgentSessionState, duration: number): string | null {
  if (!Number.isFinite(duration) || duration <= 0) return "The final assembly duration must be positive.";
  const expected = expectedVideoDurationSeconds(state);
  if (expected == null) return null;
  const tolerance = Math.max(0.1, Math.min(0.25, expected * 0.01));
  return Math.abs(duration - expected) <= tolerance
    ? null
    : `The final assembly is ${duration.toFixed(2)} seconds, but the confirmed output length is ${expected.toFixed(2)} seconds. Adjust the clip ranges before rendering.`;
}

export function validatePlanStepTransition(
  state: AgentSessionState,
  stepId: string,
  status: PlanStepStatus,
): string | null {
  const step = state.plan.find((item) => item.id === stepId);
  if (!step) return `Plan step ${stepId} does not exist.`;
  if (status === "in_progress" || status === "waiting" || status === "completed") {
    const stepById = new Map(state.plan.map((item) => [item.id, item]));
    const incomplete = step.dependsOn.find((id) => !["completed", "skipped"].includes(stepById.get(id)?.status ?? ""));
    if (incomplete) return `Plan step ${stepId} cannot run before dependency ${incomplete} is complete.`;
  }
  return null;
}

function canExtractCustomSkill(state: AgentSessionState): boolean {
  const hasVideoWork = state.assembly.clips.length > 0
    || state.assembly.outputAssetId != null
    || state.activity.some((item) => item.kind === "assembly");
  return hasVideoWork && state.brief.deliverable.toLocaleLowerCase().includes("video");
}

export function createCustomSkillDraft(state: AgentSessionState, name: string): CustomSkillDraft {
  if (!canExtractCustomSkill(state)) {
    throw new Error("Custom Skill extraction is available only after the session reaches video production.");
  }
  const userDecisions = state.decisions
    .filter((item) => item.status === "resolved")
    .map((item) => `- ${item.title}: ${item.options.find((option) => option.id === item.resolution?.optionId)?.label ?? item.resolution?.note ?? "confirmed"}`);
  const markdown = [
    "---",
    `name: ${name}`,
    "version: 1",
    "type: fruit-truck-custom",
    "---",
    "",
    `# ${name}`,
    "",
    "## Reusable direction",
    `- Visual approach: ${state.brief.visualApproach || "Follow the current user direction."}`,
    `- Output preference: ${state.brief.outputSpec || "Confirm for each session."}`,
    ...state.brief.mustAvoid.map((item) => `- Avoid: ${item}`),
    "",
    "## Decision preferences",
    ...(userDecisions.length ? userDecisions : ["- Ask before major visual, generated-media, and final-result checkpoints."]),
    "",
    "## Quality checks",
    "- Evaluate technical defects, aesthetic finish, requirement coverage, and identity consistency separately.",
    "- Preserve every source asset and record derivative relationships.",
  ].join("\n");
  return { name, version: 1, markdown, status: "proposed" };
}
