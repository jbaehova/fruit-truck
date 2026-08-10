import type {
  DraftOptions,
  GenerationModel,
  GenerationMode,
  ReferenceRole,
  VideoResult,
} from "./openrouter.ts";
import { defaultOptions, isTauriRuntime } from "./openrouter.ts";
import { migrateLegacyInputMentions } from "./inputMentions.ts";
import { createAgentState, normalizeAgentState, type AgentSessionState } from "./agent.ts";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

type AssetKind = "image" | "video";
export type AssetOrigin = "upload" | "generated" | "edited";
export type PromptModel = "openai/gpt-5.6-luna" | "openai/gpt-5.6-terra";

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
  byteSize?: number;
  fingerprint?: string;
  bridgeAvailability?: "available" | "desktop_only";
  sourceUrl?: string;
  sourcePageUrl?: string;
  license?: string;
};

export type DraftReference = {
  assetId: string;
  slot: number;
  role: ReferenceRole;
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
  imageEditMode: boolean;
  imageEditTarget: string;
  maskInstructions: string;
  maskStrokes: MaskStroke[];
};

export type SessionVideoJob = VideoResult & {
  threadId?: string;
  attemptId?: string;
  model: string;
  submittedAt: string;
  pollAttempts?: number;
  lastPolledAt?: string;
  nextPollAt?: string;
  request: Record<string, unknown>;
  inputAssetIds?: string[];
};

export type GenerationAttemptStatus =
  | "queued"
  | "enhancing"
  | "awaiting_host"
  | "submitting"
  | "in_progress"
  | "completed"
  | "failed"
  | "uncertain"
  | "canceled";

export type GenerationAttemptSnapshot = {
  mode: GenerationMode;
  modelId: string;
  outputRole: string;
  prompt: string;
  enhancePrompt: boolean;
  enhancedPrompt: string;
  options: DraftOptions;
  providerJson: string;
  assetBindings: DraftReference[];
  imageEditMode: boolean;
  imageEditTarget: string;
  maskInstructions: string;
  maskStrokes: MaskStroke[];
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
};

export type GenerationAttempt = {
  id: string;
  requestKey?: string;
  status: GenerationAttemptStatus;
  backend: "openrouter" | "codex_builtin";
  draftRevision: number;
  requestedBy: "human" | "agent";
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
};

export type GenerationThread = {
  id: string;
  requestKey?: string;
  name: string;
  mode: GenerationMode;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  revision: number;
  outputRole: string;
  modelOverrideId?: string;
  optionOverrides: DraftOptions;
  providerJsonOverride?: string;
  draft: GenerationDraftState;
  attempts: GenerationAttempt[];
  enhancementAttempts: PromptEnhancementAttempt[];
};

export type GenerationDefaults = {
  modelIds: Record<GenerationMode, string>;
  options: Record<GenerationMode, DraftOptions>;
  providerJson: Record<GenerationMode, string>;
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
  agent: AgentSessionState;
  agentBridge?: boolean;
};

export type StudioState = {
  schemaVersion: 5;
  activeSessionId: string;
  promptModel: PromptModel;
  sessions: StudioSession[];
};

const STORAGE_KEY = "fruit-truck.studio.v1";
const LEGACY_ACTIVE_VIDEO_KEY = "fruit-truck.active-video-job";
const DB_NAME = "fruit-truck-assets";
const DB_VERSION = 1;
const BLOB_STORE = "blobs";
const memoryBlobs = new Map<string, Blob>();
const LOCAL_MEDIA_MARKER = "fruit-truck-local:";
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 700 * 1024 * 1024;

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

export function emptyDraft(): GenerationDraftState {
  return {
    prompt: "",
    references: [],
    options: {},
    providerJson: "",
    enhancePrompt: true,
    enhancedPrompt: "",
    enhancedPromptDirty: false,
    enhancedVisualCount: 0,
    imageEditMode: false,
    imageEditTarget: "",
    maskInstructions: "",
    maskStrokes: [],
  };
}

export function beginGeneratedImageEdit(draft: GenerationDraftState, assetId: string): GenerationDraftState {
  return {
    ...draft,
    references: [{ assetId, slot: 1, role: "reference" }],
    imageEditMode: true,
    imageEditTarget: "@1",
    maskInstructions: "",
    maskStrokes: [],
    enhancedPrompt: "",
    enhancedPromptDirty: false,
    enhancedVisualCount: 0,
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
    outputRole: mode === "image" ? "generated_image" : "generated_video",
    optionOverrides: { ...draft.options },
    providerJsonOverride: draft.providerJson || undefined,
    draft: { ...draft, options: {}, providerJson: "" },
    attempts: [],
    enhancementAttempts: [],
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
): GenerationThread {
  const next = createGenerationThread(
    source.mode,
    index,
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

export function createSession(name = "Untitled session"): StudioSession {
  const now = new Date().toISOString();
  const imageThread = createGenerationThread("image");
  const videoThread = createGenerationThread("video");
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
    agent: createAgentState(),
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
  const imageModel = catalogs.image[0] ?? null;
  const videoModel = catalogs.video[0] ?? null;
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

function createInitialStudioState(): StudioState {
  const session = createSession("First session");
  return {
    schemaVersion: 5,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    sessions: [session],
  };
}

function validState(value: unknown): value is StudioState | (Omit<StudioState, "schemaVersion"> & { schemaVersion: 1 | 2 | 3 | 4 }) {
  if (!value || typeof value !== "object") return false;
  const state = value as { schemaVersion?: number; activeSessionId?: unknown; sessions?: unknown };
  return (state.schemaVersion === 1 || state.schemaVersion === 2 || state.schemaVersion === 3 || state.schemaVersion === 4 || state.schemaVersion === 5)
    && typeof state.activeSessionId === "string"
    && Array.isArray(state.sessions)
    && state.sessions.length > 0;
}

function normalizeDraft(draft: GenerationDraftState | undefined, migrateLegacyMentions = false): GenerationDraftState {
  const value = draft ?? emptyDraft();
  const references = Array.isArray(value.references) ? value.references : [];
  const slots = references.map((reference) => reference.slot);
  const migrate = (text: string | undefined) => migrateLegacyMentions
    ? migrateLegacyInputMentions(text ?? "", slots)
    : text ?? "";
  return {
    ...emptyDraft(),
    ...value,
    prompt: migrate(value.prompt),
    references,
    enhancedPrompt: migrate(value.enhancedPrompt),
    imageEditTarget: migrate(value.imageEditTarget),
    enhancedVisualCount: typeof value.enhancedVisualCount === "number" && value.enhancedVisualCount > 0
      ? Math.floor(value.enhancedVisualCount)
      : 0,
    maskInstructions: migrate(value.maskInstructions),
    maskStrokes: Array.isArray(value.maskStrokes)
      ? value.maskStrokes.map((stroke) => ({ ...stroke, operation: stroke.operation === "erase" ? "erase" as const : "paint" as const }))
      : [],
  };
}

function hasDraftContent(draft: GenerationDraftState | undefined) {
  if (!draft) return false;
  return Boolean(draft.prompt.trim() || draft.references.length || Object.keys(draft.options).length || draft.providerJson.trim());
}

function normalizeSession(session: StudioSession, migrateLegacyMentions = false): StudioSession {
  type LegacyWorkflow = "generate" | "edit";
  type LegacyThread = GenerationThread & Partial<{
    videoWorkflow: LegacyWorkflow;
    videoWorkflowStates: Record<string, unknown>;
  }>;
  type LegacyDefaults = Partial<GenerationDefaults> & {
    options?: Partial<Record<GenerationMode | "videoGenerate" | "videoEdit", DraftOptions>>;
    providerJson?: Partial<Record<GenerationMode | "videoGenerate" | "videoEdit", string>>;
  };
  type LegacyVideoJob = SessionVideoJob & { workflow?: LegacyWorkflow };
  const legacy = session as StudioSession & Partial<{
    videoWorkflow: LegacyWorkflow;
    selectedModelIds: Record<GenerationMode, string>;
    drafts: { image: GenerationDraftState; videoGenerate: GenerationDraftState; videoEdit: GenerationDraftState };
    activeVideoJobs: LegacyVideoJob[];
    lastResultAssetIds: Record<GenerationMode, string[]>;
    generationDefaults: LegacyDefaults;
  }>;
  const legacyDrafts = legacy.drafts ?? { image: emptyDraft(), videoGenerate: emptyDraft(), videoEdit: emptyDraft() };
  const imageDraft = normalizeDraft(legacyDrafts.image, migrateLegacyMentions);
  const videoGenerateDraft = normalizeDraft(legacyDrafts.videoGenerate, migrateLegacyMentions);
  const existingThreads = session.threads;
  const normalizeThread = (thread: LegacyThread, mode: GenerationMode): GenerationThread => {
    const { videoWorkflow: _threadWorkflow, videoWorkflowStates: _workflowStates, ...canonicalThread } = thread;
    const draft = normalizeDraft(thread.draft, migrateLegacyMentions);
    const references = draft.references.filter((reference) => (reference.role as string) !== "video_reference");
    const attempts = (thread.attempts ?? []).flatMap((attempt) => {
      const legacySnapshot = attempt.snapshot as (GenerationAttemptSnapshot & { videoWorkflow?: LegacyWorkflow }) | undefined;
      const legacyEditAttempt = mode === "video" && (thread.videoWorkflow === "edit"
        || legacySnapshot?.videoWorkflow === "edit"
        || legacySnapshot?.assetBindings?.some((reference) => (reference.role as string) === "video_reference"));
      if (legacyEditAttempt) return [];
      if (!legacySnapshot) return [{ ...attempt }];
      const { videoWorkflow: _snapshotWorkflow, ...snapshot } = legacySnapshot;
      return [{
        ...attempt,
        snapshot: {
          ...snapshot,
          assetBindings: (snapshot.assetBindings ?? []).filter((reference) => (reference.role as string) !== "video_reference"),
        },
      }];
    });
    return {
      ...canonicalThread,
      mode,
      draft: { ...draft, references },
      optionOverrides: thread.optionOverrides ?? thread.draft.options ?? {},
      attempts,
      enhancementAttempts: thread.enhancementAttempts ?? [],
      revision: thread.revision ?? 0,
    };
  };
  const imageThreads = existingThreads?.image?.length
    ? existingThreads.image.map((thread) => normalizeThread(thread as LegacyThread, "image"))
    : [createGenerationThread("image", 1, imageDraft)];
  const legacyEditThreadIds = new Set((existingThreads?.video ?? [])
    .filter((thread) => (thread as LegacyThread).videoWorkflow === "edit")
    .map((thread) => thread.id));
  const legacyEditJobIds = new Set<string>();
  for (const thread of (existingThreads?.video ?? []) as LegacyThread[]) {
    for (const attempt of thread.attempts ?? []) {
      const snapshot = attempt.snapshot as (GenerationAttemptSnapshot & { videoWorkflow?: LegacyWorkflow }) | undefined;
      const legacyEditAttempt = thread.videoWorkflow === "edit"
        || snapshot?.videoWorkflow === "edit"
        || snapshot?.assetBindings?.some((reference) => (reference.role as string) === "video_reference");
      if (legacyEditAttempt && attempt.jobId) legacyEditJobIds.add(attempt.jobId);
    }
  }
  for (const job of legacy.activeVideoJobs ?? []) {
    if (job.workflow === "edit" || (job.threadId ? legacyEditThreadIds.has(job.threadId) : false)) {
      legacyEditJobIds.add(job.jobId);
    }
  }
  let videoThreads = existingThreads?.video?.length
    ? existingThreads.video
      .filter((thread) => (thread as LegacyThread).videoWorkflow !== "edit")
      .map((thread) => normalizeThread(thread as LegacyThread, "video"))
    : hasDraftContent(videoGenerateDraft)
      ? [createGenerationThread("video", 1, videoGenerateDraft)]
      : [];
  if (!videoThreads.length) videoThreads = [createGenerationThread("video")];
  for (const job of legacy.activeVideoJobs ?? []) {
    const legacyEditJob = job.workflow === "edit" || (job.threadId ? legacyEditThreadIds.has(job.threadId) : false);
    if (legacyEditJob) continue;
    if (videoThreads.some((thread) => thread.attempts.some((attempt) => attempt.jobId === job.jobId))) continue;
    let target = job.threadId ? videoThreads.find((thread) => thread.id === job.threadId) : undefined;
    if (!target) {
      target = !activeGenerationAttempt(videoThreads[0]) ? videoThreads[0] : createGenerationThread("video", videoThreads.length + 1);
    }
    const attempt: GenerationAttempt = {
      id: job.attemptId ?? crypto.randomUUID(),
      status: job.status === "completed" || job.status === "failed" ? job.status : "in_progress",
      backend: "openrouter",
      draftRevision: target.revision,
      requestedBy: "human",
      createdAt: job.submittedAt,
      updatedAt: job.lastPolledAt ?? job.submittedAt,
      submittedAt: job.submittedAt,
      modelId: job.model,
      request: job.request,
      inputAssetIds: job.inputAssetIds ?? [],
      assetIds: [],
      jobId: job.jobId,
      progress: job.progress,
      error: job.error,
      pollAttempts: job.pollAttempts,
      lastPolledAt: job.lastPolledAt,
      nextPollAt: job.nextPollAt,
    };
    target.attempts = [...target.attempts, attempt];
    if (!videoThreads.includes(target)) videoThreads.push(target);
  }
  const storedDefaults = legacy.generationDefaults;
  const generationDefaults: GenerationDefaults = {
    modelIds: {
      image: storedDefaults?.modelIds?.image ?? legacy.selectedModelIds?.image ?? "",
      video: storedDefaults?.modelIds?.video ?? legacy.selectedModelIds?.video ?? "",
    },
    options: {
      image: storedDefaults?.options?.image ?? {},
      video: storedDefaults?.options?.video ?? storedDefaults?.options?.videoGenerate ?? {},
    },
    providerJson: {
      image: storedDefaults?.providerJson?.image ?? "",
      video: storedDefaults?.providerJson?.video ?? storedDefaults?.providerJson?.videoGenerate ?? "",
    },
  };
  const activeThreadIds = {
    image: imageThreads.some((thread) => thread.id === session.activeThreadIds?.image) ? session.activeThreadIds.image : imageThreads[0].id,
    video: videoThreads.some((thread) => thread.id === session.activeThreadIds?.video) ? session.activeThreadIds.video : videoThreads[0].id,
  };
  const agent = session.agent ? normalizeAgentState(session.agent) : createAgentState();
  agent.execution.currentJobIds = agent.execution.currentJobIds.filter((jobId) => !legacyEditJobIds.has(jobId));
  const { videoWorkflow: _videoWorkflow, selectedModelIds: _selectedModelIds, drafts: _drafts, activeVideoJobs: _activeVideoJobs, lastResultAssetIds: legacyResults, ...canonical } = legacy;
  for (const [mode, threads] of [["image", imageThreads], ["video", videoThreads]] as const) {
    const resultIds = legacyResults?.[mode]?.filter((id) => (session.assets ?? []).some((asset) => asset.id === id)) ?? [];
    if (resultIds.length && !threads.some((thread) => thread.attempts.some((attempt) => attempt.assetIds.length))) {
      const target = threads.find((thread) => thread.id === activeThreadIds[mode]) ?? threads[0];
      const now = target.updatedAt;
      target.attempts.push({ id: crypto.randomUUID(), status: "completed", backend: "openrouter", draftRevision: target.revision, requestedBy: "human", createdAt: now, updatedAt: now, completedAt: now, inputAssetIds: [], assetIds: resultIds });
    }
  }
  return {
    ...canonical,
    assets: (session.assets ?? []).map((asset) => {
      const legacyLocalPath = asset.externalUrl && /^(?:\/|[A-Za-z]:[\\/])/.test(asset.externalUrl) ? asset.externalUrl : undefined;
      return { ...asset, localPath: asset.localPath ?? legacyLocalPath, externalUrl: legacyLocalPath ? undefined : asset.externalUrl };
    }),
    generationDefaults,
    threads: { image: imageThreads, video: videoThreads },
    activeThreadIds,
    agent,
  };
}

export function loadStudioState(): StudioState {
  if (typeof localStorage === "undefined") return createInitialStudioState();
  localStorage.removeItem(LEGACY_ACTIVE_VIDEO_KEY);
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createInitialStudioState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!validState(parsed)) return createInitialStudioState();
    const state: StudioState = {
      ...parsed,
      schemaVersion: 5,
      sessions: parsed.sessions.map((session) => normalizeSession(session as StudioSession, parsed.schemaVersion < 4)),
    };
    if (!state.sessions.some((session) => session.id === state.activeSessionId)) {
      state.activeSessionId = state.sessions[0].id;
    }
    if (!PROMPT_MODELS.some((model) => model.id === state.promptModel)) {
      state.promptModel = "openai/gpt-5.6-luna";
    }
    return state;
  } catch {
    return createInitialStudioState();
  }
}

export function saveStudioState(state: StudioState) {
  if (typeof localStorage === "undefined") return;
  const bounded = {
    ...state,
    sessions: state.sessions.map((session) => ({
      ...session,
      threads: Object.fromEntries(Object.entries(session.threads).map(([mode, threads]) => [mode, threads.map((thread) => ({
        ...thread,
        attempts: thread.attempts.filter((attempt) => !["completed", "failed", "uncertain", "canceled"].includes(attempt.status)).concat(
          thread.attempts.filter((attempt) => ["completed", "failed", "uncertain", "canceled"].includes(attempt.status)).slice(-100),
        ),
        enhancementAttempts: thread.enhancementAttempts.filter((attempt) => attempt.status === "in_progress").concat(
          thread.enhancementAttempts.filter((attempt) => attempt.status !== "in_progress").slice(-100),
        ),
      }))])) as StudioSession["threads"],
      agent: {
        ...session.agent,
        activity: session.agent.activity.slice(-500),
      },
    })),
  };
  const serialized = JSON.stringify(bounded);
  if (/"(?:externalUrl|localPath)"\s*:\s*"data:(?:image|video)\//i.test(serialized)
    || /;base64,/i.test(serialized)) {
    throw new Error("Media data URLs cannot be written to studio metadata.");
  }
  localStorage.setItem(STORAGE_KEY, serialized);
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

export async function deleteSessionBlobs(session: StudioSession): Promise<void> {
  await Promise.all(session.assets.flatMap((asset) => [
    ...(asset.blobKey ? [deleteAssetBlob(asset.blobKey)] : []),
    ...(asset.localPath && isTauriRuntime()
      ? [invoke<void>("delete_managed_asset", { path: asset.localPath })]
      : []),
  ]));
}

export async function deleteManagedAsset(asset: SessionAsset): Promise<void> {
  if (asset.blobKey) await deleteAssetBlob(asset.blobKey);
  if (asset.localPath && isTauriRuntime()) {
    await invoke<void>("delete_managed_asset", { path: asset.localPath });
  }
}

export async function importFileAsset(file: File, origin: AssetOrigin = "upload"): Promise<SessionAsset> {
  const kind: AssetKind | null = file.type.startsWith("image/")
    ? "image"
    : file.type.startsWith("video/")
      ? "video"
      : null;
  if (!kind) throw new Error(`${file.name} is not a supported image or video.`);
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  const limit = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > limit) {
    throw new Error(`${file.name} exceeds the ${kind === "video" ? "700 MB" : "30 MB"} local safety limit.`);
  }
  const id = crypto.randomUUID();
  const blobKey = `asset:${id}`;
  await storeAssetBlob(blobKey, file);
  return {
    id,
    name: file.name,
    kind,
    mimeType: file.type || (kind === "image" ? "image/png" : "video/mp4"),
    origin,
    createdAt: new Date().toISOString(),
    blobKey,
    byteSize: file.size,
    fingerprint: `${file.name}:${file.size}:${file.lastModified}:${file.type}`,
  };
}

export function mediaMimeFromSource(source: string, fallback: string): string {
  const dataMime = source.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();
  if (dataMime?.startsWith("image/") || dataMime?.startsWith("video/")) return dataMime;
  const clean = source.split(/[?#]/, 1)[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".mov")) return "video/quicktime";
  if (clean.endsWith(".mp4")) return "video/mp4";
  if (clean.endsWith(".png")) return "image/png";
  return fallback;
}

export function mediaNameForMime(name: string, mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg"
    : mimeType === "image/webp" ? "webp"
      : mimeType === "image/gif" ? "gif"
        : mimeType === "video/webm" ? "webm"
          : mimeType === "video/quicktime" ? "mov"
            : mimeType.startsWith("video/") ? "mp4" : "png";
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

function sessionAssetFromManaged(
  asset: NativeManagedAsset,
  origin: AssetOrigin = "upload",
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
    bridgeAvailability: "available",
  };
}

export async function pickManagedAssets(): Promise<SessionAsset[]> {
  if (!isTauriRuntime()) return [];
  const assets = await invoke<NativeManagedAsset[]>("pick_and_import_assets");
  return assets.map((asset) => sessionAssetFromManaged(asset));
}

export function managedDroppedAssets(assets: NativeManagedAsset[]): SessionAsset[] {
  return assets.map((asset) => sessionAssetFromManaged(asset));
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
      await invoke("append_shared_asset_chunk", chunk, {
        headers: {
          "x-fruit-truck-upload-id": uploadId,
          "x-fruit-truck-origin": input.origin,
        },
      });
    }
    return await invoke<{ path: string }>("finish_shared_asset", { uploadId, input });
  } catch (error) {
    await invoke("abort_shared_asset", { uploadId, origin: input.origin }).catch(() => undefined);
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
    bridgeAvailability: "available",
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
  output?: { resolution?: string; aspectRatio?: string },
): Promise<SessionAsset> {
  const id = crypto.randomUUID();
  if (isTauriRuntime() && /^(?:\/|[A-Za-z]:[\\/])/.test(source)) {
    if (output?.resolution || output?.aspectRatio) {
      await invoke("normalize_generated_image", {
        path: source,
        resolution: output.resolution ?? null,
        aspectRatio: output.aspectRatio ?? null,
      });
    }
    const mimeType = mediaMimeFromSource(source, "image/png");
    return {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "image",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      localPath: source,
      bridgeAvailability: "available",
    };
  }
  const blobKey = `asset:${id}`;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error("Could not cache generated image");
    const blob = await normalizeGeneratedImageBlob(await response.blob(), output);
    await storeAssetBlob(blobKey, blob);
    const mimeType = blob.type || mediaMimeFromSource(source, "image/png");
    return {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "image",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      blobKey,
      byteSize: blob.size,
    };
  } catch {
    const mimeType = mediaMimeFromSource(source, "image/png");
    return {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "image",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      externalUrl: source,
    };
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
    return {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "video",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      localPath: source,
      jobId,
      duration,
      bridgeAvailability: "available",
    };
  }
  const blobKey = `asset:${id}`;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error("Could not cache generated video");
    const blob = await response.blob();
    await storeAssetBlob(blobKey, blob);
    const mimeType = blob.type || mediaMimeFromSource(source, "video/mp4");
    return {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "video",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      blobKey,
      byteSize: blob.size,
      jobId,
      duration,
    };
  } catch {
    const mimeType = mediaMimeFromSource(source, "video/mp4");
    return {
      id,
      name: mediaNameForMime(name, mimeType),
      kind: "video",
      mimeType,
      origin,
      createdAt: new Date().toISOString(),
      externalUrl: source,
      jobId,
      duration,
    };
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
