export type GenerationMode = "image" | "video";
export type VideoWorkflow = "generate" | "edit";
export type ReferenceRole = "reference" | "first_frame" | "last_frame" | "video_reference";

type CapabilityDescriptor = {
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
  endpoint_count?: number;
};

export type ImageModelEndpoint = {
  provider_name: string;
  provider_slug: string;
  provider_tag?: string | null;
  supported_parameters: Record<string, CapabilityDescriptor>;
  allowed_passthrough_parameters?: string[];
  pricing?: Array<{ billable: string; unit: string; cost_usd: number; variant?: string }>;
  supports_streaming?: boolean;
};

export type VideoModel = {
  id: string;
  name: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  input_reference_types?: Array<"image" | "video" | "audio"> | null;
  max_input_references?: number | null;
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
  role: ReferenceRole;
  slot: number;
};

export type DraftOptions = Record<string, string | number | boolean | undefined>;

export type GenerationDraft = {
  mode: GenerationMode;
  videoWorkflow?: VideoWorkflow;
  model: string;
  prompt: string;
  assets: ReferenceAsset[];
  options: DraftOptions;
  providerJson: string;
};

export type PromptEnhancementInput = {
  promptModel: string;
  mode: GenerationMode;
  videoWorkflow?: VideoWorkflow;
  editMode?: boolean;
  editTarget?: string;
  prompt: string;
  references: Array<{ slot: number; name: string; mediaType: string; role: ReferenceRole }>;
};

export type CredentialStatus = {
  configured: boolean;
  maskedKey: string | null;
  path: string;
};

export type ImageResult = {
  kind: "image";
  urls: string[];
};

export type VideoResult = {
  kind: "video";
  jobId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  url?: string;
  error?: string;
  progress?: number;
};

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("credential_status");
  const key = window.localStorage.getItem("oppa-gen.dev-key");
  return {
    configured: Boolean(key),
    maskedKey: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
    path: "~/.oppa-gen/credentials.json",
  };
}

export async function saveApiKey(apiKey: string): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("save_api_key", { apiKey });
  window.localStorage.setItem("oppa-gen.dev-key", apiKey.trim());
  return getCredentialStatus();
}

export async function removeApiKey(): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("remove_api_key");
  window.localStorage.removeItem("oppa-gen.dev-key");
  return getCredentialStatus();
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (isTauriRuntime()) {
    return invokeTauri<T>("openrouter_request", { method, path, body: body ?? null });
  }
  const key = window.localStorage.getItem("oppa-gen.dev-key");
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
  if (mode === "image") {
    const response = await request<{ data?: ImageModel[] }>("GET", "/images/models");
    return Array.isArray(response.data) ? response.data : [];
  }
  const [videoCatalog, modalCatalog] = await Promise.all([
    request<{ data?: VideoModel[] }>("GET", "/videos/models"),
    request<{ data?: Array<Pick<VideoModel, "id" | "architecture">> }>(
      "GET",
      "/models?output_modalities=video",
    ).catch(() => ({ data: [] })),
  ]);
  const architecture = new Map(
    (modalCatalog.data ?? []).map((model) => [model.id, model.architecture]),
  );
  return (videoCatalog.data ?? []).map((model) => ({
    ...model,
    architecture: model.architecture ?? architecture.get(model.id),
  }));
}

export async function loadImageModelEndpoints(modelId: string): Promise<ImageModelEndpoint[]> {
  const [author, ...slugParts] = modelId.split("/");
  if (!author || slugParts.length === 0) return [];
  const path = `/images/models/${encodeURIComponent(author)}/${encodeURIComponent(slugParts.join("/"))}/endpoints`;
  const response = await request<{ endpoints?: ImageModelEndpoint[] }>("GET", path);
  return Array.isArray(response.endpoints) ? response.endpoints : [];
}

export function imageReferenceLimit(model: ImageModel | null): number {
  return model?.supported_parameters.input_references?.max ?? 0;
}

function videoReferenceTypes(model: VideoModel | null): Array<"image" | "video" | "audio"> {
  if (!model) return [];
  if (Array.isArray(model.input_reference_types)) return model.input_reference_types;
  const declared = model.architecture?.input_modalities ?? [];
  return declared.filter((value): value is "image" | "video" | "audio" =>
    value === "image" || value === "video" || value === "audio",
  );
}

export function supportsVideoInput(model: VideoModel | null): boolean {
  return videoReferenceTypes(model).includes("video");
}

export function videoReferenceLimit(model: VideoModel | null): number {
  if (!model || videoReferenceTypes(model).length === 0) return 0;
  return model.max_input_references ?? 1;
}

export function modelInputSignature(
  mode: GenerationMode,
  model: GenerationModel,
): string {
  if (mode === "image") {
    const limit = imageReferenceLimit(model as ImageModel);
    return limit > 0 ? `Text + image ×${limit}` : "Text";
  }
  const video = model as VideoModel;
  const parts = ["Text"];
  const referenceTypes = videoReferenceTypes(video);
  if (referenceTypes.includes("image")) parts.push("image");
  if (referenceTypes.includes("video")) parts.push("video");
  if (video.supported_frame_images?.includes("first_frame")) parts.push("first frame");
  if (video.supported_frame_images?.includes("last_frame")) parts.push("last frame");
  return parts.join(" + ");
}

export function allowedAssetRoles(
  mode: GenerationMode,
  model: GenerationModel | null,
  workflow: VideoWorkflow = "generate",
): ReferenceRole[] {
  if (mode === "image") return imageReferenceLimit(model as ImageModel | null) > 0 ? ["reference"] : [];
  const video = model as VideoModel | null;
  const types = videoReferenceTypes(video);
  const roles: ReferenceRole[] = [];
  if (types.includes("image")) roles.push("reference");
  if (workflow === "edit" && types.includes("video")) roles.push("video_reference");
  if (workflow === "generate" && video?.supported_frame_images?.includes("first_frame")) roles.push("first_frame");
  if (workflow === "generate" && video?.supported_frame_images?.includes("last_frame")) roles.push("last_frame");
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

function asReference(asset: ReferenceAsset) {
  if (asset.mediaType.startsWith("video/")) {
    return { type: "video_url", video_url: { url: asset.dataUrl } };
  }
  return { type: "image_url", image_url: { url: asset.dataUrl } };
}

export function buildRequest(draft: GenerationDraft, model: GenerationModel | null): Record<string, unknown> {
  if (!model) return {};
  const sentAssets: ReferenceAsset[] = [];
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
    const images = draft.assets.filter((asset) => asset.mediaType.startsWith("image/"));
    if (limit > 0 && images.length) {
      const selected = images.slice(0, limit);
      sentAssets.push(...selected);
      payload.input_references = selected.map(asReference);
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
    const referenceTypes = videoReferenceTypes(videoModel);
    const references = draft.assets.filter((asset) => {
      if (asset.role === "video_reference") return referenceTypes.includes("video");
      return asset.role === "reference" && referenceTypes.includes("image");
    });
    const limit = videoReferenceLimit(videoModel);
    const frames = draft.assets.filter((asset) =>
      (asset.role === "first_frame" || asset.role === "last_frame")
      && videoModel.supported_frame_images?.includes(asset.role),
    );
    if (references.length && limit > 0) {
      const selected = references.slice(0, limit);
      sentAssets.push(...selected);
      payload.input_references = selected.map(asReference);
    }
    if (frames.length) {
      sentAssets.push(...frames);
      payload.frame_images = frames.map((asset) => ({
        ...asReference(asset),
        frame_type: asset.role,
      }));
    }
  }
  const provider = parseProviderJson(draft.providerJson);
  if (provider) payload.provider = provider;
  if (sentAssets.length) {
    const mapping = sentAssets
      .toSorted((a, b) => a.slot - b.slot)
      .map((asset) => `#${asset.slot} = ${asset.name} (${asset.role})`)
      .join("; ");
    payload.prompt = `Attached input mapping: ${mapping}. Preserve these identities exactly.\n\n${draft.prompt.trim()}`;
  }
  return payload;
}

export function productSystemInstruction(input: Omit<PromptEnhancementInput, "promptModel" | "prompt">): string {
  const task = input.mode === "image"
    ? input.editMode ? "image editing" : "image generation"
    : input.videoWorkflow === "edit" ? "video editing" : "video generation";
  const editRule = input.mode === "image" && input.editMode
    ? `The explicit edit target is "${input.editTarget}". Treat that numbered image as the canvas to modify; other numbered images are context only.`
    : input.mode === "video" && input.videoWorkflow === "edit"
      ? "Treat the numbered video reference as the source footage to transform."
      : "";
  return [
    `The active Oppa Gen task is ${task}.`,
    "Numbered references are immutable input identities.",
    "Do not invent inputs or options outside the selected model's declared capabilities.",
    editRule,
  ].filter(Boolean).join(" ");
}

export function promptEnhancerInstruction(): string {
  return [
    "You are Oppa Gen's prompt enhancer.",
    "Rewrite the user's request into one production-ready media prompt.",
    "Infer the best structure for this request instead of forcing a fixed schema.",
    "Preserve intent, names, constraints, ambiguity that should remain creative, and every #number reference.",
    "Preserve the user's language and every negative or forbidden condition.",
    "Add useful visual, temporal, camera, material, lighting, composition, and continuity detail only when relevant.",
    "Return only the enhanced prompt. Do not add headings, analysis, JSON, or markdown.",
  ].filter(Boolean).join(" ");
}

export function validateEnhancedPrompt(original: string, enhanced: string, editTarget?: string): string | null {
  if (!enhanced.trim()) return "The enhanced prompt is empty.";
  const tokens = (value: string) => [...value.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
  const originalTokens = new Set(tokens(`${original} ${editTarget ?? ""}`));
  const enhancedTokens = new Set(tokens(enhanced));
  for (const token of originalTokens) {
    if (!enhancedTokens.has(token)) return `Prompt enhancement removed #${token}.`;
  }
  for (const token of enhancedTokens) {
    if (!originalTokens.has(token)) return `Prompt enhancement invented #${token}.`;
  }
  return null;
}

export async function enhancePrompt(input: PromptEnhancementInput): Promise<string> {
  const catalog = input.references.length
    ? `\n\nAvailable references:\n${input.references.map((reference) =>
      `#${reference.slot}: ${reference.name} (${reference.mediaType}, ${reference.role})`,
    ).join("\n")}`
    : "";
  const response = await request<{
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
  }>("POST", "/chat/completions", {
    model: input.promptModel,
    reasoning: { effort: input.promptModel.endsWith("luna") ? "xhigh" : "high" },
    messages: [
      {
        role: "system",
        content: productSystemInstruction(input),
      },
      { role: "system", content: promptEnhancerInstruction() },
      { role: "user", content: `${input.prompt.trim()}${catalog}` },
    ],
  });
  const content = response.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : content?.map((part) => part.text ?? "").join("");
  if (!text?.trim()) throw new Error("The prompt model returned no enhanced prompt.");
  const validationError = validateEnhancedPrompt(input.prompt, text, input.editTarget);
  if (validationError) throw new Error(validationError);
  return text.trim();
}

export async function generateImage(payload: Record<string, unknown>): Promise<ImageResult> {
  const response = await request<{
    data?: Array<{ b64_json?: string; url?: string; local_path?: string; media_type?: string }>;
  }>("POST", "/images", payload);
  const urls = (response.data ?? []).flatMap((item) => {
    if (item.local_path) return [item.local_path];
    if (item.url) return [item.url];
    if (item.b64_json) return [`data:${item.media_type ?? "image/png"};base64,${item.b64_json}`];
    return [];
  });
  if (!urls.length) throw new Error("OpenRouter returned no image data.");
  return { kind: "image", urls };
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
  }>("GET", `/videos/${encodeURIComponent(jobId)}`);
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
  return result.path;
}

export function prettyRequest(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === "string" && value.startsWith("data:") && value.length > 120) {
      return `<media payload omitted · ${Math.round(value.length / 1024)} KB>`;
    }
    return value;
  }, 2);
}
