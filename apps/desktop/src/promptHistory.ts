import type { PromptEnhancementArtifact } from "./prompting/index.ts";
import type { PromptModel } from "./promptModels.ts";

export type PromptCheckpointKind = "manual" | "before_enhancement" | "enhancement_result";

export type PromptCheckpoint = {
  id: string;
  text: string;
  kind: PromptCheckpointKind;
  createdAt: string;
  enhancementAttemptId?: string;
  plannerModel?: PromptModel;
  reasoningEffort?: "high";
  inputHash?: string;
  outputHash?: string;
  negativePrompt?: string;
  enhancementArtifact?: PromptEnhancementArtifact;
  actualCostUsd?: number;
};

export type PromptHistory = {
  schemaVersion: 1;
  entries: PromptCheckpoint[];
  cursor: number;
  enhancementLocked: boolean;
  editRevision: number;
};

export type CheckpointMetadata = Omit<PromptCheckpoint, "id" | "text" | "kind" | "createdAt">;

export const MAX_PROMPT_CHECKPOINTS = 50;

export function initialPromptHistory(
  text = "",
  options: { id?: string; createdAt?: string; locked?: boolean } = {},
): PromptHistory {
  return {
    schemaVersion: 1,
    entries: [{
      id: options.id ?? crypto.randomUUID(),
      text,
      kind: "manual",
      createdAt: options.createdAt ?? new Date().toISOString(),
    }],
    cursor: 0,
    enhancementLocked: options.locked ?? false,
    editRevision: 0,
  };
}

export function currentPromptCheckpoint(
  prompt: string,
  history: PromptHistory,
): PromptCheckpoint | undefined {
  const entry = history.entries[history.cursor];
  return entry?.text === prompt ? entry : undefined;
}

/**
 * Returns planner provenance only while the selected result checkpoint still
 * owns the current draft context. The artifact signature describes the input
 * prompt sent to the planner, so it must not be recomputed from the enhanced
 * output prompt. New checkpoints therefore persist a separate output-context
 * hash. Draft context mutations both unlock the history and change that hash,
 * so even an explicit redo cannot revive provenance from a stale context.
 */
export function currentPromptEnhancementArtifact(
  prompt: string,
  history: PromptHistory,
  currentOutputHash?: string,
): PromptEnhancementArtifact | undefined {
  if (!history.enhancementLocked) return undefined;
  const checkpoint = currentPromptCheckpoint(prompt, history);
  if (checkpoint?.kind !== "enhancement_result" || !checkpoint.enhancementArtifact) return undefined;
  if (checkpoint.inputHash && checkpoint.inputHash !== checkpoint.enhancementArtifact.signature) return undefined;
  if (checkpoint.outputHash && checkpoint.outputHash !== currentOutputHash) return undefined;
  return checkpoint.enhancementArtifact;
}

export function canEnhancePrompt(input: {
  prompt: string;
  history: PromptHistory;
  enhancing: boolean;
  plannerAvailable: boolean;
  generationModelAvailable: boolean;
}): boolean {
  return input.prompt.trim().length > 0
    && !input.enhancing
    && !input.history.enhancementLocked
    && input.plannerAvailable
    && input.generationModelAvailable;
}

export function editPromptHistory(
  history: PromptHistory,
  _currentPrompt: string,
): PromptHistory {
  const cursor = clampedCursor(history);
  const entries = history.entries.slice(0, cursor + 1);
  return {
    ...history,
    entries,
    cursor,
    enhancementLocked: false,
    editRevision: history.editRevision + 1,
  };
}

export function invalidatePromptEnhancement(history: PromptHistory): PromptHistory {
  return history.enhancementLocked ? { ...history, enhancementLocked: false } : history;
}

export function beginPromptEnhancement(
  history: PromptHistory,
  prompt: string,
  input: {
    attemptId: string;
    plannerModel: PromptModel;
    inputHash?: string;
    id?: string;
    createdAt?: string;
  },
): PromptHistory {
  const sealed = sealManualPrompt(history, prompt, input.createdAt);
  const entries = sealed.entries.slice(0, sealed.cursor + 1);
  entries.push({
    id: input.id ?? crypto.randomUUID(),
    text: prompt,
    kind: "before_enhancement",
    createdAt: input.createdAt ?? new Date().toISOString(),
    enhancementAttemptId: input.attemptId,
    plannerModel: input.plannerModel,
    reasoningEffort: "high",
    inputHash: input.inputHash,
  });
  return trimPromptHistory({
    ...sealed,
    entries,
    cursor: entries.length - 1,
    enhancementLocked: true,
  }, new Set([input.attemptId]));
}

export function completePromptEnhancement(
  history: PromptHistory,
  currentPrompt: string,
  artifact: PromptEnhancementArtifact,
  input: {
    attemptId: string;
    plannerModel: PromptModel;
    autoApply: boolean;
    outputHash?: string;
    id?: string;
    createdAt?: string;
  },
): { history: PromptHistory; prompt: string } {
  let sealed = history;
  const selected = history.entries[clampedCursor(history)];
  if (!input.autoApply && selected?.text !== currentPrompt) {
    sealed = sealManualPrompt(history, currentPrompt, input.createdAt, new Set([input.attemptId]));
  }
  const entries = sealed.entries.slice(0, sealed.cursor + 1).map((entry) => (
    entry.enhancementAttemptId === input.attemptId && artifact.actualCostUsd != null
      ? { ...entry, actualCostUsd: artifact.actualCostUsd }
      : entry
  ));
  entries.push({
    id: input.id ?? crypto.randomUUID(),
    text: artifact.prompt,
    kind: "enhancement_result",
    createdAt: input.createdAt ?? new Date().toISOString(),
    enhancementAttemptId: input.attemptId,
    plannerModel: input.plannerModel,
    reasoningEffort: "high",
    inputHash: entries.find((entry) => (
      entry.kind === "before_enhancement" && entry.enhancementAttemptId === input.attemptId
    ))?.inputHash ?? artifact.signature,
    outputHash: input.outputHash,
    negativePrompt: artifact.negativePrompt,
    enhancementArtifact: structuredClone(artifact),
    actualCostUsd: artifact.actualCostUsd,
  });
  const resultCursor = entries.length - 1;
  const cursor = input.autoApply ? resultCursor : Math.max(0, resultCursor - 1);
  return {
    history: trimPromptHistory({
      ...sealed,
      entries,
      cursor,
      enhancementLocked: input.autoApply,
    }, new Set([input.attemptId])),
    prompt: input.autoApply ? artifact.prompt : currentPrompt,
  };
}

export function failPromptEnhancement(history: PromptHistory, attemptId: string): PromptHistory {
  const attemptIndex = history.entries.findIndex((entry) => (
    entry.kind === "before_enhancement" && entry.enhancementAttemptId === attemptId
  ));
  if (attemptIndex < 0) return { ...history, enhancementLocked: false };

  const before = history.entries[attemptIndex];
  const prior = history.entries[attemptIndex - 1];
  const syntheticManualIndex = prior?.kind === "manual"
    && prior.text === before.text
    && prior.createdAt === before.createdAt
    ? attemptIndex - 1
    : -1;
  const removedIndexes = new Set(history.entries.flatMap((entry, index) => (
    entry.enhancementAttemptId === attemptId || index === syntheticManualIndex ? [index] : []
  )));
  const entries = history.entries.filter((_, index) => !removedIndexes.has(index));
  const cursor = history.entries
    .slice(0, clampedCursor(history) + 1)
    .filter((_, index) => !removedIndexes.has(index)).length - 1;
  return {
    ...history,
    entries,
    cursor: Math.max(0, cursor),
    enhancementLocked: false,
  };
}

export function undoPromptEnhancement(
  history: PromptHistory,
  prompt: string,
): { history: PromptHistory; prompt: string } | undefined {
  const sealed = sealManualPrompt(history, prompt);
  if (sealed.cursor <= 0) return undefined;
  const cursor = sealed.cursor - 1;
  return {
    history: { ...sealed, cursor, enhancementLocked: true },
    prompt: sealed.entries[cursor].text,
  };
}

export function redoPromptEnhancement(
  history: PromptHistory,
): { history: PromptHistory; prompt: string } | undefined {
  const cursor = clampedCursor(history);
  if (cursor >= history.entries.length - 1) return undefined;
  const nextCursor = cursor + 1;
  return {
    history: { ...history, cursor: nextCursor, enhancementLocked: true },
    prompt: history.entries[nextCursor].text,
  };
}

export function promptHistoryCanUndo(history: PromptHistory, prompt: string): boolean {
  const entry = history.entries[clampedCursor(history)];
  return entry?.text !== prompt || clampedCursor(history) > 0;
}

export function promptHistoryCanRedo(history: PromptHistory, prompt: string): boolean {
  const cursor = clampedCursor(history);
  return history.entries[cursor]?.text === prompt && cursor < history.entries.length - 1;
}

export function sealManualPrompt(
  history: PromptHistory,
  prompt: string,
  createdAt = new Date().toISOString(),
  protectedAttemptIds: ReadonlySet<string> = new Set(),
): PromptHistory {
  const cursor = clampedCursor(history);
  const current = history.entries[cursor];
  if (current?.text === prompt) return { ...history, cursor };
  const entries = history.entries.slice(0, cursor + 1);
  entries.push(manualCheckpoint(prompt, createdAt));
  return trimPromptHistory({ ...history, entries, cursor: entries.length - 1 }, protectedAttemptIds);
}

export function trimPromptHistory(
  history: PromptHistory,
  protectedAttemptIds: ReadonlySet<string> = new Set(),
): PromptHistory {
  if (history.entries.length <= MAX_PROMPT_CHECKPOINTS) return history;
  const cursor = clampedCursor(history);
  const protectedIndexes = new Set([cursor]);
  history.entries.forEach((entry, index) => {
    if (entry.enhancementAttemptId && protectedAttemptIds.has(entry.enhancementAttemptId)) protectedIndexes.add(index);
  });
  const removableGroups = new Map<string, number[]>();
  history.entries.forEach((entry, index) => {
    const key = entry.enhancementAttemptId ? `attempt:${entry.enhancementAttemptId}` : `entry:${index}`;
    const indexes = removableGroups.get(key) ?? [];
    indexes.push(index);
    removableGroups.set(key, indexes);
  });
  const removed = new Set<number>();
  for (const indexes of removableGroups.values()) {
    if (history.entries.length - removed.size <= MAX_PROMPT_CHECKPOINTS) break;
    if (indexes.some((index) => protectedIndexes.has(index))) continue;
    indexes.forEach((index) => removed.add(index));
  }
  if (history.entries.length - removed.size > MAX_PROMPT_CHECKPOINTS) {
    for (let index = 0; index < history.entries.length; index += 1) {
      if (history.entries.length - removed.size <= MAX_PROMPT_CHECKPOINTS) break;
      if (!protectedIndexes.has(index)) removed.add(index);
    }
  }
  const entries = history.entries.filter((_, index) => !removed.has(index));
  const nextCursor = history.entries.slice(0, cursor + 1).filter((_, index) => !removed.has(index)).length - 1;
  return { ...history, entries, cursor: Math.max(0, nextCursor) };
}

function clampedCursor(history: PromptHistory): number {
  return Math.max(0, Math.min(history.cursor, history.entries.length - 1));
}

function manualCheckpoint(text: string, createdAt = new Date().toISOString()): PromptCheckpoint {
  return {
    id: crypto.randomUUID(),
    text,
    kind: "manual",
    createdAt,
  };
}
