import { applyKnownVideoCapabilities, videoInputPolicy, type InputMediaKind } from "./modelPolicies.ts";
import {
  PROMPT_PLAN_RESPONSE_FORMAT,
  compilePromptPlan,
  parsePromptPlan,
  plannerConstitutionInstruction,
  profileInstruction,
  promptProfileForModel,
  referenceCatalogInstruction,
  validateCompiledPrompt,
  type PromptEnhancementArtifact,
  type PromptPlanReference,
  type PromptReferenceInput,
  type PromptTarget,
  type PromptWorkflow,
  type ReferencePurpose,
} from "./prompting/index.ts";

export type GenerationMode = "image" | "video";
export type ReferenceRole = "reference" | "first_frame" | "last_frame";

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
  workflow?: "text" | "image";
};

export type GenerationCostContext = {
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
  input_reference_types?: InputMediaKind[] | null;
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
  const [whole, fractional = ""] = value.toFixed(12).split(".");
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
    if (normalized.includes("video_continuation")) return [];
    const workflow = normalized.includes("image_to_video")
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
  const desiredWorkflow = (context.imageInputCount ?? 0) > 0 ? "image" : "text";
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
  purpose: ReferencePurpose;
  slot: number;
};

export type DraftOptions = Record<string, string | number | boolean | undefined>;

export type GenerationDraft = {
  mode: GenerationMode;
  model: string;
  prompt: string;
  assets: ReferenceAsset[];
  options: DraftOptions;
  providerJson: string;
  editTargetSlot?: number;
  negativePrompt?: string;
};

export type ReferenceCoverage = {
  slot: number;
  purpose: ReferencePurpose;
  priority: PromptPlanReference["priority"];
  sent: boolean;
  transportRoleValid: boolean;
  boundInPrompt: boolean;
  nativeControl?: "input_references" | "frame_images.first_frame" | "frame_images.last_frame";
  providerLabel?: string;
  severity: "ok" | "warning" | "error";
};

export type PromptEnhancementInput = {
  promptModel: string;
  mode: GenerationMode;
  target: PromptTarget;
  workflow: PromptWorkflow;
  signature: string;
  editMode?: boolean;
  editTarget?: string;
  prompt: string;
  maskInstructions?: string;
  hasMask?: boolean;
  references: PromptReferenceInput[];
  visuals: PromptEnhancementVisual[];
};

export type PromptEnhancementVisual = {
  id: string;
  kind: "reference" | "edit_target" | "mask_guide" | "video_frame";
  source: string;
  slot: number;
  name: string;
  role: ReferenceRole;
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

export type VideoStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";

export type VideoResult = {
  kind: "video";
  jobId: string;
  status: VideoStatus;
  url?: string;
  error?: string;
  progress?: number;
  actualCostUsd?: number;
};

export function normalizeVideoStatus(value: unknown, fallback: VideoStatus = "in_progress"): VideoStatus {
  if (value === "canceled") return "cancelled";
  return value === "pending"
    || value === "in_progress"
    || value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "expired"
    ? value
    : fallback;
}

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
      signal: AbortSignal.timeout(180_000),
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
  return (videoCatalog.data ?? []).map((model) => applyKnownVideoCapabilities({
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

export function videoReferenceTypes(model: VideoModel | null): InputMediaKind[] {
  if (!model) return [];
  return (model.input_reference_types ?? []).filter((value): value is InputMediaKind => ["image", "video", "audio"].includes(value));
}

export function videoReferenceLimit(model: VideoModel | null, kind: InputMediaKind = "image"): number {
  if (!model || !videoReferenceTypes(model).includes(kind)) return 0;
  return videoInputPolicy(model.id).references[kind] ?? model.max_input_references ?? 1;
}

export function videoTotalInputLimit(model: VideoModel | null): number {
  if (!model) return 0;
  const policy = videoInputPolicy(model.id);
  const referenceTotal = policy.totalReferenceLimit
    ?? (["image", "video", "audio"] as const).reduce((sum, kind) => sum + videoReferenceLimit(model, kind), 0);
  const frameTotal = model.supported_frame_images?.length ?? 0;
  return policy.combination === "allow" ? referenceTotal + frameTotal : Math.max(referenceTotal, frameTotal);
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
  for (const kind of referenceTypes) parts.push(`${kind} ref`);
  if (video.supported_frame_images?.includes("first_frame")) parts.push("first frame");
  if (video.supported_frame_images?.includes("last_frame")) parts.push("last frame");
  return parts.join(" + ");
}

export function allowedAssetRoles(
  mode: GenerationMode,
  model: GenerationModel | null,
): ReferenceRole[] {
  if (mode === "image") return imageReferenceLimit(model as ImageModel | null) > 0 ? ["reference"] : [];
  const video = model as VideoModel | null;
  const types = videoReferenceTypes(video);
  const roles: ReferenceRole[] = [];
  if (types.length) roles.push("reference");
  if (video?.supported_frame_images?.includes("first_frame")) roles.push("first_frame");
  if (video?.supported_frame_images?.includes("last_frame")) roles.push("last_frame");
  return roles;
}

export function allowedAssetRolesForKind(
  mode: GenerationMode,
  model: GenerationModel | null,
  kind: InputMediaKind,
): ReferenceRole[] {
  if (mode === "image") return kind === "image" ? allowedAssetRoles(mode, model) : [];
  const video = model as VideoModel | null;
  const roles: ReferenceRole[] = [];
  if (videoReferenceTypes(video).includes(kind)) roles.push("reference");
  if (kind === "image") {
    if (video?.supported_frame_images?.includes("first_frame")) roles.push("first_frame");
    if (video?.supported_frame_images?.includes("last_frame")) roles.push("last_frame");
  }
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
      if (model.id === "openai/gpt-image-2" && key === "input_fidelity") continue;
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

function validateProviderPassthrough(provider: Record<string, unknown> | undefined, model: GenerationModel) {
  const options = provider?.options;
  if (options == null) return;
  if (!options || Array.isArray(options) || typeof options !== "object") {
    throw new Error("Provider options must be an object keyed by provider slug.");
  }
  for (const [providerSlug, rawConfig] of Object.entries(options as Record<string, unknown>)) {
    if (!rawConfig || Array.isArray(rawConfig) || typeof rawConfig !== "object") {
      throw new Error(`Provider configuration for ${providerSlug} must be an object.`);
    }
    const parameters = (rawConfig as Record<string, unknown>).parameters;
    if (parameters == null) continue;
    if (!parameters || Array.isArray(parameters) || typeof parameters !== "object") {
      throw new Error(`Passthrough parameters for ${providerSlug} must be an object.`);
    }
    const allowed = "supported_parameters" in model
      ? model.endpoint_details?.find((endpoint) => endpoint.provider_slug === providerSlug)?.allowed_passthrough_parameters
      : model.allowed_passthrough_parameters;
    for (const name of Object.keys(parameters as Record<string, unknown>)) {
      if (!allowed?.includes(name)) {
        throw new Error(`Provider passthrough parameter ${providerSlug}.${name} is not declared by the selected endpoint.`);
      }
    }
  }
}

export function validateProviderConfiguration(raw: string, model: GenerationModel): void {
  validateProviderPassthrough(parseProviderJson(raw), model);
}

function assetMediaKind(asset: Pick<ReferenceAsset, "mediaType">): InputMediaKind {
  return asset.mediaType.startsWith("video/") ? "video"
    : asset.mediaType.startsWith("audio/") ? "audio" : "image";
}

function asReference(asset: ReferenceAsset) {
  const kind = assetMediaKind(asset);
  const type = `${kind}_url`;
  return { type, [type]: { url: asset.dataUrl } };
}

function providerReferenceLabels(mode: GenerationMode, assets: ReferenceAsset[], runwaySyntax: boolean) {
  const counts: Record<InputMediaKind, number> = { image: 0, video: 0, audio: 0 };
  return new Map(assets.map((asset) => {
    if (asset.role === "first_frame") return [asset.slot, "the first-frame image"];
    if (asset.role === "last_frame") return [asset.slot, "the last-frame image"];
    const kind = assetMediaKind(asset);
    counts[kind] += 1;
    const label = mode === "image"
      ? `Image ${counts.image}`
      : `${kind[0].toUpperCase()}${kind.slice(1)} ${counts[kind]}`;
    return [asset.slot, runwaySyntax && kind === "image" ? `@[${label}]` : label];
  }));
}

function referencePurposeBinding(label: string, asset: ReferenceAsset) {
  switch (asset.purpose) {
    case "subject_identity": return `Use ${label} for the subject's defining identity and proportions; the requested prompt controls incidental background, pose, and lighting.`;
    case "product_identity": return `Use ${label} for the product's shape, materials, colors, hardware, and logo placement; the requested prompt controls the surrounding scene.`;
    case "character": return `Use ${label} as the character reference and keep the character's defining appearance continuous.`;
    case "wardrobe": return `Use ${label} only for the assigned wardrobe and accessories, fitted naturally to the requested subject.`;
    case "style": return `Use ${label} only for visual style, palette, lighting, texture, and finish; follow the requested prompt for subjects and layout.`;
    case "composition": return `Use ${label} for composition, framing, and spatial relationships; follow the requested prompt for identity and style.`;
    case "pose": return `Use ${label} for pose and gesture; follow the requested prompt for identity, wardrobe, and setting.`;
    case "motion": return `Use ${label} for motion, timing, camera rhythm, and physical dynamics rather than unrelated source appearance.`;
    case "audio": return `Use ${label} for the assigned dialogue, music, ambience, rhythm, or sound effects.`;
    case "edit_target": return `Treat ${label} as the edit canvas and preserve every unrequested region and attribute.`;
    case "context": return `Use ${label} as supporting context only where it agrees with the requested result.`;
    case "first_frame": return `${label} is the exact opening-frame anchor; animate forward from it with continuous identity and geometry.`;
    case "last_frame": return `${label} is the exact closing-frame anchor; arrive at it through a plausible continuous transition.`;
  }
}

function bindPromptReferences(
  prompt: string,
  mode: GenerationMode,
  modelId: string,
  sentAssets: ReferenceAsset[],
) {
  const profile = promptProfileForModel(mode, modelId);
  const labels = providerReferenceLabels(mode, sentAssets, profile.referenceSyntax === "runway_image_number");
  const sentSlots = new Set(sentAssets.map((asset) => asset.slot));
  const mentioned = new Set<number>();
  const rewritten = prompt.replace(/@(\d+)/g, (_match, rawSlot: string) => {
    const slot = Number(rawSlot);
    const label = labels.get(slot);
    if (!label) throw new Error(`Prompt references unavailable or unsent input @${slot}.`);
    mentioned.add(slot);
    return label;
  });
  for (const slot of mentioned) {
    if (!sentSlots.has(slot)) throw new Error(`Prompt references unsent input @${slot}.`);
  }
  const missingBindings = sentAssets
    .filter((asset) => !mentioned.has(asset.slot))
    .map((asset) => referencePurposeBinding(labels.get(asset.slot)!, asset));
  return missingBindings.length ? `${missingBindings.join("\n")}\n\n${rewritten.trim()}` : rewritten.trim();
}

function requestAssetOrder(draft: GenerationDraft, model: GenerationModel): ReferenceAsset[] {
  if (draft.mode === "image") {
    let images = draft.assets.filter((asset) => assetMediaKind(asset) === "image");
    if (draft.editTargetSlot && /^openai\/(?:gpt-image|chatgpt-image)/.test(draft.model)) {
      const target = images.find((asset) => asset.slot === draft.editTargetSlot);
      if (target) images = [target, ...images.filter((asset) => asset.slot !== draft.editTargetSlot)];
    }
    return images;
  }
  const video = model as VideoModel;
  const referenceTypes = videoReferenceTypes(video);
  const references = draft.assets.filter((asset) =>
    asset.role === "reference" && referenceTypes.includes(assetMediaKind(asset))
  );
  const frames = draft.assets.filter((asset) =>
    (asset.role === "first_frame" || asset.role === "last_frame")
    && assetMediaKind(asset) === "image"
    && video.supported_frame_images?.includes(asset.role)
  );
  return [...references, ...frames];
}

export function referenceCoverageReport(
  draft: GenerationDraft,
  model: GenerationModel | null,
  payload?: Record<string, unknown>,
  referencePriorities?: Record<number, PromptPlanReference["priority"]>,
): ReferenceCoverage[] {
  if (!model) {
    return draft.assets.map((asset) => {
      const priority = referencePriorities?.[asset.slot] ?? "required";
      return {
        slot: asset.slot,
        purpose: asset.purpose,
        priority,
        sent: false,
        transportRoleValid: false,
        boundInPrompt: false,
        severity: priority === "required" ? "error" : "warning",
      };
    });
  }
  const request = payload ?? buildRequest(draft, model);
  const sentAssets = requestAssetOrder(draft, model);
  const sentSlots = new Set(sentAssets.map((asset) => asset.slot));
  const labels = providerReferenceLabels(
    draft.mode,
    sentAssets,
    promptProfileForModel(draft.mode, draft.model).referenceSyntax === "runway_image_number",
  );
  const requestPrompt = String(request.prompt ?? "");
  return draft.assets.map((asset) => {
    const priority = referencePriorities?.[asset.slot] ?? "required";
    const sent = sentSlots.has(asset.slot);
    const transportRoleValid = allowedAssetRolesForKind(draft.mode, model, assetMediaKind(asset)).includes(asset.role);
    const providerLabel = labels.get(asset.slot);
    const boundInPrompt = Boolean(providerLabel && requestPrompt.includes(providerLabel));
    return {
      slot: asset.slot,
      purpose: asset.purpose,
      priority,
      sent,
      transportRoleValid,
      boundInPrompt,
      nativeControl: asset.role === "first_frame"
        ? "frame_images.first_frame"
        : asset.role === "last_frame"
          ? "frame_images.last_frame"
          : "input_references",
      providerLabel,
      severity: sent && transportRoleValid && boundInPrompt
        ? "ok"
        : priority === "required" ? "error" : "warning",
    };
  });
}

export function validateReferenceCoverage(coverage: ReferenceCoverage[]): string | null {
  const failed = coverage.find((entry) => entry.severity === "error");
  if (!failed) return null;
  if (!failed.transportRoleValid) return `Reference @${failed.slot} has an unsupported transport role.`;
  if (!failed.sent) return `Required reference @${failed.slot} was not serialized into the request.`;
  return `Required reference @${failed.slot} was not bound in the provider prompt.`;
}

export function buildRequest(draft: GenerationDraft, model: GenerationModel | null): Record<string, unknown> {
  if (!model) return {};
  const slots = new Set<number>();
  for (const asset of draft.assets) {
    if (!Number.isInteger(asset.slot) || asset.slot < 1) throw new Error("Every reference slot must be a positive integer.");
    if (slots.has(asset.slot)) throw new Error(`Reference slot @${asset.slot} is duplicated.`);
    slots.add(asset.slot);
  }
  const sentAssets: ReferenceAsset[] = [];
  const payload: Record<string, unknown> = {
    model: draft.model,
    prompt: draft.prompt.trim(),
  };
  if (draft.mode === "image") {
    const imageModel = model as ImageModel;
    const unsupportedAssets = draft.assets.filter((asset) => assetMediaKind(asset) !== "image");
    if (unsupportedAssets.length) {
      throw new Error(`This image model does not accept ${assetMediaKind(unsupportedAssets[0])} reference @${unsupportedAssets[0].slot}.`);
    }
    for (const [key, value] of Object.entries(draft.options)) {
      if (draft.model === "openai/gpt-image-2" && key === "input_fidelity") continue;
      if (imageModel.supported_parameters[key] && value !== undefined && value !== "") payload[key] = value;
    }
    const limit = imageReferenceLimit(imageModel);
    let images = draft.assets.filter((asset) => asset.mediaType.startsWith("image/"));
    if (images.length > limit) throw new Error(`This image model accepts at most ${limit} reference inputs; received ${images.length}.`);
    if (images.length && limit === 0) throw new Error("This image model does not accept reference inputs.");
    if (draft.editTargetSlot && /^openai\/(?:gpt-image|chatgpt-image)/.test(draft.model)) {
      const target = images.find((asset) => asset.slot === draft.editTargetSlot);
      if (!target) throw new Error(`The edit target @${draft.editTargetSlot} is not attached.`);
      images = [target, ...images.filter((asset) => asset.slot !== draft.editTargetSlot)];
    }
    if (images.length) {
      sentAssets.push(...images);
      payload.input_references = images.map(asReference);
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
      const kind = assetMediaKind(asset);
      return asset.role === "reference" && referenceTypes.includes(kind);
    });
    const unsupportedReferences = draft.assets.filter((asset) =>
      asset.role === "reference" && !referenceTypes.includes(assetMediaKind(asset))
    );
    if (unsupportedReferences.length) {
      throw new Error(`This video model does not accept ${assetMediaKind(unsupportedReferences[0])} reference @${unsupportedReferences[0].slot}.`);
    }
    const frames = draft.assets.filter((asset) =>
      (asset.role === "first_frame" || asset.role === "last_frame")
      && assetMediaKind(asset) === "image"
      && videoModel.supported_frame_images?.includes(asset.role),
    );
    const counts: Record<InputMediaKind, number> = { image: 0, video: 0, audio: 0 };
    for (const asset of references) counts[assetMediaKind(asset)] += 1;
    for (const kind of ["image", "video", "audio"] as const) {
      const limit = videoReferenceLimit(videoModel, kind);
      if (counts[kind] > limit) throw new Error(`This video model accepts at most ${limit} ${kind} references; received ${counts[kind]}.`);
    }
    const unsupportedFrames = draft.assets.filter((asset) =>
      (asset.role === "first_frame" || asset.role === "last_frame")
      && (assetMediaKind(asset) !== "image" || !videoModel.supported_frame_images?.includes(asset.role))
    );
    if (unsupportedFrames.length) throw new Error(`This video model does not accept ${unsupportedFrames[0].role.replaceAll("_", " ")} inputs.`);
    if (references.length) {
      sentAssets.push(...references);
      payload.input_references = references.map(asReference);
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
  validateProviderPassthrough(provider, model);
  payload.provider = { ...(provider ?? {}), require_parameters: true };
  if (draft.negativePrompt?.trim()) {
    if (draft.mode === "image" && (model as ImageModel).supported_parameters.negative_prompt) {
      payload.negative_prompt = draft.negativePrompt.trim();
    } else if (draft.mode === "video" && (model as VideoModel).allowed_passthrough_parameters?.includes("negative_prompt")) {
      payload.negative_prompt = draft.negativePrompt.trim();
    } else {
      payload.prompt = `${draft.prompt.trim()}\nConstraints: ${draft.negativePrompt.trim()}`;
    }
  }
  const promptTokens = [...String(payload.prompt).matchAll(/@(\d+)/g)];
  if (sentAssets.length || promptTokens.length) {
    payload.prompt = bindPromptReferences(String(payload.prompt), draft.mode, draft.model, sentAssets);
  }
  return payload;
}

export function productSystemInstruction(input: Omit<PromptEnhancementInput, "promptModel" | "prompt">): string {
  const profile = promptProfileForModel(input.mode, input.target.id);
  const task = input.mode === "image"
    ? input.editMode ? "image editing" : "image generation"
    : "video generation";
  const editRule = input.mode === "image" && input.editMode
    ? `The explicit edit target is "${input.editTarget}". Treat that numbered image as the canvas to modify; other numbered images are context only.`
    : "";
  const hasMaskGuide = input.visuals.some((visual) => visual.kind === "mask_guide");
  return [
    `The active Fruit Truck task is ${task}.`,
    `The selected generation model is ${input.target.name} (${input.target.id}).`,
    `Active generation options: ${JSON.stringify(input.target.options)}.`,
    `Declared target capabilities: ${JSON.stringify(input.target.capabilities ?? {})}.`,
    input.target.providerJson.trim()
      ? `Active provider routing and passthrough configuration: ${input.target.providerJson.trim()}.`
      : "No provider override is active.",
    profileInstruction(profile, input.workflow),
    "Numbered references are immutable input slots with authoritative semantic purposes.",
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
    plannerConstitutionInstruction(),
    hasVisuals ? "Inspect every supplied visual before adding detail, and use only facts that are actually visible." : "",
    visualKinds.includes("video_frame") ? "Images labeled as a video storyboard are ordered samples from one source video. Infer only visible temporal change, camera movement, and continuity supported across those samples; do not treat any sample as an independent reference." : "",
    "For edits, identify the existing subject and requested delta precisely, and preserve every compatible unrequested identity, anatomy, geometry, texture, lighting, depth, composition, and continuity invariant.",
    visualKinds.includes("mask_guide") ? "For a mask guide, infer the intended semantic part from the original image and explicitly prevent generation of the painted brush-stroke silhouette as a new object. Keep simple color, material, or attribute changes attribute-only: do not add pose changes, gestures, finger placement, grasp angles, contact geometry, or limb restyling. Preserve exact overlaps and occlusions around the selected subject, and limit any boundary blending to that subject's own edge." : "",
  ].filter(Boolean).join(" ");
}

export function promptEnhancementUserContent(input: PromptEnhancementInput): PromptEnhancementContentPart[] {
  const visualCatalog = input.visuals.length
    ? ["", "Visual inputs, in the same order as the attached images:", ...input.visuals.map((visual, index) => {
      return `Visual ${index + 1}: @${visual.slot} ${visual.name} (${visual.kind}, ${visual.role})`;
    })]
    : [];
  const text = [
    "User prompt:",
    input.prompt.trim() || "(none)",
    "",
    referenceCatalogInstruction(input.references),
    ...(input.hasMask ? ["", "Mask instructions:", input.maskInstructions?.trim() || "Apply the user prompt to the semantically selected subject or part."] : []),
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

export function validateEnhancedPrompt(
  original: string,
  enhanced: string,
  editTarget?: string,
  validSlots?: Iterable<number>,
  requiredSlots?: Iterable<number>,
): string | null {
  if (!enhanced.trim()) return "The enhanced prompt is empty.";
  const available = validSlots ? new Set(validSlots) : null;
  const tokens = (value: string) => [...value.matchAll(/@(\d+)/g)].map((match) => Number(match[1]));
  const originalTokens = new Set(tokens(`${original} ${editTarget ?? ""}`));
  const enhancedTokens = new Set(tokens(enhanced));
  for (const token of originalTokens) {
    if (!enhancedTokens.has(token)) return `Prompt enhancement removed @${token}.`;
  }
  for (const token of enhancedTokens) {
    if (available ? !available.has(token) : !originalTokens.has(token)) return `Prompt enhancement invented @${token}.`;
  }
  for (const token of requiredSlots ?? []) {
    if (!enhancedTokens.has(token)) return `Prompt enhancement did not bind required reference @${token}.`;
  }
  return null;
}

export async function enhancePrompt(input: PromptEnhancementInput, onActualCost?: ActualCostHandler): Promise<PromptEnhancementArtifact> {
  const profile = promptProfileForModel(input.mode, input.target.id);
  const baseMessages = [
    { role: "system", content: productSystemInstruction(input) },
    { role: "system", content: promptEnhancerInstruction(input.visuals.map((visual) => visual.kind)) },
    { role: "user", content: promptEnhancementUserContent(input) },
  ];
  let totalCost = 0;
  let previousText = "";
  let previousError = "";
  for (let repairAttempts = 0; repairAttempts < 2; repairAttempts += 1) {
    const messages = repairAttempts === 0 ? baseMessages : [
      ...baseMessages,
      { role: "assistant", content: previousText },
      {
        role: "user",
        content: `Repair the previous JSON so it exactly matches the supplied schema and reference contract. Validation error: ${previousError}. Return only the repaired JSON object.`,
      },
    ];
    let response: {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: { cost?: number };
    };
    try {
      response = await request("POST", "/chat/completions", {
        model: input.promptModel,
        reasoning: { effort: input.promptModel.endsWith("luna") ? "xhigh" : "high" },
        response_format: PROMPT_PLAN_RESPONSE_FORMAT,
        provider: { require_parameters: true },
        messages,
      });
    } catch (error) {
      if (totalCost > 0) onActualCost?.(totalCost);
      throw error;
    }
    totalCost += responseCost(response) ?? 0;
    const content = response.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : content?.map((part) => part.text ?? "").join("");
    try {
      if (!text?.trim()) throw new Error("The prompt model returned no structured prompt plan.");
      const plan = parsePromptPlan(text);
      if (plan.mode !== input.mode || plan.workflow !== input.workflow) {
        throw new Error(`The prompt planner returned ${plan.mode}/${plan.workflow} for the required ${input.mode}/${input.workflow} workflow.`);
      }
      const compiled = compilePromptPlan({ plan, profile, workflow: input.workflow, references: input.references });
      const validationError = validateCompiledPrompt(compiled, input.references);
      if (validationError) throw new Error(validationError);
      if (totalCost > 0) onActualCost?.(totalCost);
      return {
        schemaVersion: 1,
        ...compiled,
        signature: input.signature,
        plannerModel: input.promptModel,
        target: input.target,
        profileSources: profile.sources,
        repairAttempts,
        createdAt: new Date().toISOString(),
        plan,
      };
    } catch (error) {
      previousText = text ?? "";
      previousError = error instanceof Error ? error.message : String(error);
      if (repairAttempts === 1) {
        if (totalCost > 0) onActualCost?.(totalCost);
        throw error;
      }
    }
  }
  throw new Error("Prompt enhancement repair failed.");
}

type ActualCostHandler = (actualCostUsd: number) => void;

function responseCost(response: { usage?: { cost?: number } }) {
  const cost = response.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

function reportActualCost(response: { usage?: { cost?: number } }, onActualCost?: ActualCostHandler) {
  const cost = responseCost(response);
  if (cost != null) onActualCost?.(cost);
  return cost;
}

export async function generateImage(payload: Record<string, unknown>, onActualCost?: ActualCostHandler): Promise<ImageResult> {
  const response = await request<{
    data?: Array<{ b64_json?: string; url?: string; local_path?: string; media_type?: string }>;
    usage?: { cost?: number };
  }>("POST", "/images", payload);
  const actualCostUsd = reportActualCost(response, onActualCost);
  const urls = (response.data ?? []).flatMap((item) => {
    if (item.local_path) return [item.local_path];
    if (item.url) return [item.url];
    if (item.b64_json) return [`data:${item.media_type ?? "image/png"};base64,${item.b64_json}`];
    return [];
  });
  if (!urls.length) throw new Error("OpenRouter returned no image data.");
  return { kind: "image", urls, actualCostUsd };
}

function serializedVideoError(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (!error) return undefined;
  try { return JSON.stringify({ error }); } catch { return String(error); }
}

export async function submitVideo(payload: Record<string, unknown>, onActualCost?: ActualCostHandler): Promise<VideoResult> {
  const response = await request<{ id?: string; job_id?: string; status?: unknown; error?: unknown; usage?: { cost?: number } }>(
    "POST",
    "/videos",
    payload,
  );
  const actualCostUsd = reportActualCost(response, onActualCost);
  const jobId = response.id ?? response.job_id;
  if (!jobId) throw new Error("OpenRouter returned no video job ID.");
  return { kind: "video", jobId, status: normalizeVideoStatus(response.status, "pending"), error: serializedVideoError(response.error), actualCostUsd };
}

export async function pollVideo(jobId: string, onActualCost?: ActualCostHandler): Promise<VideoResult> {
  const response = await request<{
    id?: string;
    status?: unknown;
    progress?: number;
    error?: unknown;
    unsigned_urls?: string[];
    data?: Array<{ url?: string }>;
    usage?: { cost?: number };
  }>("GET", `/videos/${encodeURIComponent(jobId)}`);
  const actualCostUsd = reportActualCost(response, onActualCost);
  const error = serializedVideoError(response.error);
  const url = response.unsigned_urls?.[0] ?? response.data?.[0]?.url;
  return {
    kind: "video",
    jobId,
    status: normalizeVideoStatus(response.status),
    progress: response.progress,
    error,
    url,
    actualCostUsd,
  };
}

export async function cacheVideo(jobId: string): Promise<string> {
  if (isTauriRuntime()) {
    const result = await invokeTauri<{ path: string }>("cache_video_content", { jobId });
    return result.path;
  }
  const key = window.localStorage.getItem("fruit-truck.dev-key");
  const response = await fetch(`https://openrouter.ai/api/v1/videos/${encodeURIComponent(jobId)}/content?index=0`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: could not download generated video content.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "video/mp4";
  if (!contentType.startsWith("video/")) throw new Error("Generated video content has an invalid media type.");
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > 700 * 1024 * 1024) throw new Error("Generated video exceeds the 700 MB local safety limit.");
  const blob = await response.blob();
  if (!blob.size || blob.size > 700 * 1024 * 1024) throw new Error("Generated video exceeds the 700 MB local safety limit.");
  return URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: contentType }));
}

export function prettyRequest(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === "string" && value.startsWith("data:") && value.length > 120) {
      return `<media payload omitted · ${Math.round(value.length / 1024)} KB>`;
    }
    return value;
  }, 2);
}
