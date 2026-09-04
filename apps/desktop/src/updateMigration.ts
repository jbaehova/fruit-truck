import {
  STUDIO_SCHEMA_VERSION,
  STUDIO_STORAGE_KEY,
  loadStudioStateWithRecovery,
  saveStudioState,
  type StudioState,
  type StudioStorage,
} from "./studio.ts";
import { migrateLegacyPromptModel } from "./promptModels.ts";

type JsonRecord = Record<string, unknown>;

export type UpdateStudioV7State = JsonRecord & {
  schemaVersion: 7;
  activeSessionId: string;
  sessions: JsonRecord[];
};

export type UpdateMigrationStep = "v6→v7" | "v7→v8";

export type UpdateMigrationReport = {
  fromVersion: 6 | 7 | 8;
  toVersion: 8;
  steps: UpdateMigrationStep[];
};

export type WorkspacePromptInvariant = {
  scope: string;
  texts: string[];
};

export type WorkspaceInvariantSnapshot = {
  sessionIds: string[];
  threadIds: string[];
  assetIds: string[];
  attemptIds: string[];
  enhancementAttemptIds: string[];
  costLedgerIds: string[];
  providerJobIds: string[];
  localPaths: string[];
  legacyPrompts: WorkspacePromptInvariant[];
  promptHistories: WorkspacePromptInvariant[];
};

export type WorkspaceInvariantReport = {
  sessionIdsEqual: boolean;
  threadIdsEqual: boolean;
  assetIdsEqual: boolean;
  attemptIdsEqual: boolean;
  enhancementAttemptIdsEqual: boolean;
  costLedgerIdsEqual: boolean;
  providerJobIdsEqual: boolean;
  localPathsEqual: boolean;
  legacyPromptsPreserved: boolean;
};

export type UpdateMigrationResult = {
  state: StudioState;
  migration: UpdateMigrationReport;
  invariants: WorkspaceInvariantReport;
};

export class UpdateMigrationError extends Error {
  readonly code: "unsupported_schema" | "invalid_workspace";
  readonly cause?: unknown;

  constructor(
    code: "unsupported_schema" | "invalid_workspace",
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "UpdateMigrationError";
    this.code = code;
    this.cause = cause;
  }
}

export class WorkspaceInvariantError extends Error {
  readonly report: WorkspaceInvariantReport;
  readonly failed: Array<keyof WorkspaceInvariantReport>;

  constructor(report: WorkspaceInvariantReport) {
    const failed = invariantFailures(report);
    super(`Update migration changed protected workspace data: ${failed.join(", ")}.`);
    this.name = "WorkspaceInvariantError";
    this.report = report;
    this.failed = failed;
  }
}

export type MutationLock = {
  active: boolean;
  reason?: "update";
  transactionId?: string;
};

export const WORKSPACE_MUTATION_LOCK_MESSAGE =
  "The workspace is locked while an update is being prepared.";

export function assertWorkspaceMutable(lock: MutationLock | null | undefined): void {
  if (lock?.active) throw new Error(WORKSPACE_MUTATION_LOCK_MESSAGE);
}

export function isWorkspaceMutationLocked(lock: MutationLock | null | undefined): boolean {
  return lock?.active === true;
}

export type ActiveUpdateOperationBlocker =
  | "generation_in_flight"
  | "enhancement_in_flight"
  | "result_materialization_pending"
  | "durable_save_pending"
  | "durable_save_failed";

export type ActiveUpdateOperationInputs = {
  state: Pick<StudioState, "sessions">;
  pendingMaterializations?: number;
  pendingMaterializationCount?: number;
  materializationInFlight?: boolean;
  pendingDurableSaves?: number;
  pendingDurableSaveCount?: number;
  durableSavePending?: boolean;
  durableSaveError?: unknown;
};

export type ActiveUpdateOperationGate = {
  allowed: boolean;
  activeOperationCount: number;
  activeAttemptCount: number;
  activeGenerationAttemptIds: string[];
  activeEnhancementAttemptIds: string[];
  pendingMaterializationCount: number;
  pendingDurableSaveCount: number;
  durableSaveFailed: boolean;
  blockers: ActiveUpdateOperationBlocker[];
  reason?: ActiveUpdateOperationBlocker;
};

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UpdateMigrationError("invalid_workspace", `${label} must be an object.`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new UpdateMigrationError("invalid_workspace", `${label} must be an array.`);
  }
  return value;
}

function asString(value: unknown, label: string, fallback?: string): string {
  if (typeof value === "string") return value;
  if (fallback !== undefined && (value === undefined || value === null)) return fallback;
  throw new UpdateMigrationError("invalid_workspace", `${label} must be a string.`);
}

function cloneRecord(value: unknown, label: string): JsonRecord {
  const record = asRecord(value, label);
  try {
    return structuredClone(record);
  } catch (error) {
    throw new UpdateMigrationError(
      "invalid_workspace",
      `${label} must contain cloneable workspace data.`,
      error,
    );
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function migrationCheckpointId(kind: "manual" | "enhancement-result", text: string): string {
  const input = `${kind}\u0000${text}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `phase2-${kind}-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function legacyArtifact(value: unknown, label: string): JsonRecord | undefined {
  if (value === undefined || value === null) return undefined;
  const artifact = asRecord(value, label);
  if (artifact.schemaVersion !== 1) {
    throw new UpdateMigrationError("invalid_workspace", `${label}.schemaVersion is unsupported.`);
  }
  asString(artifact.prompt, `${label}.prompt`);
  asString(artifact.plannerModel, `${label}.plannerModel`);
  asString(artifact.createdAt, `${label}.createdAt`);
  if (artifact.negativePrompt !== undefined && artifact.negativePrompt !== null) {
    asString(artifact.negativePrompt, `${label}.negativePrompt`);
  }
  if (artifact.actualCostUsd !== undefined
    && (typeof artifact.actualCostUsd !== "number" || !Number.isFinite(artifact.actualCostUsd))) {
    throw new UpdateMigrationError("invalid_workspace", `${label}.actualCostUsd must be finite.`);
  }
  return artifact;
}

function mappedPromptHistory(value: unknown, label: string): JsonRecord {
  const history = asRecord(value, label);
  const entries = asArray(history.entries, `${label}.entries`).map((value, index) => {
    const entry = asRecord(value, `${label}.entries[${index}]`);
    return entry.plannerModel === undefined || entry.plannerModel === null
      ? entry
      : { ...entry, plannerModel: migrateLegacyPromptModel(entry.plannerModel) };
  });
  return { ...history, entries };
}

function migratedPromptContainer(
  value: unknown,
  legacyEnhanceDefault: boolean,
  label: string,
): JsonRecord {
  const container = asRecord(value, label);
  const originalPrompt = asString(container.prompt, `${label}.prompt`, "");
  let prompt = originalPrompt;
  let promptHistory: JsonRecord;
  if (container.promptHistory !== undefined && container.promptHistory !== null) {
    promptHistory = mappedPromptHistory(container.promptHistory, `${label}.promptHistory`);
  } else {
    const enhancePrompt = container.enhancePrompt === undefined || container.enhancePrompt === null
      ? legacyEnhanceDefault
      : typeof container.enhancePrompt === "boolean"
        ? container.enhancePrompt
        : (() => {
          throw new UpdateMigrationError("invalid_workspace", `${label}.enhancePrompt must be a boolean.`);
        })();
    const enhancedPrompt = asString(
      container.enhancedPrompt,
      `${label}.enhancedPrompt`,
      "",
    );
    if (container.enhancedPromptDirty !== undefined
      && container.enhancedPromptDirty !== null
      && typeof container.enhancedPromptDirty !== "boolean") {
      throw new UpdateMigrationError(
        "invalid_workspace",
        `${label}.enhancedPromptDirty must be a boolean.`,
      );
    }
    if (container.enhancedVisualCount !== undefined
      && container.enhancedVisualCount !== null
      && (typeof container.enhancedVisualCount !== "number"
        || !Number.isFinite(container.enhancedVisualCount))) {
      throw new UpdateMigrationError(
        "invalid_workspace",
        `${label}.enhancedVisualCount must be finite.`,
      );
    }
    const artifact = legacyArtifact(
      container.enhancementArtifact,
      `${label}.enhancementArtifact`,
    );
    const entries: JsonRecord[] = [{
      id: migrationCheckpointId("manual", originalPrompt),
      text: originalPrompt,
      kind: "manual",
      createdAt: new Date(0).toISOString(),
    }];
    let cursor = 0;
    if (enhancedPrompt.trim()) {
      entries.push({
        id: migrationCheckpointId("enhancement-result", enhancedPrompt),
        text: enhancedPrompt,
        kind: "enhancement_result",
        createdAt: typeof artifact?.createdAt === "string"
          ? artifact.createdAt
          : new Date(0).toISOString(),
        plannerModel: migrateLegacyPromptModel(artifact?.plannerModel),
        reasoningEffort: "high",
        ...(typeof artifact?.negativePrompt === "string"
          ? { negativePrompt: artifact.negativePrompt }
          : {}),
        ...(artifact ? { enhancementArtifact: artifact } : {}),
        ...(typeof artifact?.actualCostUsd === "number"
          ? { actualCostUsd: artifact.actualCostUsd }
          : {}),
      });
      if (enhancePrompt) cursor = 1;
    }
    prompt = asString(entries[cursor].text, `${label}.promptHistory.entries[${cursor}].text`);
    promptHistory = {
      schemaVersion: 1,
      entries,
      cursor,
      enhancementLocked: cursor > 0,
      editRevision: 0,
    };
  }
  const {
    enhancePrompt: _enhancePrompt,
    enhancedPrompt: _enhancedPrompt,
    enhancedPromptDirty: _enhancedPromptDirty,
    enhancedVisualCount: _enhancedVisualCount,
    enhancementArtifact: _enhancementArtifact,
    promptHistory: _promptHistory,
    ...current
  } = container;
  return { ...current, prompt, promptHistory };
}

function linkEnhancementAttempt(
  historyValue: unknown,
  attemptsValue: unknown,
  legacyContainerValue: unknown,
  threadRevision: number,
  label: string,
): JsonRecord {
  const history = asRecord(historyValue, `${label}.promptHistory`);
  if (attemptsValue === undefined || attemptsValue === null) return history;
  const attempts = asArray(attemptsValue, `${label}.enhancementAttempts`).map((value, index) =>
    asRecord(value, `${label}.enhancementAttempts[${index}]`));
  const legacyContainer = asRecord(legacyContainerValue, `${label}.legacyPromptContainer`);
  const artifact = legacyContainer.enhancementArtifact === undefined
    || legacyContainer.enhancementArtifact === null
    ? undefined
    : asRecord(legacyContainer.enhancementArtifact, `${label}.legacyPromptContainer.enhancementArtifact`);
  const originalPrompt = typeof legacyContainer.prompt === "string"
    ? legacyContainer.prompt
    : undefined;
  const artifactPrompt = typeof artifact?.prompt === "string"
    ? artifact.prompt
    : undefined;
  const artifactSignature = typeof artifact?.signature === "string"
    ? artifact.signature
    : undefined;
  const artifactCreatedAt = typeof artifact?.createdAt === "string"
    ? artifact.createdAt
    : undefined;
  const artifactCost = typeof artifact?.actualCostUsd === "number"
    && Number.isFinite(artifact.actualCostUsd)
    ? artifact.actualCostUsd
    : undefined;
  const dirty = legacyContainer.enhancedPromptDirty === true;
  const completed = attempts.map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt }) => attempt.status === "completed" && typeof attempt.id === "string");

  const pickLatestRelated = (
    candidates: Array<{ attempt: JsonRecord; index: number }>,
  ): JsonRecord | undefined => {
    if (!candidates.length) return undefined;
    let narrowed = candidates;
    if (artifactCost !== undefined) {
      const sameCost = narrowed.filter(({ attempt }) => attempt.actualCostUsd === artifactCost);
      if (sameCost.length) narrowed = sameCost;
    }
    const artifactTime = artifactCreatedAt === undefined ? Number.NaN : Date.parse(artifactCreatedAt);
    if (Number.isFinite(artifactTime)) {
      const surrounding = narrowed.filter(({ attempt }) => {
        const startedAt = typeof attempt.createdAt === "string"
          ? Date.parse(attempt.createdAt)
          : Number.NaN;
        const finishedAt = typeof attempt.updatedAt === "string"
          ? Date.parse(attempt.updatedAt)
          : Number.NaN;
        return Number.isFinite(startedAt)
          && Number.isFinite(finishedAt)
          && startedAt <= artifactTime
          && artifactTime <= finishedAt;
      });
      if (surrounding.length) narrowed = surrounding;
      else {
        const dated = narrowed.map((candidate) => ({
          ...candidate,
          distance: typeof candidate.attempt.updatedAt === "string"
            ? Math.abs(Date.parse(candidate.attempt.updatedAt) - artifactTime)
            : Number.NaN,
        })).filter((candidate) => Number.isFinite(candidate.distance));
        if (dated.length) {
          const nearest = Math.min(...dated.map(({ distance }) => distance));
          narrowed = dated.filter(({ distance }) => distance === nearest);
        }
      }
    }
    const revisionOrdered = narrowed.filter(({ attempt }) =>
      typeof attempt.threadRevision === "number"
      && Number.isFinite(attempt.threadRevision)
      && attempt.threadRevision <= threadRevision);
    if (revisionOrdered.length) {
      const closestRevision = Math.max(...revisionOrdered.map(({ attempt }) =>
        attempt.threadRevision as number));
      narrowed = revisionOrdered.filter(({ attempt }) => attempt.threadRevision === closestRevision);
    }
    const dated = narrowed.map((candidate) => ({
      ...candidate,
      updatedAt: typeof candidate.attempt.updatedAt === "string"
        ? Date.parse(candidate.attempt.updatedAt)
        : Number.NaN,
    })).filter((candidate) => Number.isFinite(candidate.updatedAt));
    if (dated.length) {
      const target = Number.isFinite(artifactTime)
        ? Math.min(...dated.map(({ updatedAt }) => Math.abs(updatedAt - artifactTime)))
        : Math.max(...dated.map(({ updatedAt }) => updatedAt));
      narrowed = dated.filter(({ updatedAt }) => Number.isFinite(artifactTime)
        ? Math.abs(updatedAt - artifactTime) === target
        : updatedAt === target);
    }
    return narrowed.at(-1)?.attempt;
  };

  const matchingAttempt = (entry: JsonRecord): JsonRecord | undefined => {
    const exactVisible = completed.filter(({ attempt }) => attempt.enhancedPrompt === entry.text);
    const sameOriginal = completed.filter(({ attempt }) =>
      originalPrompt !== undefined && attempt.originalPrompt === originalPrompt);
    const sameArtifactPrompt = completed.filter(({ attempt }) =>
      artifactPrompt !== undefined && attempt.enhancedPrompt === artifactPrompt);
    const sameArtifactRequest = completed.filter(({ attempt }) =>
      artifactSignature !== undefined && attempt.requestKey === artifactSignature);
    const intersection = (
      first: Array<{ attempt: JsonRecord; index: number }>,
      ...rest: Array<Array<{ attempt: JsonRecord; index: number }>>
    ) => first.filter((candidate) => rest.every((group) => group.some(({ index }) => index === candidate.index)));
    // A dirty legacy result owns its edited visible text, while the immutable
    // attempt output remains in artifact.prompt. Prefer that provenance over a
    // coincidental exact-text match and never rewrite either stored prompt.
    const tiers = dirty
      ? [
        intersection(sameArtifactRequest, sameArtifactPrompt, sameOriginal),
        intersection(sameArtifactRequest, sameArtifactPrompt),
        intersection(sameArtifactPrompt, sameOriginal),
        intersection(sameArtifactRequest, sameOriginal),
        intersection(exactVisible, sameOriginal),
        exactVisible,
      ]
      : [
        intersection(exactVisible, sameArtifactRequest, sameOriginal),
        intersection(exactVisible, sameOriginal),
        intersection(exactVisible, sameArtifactRequest),
        exactVisible,
        intersection(sameArtifactRequest, sameArtifactPrompt, sameOriginal),
        intersection(sameArtifactPrompt, sameOriginal),
      ];
    const strongest = tiers.find((tier) => tier.length > 0);
    if (strongest) return pickLatestRelated(strongest);
    return dirty && sameOriginal.length === 1
      ? sameOriginal[0].attempt
      : undefined;
  };

  const entries = asArray(history.entries, `${label}.promptHistory.entries`).map((value, index) => {
    const entry = asRecord(value, `${label}.promptHistory.entries[${index}]`);
    if (entry.kind !== "enhancement_result"
      || typeof entry.id !== "string"
      || !entry.id.startsWith("phase2-enhancement-result-")
      || entry.enhancementAttemptId !== undefined) return entry;
    const attempt = matchingAttempt(entry);
    if (!attempt || typeof attempt.id !== "string") return entry;
    return {
      ...entry,
      enhancementAttemptId: attempt.id,
      createdAt: entry.createdAt === new Date(0).toISOString()
        && typeof attempt.updatedAt === "string"
        ? attempt.updatedAt
        : entry.createdAt,
      ...(entry.actualCostUsd === undefined && typeof attempt.actualCostUsd === "number"
        ? { actualCostUsd: attempt.actualCostUsd }
        : {}),
    };
  });
  return { ...history, entries };
}

function migratedThread(
  value: unknown,
  legacyEnhanceDefault: boolean,
  label: string,
): JsonRecord {
  const thread = asRecord(value, label);
  const draft = migratedPromptContainer(thread.draft, legacyEnhanceDefault, `${label}.draft`);
  const attempts = asArray(thread.attempts, `${label}.attempts`).map((value, index) => {
    const attempt = asRecord(value, `${label}.attempts[${index}]`);
    if (attempt.snapshot === undefined || attempt.snapshot === null) return attempt;
    const snapshot = migratedPromptContainer(
      attempt.snapshot,
      legacyEnhanceDefault,
      `${label}.attempts[${index}].snapshot`,
    );
    return {
      ...attempt,
      snapshot: {
        ...snapshot,
        promptHistory: linkEnhancementAttempt(
          snapshot.promptHistory,
          thread.enhancementAttempts,
          attempt.snapshot,
          typeof attempt.draftRevision === "number" && Number.isFinite(attempt.draftRevision)
            ? attempt.draftRevision
            : 0,
          `${label}.attempts[${index}].snapshot`,
        ),
      },
    };
  });
  return {
    ...thread,
    draft: {
      ...draft,
      promptHistory: linkEnhancementAttempt(
        draft.promptHistory,
        thread.enhancementAttempts,
        thread.draft,
        typeof thread.revision === "number" && Number.isFinite(thread.revision)
          ? thread.revision
          : 0,
        label,
      ),
    },
    attempts,
  };
}

function migratedSessions(value: unknown, legacyEnhanceDefault: boolean): JsonRecord[] {
  return asArray(value, "studio.sessions").map((value, sessionIndex) => {
    const session = asRecord(value, `studio.sessions[${sessionIndex}]`);
    const threads = asRecord(session.threads, `studio.sessions[${sessionIndex}].threads`);
    const migrateMode = (mode: "image" | "video") =>
      asArray(threads[mode], `studio.sessions[${sessionIndex}].threads.${mode}`)
        .map((thread, threadIndex) => migratedThread(
          thread,
          legacyEnhanceDefault,
          `studio.sessions[${sessionIndex}].threads.${mode}[${threadIndex}]`,
        ));
    return {
      ...session,
      threads: {
        ...threads,
        image: migrateMode("image"),
        video: migrateMode("video"),
      },
    };
  });
}

function validateV8State(value: JsonRecord): StudioState {
  const candidate = value as StudioState;
  const entries = new Map<string, string>();
  const storage: StudioStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, stored) => entries.set(key, stored),
    removeItem: (key) => entries.delete(key),
  };
  try {
    saveStudioState(candidate, {
      storage,
      now: () => new Date(0),
    });
  } catch (error) {
    throw new UpdateMigrationError(
      "invalid_workspace",
      `Migrated Studio v${STUDIO_SCHEMA_VERSION} state failed validation.`,
      error,
    );
  }
  if (!entries.has(STUDIO_STORAGE_KEY)) {
    throw new UpdateMigrationError(
      "invalid_workspace",
      `Migrated Studio v${STUDIO_SCHEMA_VERSION} state was not serializable.`,
    );
  }
  const exhaustiveEntries = new Map<string, string>();
  try {
    exhaustiveEntries.set(STUDIO_STORAGE_KEY, JSON.stringify(candidate));
    const validation = loadStudioStateWithRecovery({
      storage: {
        getItem: (key) => exhaustiveEntries.get(key) ?? null,
        setItem: (key, stored) => exhaustiveEntries.set(key, stored),
        removeItem: (key) => exhaustiveEntries.delete(key),
        get length() { return exhaustiveEntries.size; },
        key: (index) => [...exhaustiveEntries.keys()][index] ?? null,
      },
      now: () => new Date(0),
    });
    if (validation.recovery.requiresUserAction || validation.state.schemaVersion !== 8) {
      throw new Error(validation.recovery.error ?? validation.recovery.reason
        ?? "Studio validation entered recovery mode.");
    }
  } catch (error) {
    if (error instanceof UpdateMigrationError) throw error;
    throw new UpdateMigrationError(
      "invalid_workspace",
      `Migrated Studio v${STUDIO_SCHEMA_VERSION} state failed exhaustive validation.`,
      error,
    );
  }
  return candidate;
}

function checkedSchema(value: unknown): 6 | 7 | 8 {
  const state = asRecord(value, "studio");
  if (state.schemaVersion === 6 || state.schemaVersion === 7 || state.schemaVersion === 8) {
    return state.schemaVersion;
  }
  throw new UpdateMigrationError(
    "unsupported_schema",
    `Unsupported update Studio schema ${String(state.schemaVersion)}.`,
  );
}

export function migrateV6ToV7(value: unknown): UpdateStudioV7State {
  if (checkedSchema(value) !== 6) {
    throw new UpdateMigrationError("unsupported_schema", "migrateV6ToV7 requires Studio schema 6.");
  }
  const state = cloneRecord(value, "studio");
  const legacyEnhanceDefault = typeof state.defaultEnhancePrompt === "boolean"
    ? state.defaultEnhancePrompt
    : true;
  const { defaultEnhancePrompt: _defaultEnhancePrompt, ...current } = state;
  const migrated = {
    ...current,
    schemaVersion: 7 as const,
    activeSessionId: asString(state.activeSessionId, "studio.activeSessionId"),
    promptModel: migrateLegacyPromptModel(state.promptModel),
    sessions: migratedSessions(state.sessions, legacyEnhanceDefault),
  } satisfies UpdateStudioV7State;
  // Running the next step is a read-only validation of the intermediate v7 shape.
  migrateV7ToV8(migrated);
  assertWorkspaceInvariants(value, migrated);
  return migrated;
}

export function migrateV7ToV8(value: unknown): StudioState {
  if (checkedSchema(value) !== 7) {
    throw new UpdateMigrationError("unsupported_schema", "migrateV7ToV8 requires Studio schema 7.");
  }
  const state = cloneRecord(value, "studio");
  const { defaultEnhancePrompt: _defaultEnhancePrompt, ...current } = state;
  const migrated = {
    ...current,
    schemaVersion: STUDIO_SCHEMA_VERSION,
    promptModel: migrateLegacyPromptModel(state.promptModel),
    sessions: migratedSessions(state.sessions, true),
    directorPresets: state.directorPresets ?? [],
  } as JsonRecord;
  const validated = validateV8State(migrated);
  assertWorkspaceInvariants(value, validated);
  return validated;
}

export function migrateStudioForUpdate(value: unknown): UpdateMigrationResult {
  const fromVersion = checkedSchema(value);
  const before = collectWorkspaceInvariants(value);
  let current: unknown = value;
  const steps: UpdateMigrationStep[] = [];
  while (checkedSchema(current) < STUDIO_SCHEMA_VERSION) {
    const version = checkedSchema(current);
    switch (version) {
      case 6:
        current = migrateV6ToV7(current);
        steps.push("v6→v7");
        break;
      case 7:
        current = migrateV7ToV8(current);
        steps.push("v7→v8");
        break;
      default:
        throw new UpdateMigrationError(
          "unsupported_schema",
          `Unsupported update Studio schema ${String(version)}.`,
        );
    }
  }
  const state = checkedSchema(current) === STUDIO_SCHEMA_VERSION
    ? validateV8State(cloneRecord(current, "studio"))
    : (() => {
      throw new UpdateMigrationError("invalid_workspace", "Update migration did not reach Studio v8.");
    })();
  const invariants = compareWorkspaceInvariants(before, collectWorkspaceInvariants(state));
  if (!workspaceInvariantsHold(invariants)) throw new WorkspaceInvariantError(invariants);
  return {
    state,
    migration: { fromVersion, toVersion: STUDIO_SCHEMA_VERSION, steps },
    invariants,
  };
}

export const migrateUpdateStudioState = migrateStudioForUpdate;

function collectPromptInvariants(
  containerValue: unknown,
  scope: string,
  legacyPrompts: WorkspacePromptInvariant[],
  promptHistories: WorkspacePromptInvariant[],
): void {
  const container = asRecord(containerValue, scope);
  if ("enhancedPrompt" in container || "enhancePrompt" in container) {
    const original = asString(container.prompt, `${scope}.prompt`, "");
    const enhanced = asString(container.enhancedPrompt, `${scope}.enhancedPrompt`, "");
    legacyPrompts.push({
      scope,
      texts: uniqueSorted([original, ...(enhanced.trim() ? [enhanced] : [])]),
    });
  }
  if (container.promptHistory === undefined || container.promptHistory === null) return;
  const history = asRecord(container.promptHistory, `${scope}.promptHistory`);
  const texts = asArray(history.entries, `${scope}.promptHistory.entries`).map((value, index) => {
    const entry = asRecord(value, `${scope}.promptHistory.entries[${index}]`);
    return asString(entry.text, `${scope}.promptHistory.entries[${index}].text`);
  });
  promptHistories.push({ scope, texts: uniqueSorted(texts) });
}

export function collectWorkspaceInvariants(value: unknown): WorkspaceInvariantSnapshot {
  const state = asRecord(value, "studio");
  const sessionIds: string[] = [];
  const threadIds: string[] = [];
  const assetIds: string[] = [];
  const attemptIds: string[] = [];
  const enhancementAttemptIds: string[] = [];
  const costLedgerIds: string[] = [];
  const providerJobIds: string[] = [];
  const localPaths: string[] = [];
  const legacyPrompts: WorkspacePromptInvariant[] = [];
  const promptHistories: WorkspacePromptInvariant[] = [];
  asArray(state.sessions, "studio.sessions").forEach((sessionValue, sessionIndex) => {
    const session = asRecord(sessionValue, `studio.sessions[${sessionIndex}]`);
    const sessionId = asString(session.id, `studio.sessions[${sessionIndex}].id`);
    sessionIds.push(sessionId);
    asArray(session.assets, `session ${sessionId}.assets`).forEach((assetValue, assetIndex) => {
      const asset = asRecord(assetValue, `session ${sessionId}.assets[${assetIndex}]`);
      assetIds.push(asString(asset.id, `session ${sessionId}.assets[${assetIndex}].id`));
      if (typeof asset.localPath === "string") localPaths.push(asset.localPath);
      else if (typeof asset.externalUrl === "string"
        && /^(?:\/|[A-Za-z]:[\\/])/.test(asset.externalUrl)) localPaths.push(asset.externalUrl);
      if (typeof asset.jobId === "string" && asset.jobId) providerJobIds.push(asset.jobId);
    });
    asArray(session.costLedger, `session ${sessionId}.costLedger`).forEach((entryValue, index) => {
      const entry = asRecord(entryValue, `session ${sessionId}.costLedger[${index}]`);
      costLedgerIds.push(asString(entry.id, `session ${sessionId}.costLedger[${index}].id`));
    });
    if (session.activeVideoJobs !== undefined && session.activeVideoJobs !== null) {
      asArray(session.activeVideoJobs, `session ${sessionId}.activeVideoJobs`)
        .forEach((jobValue, index) => {
          const job = asRecord(jobValue, `session ${sessionId}.activeVideoJobs[${index}]`);
          if (typeof job.jobId === "string" && job.jobId) providerJobIds.push(job.jobId);
        });
    }
    const threads = asRecord(session.threads, `session ${sessionId}.threads`);
    for (const mode of ["image", "video"] as const) {
      asArray(threads[mode], `session ${sessionId}.threads.${mode}`)
        .forEach((threadValue, threadIndex) => {
          const thread = asRecord(
            threadValue,
            `session ${sessionId}.threads.${mode}[${threadIndex}]`,
          );
          const threadId = asString(
            thread.id,
            `session ${sessionId}.threads.${mode}[${threadIndex}].id`,
          );
          threadIds.push(threadId);
          collectPromptInvariants(
            thread.draft,
            `${sessionId}/${mode}/${threadId}/draft`,
            legacyPrompts,
            promptHistories,
          );
          asArray(thread.attempts, `thread ${threadId}.attempts`)
            .forEach((attemptValue, attemptIndex) => {
              const attempt = asRecord(attemptValue, `thread ${threadId}.attempts[${attemptIndex}]`);
              const attemptId = asString(
                attempt.id,
                `thread ${threadId}.attempts[${attemptIndex}].id`,
              );
              attemptIds.push(attemptId);
              if (typeof attempt.jobId === "string" && attempt.jobId) {
                providerJobIds.push(attempt.jobId);
              }
              if (attempt.snapshot !== undefined && attempt.snapshot !== null) {
                collectPromptInvariants(
                  attempt.snapshot,
                  `${sessionId}/${mode}/${threadId}/attempt/${attemptId}/snapshot`,
                  legacyPrompts,
                  promptHistories,
                );
              }
            });
          if (thread.enhancementAttempts !== undefined && thread.enhancementAttempts !== null) {
            asArray(thread.enhancementAttempts, `thread ${threadId}.enhancementAttempts`)
              .forEach((attemptValue, attemptIndex) => {
                const attempt = asRecord(
                  attemptValue,
                  `thread ${threadId}.enhancementAttempts[${attemptIndex}]`,
                );
                enhancementAttemptIds.push(asString(
                  attempt.id,
                  `thread ${threadId}.enhancementAttempts[${attemptIndex}].id`,
                ));
              });
          }
        });
    }
  });
  return {
    sessionIds: uniqueSorted(sessionIds),
    threadIds: uniqueSorted(threadIds),
    assetIds: uniqueSorted(assetIds),
    attemptIds: uniqueSorted(attemptIds),
    enhancementAttemptIds: uniqueSorted(enhancementAttemptIds),
    costLedgerIds: uniqueSorted(costLedgerIds),
    providerJobIds: uniqueSorted(providerJobIds),
    localPaths: uniqueSorted(localPaths),
    legacyPrompts: [...legacyPrompts].sort((left, right) => left.scope.localeCompare(right.scope)),
    promptHistories: [...promptHistories].sort((left, right) => left.scope.localeCompare(right.scope)),
  };
}

function equalStringSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function compareWorkspaceInvariants(
  before: WorkspaceInvariantSnapshot,
  after: WorkspaceInvariantSnapshot,
): WorkspaceInvariantReport {
  const afterHistories = new Map(after.promptHistories.map((history) => [history.scope, history.texts]));
  return {
    sessionIdsEqual: equalStringSets(before.sessionIds, after.sessionIds),
    threadIdsEqual: equalStringSets(before.threadIds, after.threadIds),
    assetIdsEqual: equalStringSets(before.assetIds, after.assetIds),
    attemptIdsEqual: equalStringSets(before.attemptIds, after.attemptIds),
    enhancementAttemptIdsEqual: equalStringSets(
      before.enhancementAttemptIds,
      after.enhancementAttemptIds,
    ),
    costLedgerIdsEqual: equalStringSets(before.costLedgerIds, after.costLedgerIds),
    providerJobIdsEqual: equalStringSets(before.providerJobIds, after.providerJobIds),
    localPathsEqual: equalStringSets(before.localPaths, after.localPaths),
    legacyPromptsPreserved: before.legacyPrompts.every((requirement) => {
      const history = afterHistories.get(requirement.scope);
      return history !== undefined && requirement.texts.every((text) => history.includes(text));
    }) && before.promptHistories.every((requirement) => {
      const history = afterHistories.get(requirement.scope);
      return history !== undefined && equalStringSets(requirement.texts, history);
    }),
  };
}

export function verifyWorkspaceInvariants(
  before: unknown,
  after: unknown,
): WorkspaceInvariantReport {
  return compareWorkspaceInvariants(
    collectWorkspaceInvariants(before),
    collectWorkspaceInvariants(after),
  );
}

export function invariantFailures(
  report: WorkspaceInvariantReport,
): Array<keyof WorkspaceInvariantReport> {
  return (Object.keys(report) as Array<keyof WorkspaceInvariantReport>)
    .filter((key) => !report[key]);
}

export function workspaceInvariantsHold(report: WorkspaceInvariantReport): boolean {
  return invariantFailures(report).length === 0;
}

export function assertWorkspaceInvariants(
  before: unknown,
  after: unknown,
): WorkspaceInvariantReport {
  const report = verifyWorkspaceInvariants(before, after);
  if (!workspaceInvariantsHold(report)) throw new WorkspaceInvariantError(report);
  return report;
}

function pendingCount(...values: Array<number | boolean | undefined>): number {
  return values.reduce<number>((count, value) => {
    if (value === true) return Math.max(count, 1);
    if (typeof value !== "number" || !Number.isFinite(value)) return count;
    return Math.max(count, Math.max(0, Math.floor(value)));
  }, 0);
}

export function inspectActiveUpdateOperations(
  input: ActiveUpdateOperationInputs,
): ActiveUpdateOperationGate {
  const generationIds = new Set<string>();
  const enhancementIds = new Set<string>();
  for (const session of input.state.sessions) {
    for (const mode of ["image", "video"] as const) {
      for (const thread of session.threads[mode]) {
        for (const attempt of thread.attempts) {
          if (attempt.status === "submitting" || attempt.status === "in_progress") {
            generationIds.add(attempt.id);
          } else if (attempt.status === "enhancing") {
            enhancementIds.add(attempt.id);
          }
        }
        for (const attempt of thread.enhancementAttempts ?? []) {
          if (attempt.status === "in_progress" || attempt.status === "uncertain") {
            enhancementIds.add(attempt.id);
          }
        }
      }
    }
  }
  const activeGenerationAttemptIds = uniqueSorted(generationIds);
  const activeEnhancementAttemptIds = uniqueSorted(enhancementIds);
  const pendingMaterializationCount = pendingCount(
    input.pendingMaterializations,
    input.pendingMaterializationCount,
    input.materializationInFlight,
  );
  const pendingDurableSaveCount = pendingCount(
    input.pendingDurableSaves,
    input.pendingDurableSaveCount,
    input.durableSavePending,
  );
  const durableSaveFailed = input.durableSaveError !== undefined
    && input.durableSaveError !== null;
  const blockers: ActiveUpdateOperationBlocker[] = [];
  if (activeGenerationAttemptIds.length > 0) blockers.push("generation_in_flight");
  if (activeEnhancementAttemptIds.length > 0) blockers.push("enhancement_in_flight");
  if (pendingMaterializationCount > 0) blockers.push("result_materialization_pending");
  if (durableSaveFailed) blockers.push("durable_save_failed");
  else if (pendingDurableSaveCount > 0) blockers.push("durable_save_pending");
  const activeAttemptCount = activeGenerationAttemptIds.length
    + activeEnhancementAttemptIds.length;
  return {
    allowed: blockers.length === 0,
    activeOperationCount: activeAttemptCount + pendingMaterializationCount,
    activeAttemptCount,
    activeGenerationAttemptIds,
    activeEnhancementAttemptIds,
    pendingMaterializationCount,
    pendingDurableSaveCount,
    durableSaveFailed,
    blockers,
    reason: blockers[0],
  };
}

export function activeUpdateOperationCount(state: Pick<StudioState, "sessions">): number {
  return inspectActiveUpdateOperations({ state }).activeAttemptCount;
}

export const evaluateActiveUpdateOperationGate = inspectActiveUpdateOperations;
