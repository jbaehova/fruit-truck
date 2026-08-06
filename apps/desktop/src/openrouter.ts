export type GenerationMode = "image" | "video";
export type VideoWorkflow = "generate" | "edit";
export type ReferenceRole = "reference" | "first_frame" | "last_frame" | "video_reference";

type CapabilityDescriptor = {
  type: "enum" | "range" | "boolean";
  values?: Array<string | number>;
  min?: number;
  max?: number;
};

type ImagePricingLine = {
  billable: string;
  unit: string;
  cost_usd: number;
  variant?: string;
};

type VideoPricingBasis = "second" | "token" | "image" | "generation";

type VideoPricingLine = {
  sku: string;
  costUsd: number;
  basis: VideoPricingBasis;
  minimum: boolean;
  resolution?: string;
  audio?: boolean;
  workflow?: "text" | "image" | "edit";
};

export type GenerationCostContext = {
  videoWorkflow?: VideoWorkflow;
  imageInputCount?: number;
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
  endpoints?: string;
  endpoint_details?: ImageModelEndpoint[];
  pricing?: ImagePricingLine[];
};

export type ImageModelEndpoint = {
  provider_name: string;
  provider_slug: string;
  provider_tag?: string | null;
  supported_parameters: Record<string, CapabilityDescriptor>;
  allowed_passthrough_parameters?: string[];
  pricing?: ImagePricingLine[];
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

export function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "";
  const [whole, fractional = ""] = value.toFixed(8).split(".");
  return `$${whole}.${fractional.replace(/0+$/, "").padEnd(2, "0")}`;
}

function normalizedUsd(value: number) {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function outputImagePricingLines(pricing: ImagePricingLine[]) {
  return pricing.filter((item) => item.billable === "output_image" || item.billable === "image");
}

function estimateImagePricing(
  pricing: ImagePricingLine[],
  options: DraftOptions,
  context: GenerationCostContext,
) {
  const selectedVariant = typeof options.resolution === "string" ? options.resolution.toLowerCase() : undefined;
  const output = outputImagePricingLines(pricing)
    .filter((item) => item.unit === "image" && Number.isFinite(item.cost_usd) && item.cost_usd >= 0);
  const exact = selectedVariant ? output.filter((item) => item.variant?.toLowerCase() === selectedVariant) : [];
  const generic = output.filter((item) => !item.variant);
  const candidates = selectedVariant
    ? exact.length ? exact : generic
    : output;
  if (!candidates.length) return undefined;
  const count = typeof options.n === "number" && options.n > 0 ? options.n : 1;
  const inputRates = pricing
    .filter((item) => ["input_image", "input_reference"].includes(item.billable) && item.unit === "image")
    .map((item) => item.cost_usd)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const inputCost = inputRates.length ? Math.min(...inputRates) * (context.imageInputCount ?? 0) : 0;
  return normalizedUsd(Math.min(...candidates.map((item) => item.cost_usd)) * count + inputCost);
}

function videoPricingLines(model: VideoModel): VideoPricingLine[] {
  return Object.entries(model.pricing_skus ?? {}).flatMap(([sku, raw]) => {
    const value = Number(String(raw).replace(/[^0-9.eE+-]/g, ""));
    if (!Number.isFinite(value)) return [];
    // Live responses currently use underscores, while documented examples
    // also use hyphens. Interpret both spellings as the same SKU grammar.
    const normalized = sku.toLowerCase().replaceAll("-", "_");
    const basis: VideoPricingBasis = normalized.includes("token")
      ? "token"
      : normalized.includes("reference_image") || normalized.includes("image_input")
        ? "image"
        : normalized.includes("second") || normalized.includes("duration_seconds")
          ? "second"
          : "generation";
    const resolution = normalized.match(/(?:^|_)(480p|720p|1080p|1024p|2k|4k)(?:_|$)/)?.[1];
    const audio = normalized.includes("without_audio")
      ? false
      : normalized.includes("with_audio") ? true : undefined;
    const workflow = normalized.includes("video_continuation")
      ? "edit" as const
      : normalized.includes("image_to_video")
        ? "image" as const
        : normalized.includes("text_to_video") ? "text" as const : undefined;
    return [{
      sku,
      costUsd: normalized.includes("cents") ? value / 100 : value,
      basis,
      minimum: normalized.includes("minimum") && normalized.includes("generation"),
      resolution,
      audio,
      workflow,
    }];
  });
}

function compactUsd(value: number) {
  return Number.isInteger(value) ? `$${value}` : formatUsd(value);
}

function compactRateUsd(value: number) {
  const decimals = value < 0.1 ? 5 : value < 1 ? 4 : 2;
  const fixed = value.toFixed(decimals);
  const [whole, fractional = ""] = fixed.split(".");
  return `$${whole}.${fractional.replace(/0+$/, "").padEnd(2, "0")}`;
}

function compactPriceRange(values: number[], unit: string, scale = 1) {
  const scaled = values.map((value) => normalizedUsd(value * scale));
  const minimum = Math.min(...scaled);
  const maximum = Math.max(...scaled);
  return minimum === maximum
    ? `${compactUsd(minimum)}/${unit}`
    : `${compactUsd(minimum)}–${compactUsd(maximum)}/${unit}`;
}

function imageTokenPriceLabel(pricing: ImagePricingLine[]) {
  const tokenLines = pricing.filter((line) => line.unit === "token" && Number.isFinite(line.cost_usd));
  const input = tokenLines.filter((line) => line.billable.startsWith("input_"));
  const output = outputImagePricingLines(tokenLines);
  const labels = [];
  if (input.length) labels.push(compactPriceRange(input.map((line) => line.cost_usd), "M input", 1_000_000));
  if (output.length) labels.push(compactPriceRange(output.map((line) => line.cost_usd), input.length ? "M output" : "M output tokens", 1_000_000));
  return labels.join(" · ");
}

function seedanceSecondPrice(model: VideoModel, lines: VideoPricingLine[], options: DraftOptions = {}) {
  if (!model.id.startsWith("bytedance/seedance-")) return undefined;
  const sizes = (model.supported_sizes ?? []).flatMap((size) => {
    const match = size.match(/^(\d+)x(\d+)$/i);
    if (!match) return [];
    const width = Number(match[1]);
    const height = Number(match[2]);
    return [{ width, height }];
  });
  const resolution = typeof options.resolution === "string" ? options.resolution.toLowerCase() : "";
  const resolutionPixels = resolution === "4k"
    ? 2160
    : Number(resolution.match(/^(\d+)p$/)?.[1] ?? 0);
  const aspect = typeof options.aspect_ratio === "string" ? options.aspect_ratio.match(/^(\d+):(\d+)$/) : null;
  const targetRatio = aspect ? Number(aspect[1]) / Number(aspect[2]) : 16 / 9;
  const candidates = sizes
    .map((size) => {
      const ratioDifference = Math.abs(size.width / size.height - targetRatio);
      return {
        ...size,
        score: (resolutionPixels && Math.min(size.width, size.height) !== resolutionPixels ? 100 : 0)
          + (ratioDifference <= 0.03 ? 0 : ratioDifference),
      };
    })
    .sort((left, right) => left.score - right.score || left.width * left.height - right.width * right.height);
  const selectedSize = candidates[0];
  if (!selectedSize) return undefined;
  const tokenRates = lines.filter((line) => line.basis === "token").map((line) => line.costUsd);
  if (!tokenRates.length) return undefined;
  const tokensPerSecond = selectedSize.width * selectedSize.height * 24 / 1024;
  return Math.min(...tokenRates) * tokensPerSecond;
}

function selectVideoSecondRate(lines: VideoPricingLine[], options: DraftOptions, context: GenerationCostContext) {
  const resolution = typeof options.resolution === "string" ? options.resolution.toLowerCase() : undefined;
  const audio = typeof options.generate_audio === "boolean" ? options.generate_audio : undefined;
  const desiredWorkflow = context.videoWorkflow === "edit"
    ? "edit"
    : (context.imageInputCount ?? 0) > 0 ? "image" : "text";
  const scored = lines.filter((line) => line.basis === "second" && !line.minimum).map((line) => {
    let score = 0;
    if (line.resolution) score += line.resolution === resolution ? 4 : -100;
    if (line.audio != null) score += line.audio === audio ? 8 : -100;
    if (line.workflow) score += line.workflow === desiredWorkflow ? 2 : -100;
    return { line, score };
  });
  const bestScore = Math.max(...scored.map((item) => item.score));
  return scored.filter((item) => item.score === bestScore).map((item) => item.line.costUsd).sort((a, b) => a - b)[0];
}

export function modelPriceLabel(mode: GenerationMode, model: GenerationModel): string {
  if (mode === "image") {
    const allPricing = (model as ImageModel).pricing ?? [];
    const tokenLabel = imageTokenPriceLabel(allPricing);
    if (tokenLabel) return tokenLabel;
    const pricing = outputImagePricingLines(allPricing);
    if (!pricing.length) return "Price unavailable";
    const primaryUnit = pricing.some((item) => item.unit === "image")
      ? "image"
      : pricing.some((item) => item.unit === "megapixel") ? "megapixel" : pricing[0]?.unit;
    const costs = pricing
      .filter((item) => item.unit === primaryUnit)
      .map((item) => item.cost_usd)
      .filter(Number.isFinite);
    if (!costs.length) return "Price unavailable";
    const unit = primaryUnit === "megapixel" ? "MP" : primaryUnit?.replaceAll("_", " ") ?? "generation";
    return compactPriceRange(costs, unit);
  }
  const lines = videoPricingLines(model as VideoModel);
  const derivedSecond = seedanceSecondPrice(model as VideoModel, lines);
  if (derivedSecond != null) return `from ${compactRateUsd(derivedSecond)}/second`;
  const primary = lines.filter((line) => !line.minimum && line.basis !== "image");
  const basis = (["second", "token", "generation"] as const).find((candidate) => primary.some((line) => line.basis === candidate));
  if (!basis) return "Price unavailable";
  const values = primary.filter((line) => line.basis === basis).map((line) => line.costUsd);
  const label = basis === "token"
    ? compactPriceRange(values, "M video tokens", 1_000_000)
    : compactPriceRange(values, basis === "second" ? "second" : basis);
  const minimumGeneration = lines.filter((line) => line.minimum).map((line) => line.costUsd);
  return minimumGeneration.length ? `${label} · ${formatUsd(Math.min(...minimumGeneration))} minimum` : label;
}

export function estimateGenerationCost(
  mode: GenerationMode,
  model: GenerationModel,
  options: DraftOptions,
  context: GenerationCostContext = {},
): number | undefined {
  if (mode === "image") {
    const image = model as ImageModel;
    const endpointEstimates = (image.endpoint_details ?? [])
      .map((endpoint) => estimateImagePricing(endpoint.pricing ?? [], options, context))
      .filter((value): value is number => value != null);
    if (endpointEstimates.length) return Math.min(...endpointEstimates);
    return estimateImagePricing(image.pricing ?? [], options, context);
  }
  const lines = videoPricingLines(model as VideoModel);
  const minimum = lines.filter((line) => line.minimum).map((line) => line.costUsd);
  const secondRate = selectVideoSecondRate(lines, options, context)
    ?? seedanceSecondPrice(model as VideoModel, lines, options);
  const duration = typeof options.duration === "number" && options.duration > 0 ? options.duration : undefined;
  const fixed = lines.filter((line) => line.basis === "generation" && !line.minimum).map((line) => line.costUsd);
  let total = secondRate != null && duration != null
    ? secondRate * duration
    : fixed.length ? Math.min(...fixed) : undefined;
  if (total == null && minimum.length) total = Math.min(...minimum);
  if (total == null) return undefined;
  if (minimum.length) total = Math.max(total, Math.min(...minimum));
  const inputRates = lines.filter((line) => line.basis === "image").map((line) => line.costUsd);
  if (inputRates.length) total += Math.min(...inputRates) * (context.imageInputCount ?? 0);
  return normalizedUsd(total);
}

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
  maskInstructions?: string;
  hasMask?: boolean;
  references: Array<{ slot: number; name: string; mediaType: string; role: ReferenceRole }>;
  visuals: PromptEnhancementVisual[];
};

export type PromptEnhancementVisual = {
  id: string;
  kind: "reference" | "edit_target" | "mask_guide" | "video_frame";
  source: string;
  slot: number;
  name: string;
  role: ReferenceRole;
  framePosition?: "beginning" | "middle" | "end";
  timestampSeconds?: number;
};

export type PromptEnhancementContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type CredentialStatus = {
  configured: boolean;
  maskedKey: string | null;
  path: string;
};

export type ImageResult = {
  kind: "image";
  urls: string[];
  actualCostUsd?: number;
};

export type VideoResult = {
  kind: "video";
  jobId: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  url?: string;
  error?: string;
  progress?: number;
  actualCostUsd?: number;
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
  const key = window.localStorage.getItem("fruit-truck.dev-key");
  return {
    configured: Boolean(key),
    maskedKey: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
    path: "~/.fruit-truck/credentials.json",
  };
}

export async function saveApiKey(apiKey: string): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("save_api_key", { apiKey });
  window.localStorage.setItem("fruit-truck.dev-key", apiKey.trim());
  return getCredentialStatus();
}

export async function removeApiKey(): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("remove_api_key");
  window.localStorage.removeItem("fruit-truck.dev-key");
  return getCredentialStatus();
}

export function retryDelayMs(retryAfter: string | null, retry: number, now = Date.now(), jitter = Math.random()): number {
  const value = retryAfter?.trim() ?? "";
  const seconds = Number(value);
  const dateDelay = Date.parse(value) - now;
  const delay = value && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : value && Number.isFinite(dateDelay) && dateDelay > 0
      ? dateDelay
      : 500 * 2 ** retry + Math.floor(Math.max(0, Math.min(1, jitter)) * 200);
  return Math.min(30_000, Math.max(0, delay));
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (isTauriRuntime()) {
    return invokeTauri<T>("openrouter_request", { method, path, body: body ?? null });
  }
  const key = window.localStorage.getItem("fruit-truck.dev-key");
  for (let retry = 0; ; retry += 1) {
    const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (response.ok) return response.json() as Promise<T>;
    const message = await response.text();
    if (![429, 503].includes(response.status) || retry >= 3) throw new Error(`OpenRouter ${response.status}: ${message}`);
    await new Promise((resolveWait) => window.setTimeout(resolveWait, retryDelayMs(response.headers.get("retry-after"), retry)));
  }
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, transform: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await transform(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
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

export function applyImageModelEndpoints(model: ImageModel, endpointDetails: ImageModelEndpoint[]): ImageModel {
  const endpointPricing = endpointDetails.flatMap((endpoint) => endpoint.pricing ?? []);
  return {
    ...model,
    endpoint_details: endpointDetails,
    pricing: endpointPricing.length ? endpointPricing : model.pricing,
  };
}

export async function hydrateImageModelPricing(
  models: ImageModel[],
  onHydrated?: (model: ImageModel, endpoints: ImageModelEndpoint[]) => void,
): Promise<ImageModel[]> {
  return mapWithConcurrency(models, 6, async (model) => {
    try {
      const endpointDetails = await loadImageModelEndpoints(model.id);
      const hydrated = applyImageModelEndpoints(model, endpointDetails);
      onHydrated?.(hydrated, endpointDetails);
      return hydrated;
    } catch {
      return model;
    }
  });
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
  const hasMaskGuide = input.visuals.some((visual) => visual.kind === "mask_guide");
  return [
    `The active Fruit Truck task is ${task}.`,
    "Numbered references are immutable input identities.",
    "Do not invent inputs or options outside the selected model's declared capabilities.",
    editRule,
    input.hasMask && hasMaskGuide
      ? "The edit target and a magenta mask-guide view are supplied. The overlay is a coarse pointer to an existing semantic subject or part, never a literal silhouette or an object to generate."
      : input.hasMask
        ? "Mask instructions apply to an existing semantic subject or part in the edit target. No visual mask-guide image is supplied, so do not claim a precise boundary that cannot be seen."
        : "",
  ].filter(Boolean).join(" ");
}

export function promptEnhancerInstruction(visualKinds: PromptEnhancementVisual["kind"][] = []): string {
  const hasVisuals = visualKinds.length > 0;
  return [
    "You are Fruit Truck's prompt enhancer.",
    "Rewrite the user's request into one production-ready media prompt.",
    "Infer the best structure for this request instead of forcing a fixed schema.",
    "Preserve intent, names, constraints, ambiguity that should remain creative, and every #number reference.",
    "Preserve the user's language and every negative or forbidden condition.",
    hasVisuals ? "Inspect every supplied visual before adding detail, and use only facts that are actually visible." : "",
    "For edits, identify the existing subject and requested attribute precisely while preserving all unrequested identity, anatomy, geometry, texture, lighting, depth, composition, and continuity.",
    visualKinds.includes("mask_guide") ? "For a mask guide, infer the intended semantic part from the original image, allow its boundary to snap or softly blend to nearby natural edges, and explicitly prevent generation of the painted brush-stroke silhouette as a new object." : "",
    visualKinds.includes("video_frame") ? "Treat beginning, middle, and end video frames as one time-ordered source clip, not as separate scenes." : "",
    "Add useful visual, temporal, camera, material, lighting, composition, and continuity detail only when relevant.",
    "Return only the enhanced prompt. Do not add headings, analysis, JSON, or markdown.",
  ].filter(Boolean).join(" ");
}

export function promptEnhancementUserContent(input: PromptEnhancementInput): PromptEnhancementContentPart[] {
  const referenceCatalog = input.references.length
    ? ["", "Available numbered references:", ...input.references.map((reference) =>
      `#${reference.slot}: ${reference.name} (${reference.mediaType}, ${reference.role})`,
    )]
    : [];
  const visualCatalog = input.visuals.length
    ? ["", "Visual inputs, in the same order as the attached images:", ...input.visuals.map((visual, index) => {
      const frame = visual.kind === "video_frame"
        ? `, ${visual.framePosition} at ${(visual.timestampSeconds ?? 0).toFixed(2)}s`
        : "";
      return `Visual ${index + 1}: #${visual.slot} ${visual.name} (${visual.kind}, ${visual.role}${frame})`;
    })]
    : [];
  const text = [
    "User prompt:",
    input.prompt.trim() || "(none)",
    ...(input.hasMask ? ["", "Mask instructions:", input.maskInstructions?.trim() || "Apply the user prompt to the semantically selected subject or part."] : []),
    ...referenceCatalog,
    ...visualCatalog,
  ].join("\n");
  return [
    { type: "text", text },
    ...input.visuals.map((visual): PromptEnhancementContentPart => ({
      type: "image_url",
      image_url: { url: visual.source },
    })),
  ];
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
      { role: "system", content: promptEnhancerInstruction(input.visuals.map((visual) => visual.kind)) },
      { role: "user", content: promptEnhancementUserContent(input) },
    ],
  });
  const content = response.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : content?.map((part) => part.text ?? "").join("");
  if (!text?.trim()) throw new Error("The prompt model returned no enhanced prompt.");
  const originalIntent = [
    input.prompt.trim(),
    input.hasMask ? input.maskInstructions?.trim() ?? "" : "",
  ].filter(Boolean).join("\n");
  const validationError = validateEnhancedPrompt(originalIntent, text, input.editTarget);
  if (validationError) throw new Error(validationError);
  return text.trim();
}

export async function generateImage(payload: Record<string, unknown>): Promise<ImageResult> {
  const response = await request<{
    data?: Array<{ b64_json?: string; url?: string; local_path?: string; media_type?: string }>;
    usage?: { cost?: number };
  }>("POST", "/images", payload);
  const urls = (response.data ?? []).flatMap((item) => {
    if (item.local_path) return [item.local_path];
    if (item.url) return [item.url];
    if (item.b64_json) return [`data:${item.media_type ?? "image/png"};base64,${item.b64_json}`];
    return [];
  });
  if (!urls.length) throw new Error("OpenRouter returned no image data.");
  return { kind: "image", urls, actualCostUsd: typeof response.usage?.cost === "number" ? response.usage.cost : undefined };
}

export async function submitVideo(payload: Record<string, unknown>): Promise<VideoResult> {
  const response = await request<{ id?: string; job_id?: string; status?: VideoResult["status"]; usage?: { cost?: number } }>(
    "POST",
    "/videos",
    payload,
  );
  const jobId = response.id ?? response.job_id;
  if (!jobId) throw new Error("OpenRouter returned no video job ID.");
  return { kind: "video", jobId, status: response.status ?? "pending", actualCostUsd: typeof response.usage?.cost === "number" ? response.usage.cost : undefined };
}

export async function pollVideo(jobId: string): Promise<VideoResult> {
  const response = await request<{
    id?: string;
    status?: VideoResult["status"];
    progress?: number;
    error?: string | { message?: string };
    unsigned_urls?: string[];
    data?: Array<{ url?: string }>;
    usage?: { cost?: number };
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
    actualCostUsd: typeof response.usage?.cost === "number" ? response.usage.cost : undefined,
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
