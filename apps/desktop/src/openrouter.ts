export type GenerationMode = "image" | "video";
export type ReferenceRole = "reference" | "first_frame" | "last_frame";

export type CapabilityDescriptor = {
  type: "enum" | "range" | "boolean";
  values?: Array<string | number>;
  min?: number;
  max?: number;
};

export type ImageModel = {
  id: string;
  name: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters: Record<string, CapabilityDescriptor>;
  supports_streaming?: boolean;
};

export type VideoModel = {
  id: string;
  name: string;
  description?: string;
  supported_resolutions?: string[] | null;
  supported_aspect_ratios?: string[] | null;
  supported_sizes?: string[] | null;
  supported_durations?: number[] | null;
  supported_frame_images?: Array<"first_frame" | "last_frame"> | null;
  generate_audio?: boolean | null;
  seed?: boolean | null;
  pricing_skus?: Record<string, string> | null;
  allowed_passthrough_parameters?: string[];
};

export type GenerationModel = ImageModel | VideoModel;

export type ReferenceAsset = {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
  previewUrl: string;
  role: ReferenceRole;
};

export type DraftOptions = Record<string, string | number | boolean | undefined>;

export type GenerationDraft = {
  mode: GenerationMode;
  model: string;
  prompt: string;
  assets: ReferenceAsset[];
  options: DraftOptions;
  providerJson: string;
};

export type CredentialStatus = {
  configured: boolean;
  maskedKey: string | null;
  path: string;
};

export type ImageResult = {
  kind: "image";
  urls: string[];
  usage?: Record<string, unknown>;
  requestId?: string;
};

export type VideoResult = {
  kind: "video";
  jobId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  url?: string;
  error?: string;
  progress?: number;
};

const VIDEO_REFERENCE_OVERRIDES = new Set([
  "alibaba/wan-2.7",
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
  "x-ai/grok-imagine-video",
]);

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("credential_status");
  const key = window.localStorage.getItem("open-gen-ui.dev-key");
  return {
    configured: Boolean(key),
    maskedKey: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
    path: "~/.open-gen-ui/credentials.json",
  };
}

export async function saveApiKey(apiKey: string): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("save_api_key", { apiKey });
  window.localStorage.setItem("open-gen-ui.dev-key", apiKey.trim());
  return getCredentialStatus();
}

export async function removeApiKey(): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("remove_api_key");
  window.localStorage.removeItem("open-gen-ui.dev-key");
  return getCredentialStatus();
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (isTauriRuntime()) {
    return invokeTauri<T>("openrouter_request", { method, path, body: body ?? null });
  }
  const key = window.localStorage.getItem("open-gen-ui.dev-key");
  const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export async function loadModels(mode: "image"): Promise<ImageModel[]>;
export async function loadModels(mode: "video"): Promise<VideoModel[]>;
export async function loadModels(mode: GenerationMode): Promise<GenerationModel[]> {
  const response = await request<{ data?: GenerationModel[] }>("GET", `/${mode}s/models`);
  return Array.isArray(response.data) ? response.data : [];
}

export function imageReferenceLimit(model: ImageModel | null): number {
  return model?.supported_parameters.input_references?.max ?? 0;
}

export function supportsVideoReferences(model: VideoModel | null): boolean {
  if (!model) return false;
  return VIDEO_REFERENCE_OVERRIDES.has(model.id)
    || /reference image|reference-to-video|multi-reference|set of reference/i.test(model.description ?? "");
}

export function allowedAssetRoles(mode: GenerationMode, model: GenerationModel | null): ReferenceRole[] {
  if (mode === "image") return imageReferenceLimit(model as ImageModel | null) > 0 ? ["reference"] : [];
  const video = model as VideoModel | null;
  const roles: ReferenceRole[] = [];
  if (supportsVideoReferences(video)) roles.push("reference");
  if (video?.supported_frame_images?.includes("first_frame")) roles.push("first_frame");
  if (video?.supported_frame_images?.includes("last_frame")) roles.push("last_frame");
  return roles;
}

function first<T>(values: T[] | null | undefined): T | undefined {
  return values?.[0];
}

export function defaultOptions(mode: GenerationMode, model: GenerationModel | null): DraftOptions {
  if (!model) return {};
  if (mode === "image") {
    const output: DraftOptions = {};
    for (const [key, descriptor] of Object.entries((model as ImageModel).supported_parameters)) {
      if (key === "input_references" || key === "stream") continue;
      if (descriptor.type === "enum") output[key] = first(descriptor.values);
      if (descriptor.type === "range") output[key] = descriptor.min ?? 0;
      if (descriptor.type === "boolean" && key !== "seed") output[key] = false;
    }
    return output;
  }
  const video = model as VideoModel;
  return {
    duration: first(video.supported_durations),
    resolution: first(video.supported_resolutions),
    aspect_ratio: first(video.supported_aspect_ratios),
    generate_audio: video.generate_audio ? true : undefined,
  };
}

function parseProviderJson(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  const value = JSON.parse(raw) as unknown;
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Provider options must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

const asReference = (asset: ReferenceAsset) => ({
  type: "image_url",
  image_url: { url: asset.dataUrl },
});

export function buildRequest(draft: GenerationDraft, model: GenerationModel | null): Record<string, unknown> {
  if (!model) return {};
  const payload: Record<string, unknown> = {
    model: draft.model,
    prompt: draft.prompt.trim(),
  };
  if (draft.mode === "image") {
    const imageModel = model as ImageModel;
    for (const [key, value] of Object.entries(draft.options)) {
      if (imageModel.supported_parameters[key] && value !== undefined && value !== "") payload[key] = value;
    }
    const limit = imageReferenceLimit(imageModel);
    if (limit > 0 && draft.assets.length) {
      payload.input_references = draft.assets.slice(0, limit).map(asReference);
    }
  } else {
    const videoModel = model as VideoModel;
    const supported: Record<string, boolean> = {
      duration: Boolean(videoModel.supported_durations?.length),
      resolution: Boolean(videoModel.supported_resolutions?.length),
      aspect_ratio: Boolean(videoModel.supported_aspect_ratios?.length),
      size: Boolean(videoModel.supported_sizes?.length),
      generate_audio: videoModel.generate_audio === true,
      seed: videoModel.seed === true,
    };
    for (const [key, value] of Object.entries(draft.options)) {
      if (supported[key] && value !== undefined && value !== "") payload[key] = value;
    }
    const references = draft.assets.filter((asset) => asset.role === "reference");
    const frames = draft.assets.filter((asset) => asset.role !== "reference");
    if (references.length && supportsVideoReferences(videoModel)) {
      payload.input_references = references.map(asReference);
    }
    if (frames.length) {
      payload.frame_images = frames.map((asset) => ({
        ...asReference(asset),
        frame_type: asset.role,
      }));
    }
  }
  const provider = parseProviderJson(draft.providerJson);
  if (provider) payload.provider = provider;
  return payload;
}

export async function generateImage(payload: Record<string, unknown>): Promise<ImageResult> {
  const response = await request<{
    data?: Array<{ b64_json?: string; url?: string; media_type?: string }>;
    usage?: Record<string, unknown>;
    id?: string;
  }>("POST", "/images", payload);
  const urls = (response.data ?? []).flatMap((item) => {
    if (item.url) return [item.url];
    if (item.b64_json) return [`data:${item.media_type ?? "image/png"};base64,${item.b64_json}`];
    return [];
  });
  if (!urls.length) throw new Error("OpenRouter returned no image data.");
  return { kind: "image", urls, usage: response.usage, requestId: response.id };
}

export async function submitVideo(payload: Record<string, unknown>): Promise<VideoResult> {
  const response = await request<{ id?: string; job_id?: string; status?: VideoResult["status"] }>(
    "POST",
    "/videos",
    payload,
  );
  const jobId = response.id ?? response.job_id;
  if (!jobId) throw new Error("OpenRouter returned no video job ID.");
  return { kind: "video", jobId, status: response.status ?? "pending" };
}

export async function pollVideo(jobId: string): Promise<VideoResult> {
  const response = await request<{
    id?: string;
    status?: VideoResult["status"];
    progress?: number;
    error?: string | { message?: string };
    unsigned_urls?: string[];
    data?: Array<{ url?: string }>;
  }>("GET", `/videos/${jobId}`);
  const error = typeof response.error === "string" ? response.error : response.error?.message;
  const url = response.unsigned_urls?.[0] ?? response.data?.[0]?.url;
  return {
    kind: "video",
    jobId,
    status: response.status ?? "in_progress",
    progress: response.progress,
    error,
    url,
  };
}

export async function cacheVideo(jobId: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error("Video content caching requires the Tauri app.");
  const result = await invokeTauri<{ path: string }>("cache_video_content", { jobId });
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(result.path);
}

export function prettyRequest(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === "string" && value.startsWith("data:") && value.length > 120) {
      const [header] = value.split(",", 1);
      return `${header},<base64 omitted · ${Math.round(value.length / 1024)} KB>`;
    }
    return value;
  }, 2);
}
