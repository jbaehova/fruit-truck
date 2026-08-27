import type {
  DraftOptions,
  GenerationModel,
  GenerationMode,
  ReferenceCoverage,
  ReferenceRole,
  VideoResult,
} from "./openrouter.ts";
import { defaultOptions, isTauriRuntime } from "./openrouter.ts";
import {
  defaultReferencePurpose,
  type PromptEnhancementArtifact,
  type ReferencePurpose,
} from "./prompting/index.ts";
import { migrateLegacyInputMentions } from "./inputMentions.ts";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type AssetKind = "image" | "video" | "audio";
export type AssetOrigin = "upload" | "generated" | "edited";
export type PromptModel = "openai/gpt-5.6-luna" | "openai/gpt-5.6-terra";
export type VideoWorkflow = "generate" | "edit";

export type SessionAssetDerivation = {
  /** The original asset remains immutable; this describes a separately stored derivative. */
  kind: "resize" | "crop" | "resize_crop";
  sourceAssetId: string;
  resolution?: string;
  aspectRatio?: string;
  createdAt: string;
};

export type SessionAsset = {
  id: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
  origin: AssetOrigin;
  createdAt: string;
  localPath?: string;
  blobKey?: string;
  externalUrl?: string;
  jobId?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  facePresence?: "present" | "absent" | "unknown";
  byteSize?: number;
  fingerprint?: string;
  bridgeAvailability?: "available" | "desktop_only";
  storageAvailability?: "available" | "missing";
  sourceUrl?: string;
  sourcePageUrl?: string;
  license?: string;
  derivation?: SessionAssetDerivation;
};

export type DraftReference = {
  assetId: string;
  slot: number;
  role: ReferenceRole;
  purpose: ReferencePurpose;
  purposeBeforeEdit?: ReferencePurpose;
};

export type MaskPoint = {
  x: number;
  y: number;
};

export type MaskStroke = {
  points: MaskPoint[];
  size: number;
  operation?: "paint" | "erase";
};

export type GenerationDraftState = {
  prompt: string;
  references: DraftReference[];
  options: DraftOptions;
  providerJson: string;
  enhancePrompt: boolean;
  enhancedPrompt: string;
  enhancedPromptDirty: boolean;
  enhancedVisualCount: number;
  enhancementArtifact?: PromptEnhancementArtifact;
  imageEditMode: boolean;
  imageEditTarget: string;
  maskInstructions: string;
  maskStrokes: MaskStroke[];
};

export type SessionVideoJob = VideoResult & {
  threadId?: string;
  attemptId?: string;
  workflow?: VideoWorkflow;
  model: string;
  submittedAt: string;
  pollAttempts?: number;
  lastPolledAt?: string;
  nextPollAt?: string;
  request: Record<string, unknown>;
  inputAssetIds?: string[];
};

export type GenerationAttemptStatus =
  | "enhancing"
  | "submitting"
  | "in_progress"
  | "completed"
  | "failed"
  | "uncertain"
  | "canceled";

export type GenerationAttemptRecovery = {
  classification: "video_job_resumable" | "submission_uncertain" | "enhancement_interrupted";
  previousStatus: string;
  classifiedAt: string;
  resumable: boolean;
  retryable: boolean;
};

export type GenerationAttemptSnapshot = {
  mode: GenerationMode;
  modelId: string;
  /** Retained from the v5 snapshot contract; v6 derives this from mode. */
  outputRole?: string;
  prompt: string;
  enhancePrompt: boolean;
  enhancedPrompt: string;
  enhancementArtifact?: PromptEnhancementArtifact;
  options: DraftOptions;
  providerJson: string;
  assetBindings: DraftReference[];
  imageEditMode: boolean;
  imageEditTarget: string;
  maskInstructions: string;
  maskStrokes: MaskStroke[];
  referenceCoverage?: ReferenceCoverage[];
  videoWorkflow?: VideoWorkflow;
};

export type GenerationAttempt = {
  id: string;
  status: GenerationAttemptStatus;
  draftRevision: number;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  completedAt?: string;
  modelId?: string;
  snapshot?: GenerationAttemptSnapshot;
  enhancedPrompt?: string;
  request?: Record<string, unknown>;
  inputAssetIds: string[];
  assetIds: string[];
  /** Durable provider result handles/managed paths captured before UI materialization. */
  resultSources?: string[];
  recoveryPath?: string;
  jobId?: string;
  progress?: number;
  pollAttempts?: number;
  lastPolledAt?: string;
  nextPollAt?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  costRecordedAt?: string;
  cancelRequestedAt?: string;
  error?: string;
  errorCode?: string;
  errorAction?: string;
  errorDetails?: string;
  /** Fields retained from the v5 attempt contract while older workspaces migrate. */
  requestKey?: string;
  backend?: "openrouter" | "codex_builtin" | string;
  requestedBy?: "human" | "agent" | string;
  workflow?: VideoWorkflow;
  recovery?: GenerationAttemptRecovery;
};

export type PromptEnhancementAttempt = {
  id: string;
  requestKey: string;
  status: "in_progress" | "completed" | "failed" | "uncertain";
  threadRevision: number;
  originalPrompt: string;
  enhancedPrompt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  actualCostUsd?: number;
  costRecordedAt?: string;
  errorCode?: string;
  errorAction?: string;
  recovery?: GenerationAttemptRecovery;
};

export type GenerationThread = {
  id: string;
  /** Retained from v5 request deduplication metadata. */
  requestKey?: string;
  name: string;
  mode: GenerationMode;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  revision: number;
  /** Retained from v5's explicit output role metadata. */
  outputRole?: string;
  modelOverrideId?: string;
  optionOverrides: DraftOptions;
  providerJsonOverride?: string;
  draft: GenerationDraftState;
  attempts: GenerationAttempt[];
  /** Retained when importing v1-v5's generate/edit video workflow split. */
  videoWorkflow?: VideoWorkflow;
  /** Retained for v5 workspaces; v6 generation uses attempt snapshots. */
  enhancementAttempts?: PromptEnhancementAttempt[];
};

export type SessionCostEntry = {
  id: string;
  category: "generation" | "prompt_enhancement";
  actualCostUsd: number;
  recordedAt: string;
};

export type GenerationDefaults = {
  modelIds: Record<GenerationMode, string>;
  options: Record<GenerationMode, DraftOptions>;
  providerJson: Record<GenerationMode, string>;
};

export type GenerationPreset = {
  id: string;
  name: string;
  mode: GenerationMode;
  modelId: string;
  options: DraftOptions;
  providerJson: string;
  createdAt: string;
  updatedAt: string;
};

export type StudioSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: GenerationMode;
  assets: SessionAsset[];
  generationDefaults: GenerationDefaults;
  threads: Record<GenerationMode, GenerationThread[]>;
  activeThreadIds: Record<GenerationMode, string>;
  costLedger: SessionCostEntry[];
  /** v5 carried agent execution state; keep it opaque so migrations remain lossless. */
  agent?: Record<string, unknown>;
  agentBridge?: boolean;
};

export type StudioState = {
  schemaVersion: 6;
  activeSessionId: string;
  promptModel: PromptModel;
  defaultEnhancePrompt: boolean;
  sessions: StudioSession[];
  generationPresets?: GenerationPreset[];
  /** Ephemeral startup/persistence diagnostics; never serialized. */
  recovery?: StudioRecoveryState;
};

export type StudioStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
};

/** Async shape for a future SQLite/WAL or atomic native-file implementation. */
export type StudioNativeStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
  listKeys?(): Promise<readonly string[]>;
};

export type StudioRecoveryKind =
  | "fresh"
  | "loaded"
  | "migrated"
  | "recovered_last_known_good"
  | "corrupt"
  | "unsupported"
  | "migration_failed"
  | "write_failed";

export type StartupAttemptRecovery = GenerationAttemptRecovery & {
  sessionId: string;
  threadId: string;
  attemptId: string;
  mode: GenerationMode;
  status: GenerationAttemptStatus;
  reason: string;
};

export type StudioRecoveryState = {
  kind: StudioRecoveryKind;
  /** Alias kept for callers that use status terminology. */
  status: StudioRecoveryKind;
  sourceKey?: string;
  sourceSchemaVersion?: number;
  targetSchemaVersion: 6;
  backupKey?: string;
  lastKnownGoodKey?: string;
  rawStateAvailable: boolean;
  requiresUserAction: boolean;
  reason?: string;
  error?: string;
  attempts: StartupAttemptRecovery[];
};

export type StudioMigrationReport = {
  fromVersion: number;
  toVersion: 6;
  steps: string[];
};

export type StudioLoadResult = {
  state: StudioState;
  recovery: StudioRecoveryState;
  migration?: StudioMigrationReport;
};

/** A native orphan scanner can compare these references with managed files on disk. */
export type StudioManagedAssetReference = {
  sessionId: string;
  assetId: string;
  kind: AssetKind;
  name: string;
  localPath?: string;
  blobKey?: string;
};

export type ManagedAssetReconciliation = {
  state: StudioState;
  missingCount: number;
  relinkedCount: number;
  recoveredCount: number;
  duplicateFiles: SessionAsset[];
};

/** Export the current metadata without ephemeral recovery diagnostics or history truncation. */
export type StudioStateExport = {
  schemaVersion: 6;
  json: string;
};

export type StudioLoadOptions = {
  storage?: StudioStorage;
  now?: () => Date;
};

export type StudioSaveOptions = {
  storage?: StudioStorage;
  now?: () => Date;
};

export class StudioPersistenceError extends Error {
  readonly code: "backup_failed" | "write_failed" | "recovery_required";
  readonly cause?: unknown;

  constructor(
    code: "backup_failed" | "write_failed" | "recovery_required",
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "StudioPersistenceError";
    this.code = code;
    this.cause = cause;
  }
}

export function recordSessionCost(session: StudioSession, entry: SessionCostEntry): StudioSession {
  const index = session.costLedger.findIndex((existing) => existing.id === entry.id);
  if (index === -1) return { ...session, costLedger: [...session.costLedger, entry] };
  const existing = session.costLedger[index];
  if (existing.category === entry.category && existing.actualCostUsd === entry.actualCostUsd) return session;
  const costLedger = [...session.costLedger];
  costLedger[index] = entry;
  return { ...session, costLedger };
}

export function applyDefaultEnhancePrompt(state: StudioState, enabled: boolean): StudioState {
  return {
    ...state,
    defaultEnhancePrompt: enabled,
    sessions: state.sessions.map((session) => ({
      ...session,
      threads: {
        image: session.threads.image.map((thread) => ({
          ...thread,
          draft: { ...thread.draft, enhancePrompt: enabled },
        })),
        video: session.threads.video.map((thread) => ({
          ...thread,
          draft: { ...thread.draft, enhancePrompt: enabled },
        })),
      },
    })),
  };
}

export const STUDIO_STORAGE_KEY = "fruit-truck.studio.v1";
export const STUDIO_LAST_KNOWN_GOOD_KEY = `${STUDIO_STORAGE_KEY}.last-known-good`;
export const STUDIO_BACKUP_KEY_PREFIX = `${STUDIO_STORAGE_KEY}.backup.`;
export const STUDIO_PENDING_KEY_PREFIX = `${STUDIO_STORAGE_KEY}.pending.`;
const STORAGE_KEY = STUDIO_STORAGE_KEY;
const LEGACY_STORAGE_KEYS = [
  STORAGE_KEY,
  "oppa-gen.studio.v1",
  "open-gen-ui.studio.v1",
].filter((key, index, keys) => keys.indexOf(key) === index);
const DB_NAME = "fruit-truck-assets";
const DB_VERSION = 1;
const BLOB_STORE = "blobs";
const memoryBlobs = new Map<string, Blob>();
const LOCAL_MEDIA_MARKER = "fruit-truck-local:";
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 700 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export type NativeManagedAsset = {
  name: string;
  kind: AssetKind;
  mimeType: string;
  localPath: string;
  byteSize: number;
};

export const PROMPT_MODELS: Array<{
  id: PromptModel;
  label: string;
  effort: "xhigh" | "high";
}> = [
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", effort: "xhigh" },
  { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", effort: "high" },
];

export function emptyDraft(enhancePrompt = true): GenerationDraftState {
  return {
    prompt: "",
    references: [],
    options: {},
    providerJson: "",
    enhancePrompt,
    enhancedPrompt: "",
    enhancedPromptDirty: false,
    enhancedVisualCount: 0,
    enhancementArtifact: undefined,
    imageEditMode: false,
    imageEditTarget: "",
    maskInstructions: "",
    maskStrokes: [],
  };
}

export function markReferenceAsEditTarget(reference: DraftReference): DraftReference {
  return {
    ...reference,
    purposeBeforeEdit: reference.purpose === "edit_target"
      ? reference.purposeBeforeEdit
      : reference.purpose,
    purpose: "edit_target",
  };
}

export function restoreReferenceAfterEditTarget(
  reference: DraftReference,
  kind: AssetKind,
): DraftReference {
  if (reference.purpose !== "edit_target") return reference;
  const { purposeBeforeEdit, ...rest } = reference;
  return {
    ...rest,
    purpose: purposeBeforeEdit && purposeBeforeEdit !== "edit_target"
      ? purposeBeforeEdit
      : defaultReferencePurpose(kind, reference.role),
  };
}

export function beginGeneratedImageEdit(draft: GenerationDraftState, assetId: string): GenerationDraftState {
  return {
    ...draft,
    references: [markReferenceAsEditTarget({
      assetId,
      slot: 1,
      role: "reference",
      purpose: defaultReferencePurpose("image", "reference"),
    })],
    imageEditMode: true,
    imageEditTarget: "@1",
    maskInstructions: "",
    maskStrokes: [],
    enhancedPrompt: "",
    enhancedPromptDirty: false,
    enhancedVisualCount: 0,
    enhancementArtifact: undefined,
  };
}

function threadName(mode: GenerationMode, index = 1) {
  return `${mode === "image" ? "Image" : "Video"} ${index}`;
}

export function createGenerationThread(
  mode: GenerationMode,
  index = 1,
  draft: GenerationDraftState = emptyDraft(),
): GenerationThread {
  const createdAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: threadName(mode, index),
    mode,
    createdAt,
    updatedAt: createdAt,
    revision: 0,
    optionOverrides: { ...draft.options },
    providerJsonOverride: draft.providerJson || undefined,
    draft: { ...draft, options: {}, providerJson: "" },
    attempts: [],
  };
}

export function effectiveThreadDraft(session: StudioSession, thread: GenerationThread): GenerationDraftState {
  return {
    ...thread.draft,
    options: { ...session.generationDefaults.options[thread.mode], ...thread.optionOverrides },
    providerJson: thread.providerJsonOverride ?? session.generationDefaults.providerJson[thread.mode],
  };
}

export function effectiveThreadModelId(session: StudioSession, thread: GenerationThread) {
  return thread.modelOverrideId ?? session.generationDefaults.modelIds[thread.mode];
}

export function createSiblingGenerationThread(
  source: GenerationThread,
  index: number,
  defaultEnhancePrompt = true,
): GenerationThread {
  const next = createGenerationThread(
    source.mode,
    index,
    emptyDraft(defaultEnhancePrompt),
  );
  if (source.modelOverrideId) next.modelOverrideId = source.modelOverrideId;
  return next;
}

export function optionOverridesFromDefaults(defaults: DraftOptions, effective: DraftOptions): DraftOptions {
  return Object.fromEntries(Object.entries(effective).filter(([key, value]) => value !== defaults[key]));
}

export function activeGenerationAttempt(thread: GenerationThread) {
  return thread.attempts.findLast((attempt) => !["completed", "failed", "uncertain", "canceled"].includes(attempt.status));
}

export function latestGenerationAttempt(thread: GenerationThread) {
  return thread.attempts.at(-1);
}

export function activeVideoJobsFromAttempts(session: Pick<StudioSession, "threads">): SessionVideoJob[] {
  return session.threads.video.flatMap((thread) => thread.attempts.flatMap((attempt) => {
    if (!attempt.jobId || !["submitting", "in_progress"].includes(attempt.status)) return [];
    const snapshot = attempt.snapshot;
    return [{
      kind: "video" as const,
      jobId: attempt.jobId,
      status: "in_progress" as const,
      progress: attempt.progress,
      error: attempt.error,
      threadId: thread.id,
      attemptId: attempt.id,
      workflow: attempt.workflow ?? thread.videoWorkflow,
      model: snapshot?.modelId ?? attempt.modelId ?? "",
      submittedAt: attempt.submittedAt ?? attempt.createdAt,
      pollAttempts: attempt.pollAttempts,
      lastPolledAt: attempt.lastPolledAt,
      nextPollAt: attempt.nextPollAt,
      request: attempt.request ?? {},
      inputAssetIds: attempt.inputAssetIds,
    }];
  }));
}

export function createSession(name = "Untitled session", defaultEnhancePrompt = true): StudioSession {
  const now = new Date().toISOString();
  const imageThread = createGenerationThread("image", 1, emptyDraft(defaultEnhancePrompt));
  const videoThread = createGenerationThread("video", 1, emptyDraft(defaultEnhancePrompt));
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    mode: "image",
    assets: [],
    generationDefaults: {
      modelIds: { image: "", video: "" },
      options: { image: {}, video: {} },
      providerJson: { image: "", video: "" },
    },
    threads: { image: [imageThread], video: [videoThread] },
    activeThreadIds: { image: imageThread.id, video: videoThread.id },
    costLedger: [],
  };
}

export function nextAvailableSessionName(
  sessions: Array<Pick<StudioSession, "name">>,
  format: (count: number) => string,
) {
  const existing = new Set(sessions.map((session) => session.name.trim()));
  let count = sessions.length + 1;
  while (existing.has(format(count))) count += 1;
  return format(count);
}

export function initializeSessionCatalogDefaults(
  session: StudioSession,
  catalogs: Record<GenerationMode, GenerationModel[]>,
) {
  const imageModel = preferredCatalogModel("image", catalogs.image);
  const videoModel = preferredCatalogModel("video", catalogs.video);
  return {
    ...session,
    generationDefaults: {
      modelIds: {
        image: imageModel?.id ?? "",
        video: videoModel?.id ?? "",
      },
      options: {
        image: defaultOptions("image", imageModel),
        video: defaultOptions("video", videoModel),
      },
      providerJson: { image: "", video: "" },
    },
  };
}

export function preferredCatalogModel(mode: GenerationMode, models: GenerationModel[]): GenerationModel | null {
  if (mode === "video") {
    return models.find((model) => !/^openai\/sora-2(?:$|-)/.test(model.id)) ?? models[0] ?? null;
  }
  return models[0] ?? null;
}

type JsonRecord = Record<string, unknown>;

const TERMINAL_ATTEMPT_STATUSES = new Set<GenerationAttemptStatus>([
  "completed",
  "failed",
  "uncertain",
  "canceled",
]);
const CURRENT_ATTEMPT_STATUSES = new Set<GenerationAttemptStatus>([
  "enhancing",
  "submitting",
  "in_progress",
  ...TERMINAL_ATTEMPT_STATUSES,
]);
const LEGACY_ATTEMPT_STATUSES = new Set([
  ...CURRENT_ATTEMPT_STATUSES,
  "queued",
  "awaiting_host",
  "pending",
  "cancelled",
  "expired",
]);
const STUDIO_SCHEMA_VERSIONS = new Set([1, 2, 3, 4, 5, 6]);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function asString(value: unknown, label: string, fallback?: string): string {
  if (typeof value === "string") return value;
  if (fallback !== undefined && (value === undefined || value === null || value === "")) return fallback;
  throw new Error(`${label} must be a string.`);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, label);
}

function asFiniteNumber(value: unknown, label: string, fallback?: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (fallback !== undefined && (value === undefined || value === null)) return fallback;
  throw new Error(`${label} must be a finite number.`);
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return asFiniteNumber(value, label);
}

function asStringArray(value: unknown, label: string, fallback: string[] = []): string[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return [...value];
}

function storageFrom(optionsStorage?: StudioStorage): StudioStorage | null {
  if (optionsStorage) return optionsStorage;
  if (typeof globalThis.localStorage === "undefined") return null;
  return globalThis.localStorage;
}

function createRecovery(kind: StudioRecoveryKind, overrides: Partial<StudioRecoveryState> = {}): StudioRecoveryState {
  return {
    kind,
    status: kind,
    targetSchemaVersion: 6,
    rawStateAvailable: false,
    requiresUserAction: false,
    attempts: [],
    ...overrides,
  };
}

function stateWithRecovery(state: StudioState, recovery: StudioRecoveryState): StudioState {
  return { ...state, recovery };
}

function createInitialStudioState(): StudioState {
  const session = createSession("First session");
  return {
    schemaVersion: 6,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    generationPresets: [],
    sessions: [session],
  };
}

function isLegacySchemaVersion(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return typeof value === "number" && [1, 2, 3, 4, 5].includes(value);
}

function validEnvelope(value: unknown): value is JsonRecord & {
  schemaVersion: number;
  activeSessionId: string;
  sessions: JsonRecord[];
} {
  if (!isRecord(value)
    || typeof value.schemaVersion !== "number"
    || !STUDIO_SCHEMA_VERSIONS.has(value.schemaVersion)
    || typeof value.activeSessionId !== "string"
    || !Array.isArray(value.sessions)
    || value.sessions.length === 0
    || value.sessions.some((session) => !isRecord(session) || typeof session.id !== "string")) {
    return false;
  }
  return value.sessions.every((session) => session.mode === undefined || session.mode === "image" || session.mode === "video");
}

function validCurrentState(value: unknown): value is StudioState {
  if (!validEnvelope(value) || value.schemaVersion !== 6 || typeof value.defaultEnhancePrompt !== "boolean") return false;
  return value.sessions.every((session) => {
    const threads = session.threads;
    if (!Array.isArray(session.assets)
      || !isRecord(session.generationDefaults)
      || !isRecord(session.generationDefaults.modelIds)
      || !isRecord(session.generationDefaults.options)
      || !isRecord(session.generationDefaults.providerJson)
      || !isRecord(threads)
      || !Array.isArray(threads.image)
      || !Array.isArray(threads.video)
      || !isRecord(session.activeThreadIds)
      || typeof session.activeThreadIds.image !== "string"
      || typeof session.activeThreadIds.video !== "string"
      || !Array.isArray(session.costLedger)) {
      return false;
    }
    return (["image", "video"] as const).every((mode) => (threads[mode] as unknown[]).every((thread) => {
      if (!isRecord(thread)
        || typeof thread.id !== "string"
        || thread.mode !== mode
        || !isRecord(thread.draft)
        || !Array.isArray(thread.attempts)) {
        return false;
      }
      return thread.attempts.every((attempt) => isRecord(attempt)
        && typeof attempt.id === "string"
        && typeof attempt.status === "string"
        && CURRENT_ATTEMPT_STATUSES.has(attempt.status as GenerationAttemptStatus));
    }));
  });
}

function normalizeReference(value: unknown, index: number): DraftReference {
  const reference = asRecord(value, `reference ${index}`);
  const role = asString(reference.role, `reference ${index}.role`) as ReferenceRole;
  const slot = asFiniteNumber(reference.slot, `reference ${index}.slot`);
  if (!Number.isInteger(slot) || slot < 1) throw new Error(`reference ${index}.slot must be a positive integer.`);
  const assetId = asString(reference.assetId, `reference ${index}.assetId`);
  const purpose = typeof reference.purpose === "string" ? reference.purpose as ReferencePurpose : undefined;
  return { ...reference, assetId, slot, role, ...(purpose ? { purpose } : {}) } as DraftReference;
}

function normalizeDraft(value: unknown, defaultEnhancePrompt: boolean, migrateLegacyMentions = false): GenerationDraftState {
  const draft = value === undefined || value === null ? {} : asRecord(value, "draft");
  const references = draft.references === undefined || draft.references === null
    ? []
    : Array.isArray(draft.references)
      ? draft.references.map((reference, index) => normalizeReference(reference, index))
      : (() => { throw new Error("draft.references must be an array."); })();
  const slots = references.map((reference) => reference.slot);
  const migrate = (text: unknown, label: string): string => {
    const normalized = text === undefined || text === null ? "" : asString(text, label);
    return migrateLegacyMentions ? migrateLegacyInputMentions(normalized, slots) : normalized;
  };
  const count = draft.enhancedVisualCount === undefined || draft.enhancedVisualCount === null
    ? 0
    : asFiniteNumber(draft.enhancedVisualCount, "draft.enhancedVisualCount");
  const options = draft.options === undefined || draft.options === null
    ? {}
    : isRecord(draft.options)
      ? { ...draft.options } as DraftOptions
      : (() => { throw new Error("draft.options must be an object."); })();
  const maskStrokes = draft.maskStrokes === undefined || draft.maskStrokes === null
    ? []
    : Array.isArray(draft.maskStrokes)
      ? draft.maskStrokes.map((stroke, index) => {
        const normalized = asRecord(stroke, `draft.maskStrokes[${index}]`);
        return {
          ...normalized,
          points: Array.isArray(normalized.points) ? normalized.points : [],
          size: typeof normalized.size === "number" ? normalized.size : 0,
          operation: normalized.operation === "erase" ? "erase" as const : "paint" as const,
        } as MaskStroke;
      })
      : (() => { throw new Error("draft.maskStrokes must be an array."); })();
  const enhancePrompt = draft.enhancePrompt === undefined || draft.enhancePrompt === null
    ? defaultEnhancePrompt
    : typeof draft.enhancePrompt === "boolean"
      ? draft.enhancePrompt
      : (() => { throw new Error("draft.enhancePrompt must be a boolean."); })();
  const enhancedPromptDirty = draft.enhancedPromptDirty === undefined || draft.enhancedPromptDirty === null
    ? false
    : typeof draft.enhancedPromptDirty === "boolean"
      ? draft.enhancedPromptDirty
      : (() => { throw new Error("draft.enhancedPromptDirty must be a boolean."); })();
  const imageEditMode = draft.imageEditMode === undefined || draft.imageEditMode === null
    ? false
    : typeof draft.imageEditMode === "boolean"
      ? draft.imageEditMode
      : (() => { throw new Error("draft.imageEditMode must be a boolean."); })();
  return {
    ...emptyDraft(defaultEnhancePrompt),
    ...draft,
    prompt: migrate(draft.prompt, "draft.prompt"),
    references,
    options,
    providerJson: draft.providerJson === undefined || draft.providerJson === null ? "" : asString(draft.providerJson, "draft.providerJson"),
    enhancePrompt,
    enhancedPrompt: migrate(draft.enhancedPrompt, "draft.enhancedPrompt"),
    enhancedPromptDirty,
    enhancedVisualCount: count > 0 ? Math.floor(count) : 0,
    imageEditMode,
    imageEditTarget: migrate(draft.imageEditTarget, "draft.imageEditTarget"),
    maskInstructions: migrate(draft.maskInstructions, "draft.maskInstructions"),
    maskStrokes,
  };
}

function normalizeAsset(value: unknown, index: number): SessionAsset {
  const asset = asRecord(value, `asset ${index}`);
  const mimeType = asString(asset.mimeType, `asset ${index}.mimeType`, "application/octet-stream");
  const inferredKind: AssetKind = mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "image";
  const kind = asset.kind === undefined
    ? inferredKind
    : asset.kind === "image" || asset.kind === "video" || asset.kind === "audio" ? asset.kind : (() => { throw new Error(`asset ${index}.kind is unknown.`); })();
  const externalUrl = optionalString(asset.externalUrl, `asset ${index}.externalUrl`);
  const legacyLocalPath = externalUrl && /^(?:\/|[A-Za-z]:[\\/])/.test(externalUrl) ? externalUrl : undefined;
  const derivation = asset.derivation === undefined || asset.derivation === null
    ? undefined
    : (() => {
      const raw = asRecord(asset.derivation, `asset ${index}.derivation`);
      if (raw.kind !== "resize" && raw.kind !== "crop" && raw.kind !== "resize_crop") {
        throw new Error(`asset ${index}.derivation.kind is unknown.`);
      }
      return {
        ...raw,
        kind: raw.kind,
        sourceAssetId: asString(raw.sourceAssetId, `asset ${index}.derivation.sourceAssetId`),
        resolution: optionalString(raw.resolution, `asset ${index}.derivation.resolution`),
        aspectRatio: optionalString(raw.aspectRatio, `asset ${index}.derivation.aspectRatio`),
        createdAt: asString(raw.createdAt, `asset ${index}.derivation.createdAt`, new Date(0).toISOString()),
      } as SessionAssetDerivation;
    })();
  return {
    ...asset,
    id: asString(asset.id, `asset ${index}.id`),
    name: asString(asset.name, `asset ${index}.name`, `asset-${index}`),
    kind,
    mimeType,
    origin: asset.origin === undefined || asset.origin === "upload"
      ? "upload"
      : asset.origin === "generated" || asset.origin === "edited" ? asset.origin : (() => { throw new Error(`asset ${index}.origin is unknown.`); })(),
    createdAt: asString(asset.createdAt, `asset ${index}.createdAt`, new Date(0).toISOString()),
    localPath: optionalString(asset.localPath, `asset ${index}.localPath`) ?? legacyLocalPath,
    externalUrl: legacyLocalPath ? undefined : externalUrl,
    blobKey: optionalString(asset.blobKey, `asset ${index}.blobKey`),
    jobId: optionalString(asset.jobId, `asset ${index}.jobId`),
    duration: optionalFiniteNumber(asset.duration, `asset ${index}.duration`),
    width: optionalFiniteNumber(asset.width, `asset ${index}.width`),
    height: optionalFiniteNumber(asset.height, `asset ${index}.height`),
    fps: optionalFiniteNumber(asset.fps, `asset ${index}.fps`),
    codec: optionalString(asset.codec, `asset ${index}.codec`),
    facePresence: asset.facePresence === undefined || asset.facePresence === null
      ? undefined
      : asset.facePresence === "present" || asset.facePresence === "absent" || asset.facePresence === "unknown"
        ? asset.facePresence
        : (() => { throw new Error(`asset ${index}.facePresence is unknown.`); })(),
    byteSize: optionalFiniteNumber(asset.byteSize, `asset ${index}.byteSize`),
    fingerprint: optionalString(asset.fingerprint, `asset ${index}.fingerprint`),
    bridgeAvailability: asset.bridgeAvailability === undefined || asset.bridgeAvailability === null
      ? undefined
      : asset.bridgeAvailability === "available" || asset.bridgeAvailability === "desktop_only"
        ? asset.bridgeAvailability
        : (() => { throw new Error(`asset ${index}.bridgeAvailability is unknown.`); })(),
    storageAvailability: asset.storageAvailability === undefined || asset.storageAvailability === null
      ? undefined
      : asset.storageAvailability === "available" || asset.storageAvailability === "missing"
        ? asset.storageAvailability
        : (() => { throw new Error(`asset ${index}.storageAvailability is unknown.`); })(),
    sourceUrl: optionalString(asset.sourceUrl, `asset ${index}.sourceUrl`),
    sourcePageUrl: optionalString(asset.sourcePageUrl, `asset ${index}.sourcePageUrl`),
    license: optionalString(asset.license, `asset ${index}.license`),
    derivation,
  } as SessionAsset;
}

function normalizeSnapshot(value: unknown, defaultMode: GenerationMode, defaultEnhancePrompt: boolean, migrateLegacyMentions: boolean): GenerationAttemptSnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  const snapshot = asRecord(value, "attempt.snapshot");
  const mode = snapshot.mode === "video" ? "video" : snapshot.mode === "image" ? "image" : defaultMode;
  const normalizedDraft = normalizeDraft({
    prompt: snapshot.prompt,
    references: snapshot.assetBindings,
    options: snapshot.options,
    providerJson: snapshot.providerJson,
    enhancePrompt: snapshot.enhancePrompt,
    enhancedPrompt: snapshot.enhancedPrompt,
    imageEditMode: snapshot.imageEditMode,
    imageEditTarget: snapshot.imageEditTarget,
    maskInstructions: snapshot.maskInstructions,
    maskStrokes: snapshot.maskStrokes,
  }, defaultEnhancePrompt, migrateLegacyMentions);
  return {
    ...snapshot,
    mode,
    modelId: asString(snapshot.modelId, "attempt.snapshot.modelId", ""),
    prompt: normalizedDraft.prompt,
    enhancePrompt: normalizedDraft.enhancePrompt,
    enhancedPrompt: normalizedDraft.enhancedPrompt,
    options: normalizedDraft.options,
    providerJson: normalizedDraft.providerJson,
    assetBindings: normalizedDraft.references,
    imageEditMode: normalizedDraft.imageEditMode,
    imageEditTarget: normalizedDraft.imageEditTarget,
    maskInstructions: normalizedDraft.maskInstructions,
    maskStrokes: normalizedDraft.maskStrokes,
  } as GenerationAttemptSnapshot;
}

function normalizeAttemptStatus(status: unknown, mode: GenerationMode, jobId: unknown): GenerationAttemptStatus {
  if (typeof status !== "string" || !LEGACY_ATTEMPT_STATUSES.has(status)) throw new Error("attempt.status is unknown or missing.");
  if (status === "queued" || status === "awaiting_host") return mode === "video" && typeof jobId === "string" && jobId.length > 0 ? "in_progress" : "uncertain";
  if (status === "pending") return mode === "video" && typeof jobId === "string" && jobId.length > 0 ? "in_progress" : "uncertain";
  if (status === "cancelled") return "canceled";
  if (status === "expired") return "failed";
  return status as GenerationAttemptStatus;
}

function normalizeAttemptRecovery(value: unknown, label: string): GenerationAttemptRecovery | undefined {
  if (value === undefined || value === null) return undefined;
  const recovery = asRecord(value, label);
  if (recovery.classification !== "video_job_resumable"
    && recovery.classification !== "submission_uncertain"
    && recovery.classification !== "enhancement_interrupted") {
    throw new Error(`${label}.classification is unknown.`);
  }
  if (typeof recovery.resumable !== "boolean" || typeof recovery.retryable !== "boolean") throw new Error(`${label} resumability flags are invalid.`);
  return {
    ...recovery,
    classification: recovery.classification,
    previousStatus: asString(recovery.previousStatus, `${label}.previousStatus`),
    classifiedAt: asString(recovery.classifiedAt, `${label}.classifiedAt`),
    resumable: recovery.resumable,
    retryable: recovery.retryable,
  };
}

function normalizeAttempt(value: unknown, mode: GenerationMode, defaultEnhancePrompt: boolean, migrateLegacyMentions: boolean): GenerationAttempt {
  const attempt = asRecord(value, "attempt");
  // These paid-result recovery fields were added while v5 workspaces were
  // still in the wild. Validate them without rebuilding the object so their
  // exact provider handles/paths survive migration and subsequent saves.
  if (attempt.resultSources !== undefined && attempt.resultSources !== null) asStringArray(attempt.resultSources, "attempt.resultSources");
  if (attempt.recoveryPath !== undefined && attempt.recoveryPath !== null) optionalString(attempt.recoveryPath, "attempt.recoveryPath");
  const rawJobId = optionalString(attempt.jobId, "attempt.jobId");
  const jobId = rawJobId && rawJobId.length > 0 ? rawJobId : undefined;
  const status = normalizeAttemptStatus(attempt.status, mode, jobId);
  const createdAt = asString(attempt.createdAt, "attempt.createdAt", new Date(0).toISOString());
  const request = attempt.request === undefined || attempt.request === null
    ? undefined
    : isRecord(attempt.request)
      ? { ...attempt.request }
      : (() => { throw new Error("attempt.request must be an object."); })();
  const normalized: GenerationAttempt = {
    ...attempt,
    id: asString(attempt.id, "attempt.id"),
    status,
    draftRevision: typeof attempt.draftRevision === "number" && Number.isFinite(attempt.draftRevision) ? attempt.draftRevision : 0,
    createdAt,
    updatedAt: asString(attempt.updatedAt, "attempt.updatedAt", createdAt),
    submittedAt: optionalString(attempt.submittedAt, "attempt.submittedAt"),
    completedAt: optionalString(attempt.completedAt, "attempt.completedAt"),
    modelId: optionalString(attempt.modelId, "attempt.modelId"),
    inputAssetIds: asStringArray(attempt.inputAssetIds, "attempt.inputAssetIds"),
    assetIds: asStringArray(attempt.assetIds, "attempt.assetIds"),
    jobId,
    progress: optionalFiniteNumber(attempt.progress, "attempt.progress"),
    pollAttempts: optionalFiniteNumber(attempt.pollAttempts, "attempt.pollAttempts"),
    lastPolledAt: optionalString(attempt.lastPolledAt, "attempt.lastPolledAt"),
    nextPollAt: optionalString(attempt.nextPollAt, "attempt.nextPollAt"),
    estimatedCostUsd: optionalFiniteNumber(attempt.estimatedCostUsd, "attempt.estimatedCostUsd"),
    actualCostUsd: optionalFiniteNumber(attempt.actualCostUsd, "attempt.actualCostUsd"),
    costRecordedAt: optionalString(attempt.costRecordedAt, "attempt.costRecordedAt"),
    cancelRequestedAt: optionalString(attempt.cancelRequestedAt, "attempt.cancelRequestedAt"),
    enhancedPrompt: optionalString(attempt.enhancedPrompt, "attempt.enhancedPrompt"),
    request,
    error: optionalString(attempt.error, "attempt.error"),
    errorCode: optionalString(attempt.errorCode, "attempt.errorCode"),
    errorAction: optionalString(attempt.errorAction, "attempt.errorAction"),
    errorDetails: optionalString(attempt.errorDetails, "attempt.errorDetails"),
    requestKey: optionalString(attempt.requestKey, "attempt.requestKey"),
    backend: optionalString(attempt.backend, "attempt.backend"),
    requestedBy: optionalString(attempt.requestedBy, "attempt.requestedBy"),
    workflow: attempt.workflow === undefined || attempt.workflow === null
      ? undefined
      : attempt.workflow === "generate" || attempt.workflow === "edit"
        ? attempt.workflow
        : (() => { throw new Error("attempt.workflow is unknown."); })(),
    recovery: normalizeAttemptRecovery(attempt.recovery, "attempt.recovery"),
    snapshot: normalizeSnapshot(attempt.snapshot, mode, defaultEnhancePrompt, migrateLegacyMentions),
  };
  if (status === "uncertain" && (attempt.status === "queued" || attempt.status === "awaiting_host" || attempt.status === "pending")) {
    normalized.errorCode = normalized.errorCode ?? "submission_uncertain";
    normalized.errorAction = normalized.errorAction ?? "check_status_or_retry";
    normalized.error = normalized.error ?? "The previous submission had no resumable job ID; verify provider status before retrying.";
  }
  return normalized;
}

function normalizeEnhancementAttempt(value: unknown): PromptEnhancementAttempt {
  const attempt = asRecord(value, "enhancement attempt");
  const createdAt = asString(attempt.createdAt, "enhancement attempt.createdAt", new Date(0).toISOString());
  if (attempt.status !== "in_progress" && attempt.status !== "completed" && attempt.status !== "failed" && attempt.status !== "uncertain") {
    throw new Error("enhancement attempt.status is unknown or missing.");
  }
  const status = attempt.status;
  return {
    ...attempt,
    id: asString(attempt.id, "enhancement attempt.id"),
    requestKey: asString(attempt.requestKey, "enhancement attempt.requestKey", ""),
    status,
    threadRevision: typeof attempt.threadRevision === "number" && Number.isFinite(attempt.threadRevision) ? attempt.threadRevision : 0,
    originalPrompt: asString(attempt.originalPrompt, "enhancement attempt.originalPrompt", ""),
    enhancedPrompt: typeof attempt.enhancedPrompt === "string" ? attempt.enhancedPrompt : undefined,
    createdAt,
    updatedAt: asString(attempt.updatedAt, "enhancement attempt.updatedAt", createdAt),
    actualCostUsd: optionalFiniteNumber(attempt.actualCostUsd, "enhancement attempt.actualCostUsd"),
    costRecordedAt: optionalString(attempt.costRecordedAt, "enhancement attempt.costRecordedAt"),
    error: optionalString(attempt.error, "enhancement attempt.error"),
    errorCode: optionalString(attempt.errorCode, "enhancement attempt.errorCode"),
    errorAction: optionalString(attempt.errorAction, "enhancement attempt.errorAction"),
    recovery: normalizeAttemptRecovery(attempt.recovery, "enhancement attempt.recovery"),
  } as PromptEnhancementAttempt;
}

function hasDraftContent(draft: GenerationDraftState | undefined): boolean {
  return Boolean(draft && (draft.prompt.trim() || draft.references.length || Object.keys(draft.options).length || draft.providerJson.trim()));
}

function normalizeThread(value: unknown, mode: GenerationMode, defaultEnhancePrompt: boolean, migrateLegacyMentions: boolean, assetKinds: Map<string, AssetKind>): GenerationThread {
  const thread = asRecord(value, "thread");
  const draft = normalizeDraft(thread.draft, defaultEnhancePrompt, migrateLegacyMentions);
  const references = draft.references.map((reference) => {
    const isEditTarget = mode === "image" && draft.imageEditMode && `@${reference.slot}` === draft.imageEditTarget;
    const normalized: DraftReference = {
      ...reference,
      purpose: reference.role === "first_frame" ? "first_frame" : reference.role === "last_frame" ? "last_frame" : reference.purpose ?? defaultReferencePurpose(assetKinds.get(reference.assetId) ?? "image", reference.role),
    };
    return isEditTarget ? markReferenceAsEditTarget(normalized) : restoreReferenceAfterEditTarget(normalized, assetKinds.get(reference.assetId) ?? "image");
  });
  const attempts = thread.attempts === undefined || thread.attempts === null
    ? []
    : Array.isArray(thread.attempts)
      ? thread.attempts.map((attempt) => normalizeAttempt(attempt, mode, defaultEnhancePrompt, migrateLegacyMentions))
      : (() => { throw new Error("thread.attempts must be an array."); })();
  const normalizedThread: GenerationThread = {
    ...thread,
    id: asString(thread.id, "thread.id"),
    name: asString(thread.name, "thread.name", threadName(mode, 1)),
    mode,
    createdAt: asString(thread.createdAt, "thread.createdAt", new Date(0).toISOString()),
    updatedAt: asString(thread.updatedAt, "thread.updatedAt", new Date(0).toISOString()),
    revision: typeof thread.revision === "number" && Number.isFinite(thread.revision) ? thread.revision : 0,
    optionOverrides: isRecord(thread.optionOverrides) ? { ...thread.optionOverrides } as DraftOptions : { ...draft.options },
    providerJsonOverride: typeof thread.providerJsonOverride === "string" ? thread.providerJsonOverride : undefined,
    draft: { ...draft, references },
    attempts,
  };
  if (thread.enhancementAttempts !== undefined && thread.enhancementAttempts !== null) {
    if (!Array.isArray(thread.enhancementAttempts)) throw new Error("thread.enhancementAttempts must be an array.");
    normalizedThread.enhancementAttempts = thread.enhancementAttempts.map(normalizeEnhancementAttempt);
  }
  return normalizedThread;
}

function legacyDefaults(session: JsonRecord): GenerationDefaults {
  const selectedModelIds = session.selectedModelIds === undefined || session.selectedModelIds === null
    ? {}
    : isRecord(session.selectedModelIds)
      ? session.selectedModelIds
      : (() => { throw new Error("session.selectedModelIds must be an object."); })();
  const stored = session.generationDefaults === undefined || session.generationDefaults === null
    ? {}
    : isRecord(session.generationDefaults)
      ? session.generationDefaults
      : (() => { throw new Error("session.generationDefaults must be an object."); })();
  if (stored.modelIds !== undefined && stored.modelIds !== null && !isRecord(stored.modelIds)) throw new Error("session.generationDefaults.modelIds must be an object.");
  if (stored.options !== undefined && stored.options !== null && !isRecord(stored.options)) throw new Error("session.generationDefaults.options must be an object.");
  if (stored.providerJson !== undefined && stored.providerJson !== null && !isRecord(stored.providerJson)) throw new Error("session.generationDefaults.providerJson must be an object.");
  const storedModelIds = isRecord(stored.modelIds) ? stored.modelIds : {};
  const storedOptions = isRecord(stored.options) ? stored.options : {};
  const storedProviderJson = isRecord(stored.providerJson) ? stored.providerJson : {};
  for (const key of ["image", "video", "videoGenerate", "videoEdit"]) {
    if (storedOptions[key] !== undefined && storedOptions[key] !== null && !isRecord(storedOptions[key])) throw new Error(`session.generationDefaults.options.${key} must be an object.`);
    if (storedProviderJson[key] !== undefined && storedProviderJson[key] !== null && typeof storedProviderJson[key] !== "string") throw new Error(`session.generationDefaults.providerJson.${key} must be a string.`);
  }
  for (const key of ["image", "video"] as const) {
    if (storedModelIds[key] !== undefined && storedModelIds[key] !== null && typeof storedModelIds[key] !== "string") throw new Error(`session.generationDefaults.modelIds.${key} must be a string.`);
    if (selectedModelIds[key] !== undefined && selectedModelIds[key] !== null && typeof selectedModelIds[key] !== "string") throw new Error(`session.selectedModelIds.${key} must be a string.`);
  }
  const videoOptions = storedOptions.video ?? storedOptions.videoGenerate ?? storedOptions.videoEdit ?? {};
  const videoProviderJson = storedProviderJson.video ?? storedProviderJson.videoGenerate ?? storedProviderJson.videoEdit ?? "";
  return {
    ...(isRecord(session.generationDefaults) ? session.generationDefaults : {}),
    modelIds: {
      image: typeof storedModelIds.image === "string" ? storedModelIds.image : typeof selectedModelIds.image === "string" ? selectedModelIds.image : "",
      video: typeof storedModelIds.video === "string" ? storedModelIds.video : typeof selectedModelIds.video === "string" ? selectedModelIds.video : "",
    },
    options: { ...(isRecord(storedOptions) ? storedOptions : {}), image: isRecord(storedOptions.image) ? storedOptions.image : {}, video: isRecord(videoOptions) ? videoOptions : {} },
    providerJson: { ...(isRecord(storedProviderJson) ? storedProviderJson : {}), image: typeof storedProviderJson.image === "string" ? storedProviderJson.image : "", video: typeof videoProviderJson === "string" ? videoProviderJson : "" },
  } as GenerationDefaults;
}

function sessionCostLedger(session: JsonRecord, threads: Record<GenerationMode, GenerationThread[]>): SessionCostEntry[] {
  const ledger: SessionCostEntry[] = [];
  if (Array.isArray(session.costLedger)) {
    for (const value of session.costLedger) {
      if (!isRecord(value)
        || typeof value.id !== "string"
        || (value.category !== "generation" && value.category !== "prompt_enhancement")
        || typeof value.actualCostUsd !== "number"
        || !Number.isFinite(value.actualCostUsd)
        || typeof value.recordedAt !== "string") {
        throw new Error("session.costLedger contains an unreadable cost entry; original state was retained.");
      }
      ledger.push({ ...value, id: value.id, category: value.category, actualCostUsd: value.actualCostUsd, recordedAt: value.recordedAt } as SessionCostEntry);
    }
  }
  const addDerived = (entry: SessionCostEntry) => { if (!ledger.some((existing) => existing.id === entry.id)) ledger.push(entry); };
  for (const mode of ["image", "video"] as const) {
    for (const thread of threads[mode]) {
      for (const attempt of thread.attempts) if (typeof attempt.actualCostUsd === "number" && Number.isFinite(attempt.actualCostUsd)) addDerived({ id: `generation:${attempt.id}`, category: "generation", actualCostUsd: attempt.actualCostUsd, recordedAt: attempt.costRecordedAt ?? attempt.updatedAt ?? attempt.createdAt });
      for (const attempt of thread.enhancementAttempts ?? []) if (typeof attempt.actualCostUsd === "number" && Number.isFinite(attempt.actualCostUsd)) addDerived({ id: `prompt-enhancement:${attempt.id}`, category: "prompt_enhancement", actualCostUsd: attempt.actualCostUsd, recordedAt: attempt.costRecordedAt ?? attempt.updatedAt ?? attempt.createdAt });
    }
  }
  return ledger;
}

function normalizeLegacySession(value: unknown, defaultEnhancePrompt: boolean, migrateLegacyMentions: boolean): StudioSession {
  const session = asRecord(value, "session");
  const id = asString(session.id, "session.id");
  const assets = session.assets === undefined || session.assets === null
    ? []
    : Array.isArray(session.assets)
      ? session.assets.map(normalizeAsset)
      : (() => { throw new Error("session.assets must be an array."); })();
  const assetKinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const rawThreads = session.threads === undefined || session.threads === null
    ? {}
    : isRecord(session.threads)
      ? session.threads
      : (() => { throw new Error("session.threads must be an object."); })();
  if (rawThreads.image !== undefined && rawThreads.image !== null && !Array.isArray(rawThreads.image)) throw new Error("session.threads.image must be an array.");
  if (rawThreads.video !== undefined && rawThreads.video !== null && !Array.isArray(rawThreads.video)) throw new Error("session.threads.video must be an array.");
  const legacyDrafts = session.drafts === undefined || session.drafts === null
    ? {}
    : isRecord(session.drafts)
      ? session.drafts
      : (() => { throw new Error("session.drafts must be an object."); })();
  const imageDraft = normalizeDraft(legacyDrafts.image, defaultEnhancePrompt, migrateLegacyMentions);
  const videoGenerateDraft = normalizeDraft(legacyDrafts.videoGenerate, defaultEnhancePrompt, migrateLegacyMentions);
  const videoEditDraft = normalizeDraft(legacyDrafts.videoEdit, defaultEnhancePrompt, migrateLegacyMentions);
  const storedImageThreads = Array.isArray(rawThreads.image)
    ? rawThreads.image.map((thread) => normalizeThread(thread, "image", defaultEnhancePrompt, migrateLegacyMentions, assetKinds))
    : [];
  const storedVideoThreads = Array.isArray(rawThreads.video)
    ? rawThreads.video.map((thread) => normalizeThread(thread, "video", defaultEnhancePrompt, migrateLegacyMentions, assetKinds))
    : [];
  const imageThreads = storedImageThreads.length ? storedImageThreads : [createGenerationThread("image", 1, imageDraft)];
  const sessionWorkflow: VideoWorkflow = session.videoWorkflow === "edit" ? "edit" : "generate";
  let videoThreads = storedVideoThreads.length
    ? storedVideoThreads.map((thread, index) => thread.videoWorkflow ? thread : { ...thread, videoWorkflow: index === 0 ? sessionWorkflow : "generate" })
    : [{ ...createGenerationThread("video", 1, sessionWorkflow === "edit" ? videoEditDraft : videoGenerateDraft), videoWorkflow: sessionWorkflow }];
  if (!storedVideoThreads.length) {
    const inactiveDraft = sessionWorkflow === "edit" ? videoGenerateDraft : videoEditDraft;
    if (hasDraftContent(inactiveDraft)) {
      videoThreads = [...videoThreads, {
        ...createGenerationThread("video", 2, inactiveDraft),
        videoWorkflow: sessionWorkflow === "edit" ? "generate" : "edit",
      }];
    }
  }
  const activeThreadIds = session.activeThreadIds === undefined || session.activeThreadIds === null
    ? {}
    : isRecord(session.activeThreadIds)
      ? session.activeThreadIds
      : (() => { throw new Error("session.activeThreadIds must be an object."); })();
  const rawJobs = session.activeVideoJobs === undefined || session.activeVideoJobs === null
    ? []
    : Array.isArray(session.activeVideoJobs)
      ? session.activeVideoJobs
      : (() => { throw new Error("session.activeVideoJobs must be an array."); })();
  for (const rawJob of rawJobs) {
    const job = asRecord(rawJob, "active video job");
    const jobId = asString(job.jobId, "active video job.jobId");
    if (videoThreads.some((thread) => thread.attempts.some((attempt) => attempt.jobId === jobId))) continue;
    const workflow: VideoWorkflow = job.workflow === "edit" ? "edit" : job.workflow === "generate" ? "generate" : sessionWorkflow;
    let target = typeof job.threadId === "string" ? videoThreads.find((thread) => thread.id === job.threadId) : undefined;
    if (!target) {
      target = videoThreads.find((thread) => thread.videoWorkflow === workflow && !activeGenerationAttempt(thread));
      if (!target) target = !activeGenerationAttempt(videoThreads[0]) ? videoThreads[0] : undefined;
      if (!target) {
        target = { ...createGenerationThread("video", videoThreads.length + 1), videoWorkflow: workflow };
        videoThreads = [...videoThreads, target];
      }
    }
    const submittedAt = asString(job.submittedAt, "active video job.submittedAt", target.createdAt);
    const jobRequest = job.request === undefined || job.request === null
      ? {}
      : isRecord(job.request)
        ? job.request
        : (() => { throw new Error("active video job.request must be an object."); })();
    const attempt = normalizeAttempt({
      ...job,
      id: typeof job.attemptId === "string" ? job.attemptId : crypto.randomUUID(),
      status: normalizeAttemptStatus(job.status ?? "pending", "video", jobId),
      backend: "openrouter",
      draftRevision: target.revision,
      requestedBy: "human",
      createdAt: submittedAt,
      updatedAt: optionalString(job.lastPolledAt, "active video job.lastPolledAt") ?? submittedAt,
      submittedAt,
      modelId: optionalString(job.model, "active video job.model") ?? "",
      workflow,
      request: jobRequest,
      inputAssetIds: asStringArray(job.inputAssetIds, "active video job.inputAssetIds"),
      assetIds: [],
      jobId,
    }, "video", defaultEnhancePrompt, migrateLegacyMentions);
    target.attempts = [...target.attempts, attempt];
  }
  const legacyResults = session.lastResultAssetIds === undefined || session.lastResultAssetIds === null
    ? {}
    : isRecord(session.lastResultAssetIds)
      ? session.lastResultAssetIds
      : (() => { throw new Error("session.lastResultAssetIds must be an object."); })();
  for (const mode of ["image", "video"] as const) {
    if (legacyResults[mode] !== undefined && legacyResults[mode] !== null && !Array.isArray(legacyResults[mode])) throw new Error(`session.lastResultAssetIds.${mode} must be an array.`);
  }
  for (const mode of ["image", "video"] as const) {
    const resultIds = Array.isArray(legacyResults[mode])
      ? legacyResults[mode].filter((id): id is string => typeof id === "string" && assets.some((asset) => asset.id === id))
      : [];
    if (!resultIds.length || [...imageThreads, ...videoThreads].some((thread) => thread.attempts.some((attempt) => attempt.assetIds.some((id) => resultIds.includes(id))))) continue;
    const targetThreads = mode === "image" ? imageThreads : videoThreads;
    const target = targetThreads.find((thread) => thread.id === (activeThreadIds[mode] as string | undefined)) ?? targetThreads[0];
    if (!target) continue;
    const timestamp = target.updatedAt;
    target.attempts.push({
      id: `legacy-result:${mode}:${target.id}`,
      status: "completed",
      backend: "openrouter",
      draftRevision: target.revision,
      requestedBy: "human",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
      inputAssetIds: [],
      assetIds: resultIds,
    });
  }
  return {
    ...session,
    id,
    name: asString(session.name, "session.name", "Untitled session"),
    createdAt: asString(session.createdAt, "session.createdAt", new Date(0).toISOString()),
    updatedAt: asString(session.updatedAt, "session.updatedAt", new Date(0).toISOString()),
    mode: session.mode === "video" ? "video" : "image",
    assets,
    generationDefaults: legacyDefaults(session),
    threads: { image: imageThreads, video: videoThreads },
    activeThreadIds: {
      image: imageThreads.some((thread) => thread.id === activeThreadIds.image) ? activeThreadIds.image as string : imageThreads[0].id,
      video: videoThreads.some((thread) => thread.id === activeThreadIds.video) ? activeThreadIds.video as string : videoThreads[0].id,
    },
    costLedger: sessionCostLedger(session, { image: imageThreads, video: videoThreads }),
  };
}

function migrateV1ToV2(value: JsonRecord): JsonRecord {
  return { ...value, schemaVersion: 2 };
}

function migrateV2ToV3(value: JsonRecord): JsonRecord {
  return {
    ...value,
    schemaVersion: 3,
    sessions: (value.sessions as unknown[]).map((session) => normalizeLegacySession(session, true, true)),
  };
}

function migrateV3ToV4(value: JsonRecord): JsonRecord {
  return {
    ...value,
    schemaVersion: 4,
    // v3 still used the legacy #N reference syntax. Normalize it before the
    // v4 semantic-reference migration so loading v3 directly is lossless too.
    sessions: (value.sessions as unknown[]).map((session) => normalizeLegacySession(session, true, true)),
  };
}

function migrateV4ToV5(value: JsonRecord): JsonRecord {
  return {
    ...value,
    schemaVersion: 5,
    sessions: (value.sessions as unknown[]).map((session) => normalizeLegacySession(session, true, false)),
  };
}

function migrateV5ToV6(value: JsonRecord): JsonRecord {
  const defaultEnhancePrompt = typeof value.defaultEnhancePrompt === "boolean" ? value.defaultEnhancePrompt : true;
  const sessions = (value.sessions as unknown[]).map((sessionValue) => {
    const session = asRecord(sessionValue, "session");
    const rawThreads = isRecord(session.threads) ? session.threads : {};
    const threadDrafts = Object.values(rawThreads).flatMap((threads) => Array.isArray(threads) ? threads : []);
    const inferred = threadDrafts
      .map((thread) => isRecord(thread) && isRecord(thread.draft) && typeof thread.draft.enhancePrompt === "boolean" ? thread.draft.enhancePrompt : undefined)
      .find((item): item is boolean => item !== undefined);
    return normalizeLegacySession(session, inferred ?? defaultEnhancePrompt, false);
  });
  return { ...value, schemaVersion: 6, defaultEnhancePrompt, sessions };
}

function normalizeCurrentState(value: JsonRecord): StudioState {
  const defaultEnhancePrompt = value.defaultEnhancePrompt as boolean;
  const sessions = (value.sessions as unknown[]).map((sessionValue) => {
    const session = asRecord(sessionValue, "session");
    const assets = Array.isArray(session.assets) ? session.assets.map(normalizeAsset) : [];
    const assetKinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
    const rawThreads = asRecord(session.threads, "session.threads");
    const threads = {
      image: (rawThreads.image as unknown[]).map((thread) => normalizeThread(thread, "image", defaultEnhancePrompt, false, assetKinds)),
      video: (rawThreads.video as unknown[]).map((thread) => normalizeThread(thread, "video", defaultEnhancePrompt, false, assetKinds)),
    };
    const activeThreadIds = asRecord(session.activeThreadIds, "session.activeThreadIds");
    return {
      ...session,
      id: asString(session.id, "session.id"),
      name: asString(session.name, "session.name", "Untitled session"),
      createdAt: asString(session.createdAt, "session.createdAt", new Date(0).toISOString()),
      updatedAt: asString(session.updatedAt, "session.updatedAt", new Date(0).toISOString()),
      mode: session.mode === "video" ? "video" : "image",
      assets,
      generationDefaults: legacyDefaults(session),
      threads,
      activeThreadIds: {
        image: typeof activeThreadIds.image === "string" && threads.image.some((thread) => thread.id === activeThreadIds.image) ? activeThreadIds.image : threads.image[0].id,
        video: typeof activeThreadIds.video === "string" && threads.video.some((thread) => thread.id === activeThreadIds.video) ? activeThreadIds.video : threads.video[0].id,
      },
      costLedger: sessionCostLedger(session, threads),
    } as StudioSession;
  });
  return {
    ...value,
    schemaVersion: 6,
    activeSessionId: typeof value.activeSessionId === "string" && sessions.some((session) => session.id === value.activeSessionId) ? value.activeSessionId : sessions[0].id,
    promptModel: PROMPT_MODELS.some((model) => model.id === value.promptModel) ? value.promptModel : "openai/gpt-5.6-luna",
    defaultEnhancePrompt,
    generationPresets: normalizeGenerationPresets(value.generationPresets),
    sessions,
  } as StudioState;
}

function normalizeGenerationPresets(value: unknown): GenerationPreset[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("generationPresets must be an array.");
  return value.map((entry, index) => {
    const preset = asRecord(entry, `generation preset ${index}`);
    if (preset.mode !== "image" && preset.mode !== "video") throw new Error(`generation preset ${index}.mode is unknown.`);
    if (!isRecord(preset.options)) throw new Error(`generation preset ${index}.options must be an object.`);
    const createdAt = asString(preset.createdAt, `generation preset ${index}.createdAt`, new Date(0).toISOString());
    return {
      id: asString(preset.id, `generation preset ${index}.id`),
      name: asString(preset.name, `generation preset ${index}.name`),
      mode: preset.mode,
      modelId: asString(preset.modelId, `generation preset ${index}.modelId`),
      options: { ...preset.options } as DraftOptions,
      providerJson: asString(preset.providerJson, `generation preset ${index}.providerJson`, ""),
      createdAt,
      updatedAt: asString(preset.updatedAt, `generation preset ${index}.updatedAt`, createdAt),
    };
  });
}

function migrateState(value: JsonRecord): { state: StudioState; report: StudioMigrationReport } {
  const fromVersion = value.schemaVersion as number;
  let current = value;
  const steps: string[] = [];
  while (typeof current.schemaVersion === "number" && current.schemaVersion < 6) {
    const version = current.schemaVersion;
    switch (version) {
      case 1: current = migrateV1ToV2(current); steps.push("v1→v2"); break;
      case 2: current = migrateV2ToV3(current); steps.push("v2→v3"); break;
      case 3: current = migrateV3ToV4(current); steps.push("v3→v4"); break;
      case 4: current = migrateV4ToV5(current); steps.push("v4→v5"); break;
      case 5: current = migrateV5ToV6(current); steps.push("v5→v6"); break;
      default: throw new Error(`Unsupported studio schema version ${String(current.schemaVersion)}.`);
    }
  }
  if (!validCurrentState(current)) throw new Error("Migrated studio state failed schema validation.");
  const state = normalizeCurrentState(current);
  if (!validCurrentState(state)) throw new Error("Normalized studio state failed schema validation.");
  return { state, report: { fromVersion, toVersion: 6, steps } };
}

function classifyAttempt(state: StudioState, now: string): { state: StudioState; recovery: StartupAttemptRecovery[]; changed: boolean } {
  const recoveries: StartupAttemptRecovery[] = [];
  let changed = false;
  const sessions = state.sessions.map((session) => {
    const threads: Record<GenerationMode, GenerationThread[]> = { image: [], video: [] };
    for (const mode of ["image", "video"] as const) {
      threads[mode] = session.threads[mode].map((thread) => {
        const attempts = thread.attempts.map((attempt) => {
          const hasJob = Boolean(attempt.jobId);
          if (attempt.status === "enhancing") {
            changed = true;
            const next: GenerationAttempt = {
              ...attempt,
              status: "failed",
              updatedAt: now,
              completedAt: attempt.completedAt ?? now,
              error: attempt.error ?? "Prompt enhancement was interrupted before completion.",
              errorCode: attempt.errorCode ?? "enhancement_interrupted",
              errorAction: attempt.errorAction ?? "retry",
              recovery: { classification: "enhancement_interrupted", previousStatus: attempt.status, classifiedAt: now, resumable: false, retryable: true },
            };
            recoveries.push({ sessionId: session.id, threadId: thread.id, attemptId: attempt.id, mode, status: next.status, previousStatus: attempt.status, classification: "enhancement_interrupted", classifiedAt: now, resumable: false, retryable: true, reason: "Enhancement cannot resume without a completed planner response; retry from the saved snapshot." });
            return next;
          }
          if (mode === "video" && hasJob && (attempt.status === "submitting" || attempt.status === "in_progress")) {
            // A submission that already has a provider job id is safe to
            // resume. Normalize submitting to the poller's durable state and
            // make the first poll eligible immediately after startup.
            const next: GenerationAttempt = attempt.status === "in_progress"
              ? attempt
              : { ...attempt, status: "in_progress", nextPollAt: now, updatedAt: now };
            if (next !== attempt) changed = true;
            recoveries.push({ sessionId: session.id, threadId: thread.id, attemptId: attempt.id, mode, status: next.status, previousStatus: attempt.status, classification: "video_job_resumable", classifiedAt: now, resumable: true, retryable: false, reason: "Remote video job has a durable job ID and can resume polling." });
            return next;
          }
          if ((attempt.status === "submitting" || attempt.status === "in_progress") && !hasJob) {
            changed = true;
            const next: GenerationAttempt = {
              ...attempt,
              status: "uncertain",
              updatedAt: now,
              completedAt: attempt.completedAt ?? now,
              error: attempt.error ?? "Submission outcome is unknown; verify provider status before retrying.",
              errorCode: attempt.errorCode ?? "submission_uncertain",
              errorAction: attempt.errorAction ?? "check_status_or_retry",
              recovery: { classification: "submission_uncertain", previousStatus: attempt.status, classifiedAt: now, resumable: false, retryable: true },
            };
            recoveries.push({ sessionId: session.id, threadId: thread.id, attemptId: attempt.id, mode, status: next.status, previousStatus: attempt.status, classification: "submission_uncertain", classifiedAt: now, resumable: false, retryable: true, reason: "The request may have been accepted before the app lost its response; check status to avoid duplicate billing." });
            return next;
          }
          return attempt;
        });
        return { ...thread, attempts };
      });
    }
    for (const mode of ["image", "video"] as const) {
      threads[mode] = threads[mode].map((thread) => {
        if (!thread.enhancementAttempts) return thread;
        const enhancementAttempts = thread.enhancementAttempts.map((enhancement) => {
          if (enhancement.status !== "in_progress") return enhancement;
          changed = true;
          const next: PromptEnhancementAttempt = {
            ...enhancement,
            status: "failed",
            updatedAt: now,
            error: enhancement.error ?? "Prompt enhancement was interrupted before completion.",
            errorCode: enhancement.errorCode ?? "enhancement_interrupted",
            errorAction: enhancement.errorAction ?? "retry",
            recovery: { classification: "enhancement_interrupted", previousStatus: enhancement.status, classifiedAt: now, resumable: false, retryable: true },
          };
          recoveries.push({ sessionId: session.id, threadId: thread.id, attemptId: enhancement.id, mode, status: "failed", previousStatus: "enhancing", classification: "enhancement_interrupted", classifiedAt: now, resumable: false, retryable: true, reason: "Enhancement cannot resume without a completed planner response; retry from the saved prompt." });
          return next;
        });
        return { ...thread, enhancementAttempts };
      });
    }
    return { ...session, threads };
  });
  return { state: { ...state, sessions }, recovery: recoveries, changed };
}

export function reconcileStartupAttempts(state: StudioState, now: Date = new Date()): { state: StudioState; recovery: StartupAttemptRecovery[]; changed: boolean } {
  return classifyAttempt(state, now.toISOString());
}

export const reconcileStudioAttempts = reconcileStartupAttempts;

function serializedState(state: StudioState, boundHistory: boolean): string {
  const { recovery: _recovery, ...persistedState } = state;
  const bounded = {
    ...persistedState,
    sessions: persistedState.sessions.map((session) => ({
      ...session,
      threads: Object.fromEntries(Object.entries(session.threads).map(([mode, threads]) => [mode, threads.map((thread) => ({
        ...thread,
        attempts: boundHistory
          ? thread.attempts.filter((attempt) => !TERMINAL_ATTEMPT_STATUSES.has(attempt.status)).concat(thread.attempts.filter((attempt) => TERMINAL_ATTEMPT_STATUSES.has(attempt.status)).slice(-100))
          : thread.attempts,
        enhancementAttempts: boundHistory && thread.enhancementAttempts
          ? thread.enhancementAttempts.filter((attempt) => attempt.status === "in_progress").concat(thread.enhancementAttempts.filter((attempt) => attempt.status !== "in_progress").slice(-100))
          : thread.enhancementAttempts,
      }))])) as StudioSession["threads"],
      costLedger: boundHistory ? session.costLedger.slice(-500) : session.costLedger,
    })),
  };
  const serialized = JSON.stringify(bounded);
  if (/(?:"(?:externalUrl|localPath)"\s*:\s*"data:(?:image|video|audio)\/)/i.test(serialized) || /;base64,/i.test(serialized)) throw new Error("Media data URLs cannot be written to studio metadata.");
  return serialized;
}

function keySuffix(now: () => Date): string {
  return `${now().getTime()}-${Math.random().toString(36).slice(2, 10)}`;
}

function verifyStoredValue(storage: StudioStorage, key: string, expected: string | null): void {
  if (storage.getItem(key) !== expected) throw new Error(`Storage verification failed for ${key}.`);
}

function hasReadableStudioEnvelope(raw: string | null): boolean {
  if (raw === null) return false;
  try { return validEnvelope(JSON.parse(raw) as unknown); } catch { return false; }
}

function bestEffortRestore(storage: StudioStorage, previousRaw: string | null): void {
  try {
    if (previousRaw === null) {
      storage.removeItem(STORAGE_KEY);
      verifyStoredValue(storage, STORAGE_KEY, null);
    } else {
      storage.setItem(STORAGE_KEY, previousRaw);
      verifyStoredValue(storage, STORAGE_KEY, previousRaw);
    }
  } catch { /* last-known-good copy remains available */ }
}

function durableWrite(
  storage: StudioStorage,
  serialized: string,
  now: () => Date,
  backupRaw: string | null,
  createTimestampedBackup: boolean,
  previousCurrentRaw = backupRaw,
): { backupKey?: string; lastKnownGoodKey?: string } {
  const suffix = keySuffix(now);
  let backupKey: string | undefined;
  if (backupRaw !== null) {
    if (createTimestampedBackup) {
      backupKey = `${STUDIO_BACKUP_KEY_PREFIX}${suffix}`;
      try {
        storage.setItem(backupKey, backupRaw);
        verifyStoredValue(storage, backupKey, backupRaw);
      } catch (error) {
        throw new StudioPersistenceError("backup_failed", "Could not create a durable studio backup; original state was retained.", error);
      }
    }
    try {
      // A normal save may be explicitly replacing a corrupt primary after the
      // caller acknowledged recovery. Keep the prior good snapshot instead of
      // replacing it with those unreadable bytes.
      if ((createTimestampedBackup || hasReadableStudioEnvelope(backupRaw))
        && storage.getItem(STUDIO_LAST_KNOWN_GOOD_KEY) !== backupRaw) {
        storage.setItem(STUDIO_LAST_KNOWN_GOOD_KEY, backupRaw);
        verifyStoredValue(storage, STUDIO_LAST_KNOWN_GOOD_KEY, backupRaw);
      }
    } catch (error) {
      throw new StudioPersistenceError("backup_failed", "Could not update the last-known-good studio state; original state was retained.", error);
    }
  }
  const pendingKey = `${STUDIO_PENDING_KEY_PREFIX}${suffix}`;
  try {
    storage.setItem(pendingKey, serialized);
    verifyStoredValue(storage, pendingKey, serialized);
    storage.setItem(STORAGE_KEY, serialized);
    verifyStoredValue(storage, STORAGE_KEY, serialized);
  } catch (error) {
    // `backupRaw` can come from a legacy/alternate key while the current key
    // was absent. Restore only the bytes that were actually in the current
    // slot; never copy a legacy candidate into the primary after a failed
    // write.
    bestEffortRestore(storage, previousCurrentRaw);
    try { storage.removeItem(pendingKey); } catch { /* best effort cleanup */ }
    throw new StudioPersistenceError("write_failed", "Could not durably write studio state; the previous state was retained.", error);
  }
  try { storage.removeItem(pendingKey); } catch { /* best effort cleanup */ }
  return { backupKey, lastKnownGoodKey: backupRaw === null ? undefined : STUDIO_LAST_KNOWN_GOOD_KEY };
}

function readStorageSource(storage: StudioStorage): { key: string; raw: string } | null {
  for (const key of LEGACY_STORAGE_KEYS) {
    const raw = storage.getItem(key);
    if (raw !== null) return { key, raw };
  }
  if (storage.length !== undefined && storage.key) {
    const pendingKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STUDIO_PENDING_KEY_PREFIX)) pendingKeys.push(key);
    }
    for (const key of pendingKeys.sort().reverse()) {
      const raw = storage.getItem(key);
      if (raw !== null) return { key, raw };
    }
  }
  return null;
}

function recoveryStateFallback(
  storage: StudioStorage,
  source: { key: string; raw: string } | null,
  kind: "corrupt" | "unsupported",
  error: unknown,
  now: Date = new Date(),
): StudioLoadResult {
  let knownGoodRaw: string | null = null;
  try {
    knownGoodRaw = storage.getItem(STUDIO_LAST_KNOWN_GOOD_KEY);
  } catch (readError) {
    error = new Error(`${error instanceof Error ? error.message : String(error)}; last-known-good could not be read: ${readError instanceof Error ? readError.message : String(readError)}`);
  }
  if (knownGoodRaw !== null) {
    try {
      const parsed = JSON.parse(knownGoodRaw) as unknown;
      if (validEnvelope(parsed)) {
        const migrated = parsed.schemaVersion === 6 ? { state: normalizeCurrentState(parsed), report: undefined } : migrateState(parsed);
        if (validCurrentState(migrated.state)) {
          const reconciled = reconcileStartupAttempts(migrated.state, now);
          const recovery = createRecovery("recovered_last_known_good", {
            sourceKey: source?.key,
            sourceSchemaVersion: parsed.schemaVersion,
            lastKnownGoodKey: STUDIO_LAST_KNOWN_GOOD_KEY,
            rawStateAvailable: source !== null || knownGoodRaw !== null,
            requiresUserAction: true,
            reason: "The primary studio state was unreadable; the last-known-good snapshot was loaded.",
            error: error instanceof Error ? error.message : String(error),
            attempts: reconciled.recovery,
          });
          return { state: stateWithRecovery(reconciled.state, recovery), recovery, migration: migrated.report };
        }
      }
    } catch { /* fall through to explicit recovery state */ }
  }
  const recovery = createRecovery(kind, {
    sourceKey: source?.key,
    rawStateAvailable: source !== null,
    requiresUserAction: source !== null,
    reason: source === null ? "No studio state exists yet." : "Studio state could not be read safely; the original bytes were retained.",
    error: error instanceof Error ? error.message : String(error),
  });
  const state = stateWithRecovery(createInitialStudioState(), recovery);
  return { state, recovery };
}

export function loadStudioStateWithRecovery(options: StudioLoadOptions = {}): StudioLoadResult {
  const storage = storageFrom(options.storage);
  if (!storage) {
    const recovery = createRecovery("fresh");
    const state = stateWithRecovery(createInitialStudioState(), recovery);
    return { state, recovery };
  }
  let source: { key: string; raw: string } | null;
  try {
    source = readStorageSource(storage);
  } catch (error) {
    const recovery = createRecovery("write_failed", {
      rawStateAvailable: false,
      requiresUserAction: true,
      reason: "Studio storage could not be read; no replacement state was written.",
      error: error instanceof Error ? error.message : String(error),
    });
    const state = stateWithRecovery(createInitialStudioState(), recovery);
    return { state, recovery };
  }
  if (!source) {
    let hasLastKnownGood = false;
    try { hasLastKnownGood = storage.getItem(STUDIO_LAST_KNOWN_GOOD_KEY) !== null; } catch { /* fresh state remains the safe fallback */ }
    if (hasLastKnownGood) return recoveryStateFallback(storage, null, "corrupt", new Error("Primary studio state is missing; the last-known-good snapshot was loaded."), options.now?.() ?? new Date());
    const recovery = createRecovery("fresh");
    const state = stateWithRecovery(createInitialStudioState(), recovery);
    return { state, recovery };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.raw) as unknown;
  } catch (error) {
    return recoveryStateFallback(storage, source, "corrupt", error, options.now?.() ?? new Date());
  }
  if (!validEnvelope(parsed)) {
    return recoveryStateFallback(storage, source, "unsupported", new Error("Studio state has an unsupported or incompatible shape."), options.now?.() ?? new Date());
  }
  const sourceVersion = parsed.schemaVersion;
  // A v6 envelope with malformed required fields is corrupt, not an empty
  // workspace. Give the last-known-good snapshot a chance before reporting
  // recovery-required to the caller.
  if (sourceVersion === 6 && !validCurrentState(parsed)) {
    return recoveryStateFallback(storage, source, "corrupt", new Error("Current studio state failed schema validation."), options.now?.() ?? new Date());
  }
  try {
    let migrated: { state: StudioState; report?: StudioMigrationReport };
    if (sourceVersion === 6) {
      migrated = { state: normalizeCurrentState(parsed) };
    } else if (isLegacySchemaVersion(sourceVersion)) {
      migrated = migrateState(parsed);
    } else {
      throw new Error(`Unsupported studio schema version ${String(sourceVersion)}.`);
    }
    const reconciled = reconcileStartupAttempts(migrated.state, options.now?.() ?? new Date());
    const state = reconciled.state;
    if (!validCurrentState(state)) throw new Error("Studio state failed validation after startup reconciliation.");
    const needsWrite = sourceVersion !== 6 || source.key !== STORAGE_KEY || reconciled.changed;
    let durable: { backupKey?: string; lastKnownGoodKey?: string } = {};
    if (needsWrite) {
      let previousCurrentRaw: string | null = null;
      try {
        previousCurrentRaw = storage.getItem(STORAGE_KEY);
      } catch (readError) {
        throw new StudioPersistenceError("write_failed", "Could not read the primary studio state before migration; original state was retained.", readError);
      }
      durable = durableWrite(
        storage,
        serializedState(state, false),
        options.now ?? (() => new Date()),
        source.raw,
        sourceVersion !== 6,
        previousCurrentRaw,
      );
    }
    if (needsWrite && source.key.startsWith(STUDIO_PENDING_KEY_PREFIX)) {
      try { storage.removeItem(source.key); } catch { /* stale temp cleanup is best effort */ }
    }
    const recovery = createRecovery(sourceVersion === 6 && !needsWrite ? "loaded" : "migrated", {
      sourceKey: source.key,
      sourceSchemaVersion: sourceVersion,
      backupKey: durable.backupKey,
      lastKnownGoodKey: durable.lastKnownGoodKey,
      rawStateAvailable: true,
      requiresUserAction: false,
      attempts: reconciled.recovery,
    });
    return { state: stateWithRecovery(state, recovery), recovery, migration: migrated.report };
  } catch (error) {
    if (!(error instanceof StudioPersistenceError)) {
      let hasLastKnownGood = false;
      try { hasLastKnownGood = storage.getItem(STUDIO_LAST_KNOWN_GOOD_KEY) !== null; } catch { /* preserve the explicit migration failure below */ }
      if (hasLastKnownGood) return recoveryStateFallback(storage, source, "corrupt", error, options.now?.() ?? new Date());
    }
    const failureKind = error instanceof StudioPersistenceError ? "write_failed" : sourceVersion === 6 ? "write_failed" : "migration_failed";
    const recovery = createRecovery(failureKind, {
      sourceKey: source.key,
      sourceSchemaVersion: sourceVersion,
      rawStateAvailable: true,
      requiresUserAction: true,
      reason: "The original studio bytes were retained because migration or durable write did not complete.",
      error: error instanceof Error ? error.message : String(error),
    });
    const state = stateWithRecovery(createInitialStudioState(), recovery);
    return { state, recovery };
  }
}

export function loadStudioState(options: StudioLoadOptions = {}): StudioState {
  return loadStudioStateWithRecovery(options).state;
}

/** Alias for integrations that need the recovery report rather than only the state. */
export const loadStudioStateResult = loadStudioStateWithRecovery;

export function exportStudioState(state: StudioState): StudioStateExport {
  return { schemaVersion: 6, json: serializedState(acknowledgeStudioRecovery(state), false) };
}

export const exportStudioStateJson = (state: StudioState): string => exportStudioState(state).json;

export function listStudioManagedAssetReferences(
  state: Pick<StudioState, "sessions">,
): StudioManagedAssetReference[] {
  return state.sessions.flatMap((session) => session.assets.map((asset) => ({
    sessionId: session.id,
    assetId: asset.id,
    kind: asset.kind,
    name: asset.name,
    localPath: asset.localPath,
    blobKey: asset.blobKey,
  })));
}

export const listManagedAssetReferences = listStudioManagedAssetReferences;

export function listStudioBackupKeys(options: StudioLoadOptions = {}): string[] {
  const storage = storageFrom(options.storage);
  if (!storage || storage.length === undefined || !storage.key) return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(STUDIO_BACKUP_KEY_PREFIX)) keys.push(key);
  }
  return keys.sort().reverse();
}

export function readStudioBackup(key: string, options: StudioLoadOptions = {}): string | null {
  if (!key.startsWith(STUDIO_BACKUP_KEY_PREFIX) && key !== STUDIO_LAST_KNOWN_GOOD_KEY) return null;
  return storageFrom(options.storage)?.getItem(key) ?? null;
}

export function acknowledgeStudioRecovery(state: StudioState): StudioState {
  const { recovery: _recovery, ...acknowledged } = state;
  return acknowledged;
}

export function saveStudioState(state: StudioState, options: StudioSaveOptions = {}): void {
  const storage = storageFrom(options.storage);
  if (!storage) return;
  if (state.recovery?.requiresUserAction) throw new StudioPersistenceError("recovery_required", "Studio recovery requires an explicit user decision before replacing the retained state.");
  let previousRaw: string | null;
  try {
    previousRaw = storage.getItem(STORAGE_KEY);
  } catch (error) {
    throw new StudioPersistenceError("write_failed", "Could not read the existing studio state before saving; no replacement was written.", error);
  }
  // Validate the exact bounded candidate before touching any storage slot.
  // This keeps a caller's malformed state from replacing a readable snapshot.
  const serialized = serializedState(state, true);
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new StudioPersistenceError("write_failed", "Studio state could not be encoded safely; no replacement was written.", error);
  }
  if (!validCurrentState(candidate)) {
    throw new StudioPersistenceError("write_failed", "Studio state failed schema validation; no replacement was written.");
  }
  durableWrite(storage, serialized, options.now ?? (() => new Date()), previousRaw, false);
}

function openAssetDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the asset database"));
  });
}

async function storeAssetBlob(key: string, blob: Blob): Promise<void> {
  const db = await openAssetDb();
  if (!db) {
    memoryBlobs.set(key, blob);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE, "readwrite");
      tx.objectStore(BLOB_STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save asset data"));
    });
  } finally {
    db.close();
  }
}

async function loadAssetBlob(key: string): Promise<Blob | null> {
  const db = await openAssetDb();
  if (!db) return memoryBlobs.get(key) ?? null;
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE, "readonly");
      const request = tx.objectStore(BLOB_STORE).get(key);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error("Could not load asset data"));
    });
  } finally {
    db.close();
  }
}

export async function deleteAssetBlob(key: string): Promise<void> {
  const db = await openAssetDb();
  if (!db) {
    memoryBlobs.delete(key);
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE, "readwrite");
      tx.objectStore(BLOB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not delete asset data"));
    });
  } finally {
    db.close();
  }
}

export async function deleteSessionBlobs(session: StudioSession): Promise<{
  deletedIds: string[];
  failures: Array<{ assetId: string; name: string; error: unknown }>;
}> {
  const outcomes = await Promise.allSettled(session.assets.map(deleteManagedAsset));
  return {
    deletedIds: outcomes.flatMap((outcome, index) => outcome.status === "fulfilled" ? [session.assets[index].id] : []),
    failures: outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [{
      assetId: session.assets[index].id,
      name: session.assets[index].name,
      error: outcome.reason,
    }] : []),
  };
}

export async function deleteManagedAsset(asset: SessionAsset): Promise<void> {
  if (asset.blobKey) await deleteAssetBlob(asset.blobKey);
  if (asset.localPath && isTauriRuntime()) {
    await invoke<void>("delete_managed_asset", { path: asset.localPath });
  }
}

type BrowserFaceDetector = new (options?: { maxDetectedFaces?: number; fastMode?: boolean }) => {
  detect(source: CanvasImageSource): Promise<unknown[]>;
};

type NativeMediaMetadata = {
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  codec?: string;
  byteSize?: number;
};

function loadVisualMetadata(source: string, kind: "image" | "video"): Promise<{ width?: number; height?: number; duration?: number; element: HTMLImageElement | HTMLVideoElement }> {
  return new Promise((resolve, reject) => {
    if (kind === "image") {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight, element: image });
      image.onerror = () => reject(new Error("Could not inspect image dimensions."));
      image.src = source;
      return;
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : undefined, element: video });
    video.onerror = () => reject(new Error("Could not inspect video metadata."));
    video.src = source;
  });
}

function loadAudioDuration(source: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : undefined);
    audio.onerror = () => reject(new Error("Could not inspect audio metadata."));
    audio.src = source;
  });
}

export async function inspectSessionAssetMetadata(
  asset: SessionAsset,
  suppliedSource?: string,
  options: { strict?: boolean } = {},
): Promise<SessionAsset> {
  const source = suppliedSource ?? await resolveAssetSource(asset);
  let nativeMetadata: NativeMediaMetadata = {};
  const nativeAsset = Boolean(asset.localPath && isTauriRuntime());
  if (nativeAsset) {
    try {
      nativeMetadata = await invoke<NativeMediaMetadata>("inspect_managed_asset", { path: asset.localPath });
    } catch (error) {
      if (options.strict) {
        throw new Error(`Could not validate generated ${asset.kind} bytes in managed storage.`, { cause: error });
      }
    }
  }
  try {
    // Native inspection validates the actual managed bytes with the bundled
    // decoder. Do not make a valid result depend on a second WebView decode.
    if (nativeAsset && options.strict) return {
      ...asset,
      width: nativeMetadata.width ?? asset.width,
      height: nativeMetadata.height ?? asset.height,
      duration: nativeMetadata.duration ?? asset.duration,
      fps: nativeMetadata.fps ?? asset.fps,
      codec: nativeMetadata.codec ?? asset.codec,
      byteSize: nativeMetadata.byteSize ?? asset.byteSize,
      facePresence: asset.kind === "image" ? "unknown" : asset.facePresence,
    };
    if (asset.kind === "audio") return {
      ...asset,
      duration: nativeMetadata.duration ?? await loadAudioDuration(source),
      codec: nativeMetadata.codec ?? asset.codec,
      byteSize: nativeMetadata.byteSize ?? asset.byteSize,
    };
    const metadata = await loadVisualMetadata(source, asset.kind);
    let facePresence = asset.facePresence;
    if (asset.kind === "image") {
      const Detector = (globalThis as typeof globalThis & { FaceDetector?: BrowserFaceDetector }).FaceDetector;
      if (Detector) {
        try {
          facePresence = (await new Detector({ maxDetectedFaces: 1, fastMode: true }).detect(metadata.element)).length ? "present" : "absent";
        } catch { facePresence = "unknown"; }
      } else facePresence = "unknown";
    }
    return {
      ...asset,
      width: nativeMetadata.width ?? metadata.width,
      height: nativeMetadata.height ?? metadata.height,
      duration: nativeMetadata.duration ?? metadata.duration,
      fps: nativeMetadata.fps ?? asset.fps,
      codec: nativeMetadata.codec ?? asset.codec,
      byteSize: nativeMetadata.byteSize ?? asset.byteSize,
      facePresence,
    };
  } catch (error) {
    if (options.strict) {
      throw new Error(`Could not validate generated ${asset.kind} bytes.`, { cause: error });
    }
    return { ...asset, facePresence: asset.kind === "image" ? "unknown" : asset.facePresence };
  } finally {
    if (source.startsWith("blob:")) URL.revokeObjectURL(source);
  }
}

export async function importFileAsset(file: File, origin: AssetOrigin = "upload"): Promise<SessionAsset> {
  const kind: AssetKind | null = file.type.startsWith("image/")
    ? "image"
    : file.type.startsWith("video/")
      ? "video"
      : file.type.startsWith("audio/")
        ? "audio"
      : null;
  if (!kind) throw new Error(`${file.name} is not a supported image, video, or audio file.`);
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  const limit = kind === "video" ? MAX_VIDEO_BYTES : kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > limit) {
    throw new Error(`${file.name} exceeds the ${kind === "video" ? "700 MB" : kind === "audio" ? "50 MB" : "30 MB"} local safety limit.`);
  }
  const id = crypto.randomUUID();
  const blobKey = `asset:${id}`;
  await storeAssetBlob(blobKey, file);
  const asset: SessionAsset = {
    id,
    name: file.name,
    kind,
    mimeType: file.type || (kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg"),
    origin,
    createdAt: new Date().toISOString(),
    blobKey,
    byteSize: file.size,
    fingerprint: `${file.name}:${file.size}:${file.lastModified}:${file.type}`,
  };
  return inspectSessionAssetMetadata(asset, URL.createObjectURL(file));
}

export function mediaMimeFromSource(source: string, fallback: string): string {
  const dataMime = source.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();
  if (dataMime?.startsWith("image/") || dataMime?.startsWith("video/") || dataMime?.startsWith("audio/")) return dataMime;
  const clean = source.split(/[?#]/, 1)[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".mov")) return "video/quicktime";
  if (clean.endsWith(".mp4")) return "video/mp4";
  if (clean.endsWith(".mp3")) return "audio/mpeg";
  if (clean.endsWith(".wav")) return "audio/wav";
  if (clean.endsWith(".flac")) return "audio/flac";
  if (clean.endsWith(".m4a")) return "audio/mp4";
  if (clean.endsWith(".aac")) return "audio/aac";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  if (clean.endsWith(".avif")) return "image/avif";
  if (clean.endsWith(".png")) return "image/png";
  return fallback;
}

export function mediaNameForMime(name: string, mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg"
    : mimeType === "image/webp" ? "webp"
    : mimeType === "image/gif" ? "gif"
      : mimeType === "image/svg+xml" ? "svg"
        : mimeType === "image/avif" ? "avif"
      : mimeType === "video/webm" ? "webm"
          : mimeType === "video/quicktime" ? "mov"
            : mimeType.startsWith("video/") ? "mp4"
              : mimeType === "audio/wav" ? "wav"
                : mimeType === "audio/flac" ? "flac"
                  : mimeType === "audio/mp4" ? "m4a"
                    : mimeType.startsWith("audio/") ? "mp3" : "png";
  const stem = name.replace(/\.[^.]+$/, "");
  return `${stem}.${extension}`;
}

export function requestedImageDimensions(
  width: number,
  height: number,
  resolution?: string,
  aspectRatio?: string,
): { width: number; height: number } | null {
  const resolutionValue = resolution?.trim().toLowerCase();
  const longSide = resolutionValue === "4k" ? 4096
    : resolutionValue === "2k" ? 2048
      : resolutionValue === "1k" ? 1024
        : Number(resolutionValue?.match(/^(\d+)(?:px|p)?$/)?.[1] ?? 0);
  const ratioMatch = aspectRatio?.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  const ratio = ratioMatch ? Number(ratioMatch[1]) / Number(ratioMatch[2]) : width / height;
  const targetLongSide = longSide || Math.max(width, height);
  if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(targetLongSide) || targetLongSide <= 0) return null;
  const target = ratio >= 1
    ? { width: targetLongSide, height: Math.max(1, Math.round(targetLongSide / ratio)) }
    : { width: Math.max(1, Math.round(targetLongSide * ratio)), height: targetLongSide };
  return target.width === width && target.height === height ? null : target;
}

async function normalizeGeneratedImageBlob(
  blob: Blob,
  output?: { resolution?: string; aspectRatio?: string },
): Promise<Blob> {
  if (!output?.resolution && !output?.aspectRatio) return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const target = requestedImageDimensions(bitmap.width, bitmap.height, output.resolution, output.aspectRatio);
    if (!target) return blob;
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) return blob;
    const sourceRatio = bitmap.width / bitmap.height;
    const targetRatio = target.width / target.height;
    const sourceWidth = sourceRatio > targetRatio ? bitmap.height * targetRatio : bitmap.width;
    const sourceHeight = sourceRatio > targetRatio ? bitmap.height : bitmap.width / targetRatio;
    const sourceX = (bitmap.width - sourceWidth) / 2;
    const sourceY = (bitmap.height - sourceHeight) / 2;
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, target.width, target.height);
    return await new Promise<Blob>((resolve) => canvas.toBlob(
      (value) => resolve(value ?? blob),
      blob.type || "image/png",
      blob.type === "image/jpeg" ? .95 : undefined,
    ));
  } finally {
    bitmap.close();
  }
}

export type ImageDerivationOptions = {
  resolution?: string;
  aspectRatio?: string;
};

function derivationKind(output: ImageDerivationOptions): SessionAssetDerivation["kind"] {
  return output.resolution && output.aspectRatio
    ? "resize_crop"
    : output.aspectRatio
      ? "crop"
      : "resize";
}

/**
 * Create a separately stored image derivative. The source asset and its bytes
 * are never changed; the returned asset records the source and operation so a
 * native recovery/orphan scanner can retain both files safely.
 */
export async function deriveImageAsset(
  sourceAsset: SessionAsset,
  output: ImageDerivationOptions,
  origin: AssetOrigin = "edited",
): Promise<SessionAsset> {
  if (sourceAsset.kind !== "image") throw new Error("Only image assets can be resized or cropped.");
  if (!output.resolution && !output.aspectRatio) throw new Error("An image derivative requires a resolution or aspect ratio.");
  const source = await resolveAssetSource(sourceAsset);
  if (!source) throw new Error(`${sourceAsset.name} has no readable source.`);
  const sourceOwned = source.startsWith("blob:");
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Could not read ${sourceAsset.name} for derivation.`);
    const original = await response.blob();
    const blob = await normalizeGeneratedImageBlob(original, output);
    const id = crypto.randomUUID();
    const blobKey = `asset:${id}`;
    await storeAssetBlob(blobKey, blob);
    const mimeType = blob.type || sourceAsset.mimeType;
    const createdAt = new Date().toISOString();
    const asset: SessionAsset = {
      id,
      name: mediaNameForMime(sourceAsset.name, mimeType),
      kind: "image",
      mimeType,
      origin,
      createdAt,
      blobKey,
      byteSize: blob.size,
      derivation: {
        kind: derivationKind(output),
        sourceAssetId: sourceAsset.id,
        resolution: output.resolution,
        aspectRatio: output.aspectRatio,
        createdAt,
      },
    };
    let inspectionSource: string | undefined;
    try {
      inspectionSource = typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : undefined;
    } catch { /* derived bytes are stored even when browser inspection is unavailable */ }
    return inspectionSource ? inspectSessionAssetMetadata(asset, inspectionSource) : asset;
  } finally {
    if (sourceOwned) URL.revokeObjectURL(source);
  }
}

function sessionAssetFromManaged(
  asset: NativeManagedAsset,
  origin: AssetOrigin = /(?:^|[\\/])generated(?:[\\/]|$)/.test(asset.localPath) ? "generated" : "upload",
): SessionAsset {
  return {
    id: crypto.randomUUID(),
    name: asset.name,
    kind: asset.kind,
    mimeType: asset.mimeType,
    origin,
    createdAt: new Date().toISOString(),
    localPath: asset.localPath,
    byteSize: asset.byteSize,
    fingerprint: `${asset.name}:${asset.byteSize}:${asset.mimeType}`,
    storageAvailability: "available",
  };
}

export async function pickManagedAssets(): Promise<SessionAsset[]> {
  if (!isTauriRuntime()) return [];
  const assets = await invoke<NativeManagedAsset[]>("pick_and_import_assets");
  return Promise.all(assets.map((asset) => inspectSessionAssetMetadata(sessionAssetFromManaged(asset))));
}

export async function managedDroppedAssets(assets: NativeManagedAsset[]): Promise<SessionAsset[]> {
  return Promise.all(assets.map((asset) => inspectSessionAssetMetadata(sessionAssetFromManaged(asset))));
}

/**
 * Reconcile persisted metadata with a native managed-file scan. Exact paths
 * remain authoritative; a unique fingerprint can repair a moved path. Files
 * with no metadata are recovered into the active session, while duplicate
 * copies are returned to the caller for idempotent cleanup.
 */
export function reconcileManagedAssetIndex(
  state: StudioState,
  scannedAssets: SessionAsset[],
): ManagedAssetReconciliation {
  const scannedByPath = new Map(scannedAssets.flatMap((asset) => asset.localPath ? [[asset.localPath, asset] as const] : []));
  const scannedByFingerprint = new Map<string, SessionAsset[]>();
  for (const asset of scannedAssets) {
    if (!asset.fingerprint) continue;
    scannedByFingerprint.set(asset.fingerprint, [...(scannedByFingerprint.get(asset.fingerprint) ?? []), asset]);
  }
  const matchedPaths = new Set<string>();
  const relinkedPaths = new Set<string>();
  let missingCount = 0;
  let relinkedCount = 0;
  const withMetadata = (asset: SessionAsset, scanned: SessionAsset, relink: boolean): SessionAsset => ({
    ...asset,
    localPath: scanned.localPath ?? asset.localPath,
    mimeType: scanned.mimeType,
    kind: scanned.kind,
    byteSize: scanned.byteSize ?? asset.byteSize,
    width: scanned.width ?? asset.width,
    height: scanned.height ?? asset.height,
    duration: scanned.duration ?? asset.duration,
    fps: scanned.fps ?? asset.fps,
    codec: scanned.codec ?? asset.codec,
    fingerprint: scanned.fingerprint ?? asset.fingerprint,
    storageAvailability: "available",
    ...(relink ? { externalUrl: undefined } : {}),
  });
  let sessions = state.sessions.map((session) => ({
    ...session,
    assets: session.assets.map((asset) => {
      if (!asset.localPath) return asset;
      const exact = scannedByPath.get(asset.localPath);
      if (exact) {
        matchedPaths.add(asset.localPath);
        return withMetadata(asset, exact, false);
      }
      const fingerprintMatch = asset.fingerprint
        ? (scannedByFingerprint.get(asset.fingerprint) ?? []).find((candidate) =>
          candidate.localPath && !matchedPaths.has(candidate.localPath) && !relinkedPaths.has(candidate.localPath))
        : undefined;
      if (fingerprintMatch?.localPath) {
        matchedPaths.add(fingerprintMatch.localPath);
        relinkedPaths.add(fingerprintMatch.localPath);
        relinkedCount += 1;
        return withMetadata(asset, fingerprintMatch, true);
      }
      missingCount += 1;
      return { ...asset, storageAvailability: "missing" as const };
    }),
  }));
  const knownFingerprints = new Set(sessions.flatMap((session) => session.assets.flatMap((asset) => asset.fingerprint ? [asset.fingerprint] : [])));
  const unmatched = scannedAssets.filter((asset) => !asset.localPath || !matchedPaths.has(asset.localPath));
  const duplicateFiles = unmatched.filter((asset) => asset.fingerprint && knownFingerprints.has(asset.fingerprint));
  const recovered = unmatched.filter((asset) => !asset.fingerprint || !knownFingerprints.has(asset.fingerprint));
  if (recovered.length) {
    sessions = sessions.map((session) => session.id === state.activeSessionId
      ? { ...session, assets: [...session.assets, ...recovered] }
      : session);
  }
  return {
    state: { ...state, sessions },
    missingCount,
    relinkedCount,
    recoveredCount: recovered.length,
    duplicateFiles,
  };
}

const SHARED_ASSET_CHUNK_BYTES = 4 * 1024 * 1024;

async function materializeBlob(
  blob: Blob,
  input: { assetId: string; name: string; mimeType: string; origin: AssetOrigin },
): Promise<{ path: string }> {
  const uploadId = crypto.randomUUID();
  try {
    for (let offset = 0; offset < blob.size; offset += SHARED_ASSET_CHUNK_BYTES) {
      const chunk = new Uint8Array(await blob.slice(offset, offset + SHARED_ASSET_CHUNK_BYTES).arrayBuffer());
      await invoke("append_asset_chunk", chunk, {
        headers: {
          "x-fruit-truck-upload-id": uploadId,
          "x-fruit-truck-origin": input.origin,
        },
      });
    }
    return await invoke<{ path: string }>("finish_asset_upload", { uploadId, input });
  } catch (error) {
    await invoke("abort_asset_upload", { uploadId, origin: input.origin }).catch(() => undefined);
    throw error;
  }
}

const legacyMaterializations = new Map<string, Promise<SessionAsset>>();

async function materializeLegacyAssetOnce(asset: SessionAsset): Promise<SessionAsset> {
  if (asset.localPath) return asset;
  const legacyDataUrl = asset.externalUrl?.startsWith("data:") ? asset.externalUrl : undefined;
  const blob = asset.blobKey
    ? await loadAssetBlob(asset.blobKey)
    : legacyDataUrl
      ? await fetch(legacyDataUrl).then((response) => response.blob())
      : null;
  if (!blob) return asset;
  if (!isTauriRuntime()) {
    const blobKey = asset.blobKey ?? `asset:${asset.id}`;
    await storeAssetBlob(blobKey, blob);
    return { ...asset, blobKey, externalUrl: legacyDataUrl ? undefined : asset.externalUrl };
  }
  const materialized = await materializeBlob(blob, {
    assetId: asset.id,
    name: asset.name,
    mimeType: asset.mimeType,
    origin: asset.origin,
  });
  if (!materialized.path) throw new Error(`Could not migrate ${asset.name} into managed storage.`);
  const migrated: SessionAsset = {
    ...asset,
    localPath: materialized.path,
    blobKey: undefined,
    externalUrl: legacyDataUrl ? undefined : asset.externalUrl,
  };
  return migrated;
}

export async function migrateLegacyAsset(asset: SessionAsset): Promise<SessionAsset> {
  const migrated = await materializeLegacyAssetForBridge(asset);
  if (asset.blobKey && migrated.localPath) await deleteAssetBlob(asset.blobKey);
  return migrated;
}

export async function materializeLegacyAssetForBridge(asset: SessionAsset): Promise<SessionAsset> {
  const existing = legacyMaterializations.get(asset.id);
  if (existing) return existing;
  const materialization = materializeLegacyAssetOnce(asset);
  legacyMaterializations.set(asset.id, materialization);
  try {
    return await materialization;
  } finally {
    if (legacyMaterializations.get(asset.id) === materialization) {
      legacyMaterializations.delete(asset.id);
    }
  }
}

export async function materializeRequestBlob(blob: Blob, name: string): Promise<string> {
  if (!isTauriRuntime()) return blobToDataUrl(blob);
  const materialized = await materializeBlob(blob, {
    assetId: crypto.randomUUID(),
    name,
    mimeType: blob.type || "image/png",
    origin: "edited",
  });
  return `${LOCAL_MEDIA_MARKER}${materialized.path}`;
}

export async function importGeneratedImage(
  source: string,
  name: string,
  origin: AssetOrigin,
  _output?: { resolution?: string; aspectRatio?: string },
): Promise<SessionAsset> {
  const id = crypto.randomUUID();
  if (isTauriRuntime() && /^(?:\/|[A-Za-z]:[\\/])/.test(source)) {
    const mimeType = mediaMimeFromSource(source, "image/png");
    const asset: SessionAsset = {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "image",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      localPath: source,
    };
    // Generated output is an immutable provider original. Native inspection
    // may enrich dimensions/codec metadata, but it must never rewrite the file.
    return inspectSessionAssetMetadata(asset, undefined, { strict: true });
  }
  const blobKey = `asset:${id}`;
  let storedBlob: Blob;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error("Could not cache generated image");
    // Keep the provider bytes and MIME type exactly as returned. Any requested
    // resize/crop is an explicit derivative operation (see deriveImageAsset).
    storedBlob = await response.blob();
    await storeAssetBlob(blobKey, storedBlob);
    const mimeType = storedBlob.type || mediaMimeFromSource(source, "image/png");
    const asset: SessionAsset = {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "image",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      blobKey,
      byteSize: storedBlob.size,
    };
    const inspectionSource = typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(storedBlob)
      : undefined;
    if (!inspectionSource) throw new Error("Could not create a local inspection source for the generated image.");
    try {
      return await inspectSessionAssetMetadata(asset, inspectionSource, { strict: true });
    } catch (error) {
      await deleteAssetBlob(blobKey).catch(() => undefined);
      throw error;
    }
  } finally {
    if (source.startsWith("blob:")) URL.revokeObjectURL(source);
  }
}

export async function importGeneratedVideo(
  source: string,
  name: string,
  origin: AssetOrigin,
  jobId: string,
  duration?: number,
): Promise<SessionAsset> {
  const id = crypto.randomUUID();
  if (isTauriRuntime() && /^(?:\/|[A-Za-z]:[\\/])/.test(source)) {
    const mimeType = mediaMimeFromSource(source, "video/mp4");
    const asset: SessionAsset = {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "video",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      localPath: source,
      jobId,
      duration,
    };
    return inspectSessionAssetMetadata(asset, undefined, { strict: true });
  }
  const blobKey = `asset:${id}`;
  let storedBlob: Blob;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error("Could not cache generated video");
    storedBlob = await response.blob();
    await storeAssetBlob(blobKey, storedBlob);
    const mimeType = storedBlob.type || mediaMimeFromSource(source, "video/mp4");
    const asset: SessionAsset = {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "video",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      blobKey,
      byteSize: storedBlob.size,
      jobId,
      duration,
    };
    const inspectionSource = typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(storedBlob)
      : undefined;
    if (!inspectionSource) throw new Error("Could not create a local inspection source for the generated video.");
    try {
      return await inspectSessionAssetMetadata(asset, inspectionSource, { strict: true });
    } catch (error) {
      await deleteAssetBlob(blobKey).catch(() => undefined);
      throw error;
    }
  } finally {
    if (source.startsWith("blob:")) URL.revokeObjectURL(source);
  }
}

export async function resolveAssetSource(asset: SessionAsset): Promise<string> {
  if (asset.localPath && isTauriRuntime()) return convertFileSrc(asset.localPath);
  if (asset.externalUrl) {
    return asset.externalUrl;
  }
  if (!asset.blobKey) return "";
  const blob = await loadAssetBlob(asset.blobKey);
  return blob ? URL.createObjectURL(blob) : "";
}

function dataUrlToObjectUrl(source: string): string {
  const match = source.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error("The managed image payload is invalid.");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: match[1] }));
}

export async function resolveAssetMaskSource(asset: SessionAsset): Promise<string> {
  if (asset.localPath && isTauriRuntime()) {
    const dataUrl = await invoke<string>("read_managed_image_data_url", { path: asset.localPath });
    return dataUrlToObjectUrl(dataUrl);
  }
  return resolveAssetSource(asset);
}

export async function exportAssetToDownloads(asset: SessionAsset): Promise<string> {
  if (isTauriRuntime()) {
    const exportable = asset.localPath ? asset : await materializeLegacyAssetForBridge(asset);
    if (!exportable.localPath) throw new Error(`${asset.name} is not available in local managed storage.`);
    return invoke<string>("export_managed_asset", {
      path: exportable.localPath,
      name: asset.name,
    });
  }
  const source = await resolveAssetSource(asset);
  if (!source) throw new Error(`${asset.name} has no readable source.`);
  const anchor = document.createElement("a");
  anchor.href = source;
  anchor.download = asset.name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (source.startsWith("blob:")) window.setTimeout(() => URL.revokeObjectURL(source), 1_000);
  return asset.name;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read asset"));
    reader.readAsDataURL(blob);
  });
}

export async function assetRequestUrl(asset: SessionAsset): Promise<string> {
  if (asset.localPath) {
    if (!isTauriRuntime()) throw new Error(`${asset.name} requires the desktop runtime.`);
    return `${LOCAL_MEDIA_MARKER}${asset.localPath}`;
  }
  if (asset.blobKey) {
    const blob = await loadAssetBlob(asset.blobKey);
    if (!blob) throw new Error(`${asset.name} is missing from local storage.`);
    return blobToDataUrl(blob);
  }
  if (asset.externalUrl) {
    return asset.externalUrl;
  }
  throw new Error(`${asset.name} has no readable source.`);
}

export function nextReferenceSlot(references: DraftReference[]): number {
  const used = new Set(references.map((reference) => reference.slot));
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return slot;
}
