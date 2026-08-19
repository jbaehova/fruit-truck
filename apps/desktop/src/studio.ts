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
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type AssetKind = "image" | "video" | "audio";
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
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  facePresence?: "present" | "absent" | "unknown";
  byteSize?: number;
  fingerprint?: string;
  sourceUrl?: string;
  sourcePageUrl?: string;
  license?: string;
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

export type GenerationAttemptSnapshot = {
  mode: GenerationMode;
  modelId: string;
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
};

export type GenerationThread = {
  id: string;
  name: string;
  mode: GenerationMode;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  revision: number;
  modelOverrideId?: string;
  optionOverrides: DraftOptions;
  providerJsonOverride?: string;
  draft: GenerationDraftState;
  attempts: GenerationAttempt[];
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
};

export type StudioState = {
  schemaVersion: 6;
  activeSessionId: string;
  promptModel: PromptModel;
  defaultEnhancePrompt: boolean;
  sessions: StudioSession[];
};

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

const STORAGE_KEY = "fruit-truck.studio.v1";
const LEGACY_ACTIVE_VIDEO_KEY = "fruit-truck.active-video-job";
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

function createInitialStudioState(): StudioState {
  const session = createSession("First session");
  return {
    schemaVersion: 6,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    sessions: [session],
  };
}

function validCurrentState(value: unknown): value is StudioState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<StudioState>;
  return state.schemaVersion === 6
    && typeof state.activeSessionId === "string"
    && typeof state.defaultEnhancePrompt === "boolean"
    && Array.isArray(state.sessions)
    && state.sessions.length > 0;
}

function normalizeCurrentSession(session: StudioSession, defaultEnhancePrompt: boolean): StudioSession {
  const assetKinds = new Map(session.assets?.map((asset) => [asset.id, asset.kind]) ?? []);
  const normalizeThread = (thread: GenerationThread): GenerationThread => ({
    ...thread,
    draft: {
      ...emptyDraft(defaultEnhancePrompt),
      ...thread.draft,
      enhancePrompt: typeof thread.draft?.enhancePrompt === "boolean"
        ? thread.draft.enhancePrompt
        : defaultEnhancePrompt,
      references: Array.isArray(thread.draft?.references) ? thread.draft.references.map((reference) => {
        const isEditTarget = thread.mode === "image"
          && thread.draft?.imageEditMode
          && `@${reference.slot}` === thread.draft.imageEditTarget;
        const normalized: DraftReference = {
          ...reference,
          purpose: reference.role === "first_frame"
              ? "first_frame"
              : reference.role === "last_frame"
                ? "last_frame"
                : reference.purpose ?? defaultReferencePurpose(
                  assetKinds.get(reference.assetId) ?? "image",
                  reference.role,
                ),
        };
        return isEditTarget
          ? markReferenceAsEditTarget(normalized)
          : restoreReferenceAfterEditTarget(normalized, assetKinds.get(reference.assetId) ?? "image");
      }) : [],
      maskStrokes: Array.isArray(thread.draft?.maskStrokes) ? thread.draft.maskStrokes : [],
    },
    attempts: Array.isArray(thread.attempts) ? thread.attempts : [],
  });
  return {
    ...session,
    assets: Array.isArray(session.assets) ? session.assets : [],
    threads: {
      image: session.threads.image.map(normalizeThread),
      video: session.threads.video.map(normalizeThread),
    },
    costLedger: Array.isArray(session.costLedger) ? session.costLedger : [],
  };
}

export function loadStudioState(): StudioState {
  if (typeof localStorage === "undefined") return createInitialStudioState();
  localStorage.removeItem(LEGACY_ACTIVE_VIDEO_KEY);
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createInitialStudioState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!validCurrentState(parsed)) return createInitialStudioState();
    const state: StudioState = {
      ...parsed,
      sessions: parsed.sessions.map((session) => normalizeCurrentSession(session, parsed.defaultEnhancePrompt)),
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
      }))])) as StudioSession["threads"],
      costLedger: session.costLedger.slice(-500),
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

type BrowserFaceDetector = new (options?: { maxDetectedFaces?: number; fastMode?: boolean }) => {
  detect(source: CanvasImageSource): Promise<unknown[]>;
};

type NativeMediaMetadata = {
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  codec?: string;
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

export async function inspectSessionAssetMetadata(asset: SessionAsset, suppliedSource?: string): Promise<SessionAsset> {
  const source = suppliedSource ?? await resolveAssetSource(asset);
  const nativeMetadata: NativeMediaMetadata = asset.localPath && isTauriRuntime()
    ? await invoke<NativeMediaMetadata>("inspect_managed_asset", { path: asset.localPath }).catch(() => ({}))
    : {};
  try {
    if (asset.kind === "audio") return { ...asset, duration: nativeMetadata.duration ?? await loadAudioDuration(source), codec: nativeMetadata.codec };
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
      fps: nativeMetadata.fps,
      codec: nativeMetadata.codec,
      facePresence,
    };
  } catch {
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
  if (clean.endsWith(".png")) return "image/png";
  return fallback;
}

export function mediaNameForMime(name: string, mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg"
    : mimeType === "image/webp" ? "webp"
      : mimeType === "image/gif" ? "gif"
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
