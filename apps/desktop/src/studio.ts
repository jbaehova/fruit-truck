import type {
  DraftOptions,
  GenerationMode,
  ReferenceRole,
  VideoWorkflow,
  VideoResult,
} from "@/openrouter";
import { fetchRemoteImageDataUrl, isTauriRuntime } from "@/openrouter";

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
  blobKey?: string;
  externalUrl?: string;
  jobId?: string;
  duration?: number;
  byteSize?: number;
  fingerprint?: string;
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
  imageEditMode: boolean;
  imageEditTarget: string;
  maskInstructions: string;
  maskStrokes: MaskStroke[];
};

export type SessionVideoJob = VideoResult & {
  workflow: VideoWorkflow;
  model: string;
  submittedAt: string;
  request: Record<string, unknown>;
};

export type StudioSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: GenerationMode;
  videoWorkflow: VideoWorkflow;
  selectedModelIds: Record<GenerationMode, string>;
  drafts: {
    image: GenerationDraftState;
    videoGenerate: GenerationDraftState;
    videoEdit: GenerationDraftState;
  };
  assets: SessionAsset[];
  activeVideoJobs: SessionVideoJob[];
  lastResultAssetIds: Record<"image" | "video", string[]>;
};

export type StudioState = {
  schemaVersion: 1;
  activeSessionId: string;
  promptModel: PromptModel;
  sessions: StudioSession[];
};

const STORAGE_KEY = "open-gen-ui.studio.v1";
const LEGACY_ACTIVE_VIDEO_KEY = "open-gen-ui.active-video-job";
const DB_NAME = "open-gen-ui-assets";
const DB_VERSION = 1;
const BLOB_STORE = "blobs";
const memoryBlobs = new Map<string, Blob>();

export const PROMPT_MODELS: Array<{
  id: PromptModel;
  label: string;
  effort: "xhigh" | "high";
}> = [
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", effort: "xhigh" },
  { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", effort: "high" },
];

function emptyDraft(): GenerationDraftState {
  return {
    prompt: "",
    references: [],
    options: {},
    providerJson: "",
    enhancePrompt: true,
    enhancedPrompt: "",
    enhancedPromptDirty: false,
    imageEditMode: false,
    imageEditTarget: "",
    maskInstructions: "",
    maskStrokes: [],
  };
}

export function createSession(name = "Untitled session"): StudioSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    mode: "image",
    videoWorkflow: "generate",
    selectedModelIds: { image: "", video: "" },
    drafts: {
      image: emptyDraft(),
      videoGenerate: emptyDraft(),
      videoEdit: emptyDraft(),
    },
    assets: [],
    activeVideoJobs: [],
    lastResultAssetIds: { image: [], video: [] },
  };
}

function createInitialStudioState(): StudioState {
  const session = createSession("First session");
  return {
    schemaVersion: 1,
    activeSessionId: session.id,
    promptModel: "openai/gpt-5.6-luna",
    sessions: [session],
  };
}

function validState(value: unknown): value is StudioState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<StudioState>;
  return state.schemaVersion === 1
    && typeof state.activeSessionId === "string"
    && Array.isArray(state.sessions)
    && state.sessions.length > 0;
}

export function loadStudioState(): StudioState {
  if (typeof localStorage === "undefined") return createInitialStudioState();
  localStorage.removeItem(LEGACY_ACTIVE_VIDEO_KEY);
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createInitialStudioState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!validState(parsed)) return createInitialStudioState();
    const state = {
      ...parsed,
      sessions: parsed.sessions.map((session) => ({
        ...session,
        drafts: Object.fromEntries(Object.entries(session.drafts).map(([key, draft]) => [
          key,
          {
            ...draft,
            maskInstructions: draft.maskInstructions ?? "",
            maskStrokes: Array.isArray(draft.maskStrokes)
              ? draft.maskStrokes.map((stroke) => ({
                ...stroke,
                operation: stroke.operation === "erase" ? "erase" as const : "paint" as const,
              }))
              : [],
          },
        ])) as StudioSession["drafts"],
      })),
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readwrite");
    tx.objectStore(BLOB_STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save asset data"));
  });
  db.close();
}

async function loadAssetBlob(key: string): Promise<Blob | null> {
  const db = await openAssetDb();
  if (!db) return memoryBlobs.get(key) ?? null;
  const value = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readonly");
    const request = tx.objectStore(BLOB_STORE).get(key);
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error("Could not load asset data"));
  });
  db.close();
  return value;
}

export async function deleteAssetBlob(key: string): Promise<void> {
  const db = await openAssetDb();
  if (!db) {
    memoryBlobs.delete(key);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE, "readwrite");
    tx.objectStore(BLOB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not delete asset data"));
  });
  db.close();
}

export async function deleteSessionBlobs(session: StudioSession): Promise<void> {
  await Promise.all(session.assets.flatMap((asset) => asset.blobKey ? [deleteAssetBlob(asset.blobKey)] : []));
}

export async function importFileAsset(file: File, origin: AssetOrigin = "upload"): Promise<SessionAsset> {
  const kind: AssetKind | null = file.type.startsWith("image/")
    ? "image"
    : file.type.startsWith("video/")
      ? "video"
      : null;
  if (!kind) throw new Error(`${file.name} is not a supported image or video.`);
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

export async function importGeneratedImage(
  source: string,
  name: string,
  origin: AssetOrigin,
): Promise<SessionAsset> {
  const id = crypto.randomUUID();
  const blobKey = `asset:${id}`;
  try {
    let response: Response;
    try {
      response = await fetch(source);
      if (!response.ok) throw new Error("Could not cache generated image");
    } catch (error) {
      if (!isTauriRuntime() || !/^https?:/i.test(source)) throw error;
      response = await fetch(await fetchRemoteImageDataUrl(source));
    }
    if (!response.ok) throw new Error("Could not cache generated image");
    const blob = await response.blob();
    await storeAssetBlob(blobKey, blob);
    return {
      id,
      name,
      kind: "image",
      mimeType: blob.type || "image/png",
      origin,
      createdAt: new Date().toISOString(),
      blobKey,
      byteSize: blob.size,
    };
  } catch {
    return {
      id,
      name,
      kind: "image",
      mimeType: "image/png",
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
): Promise<SessionAsset> {
  const id = crypto.randomUUID();
  const blobKey = `asset:${id}`;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error("Could not cache generated video");
    const blob = await response.blob();
    await storeAssetBlob(blobKey, blob);
    return {
      id,
      name,
      kind: "video",
      mimeType: blob.type || "video/mp4",
      origin,
      createdAt: new Date().toISOString(),
      blobKey,
      byteSize: blob.size,
      jobId,
    };
  } catch {
    return {
      id,
      name,
      kind: "video",
      mimeType: "video/mp4",
      origin,
      createdAt: new Date().toISOString(),
      externalUrl: source,
      jobId,
    };
  }
}

export async function resolveAssetSource(asset: SessionAsset): Promise<string> {
  if (asset.externalUrl) return asset.externalUrl;
  if (!asset.blobKey) return "";
  const blob = await loadAssetBlob(asset.blobKey);
  return blob ? URL.createObjectURL(blob) : "";
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
  if (asset.blobKey) {
    const blob = await loadAssetBlob(asset.blobKey);
    if (!blob) throw new Error(`${asset.name} is missing from local storage.`);
    return blobToDataUrl(blob);
  }
  if (asset.externalUrl) {
    return isTauriRuntime() && /^https?:/i.test(asset.externalUrl)
      ? fetchRemoteImageDataUrl(asset.externalUrl)
      : asset.externalUrl;
  }
  throw new Error(`${asset.name} has no readable source.`);
}

export function nextReferenceSlot(references: DraftReference[]): number {
  const used = new Set(references.map((reference) => reference.slot));
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return slot;
}
