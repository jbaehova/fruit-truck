import type {
  DraftOptions,
  GenerationMode,
  ReferenceRole,
  VideoWorkflow,
  VideoResult,
} from "./openrouter.ts";
import { isTauriRuntime } from "./openrouter.ts";
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
  pollAttempts?: number;
  lastPolledAt?: string;
  request: Record<string, unknown>;
  inputAssetIds?: string[];
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
  agent: AgentSessionState;
  agentBridge?: boolean;
};

export type StudioState = {
  schemaVersion: 1;
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
    agent: createAgentState(),
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
        assets: session.assets.map((asset) => {
          const legacyLocalPath = asset.externalUrl && /^(?:\/|[A-Za-z]:[\\/])/.test(asset.externalUrl)
            ? asset.externalUrl
            : undefined;
          return {
            ...asset,
            localPath: asset.localPath ?? legacyLocalPath,
            externalUrl: legacyLocalPath ? undefined : asset.externalUrl,
          };
        }),
        agent: session.agent ? normalizeAgentState(session.agent) : createAgentState(),
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
  const bounded = {
    ...state,
    sessions: state.sessions.map((session) => ({
      ...session,
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
): Promise<SessionAsset> {
  const id = crypto.randomUUID();
  if (isTauriRuntime() && /^(?:\/|[A-Za-z]:[\\/])/.test(source)) {
    return {
      id,
      name,
      kind: "image",
      mimeType: "image/png",
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
  if (isTauriRuntime() && /^(?:\/|[A-Za-z]:[\\/])/.test(source)) {
    return {
      id,
      name,
      kind: "video",
      mimeType: "video/mp4",
      origin,
      createdAt: new Date().toISOString(),
      localPath: source,
      jobId,
      bridgeAvailability: "available",
    };
  }
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
