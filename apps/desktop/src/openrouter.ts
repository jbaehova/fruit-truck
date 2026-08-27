import {
  applyVideoCapabilityProvenance,
  assessVideoReferenceTransport,
  videoInputPolicy,
  videoReferenceTransportForUrl,
  type InputMediaKind,
  type VideoReferenceTransport,
} from "./modelPolicies.ts";
import {
  validateCapabilityOptions,
  normalizeModelSearchText,
  modelSearchMatches,
  type CapabilityValidationIssue,
} from "./optionValues.ts";
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

export type CapabilityDescriptor = {
  type: "enum" | "range" | "boolean";
  values?: Array<string | number>;
  min?: number;
  max?: number;
};

export type ImagePricingLine = {
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
  route?: GenerationRoute;
  providerJson?: string;
  plannerCostUsd?: number;
  plannerRoute?: GenerationRoute;
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
  supported_sizes?: string[] | null;
  supports_streaming?: boolean;
  endpoint_count?: number;
  endpoints?: string;
  endpoint_details?: ImageModelEndpoint[];
  pricing?: ImagePricingLine[];
};

export type ImageModelEndpoint = {
  id?: string;
  endpoint_id?: string;
  provider_name: string;
  provider_slug: string;
  provider_tag?: string | null;
  supported_parameters: Record<string, CapabilityDescriptor>;
  /** Endpoint-specific size values, when the endpoint exposes them directly. */
  supported_sizes?: string[] | null;
  allowed_passthrough_parameters?: string[];
  pricing?: ImagePricingLine[];
  supports_streaming?: boolean;
  privacy?: EndpointPrivacy;
  zdr?: boolean | null;
  data_collection?: string | null;
};

/** Endpoint metadata is intentionally separate from the model-level union. */
export type VideoModelEndpoint = {
  id?: string;
  endpoint_id?: string;
  provider_name: string;
  provider_slug: string;
  provider_tag?: string | null;
  supported_parameters?: Record<string, CapabilityDescriptor>;
  supported_resolutions?: string[] | null;
  supported_aspect_ratios?: string[] | null;
  supported_sizes?: string[] | null;
  supported_durations?: number[] | null;
  input_reference_types?: InputMediaKind[] | null;
  max_input_references?: number | null;
  supported_frame_images?: Array<"first_frame" | "last_frame"> | null;
  reference_transports?: Partial<Record<InputMediaKind, VideoReferenceTransport[]>> | VideoReferenceTransport[] | null;
  input_reference_transports?: Partial<Record<InputMediaKind, VideoReferenceTransport[]>> | VideoReferenceTransport[] | null;
  supports_references?: boolean | null;
  pricing_skus?: Record<string, string> | null;
  allowed_passthrough_parameters?: string[];
  supports_streaming?: boolean;
  privacy?: EndpointPrivacy;
  zdr?: boolean | null;
  data_collection?: string | null;
};

export type EndpointPrivacy = {
  /** Whether the endpoint is explicitly zero-data-retention capable. */
  zdr?: boolean | null;
  data_collection?: string | null;
};

export type VideoModel = {
  id: string;
  name: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: Record<string, CapabilityDescriptor>;
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
  endpoints?: VideoModelEndpoint[];
  reference_transports?: Partial<Record<InputMediaKind, VideoReferenceTransport[]>> | VideoReferenceTransport[] | null;
  reference_transport_source?: "openrouter_endpoint" | "contract_fixture" | "unknown" | null;
  privacy?: EndpointPrivacy;
};

export type GenerationModel = ImageModel | VideoModel;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return values.length ? [...new Set(values)] : [];
}

function inputMediaKinds(value: unknown): InputMediaKind[] | null | undefined {
  if (value == null) return value === null ? null : undefined;
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is InputMediaKind => item === "image" || item === "video" || item === "audio");
  return [...new Set(values)];
}

/** Normalize one external capability descriptor; malformed fields are isolated. */
export function normalizeCapabilityDescriptor(raw: unknown): CapabilityDescriptor | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (type === "boolean") return { type };
  if (type === "enum") {
    if (!Array.isArray(raw.values)) return null;
    const values = raw.values.filter((value): value is string | number =>
      (typeof value === "string" && value.trim().length > 0) || (typeof value === "number" && Number.isFinite(value)),
    );
    return values.length ? { type, values: [...new Set(values)] } : null;
  }
  if (type === "range") {
    const min = finiteNumber(raw.min);
    const max = finiteNumber(raw.max);
    if (min == null && max == null) return null;
    if (min != null && max != null && min > max) return null;
    return { type, ...(min == null ? {} : { min }), ...(max == null ? {} : { max }) };
  }
  return null;
}

function normalizeDescriptors(raw: unknown): Record<string, CapabilityDescriptor> {
  if (!isRecord(raw)) return {};
  const output: Record<string, CapabilityDescriptor> = {};
  for (const [name, value] of Object.entries(raw)) {
    const descriptor = normalizeCapabilityDescriptor(value);
    if (descriptor) output[name] = descriptor;
  }
  return output;
}

function normalizePricing(raw: unknown): ImagePricingLine[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const output: ImagePricingLine[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value.billable !== "string" || typeof value.unit !== "string") continue;
    const cost = finiteNumber(value.cost_usd);
    if (cost == null || cost < 0) continue;
    output.push({
      billable: value.billable,
      unit: value.unit,
      cost_usd: cost,
      ...(typeof value.variant === "string" && value.variant ? { variant: value.variant } : {}),
    });
  }
  return output;
}

function normalizePrivacy(raw: unknown): EndpointPrivacy | undefined {
  if (!isRecord(raw)) return undefined;
  const privacy = isRecord(raw.privacy) ? raw.privacy : raw;
  const zdr = typeof privacy.zdr === "boolean" ? privacy.zdr : null;
  const dataCollection = typeof privacy.data_collection === "string" ? privacy.data_collection : null;
  if (zdr == null && dataCollection == null) return undefined;
  return { ...(zdr == null ? {} : { zdr }), ...(dataCollection == null ? {} : { data_collection: dataCollection }) };
}

function normalizePassthrough(raw: unknown): string[] | undefined {
  return stringArray(raw);
}

function normalizeImageEndpoint(raw: unknown): ImageModelEndpoint | null {
  if (!isRecord(raw) || typeof raw.provider_name !== "string" || typeof raw.provider_slug !== "string") return null;
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.endpoint_id === "string" ? { endpoint_id: raw.endpoint_id } : {}),
    provider_name: raw.provider_name,
    provider_slug: raw.provider_slug,
    ...(typeof raw.provider_tag === "string" || raw.provider_tag === null ? { provider_tag: raw.provider_tag } : {}),
    supported_parameters: normalizeDescriptors(raw.supported_parameters),
    ...(stringArray(raw.supported_sizes) !== undefined ? { supported_sizes: stringArray(raw.supported_sizes) } : {}),
    ...(normalizePassthrough(raw.allowed_passthrough_parameters) ? { allowed_passthrough_parameters: normalizePassthrough(raw.allowed_passthrough_parameters) } : {}),
    ...(normalizePricing(raw.pricing) ? { pricing: normalizePricing(raw.pricing) } : {}),
    ...(typeof raw.supports_streaming === "boolean" ? { supports_streaming: raw.supports_streaming } : {}),
    ...(normalizePrivacy(raw) ? { privacy: normalizePrivacy(raw) } : {}),
    ...(typeof raw.zdr === "boolean" || raw.zdr === null ? { zdr: raw.zdr } : {}),
    ...(typeof raw.data_collection === "string" || raw.data_collection === null ? { data_collection: raw.data_collection } : {}),
  };
}

function normalizeTransport(value: unknown): VideoReferenceTransport | null {
  const normalized = String(value ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (["http", "http_url"].includes(normalized)) return "http_url";
  if (["https", "url", "https_url", "remote_url", "public_url"].includes(normalized)) return "https_url";
  if (["signed", "signed_url", "presigned_url"].includes(normalized)) return "signed_url";
  if (["data", "data_url", "data_uri", "base64"].includes(normalized)) return "data_url";
  if (["local", "local_file", "file"].includes(normalized)) return "local_file";
  return null;
}

function normalizeTransports(raw: unknown): VideoModelEndpoint["reference_transports"] {
  if (Array.isArray(raw)) {
    const values = raw.map(normalizeTransport).filter((value): value is VideoReferenceTransport => value != null);
    return values.length ? values : [];
  }
  if (!isRecord(raw)) return undefined;
  const output: Partial<Record<InputMediaKind, VideoReferenceTransport[]>> = {};
  for (const kind of ["image", "video", "audio"] as const) {
    const values = raw[kind];
    if (!Array.isArray(values)) continue;
    output[kind] = values.map(normalizeTransport).filter((value): value is VideoReferenceTransport => value != null);
  }
  return output;
}

function normalizeVideoEndpoint(raw: unknown): VideoModelEndpoint | null {
  if (!isRecord(raw) || typeof raw.provider_name !== "string" || typeof raw.provider_slug !== "string") return null;
  const inputTypes = inputMediaKinds(raw.input_reference_types);
  const max = raw.max_input_references == null ? raw.max_input_references : nonNegativeInteger(raw.max_input_references);
  if (raw.max_input_references != null && max == null) return null;
  const transports = normalizeTransports(raw.reference_transports ?? raw.input_reference_transports);
  return {
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.endpoint_id === "string" ? { endpoint_id: raw.endpoint_id } : {}),
    provider_name: raw.provider_name,
    provider_slug: raw.provider_slug,
    supported_parameters: normalizeDescriptors(raw.supported_parameters),
    ...(stringArray(raw.supported_resolutions) !== undefined ? { supported_resolutions: stringArray(raw.supported_resolutions) } : {}),
    ...(stringArray(raw.supported_aspect_ratios) !== undefined ? { supported_aspect_ratios: stringArray(raw.supported_aspect_ratios) } : {}),
    ...(stringArray(raw.supported_sizes) !== undefined ? { supported_sizes: stringArray(raw.supported_sizes) } : {}),
    ...(normalizeNumericArray(raw.supported_durations) !== undefined ? { supported_durations: normalizeNumericArray(raw.supported_durations) } : {}),
    ...(inputTypes !== undefined ? { input_reference_types: inputTypes } : {}),
    ...(max === null ? { max_input_references: null } : max === undefined ? {} : { max_input_references: max }),
    ...(Array.isArray(raw.supported_frame_images) ? { supported_frame_images: raw.supported_frame_images.filter((value): value is "first_frame" | "last_frame" => value === "first_frame" || value === "last_frame") } : {}),
    ...(transports !== undefined ? { reference_transports: transports } : {}),
    ...(transports !== undefined ? { input_reference_transports: transports } : {}),
    ...(typeof raw.supports_references === "boolean" || raw.supports_references === null ? { supports_references: raw.supports_references } : {}),
    ...(isRecord(raw.pricing_skus) ? { pricing_skus: Object.fromEntries(Object.entries(raw.pricing_skus).filter(([, value]) => typeof value === "string")) as Record<string, string> } : {}),
    ...(normalizePassthrough(raw.allowed_passthrough_parameters) ? { allowed_passthrough_parameters: normalizePassthrough(raw.allowed_passthrough_parameters) } : {}),
    ...(typeof raw.supports_streaming === "boolean" ? { supports_streaming: raw.supports_streaming } : {}),
    ...(normalizePrivacy(raw) ? { privacy: normalizePrivacy(raw) } : {}),
    ...(typeof raw.zdr === "boolean" || raw.zdr === null ? { zdr: raw.zdr } : {}),
    ...(typeof raw.data_collection === "string" || raw.data_collection === null ? { data_collection: raw.data_collection } : {}),
  };
}

function normalizeArchitecture(raw: unknown): ImageModel["architecture"] | undefined {
  if (!isRecord(raw)) return undefined;
  const input = stringArray(raw.input_modalities);
  const output = stringArray(raw.output_modalities);
  if (!input && !output) return undefined;
  return { ...(input ? { input_modalities: input } : {}), ...(output ? { output_modalities: output } : {}) };
}

function normalizeNumericArray(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return [...new Set(raw.map(finiteNumber).filter((value): value is number => value != null && value >= 0))];
}

export type CatalogItemRejection = { index: number; error: string; raw: unknown };
export type CatalogNormalizationResult<T extends GenerationModel> = {
  models: T[];
  rejected: CatalogItemRejection[];
};

export function normalizeImageModel(raw: unknown): ImageModel | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (!isRecord(raw.supported_parameters)) return null;
  const endpointRaw = raw.endpoint_details ?? (Array.isArray(raw.endpoints) ? raw.endpoints : undefined);
  const endpoints = Array.isArray(endpointRaw)
    ? endpointRaw.map(normalizeImageEndpoint).filter((value): value is ImageModelEndpoint => value != null)
    : undefined;
  const sizes = stringArray(raw.supported_sizes);
  return {
    id: raw.id.trim(),
    name: raw.name.trim(),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(normalizeArchitecture(raw.architecture) ? { architecture: normalizeArchitecture(raw.architecture) } : {}),
    supported_parameters: normalizeDescriptors(raw.supported_parameters),
    ...(sizes !== undefined ? { supported_sizes: sizes } : {}),
    ...(typeof raw.supports_streaming === "boolean" ? { supports_streaming: raw.supports_streaming } : {}),
    ...(nonNegativeInteger(raw.endpoint_count) != null ? { endpoint_count: nonNegativeInteger(raw.endpoint_count) } : {}),
    ...(typeof raw.endpoints === "string" ? { endpoints: raw.endpoints } : {}),
    ...(endpoints ? { endpoint_details: endpoints } : {}),
    ...(normalizePricing(raw.pricing) ? { pricing: normalizePricing(raw.pricing) } : {}),
  };
}

export function normalizeVideoModel(raw: unknown): VideoModel | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || typeof raw.name !== "string" || !raw.name.trim()) return null;
  const inputTypes = inputMediaKinds(raw.input_reference_types);
  const max = raw.max_input_references == null ? raw.max_input_references : nonNegativeInteger(raw.max_input_references);
  if (raw.max_input_references != null && max == null) return null;
  const frameImages = Array.isArray(raw.supported_frame_images)
    ? raw.supported_frame_images.filter((value): value is "first_frame" | "last_frame" => value === "first_frame" || value === "last_frame")
    : undefined;
  const endpointRaw = raw.endpoints ?? raw.endpoint_details;
  const endpointValues = Array.isArray(endpointRaw)
    ? endpointRaw.map(normalizeVideoEndpoint).filter((value): value is VideoModelEndpoint => value != null)
    : undefined;
  const transports = normalizeTransports(raw.reference_transports);
  return {
    id: raw.id.trim(),
    name: raw.name.trim(),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(normalizeArchitecture(raw.architecture) ? { architecture: normalizeArchitecture(raw.architecture) } : {}),
    ...(isRecord(raw.supported_parameters) ? { supported_parameters: normalizeDescriptors(raw.supported_parameters) } : {}),
    ...(inputTypes !== undefined ? { input_reference_types: inputTypes } : {}),
    ...(max === null ? { max_input_references: null } : max === undefined ? {} : { max_input_references: max }),
    ...(stringArray(raw.supported_resolutions) !== undefined ? { supported_resolutions: stringArray(raw.supported_resolutions) } : {}),
    ...(stringArray(raw.supported_aspect_ratios) !== undefined ? { supported_aspect_ratios: stringArray(raw.supported_aspect_ratios) } : {}),
    ...(stringArray(raw.supported_sizes) !== undefined ? { supported_sizes: stringArray(raw.supported_sizes) } : {}),
    ...(normalizeNumericArray(raw.supported_durations) !== undefined ? { supported_durations: normalizeNumericArray(raw.supported_durations) } : {}),
    ...(frameImages ? { supported_frame_images: [...new Set(frameImages)] } : {}),
    ...(typeof raw.generate_audio === "boolean" || raw.generate_audio === null ? { generate_audio: raw.generate_audio } : {}),
    ...(typeof raw.seed === "boolean" || raw.seed === null ? { seed: raw.seed } : {}),
    ...(isRecord(raw.pricing_skus) ? { pricing_skus: Object.fromEntries(Object.entries(raw.pricing_skus).filter(([, value]) => typeof value === "string")) as Record<string, string> } : {}),
    ...(normalizePassthrough(raw.allowed_passthrough_parameters) ? { allowed_passthrough_parameters: normalizePassthrough(raw.allowed_passthrough_parameters) } : {}),
    ...(endpointValues ? { endpoints: endpointValues } : {}),
    ...(transports !== undefined ? { reference_transports: transports } : {}),
    ...(raw.reference_transport_source === "openrouter_endpoint" || raw.reference_transport_source === "contract_fixture" || raw.reference_transport_source === "unknown"
      ? { reference_transport_source: raw.reference_transport_source }
      : {}),
    ...(normalizePrivacy(raw) ? { privacy: normalizePrivacy(raw) } : {}),
  };
}

export function normalizeCatalogItems(mode: "image", raw: unknown): CatalogNormalizationResult<ImageModel>;
export function normalizeCatalogItems(mode: "video", raw: unknown): CatalogNormalizationResult<VideoModel>;
export function normalizeCatalogItems(mode: GenerationMode, raw: unknown): CatalogNormalizationResult<GenerationModel> {
  const values = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : null;
  if (!values) return { models: [], rejected: [{ index: -1, error: "Catalog response data must be an array.", raw }] };
  const models: GenerationModel[] = [];
  const rejected: CatalogItemRejection[] = [];
  values.forEach((value, index) => {
    const model = mode === "image" ? normalizeImageModel(value) : normalizeVideoModel(value);
    if (model) models.push(model);
    else rejected.push({ index, error: `Invalid ${mode} model catalog item.`, raw: value });
  });
  return { models, rejected };
}

/** Explicit mode aliases make call sites and contract fixtures self-documenting. */
export const normalizeImageCatalog = (raw: unknown): CatalogNormalizationResult<ImageModel> => normalizeCatalogItems("image", raw);
export const normalizeVideoCatalog = (raw: unknown): CatalogNormalizationResult<VideoModel> => normalizeCatalogItems("video", raw);

export type CatalogSelection = {
  status: "available" | "unavailable" | "missing";
  modelId: string;
  model?: GenerationModel;
  changed: boolean;
  reason?: string;
};

/** Keep a saved model id stable across refreshes; never silently pick index 0. */
export function reconcileCatalogSelection(
  selectedModelId: string | undefined,
  models: GenerationModel[],
): CatalogSelection {
  const modelId = selectedModelId?.trim() ?? "";
  if (!modelId) return {
    status: "missing",
    modelId: "",
    changed: false,
    reason: "No model was selected.",
  };
  const model = models.find((candidate) => candidate.id === modelId);
  if (model) return { status: "available", modelId, model, changed: false };
  return {
    status: "unavailable",
    modelId,
    changed: false,
    reason: "The saved model is not present in the current catalog; explicit re-selection is required.",
  };
}

export function catalogFingerprint(models: GenerationModel[]): string {
  return stableHash(models.map((model) => model));
}

export const normalizeSearchText = normalizeModelSearchText;
export const modelMatchesSearch = modelSearchMatches;

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

export function modelPriceLabel(mode: GenerationMode, model: GenerationModel, route?: GenerationRoute): string {
  if (mode === "image") {
    const allPricing = route ? route.pricing ?? [] : (model as ImageModel).pricing ?? [];
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
  const video = route
    ? { ...(model as VideoModel), pricing_skus: route.pricingSkus }
    : model as VideoModel;
  const lines = videoPricingLines(video);
  const derivedSecond = seedanceSecondPrice(video, lines);
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
  const route = context.route ?? (context.providerJson
    ? resolveEligibleRoute({ mode, model, options, providerJson: context.providerJson }).selected
    : undefined);
  const routedContext = route && !context.route ? { ...context, route } : context;
  if (mode === "image") {
    const image = model as ImageModel;
    const endpointEstimates = route
      ? [estimateImagePricing(route.pricing ?? [], options, routedContext)]
      : (image.endpoint_details ?? [])
        .map((endpoint) => estimateImagePricing(endpoint.pricing ?? [], options, routedContext));
    const validEndpointEstimates = endpointEstimates
      .filter((value): value is number => value != null);
    if (validEndpointEstimates.length) return Math.min(...validEndpointEstimates);
    return estimateImagePricing(image.pricing ?? [], options, context);
  }
  const video = route
    ? { ...(model as VideoModel), pricing_skus: route.pricingSkus }
    : model as VideoModel;
  const lines = videoPricingLines(video);
  const minimum = lines.filter((line) => line.minimum).map((line) => line.costUsd);
  const secondRate = selectVideoSecondRate(lines, options, routedContext)
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

export type GenerationCostMetadata = {
  currency: "USD";
  generationMinUsd?: number;
  generationMaxUsd?: number;
  plannerUsd?: number;
  totalMinUsd?: number;
  totalMaxUsd?: number;
  outputCount: number;
  known: boolean;
  uncertain: boolean;
  routeIds: string[];
  label: string;
};

function estimateForRoute(
  mode: GenerationMode,
  model: GenerationModel,
  options: DraftOptions,
  route: GenerationRoute,
  context: GenerationCostContext,
): number | undefined {
  return estimateGenerationCost(mode, model, options, { ...context, route });
}

/** Route-aware estimate which never combines input/output prices across routes. */
export function generationCostMetadata(
  mode: GenerationMode,
  model: GenerationModel,
  options: DraftOptions,
  context: GenerationCostContext = {},
): GenerationCostMetadata {
  const resolution = context.route
    ? { selected: context.route, eligible: [context.route], definitive: context.route.endpointVerified }
    : resolveEligibleRoute({ mode, model, options, providerJson: context.providerJson });
  const routes = resolution.eligible.length ? resolution.eligible : resolution.selected ? [resolution.selected] : [];
  const estimates = routes
    .map((route) => estimateForRoute(mode, model, options, route, context))
    .filter((value): value is number => value != null && Number.isFinite(value));
  // A provider pin with no eligible route must not fall back to an unrelated
  // model-level price. Surface the estimate as unknown so callers can block
  // submission and ask for a route/catalog refresh.
  if (!estimates.length && !routes.length && !context.providerJson) {
    const fallback = estimateGenerationCost(mode, model, options, context);
    if (fallback != null) estimates.push(fallback);
  }
  const generationMinUsd = estimates.length ? normalizedUsd(Math.min(...estimates)) : undefined;
  const generationMaxUsd = estimates.length ? normalizedUsd(Math.max(...estimates)) : undefined;
  const plannerUsd = context.plannerCostUsd != null && Number.isFinite(context.plannerCostUsd) && context.plannerCostUsd >= 0
    ? normalizedUsd(context.plannerCostUsd)
    : undefined;
  const totalMinUsd = generationMinUsd == null ? plannerUsd : normalizedUsd(generationMinUsd + (plannerUsd ?? 0));
  const totalMaxUsd = generationMaxUsd == null ? plannerUsd : normalizedUsd(generationMaxUsd + (plannerUsd ?? 0));
  const routeIds = routes.map((route) => route.routeId);
  const priceKnown = estimates.length > 0 && estimates.length === routes.length;
  const uncertain = !resolution.definitive || !priceKnown || generationMaxUsd !== generationMinUsd;
  return {
    currency: "USD",
    generationMinUsd,
    generationMaxUsd,
    plannerUsd,
    totalMinUsd,
    totalMaxUsd,
    outputCount: typeof options.n === "number" && options.n > 0 ? Math.floor(options.n) : 1,
    known: priceKnown,
    uncertain,
    routeIds,
    label: totalMinUsd == null
      ? "Price unavailable"
      : totalMaxUsd != null && totalMaxUsd !== totalMinUsd
        ? `${formatUsd(totalMinUsd)}–${formatUsd(totalMaxUsd)} total`
        : `${formatUsd(totalMinUsd)} total`,
  };
}

export type RoutePrivacyMetadata = {
  providerSlug?: string;
  providerName?: string;
  endpointVerified: boolean;
  zdr: "required" | "supported" | "unsupported" | "unknown";
  dataCollection: "allow" | "deny" | "unknown";
  plannerSeparate: boolean;
  plannerInheritsConstraints: boolean;
  warning?: string;
};

function dataCollectionState(value: unknown): "allow" | "deny" | "unknown" {
  const normalized = String(value ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (["deny", "no", "none", "zdr", "zero", "zerodataretention"].includes(normalized)) return "deny";
  if (["allow", "yes", "standard", "retain", "retention"].includes(normalized)) return "allow";
  return "unknown";
}

export function routePrivacyMetadata(
  route: GenerationRoute | undefined,
  planner?: { route?: GenerationRoute; requested?: boolean; inheritsConstraints?: boolean },
): RoutePrivacyMetadata {
  const endpointPrivacy = route?.privacy ?? {};
  const plannerRequested = planner?.requested ?? Boolean(planner?.route);
  const plannerInherits = planner?.inheritsConstraints ?? Boolean(planner?.route && route && (
    planner.route.providerSlug === route.providerSlug
    || (planner.route.privacy.zdr === route.privacy.zdr && planner.route.privacy.data_collection === route.privacy.data_collection)
  ));
  return {
    providerSlug: route?.providerSlug,
    providerName: route?.providerName,
    endpointVerified: route?.endpointVerified === true,
    zdr: endpointPrivacy.zdr === true ? "supported" : endpointPrivacy.zdr === false ? "unsupported" : "unknown",
    dataCollection: dataCollectionState(endpointPrivacy.data_collection),
    plannerSeparate: plannerRequested,
    plannerInheritsConstraints: !plannerRequested || plannerInherits,
    ...(!plannerInherits && plannerRequested ? { warning: "Prompt planner privacy/routing constraints are not proven to match the generation route." } : {}),
  };
}

export type ReferenceAsset = {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
  role: ReferenceRole;
  purpose: ReferencePurpose;
  slot: number;
  /** Optional native byte size, used for bounded preflight accounting. */
  byteSize?: number;
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
  /** Resolved generation route used to inherit privacy constraints. */
  targetRoute?: GenerationRoute;
  /** Explicit planner routing policy; passthrough fields are never copied. */
  plannerProvider?: Record<string, unknown>;
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

export type OpenRouterKeyInfo = {
  label?: string;
  limit?: number | null;
  limit_remaining?: number | null;
  is_free_tier?: boolean;
  rate_limit?: unknown;
  [key: string]: unknown;
};

export type CredentialValidationStatus = "missing" | "stored" | "connected" | "unauthorized" | "rate_limited" | "offline" | "server_error" | "unknown";

export type CredentialValidationResult = {
  status: CredentialValidationStatus;
  key?: OpenRouterKeyInfo;
  httpStatus?: number;
  retryAfter?: string | null;
  error?: string;
};

export type ApiKeyCandidateValidation = {
  valid: boolean;
  state: "connected" | "unauthorized" | "rate_limited" | "offline" | "server_error" | "invalid" | "unknown";
  statusCode?: number;
  message?: string;
};

export function classifyCredentialError(error: unknown): CredentialValidationStatus {
  const value = String(error instanceof Error ? error.message : error).toLowerCase();
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: unknown }).status) : undefined;
  if (status === 401 || /\b401\b|unauthori[sz]ed|invalid.*(?:api|credential|key)/.test(value)) return "unauthorized";
  if (status === 429 || /\b429\b|rate.?limit|too many requests/.test(value)) return "rate_limited";
  if (status != null && status >= 500 || /\b5\d\d\b|server error|temporarily unavailable/.test(value)) return "server_error";
  if (/network|offline|failed to fetch|fetch failed|timeout|timed out|abort/.test(value)) return "offline";
  return "unknown";
}

export type ImageResult = {
  kind: "image";
  urls: string[];
  actualCostUsd?: number;
  recoveryPath?: string;
  materializationErrors: string[];
};

export type ImageGenerationProgress = {
  stage: "accepted" | "partial_image" | "completed" | "failed";
  partialImageIndex?: number;
};

type OpenRouterRequestOptions = {
  requestId?: string;
  onProgress?: (progress: ImageGenerationProgress) => void;
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

const browserRequestControllers = new Map<string, AbortController>();

export async function getCredentialStatus(): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("credential_status");
  const key = typeof window !== "undefined" ? window.localStorage.getItem("fruit-truck.dev-key") : null;
  return {
    configured: Boolean(key),
    maskedKey: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
    path: "~/.fruit-truck/credentials.json",
  };
}

export async function saveApiKey(apiKey: string): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("save_api_key", { apiKey });
  if (typeof window === "undefined") throw new Error("A browser or Tauri runtime is required to store an API key.");
  window.localStorage.setItem("fruit-truck.dev-key", apiKey.trim());
  return getCredentialStatus();
}

/** Validate a replacement key before mutating the currently working credential. */
export async function validateApiKeyCandidate(apiKey: string): Promise<ApiKeyCandidateValidation> {
  const candidate = apiKey.trim();
  if (isTauriRuntime()) return invokeTauri<ApiKeyCandidateValidation>("validate_api_key_candidate", { apiKey: candidate });
  if (typeof window === "undefined") throw new Error("A browser or Tauri runtime is required to validate an API key.");
  const previous = window.localStorage.getItem("fruit-truck.dev-key");
  window.localStorage.setItem("fruit-truck.dev-key", candidate);
  try {
    await getCurrentKey();
    return { valid: true, state: "connected", statusCode: 200 };
  } catch (error) {
    const state = classifyCredentialError(error);
    const typed = error as { status?: unknown };
    return {
      valid: false,
      state: state === "stored" || state === "missing" ? "unknown" : state,
      ...(typeof typed.status === "number" ? { statusCode: typed.status } : {}),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (previous == null) window.localStorage.removeItem("fruit-truck.dev-key");
    else window.localStorage.setItem("fruit-truck.dev-key", previous);
  }
}

export async function removeApiKey(): Promise<CredentialStatus> {
  if (isTauriRuntime()) return invokeTauri<CredentialStatus>("remove_api_key");
  if (typeof window === "undefined") return { configured: false, maskedKey: null, path: "~/.fruit-truck/credentials.json" };
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

function imageSseError(event: Record<string, unknown>): string | undefined {
  const error = event.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return undefined;
}

async function parseImageSseResponse(
  response: Response,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OpenRouter returned an unreadable image stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  const data: Array<Record<string, unknown>> = [];
  let usage: unknown;
  let created: unknown;
  const handleLine = (line: string) => {
    const payload = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : "";
    if (!payload || payload === "[DONE]") return;
    const event = JSON.parse(payload) as Record<string, unknown>;
    const error = imageSseError(event);
    if (error) throw new Error(`OpenRouter image stream failed: ${error}`);
    if (event.type === "image_generation.partial_image") {
      const partialImageIndex = typeof event.partial_image_index === "number" ? event.partial_image_index : undefined;
      onProgress?.({ stage: "partial_image", ...(partialImageIndex != null ? { partialImageIndex } : {}) });
      return;
    }
    if (event.type === "image_generation.completed") {
      const { type: _type, partial_image_index: _partialImageIndex, usage: eventUsage, created: eventCreated, ...image } = event;
      void _type;
      void _partialImageIndex;
      if (eventUsage !== undefined) usage = eventUsage;
      if (eventCreated !== undefined) created = eventCreated;
      data.push(image);
      onProgress?.({ stage: "completed" });
      return;
    }
    if (event.type === "image_generation.failed" || event.type === "error") {
      throw new Error(`OpenRouter image stream failed: ${JSON.stringify(event)}`);
    }
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > 448 * 1024 * 1024) throw new Error("OpenRouter image stream exceeds the local safety limit.");
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) break;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      handleLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);
  if (!data.length) throw new Error("OpenRouter image stream ended without a completed image.");
  return { data, ...(usage !== undefined ? { usage } : {}), ...(created !== undefined ? { created } : {}) };
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: OpenRouterRequestOptions = {},
): Promise<T> {
  if (isTauriRuntime()) {
    let unlisten: (() => void) | undefined;
    if (options.requestId && options.onProgress) {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<ImageGenerationProgress & { requestId: string }>("openrouter-request-progress", (event) => {
          if (event.payload.requestId !== options.requestId) return;
          options.onProgress?.({
            stage: event.payload.stage,
            ...(event.payload.partialImageIndex != null ? { partialImageIndex: event.payload.partialImageIndex } : {}),
          });
        });
      } catch {
        // Progress is advisory; a listener setup failure must not duplicate or
        // block the reviewed paid request.
      }
    }
    try {
      return await invokeTauri<T>("openrouter_request", {
        method,
        path,
        body: body ?? null,
        ...(options.requestId ? { requestId: options.requestId } : {}),
      });
    } finally {
      unlisten?.();
    }
  }
  const key = typeof window !== "undefined" ? window.localStorage.getItem("fruit-truck.dev-key") : null;
  const controller = options.requestId ? new AbortController() : undefined;
  if (options.requestId && controller) browserRequestControllers.set(options.requestId, controller);
  try {
    for (let retry = 0; ; retry += 1) {
      const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
        method,
        signal: controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: body == null ? undefined : JSON.stringify(body),
      });
      if (response.ok) {
        const contentType = response.headers?.get?.("content-type")?.toLowerCase() ?? "";
        if (path === "/images" && contentType.includes("text/event-stream")) {
          return await parseImageSseResponse(response, options.onProgress) as T;
        }
        return response.json() as Promise<T>;
      }
      const message = await response.text();
      // Image/video creation and planner calls are paid, non-idempotent POSTs.
      // A transport-level 429/503 must be surfaced as one uncertain attempt;
      // retrying here could create a second billable job after the first was
      // accepted. GET catalog/status reads remain safely retryable.
      if (method === "POST" || ![429, 503].includes(response.status) || retry >= 3) {
        const requestError = Object.assign(new Error(`OpenRouter ${response.status}: ${message}`), {
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
        });
        throw requestError;
      }
      await new Promise((resolveWait) => {
        const timer = typeof window !== "undefined" && typeof window.setTimeout === "function"
          ? window.setTimeout
          : globalThis.setTimeout;
        timer(resolveWait, retryDelayMs(response.headers.get("retry-after"), retry));
      });
    }
  } finally {
    if (options.requestId && browserRequestControllers.get(options.requestId) === controller) {
      browserRequestControllers.delete(options.requestId);
    }
  }
}

export async function cancelOpenRouterRequest(requestId: string): Promise<boolean> {
  if (isTauriRuntime()) return invokeTauri<boolean>("cancel_openrouter_request", { requestId });
  const controller = browserRequestControllers.get(requestId);
  if (!controller) return false;
  controller.abort("Local request tracking stopped.");
  return true;
}

/** Authenticated read-only OpenRouter key metadata check. */
export async function getCurrentKey(): Promise<OpenRouterKeyInfo> {
  const response = await request<OpenRouterKeyInfo | { data?: OpenRouterKeyInfo }>("GET", "/key");
  if (response && typeof response === "object" && "data" in response && response.data && typeof response.data === "object") {
    return response.data as OpenRouterKeyInfo;
  }
  return response as OpenRouterKeyInfo;
}

/** Distinguish a merely stored key from a key accepted by OpenRouter. */
export async function validateCredential(): Promise<CredentialValidationResult> {
  const credential = await getCredentialStatus();
  if (!credential.configured) return { status: "missing", error: "No OpenRouter API key is configured." };
  try {
    const key = await getCurrentKey();
    return { status: "connected", key };
  } catch (error) {
    const status = classifyCredentialError(error);
    const typed = error as { status?: unknown; retryAfter?: unknown };
    return {
      status,
      ...(typeof typed.status === "number" ? { httpStatus: typed.status } : {}),
      ...(typeof typed.retryAfter === "string" || typed.retryAfter === null ? { retryAfter: typed.retryAfter as string | null } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const validateOpenRouterCredential = validateCredential;

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
    const response = await request<{ data?: unknown }>("GET", "/images/models");
    const normalized = normalizeCatalogItems("image", response);
    if (!normalized.models.length && normalized.rejected.length) {
      throw new Error(`The image catalog contained no valid models (${normalized.rejected.length} rejected item${normalized.rejected.length === 1 ? "" : "s"}).`);
    }
    return normalized.models;
  }
  // The auxiliary `/models` architecture lookup is best effort and must not
  // make an otherwise valid video catalog fail. Each item is normalized in
  // isolation below, so one schema drift cannot erase the remaining catalog.
  const [videoResult, modalResult] = await Promise.allSettled([
    request<{ data?: unknown }>("GET", "/videos/models"),
    request<{ data?: Array<Pick<VideoModel, "id" | "architecture">> }>("GET", "/models?output_modalities=video"),
  ]);
  if (videoResult.status === "rejected") throw videoResult.reason;
  const videoCatalog = videoResult.value;
  const modalCatalog = modalResult.status === "fulfilled" ? modalResult.value : { data: [] };
  const architecture = new Map(
    (Array.isArray(modalCatalog.data) ? modalCatalog.data : [])
      .filter((model): model is Pick<VideoModel, "id" | "architecture"> => isRecord(model) && typeof model.id === "string")
      .map((model) => [model.id, model.architecture] as const),
  );
  const normalized = normalizeCatalogItems("video", videoCatalog);
  if (!normalized.models.length && normalized.rejected.length) {
    throw new Error(`The video catalog contained no valid models (${normalized.rejected.length} rejected item${normalized.rejected.length === 1 ? "" : "s"}).`);
  }
  return normalized.models.map((model) => applyVideoCapabilityProvenance({
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
  const response = await request<{ endpoints?: unknown }>("GET", path);
  return Array.isArray(response.endpoints)
    ? response.endpoints.map(normalizeImageEndpoint).filter((value): value is ImageModelEndpoint => value != null)
    : [];
}

export function imageReferenceLimit(model: ImageModel | null): number {
  return model?.supported_parameters.input_references?.max ?? 0;
}

export function imageReferenceMinimum(model: ImageModel | null): number {
  return model?.supported_parameters.input_references?.min ?? 0;
}

export function videoReferenceTypes(model: VideoModel | null, endpoint?: VideoModelEndpoint): InputMediaKind[] {
  if (!model) return [];
  // Once an endpoint is selected, its metadata is definitive. Falling back to
  // the model union here would advertise references that this provider route
  // never declared.
  const declared = endpoint ? endpoint.input_reference_types : model.input_reference_types;
  return (declared ?? []).filter((value): value is InputMediaKind => ["image", "video", "audio"].includes(value));
}

export function videoReferenceLimit(model: VideoModel | null, kind: InputMediaKind = "image", endpoint?: VideoModelEndpoint): number {
  if (!model || !videoReferenceTypes(model, endpoint).includes(kind)) return 0;
  const policyLimit = videoInputPolicy(model.id).references[kind];
  const endpointRange = endpoint?.supported_parameters?.input_references;
  const endpointLimit = endpoint?.max_input_references != null
    ? Math.max(0, endpoint.max_input_references)
    : endpointRange?.max != null ? Math.max(0, endpointRange.max) : undefined;
  // Endpoint metadata supersedes researched direct-provider policy. The
  // policy remains a conservative fallback only for an unhydrated model.
  if (endpoint) return endpointLimit ?? 1;
  const globalLimit = endpointLimit ?? (model.max_input_references == null ? undefined : Math.max(0, model.max_input_references));
  if (policyLimit != null && globalLimit != null) return Math.min(policyLimit, globalLimit);
  return policyLimit ?? globalLimit ?? 1;
}

export function videoTotalInputLimit(model: VideoModel | null): number {
  if (!model) return 0;
  const policy = videoInputPolicy(model.id);
  const perKindTotal = (["image", "video", "audio"] as const)
    .reduce((sum, kind) => sum + (policy.references[kind] ?? 0), 0);
  const declaredKindTotal = (["image", "video", "audio"] as const)
    .reduce((sum, kind) => sum + videoReferenceLimit(model, kind), 0);
  const policyTotal = policy.totalReferenceLimit ?? (perKindTotal || declaredKindTotal || undefined);
  const referenceTotal = model.max_input_references != null && policyTotal != null
    ? Math.min(model.max_input_references, policyTotal)
    : model.max_input_references ?? policyTotal ?? 0;
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
    }
    const image = model as ImageModel;
    if (!output.size && image.supported_sizes?.length && !image.supported_parameters.resolution) {
      output.size = first(image.supported_sizes);
    }
    return output;
  }
  const video = model as VideoModel;
  const output: DraftOptions = {
    duration: first(video.supported_durations),
    resolution: first(video.supported_resolutions),
    aspect_ratio: first(video.supported_aspect_ratios),
    generate_audio: video.generate_audio ? true : undefined,
  };
  if (!output.resolution && !output.aspect_ratio && video.supported_sizes?.length) output.size = first(video.supported_sizes);
  return output;
}

function parseProviderJson(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  const value = JSON.parse(raw) as unknown;
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Provider options must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export type ProviderRoutingConfig = {
  order?: string[];
  only?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  options?: Record<string, unknown>;
  [key: string]: unknown;
};

function stringList(value: unknown, field: string): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Provider ${field} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function parseProviderConfiguration(raw: string | undefined | null): ProviderRoutingConfig | undefined {
  const parsed = parseProviderJson(raw ?? "");
  if (!parsed) return undefined;
  const allowedFields = new Set([
    "order", "only", "allow_fallbacks", "require_parameters", "options", "data_collection",
    "zdr", "sort", "ignore", "quantizations", "allow", "deny", "max_price",
  ]);
  for (const field of Object.keys(parsed)) {
    if (!allowedFields.has(field)) throw new Error(`Provider field ${field} is not supported by the OpenRouter routing contract.`);
  }
  const order = stringList(parsed.order, "order");
  const only = stringList(parsed.only, "only");
  if (parsed.allow_fallbacks != null && typeof parsed.allow_fallbacks !== "boolean") {
    throw new Error("Provider allow_fallbacks must be a boolean.");
  }
  if (parsed.require_parameters != null && typeof parsed.require_parameters !== "boolean") {
    throw new Error("Provider require_parameters must be a boolean.");
  }
  return {
    ...parsed,
    ...(order ? { order } : {}),
    ...(only ? { only } : {}),
    ...(parsed.allow_fallbacks == null ? {} : { allow_fallbacks: parsed.allow_fallbacks }),
    ...(parsed.require_parameters == null ? {} : { require_parameters: parsed.require_parameters }),
  };
}

function endpointPassthrough(
  model: GenerationModel,
  route?: GenerationRoute,
  providerSlug?: string,
): string[] | undefined {
  if (route) return route.allowedPassthroughParameters;
  if (model && "endpoint_details" in model) {
    return model.endpoint_details?.find((endpoint) => endpoint.provider_slug === providerSlug)?.allowed_passthrough_parameters;
  }
  if (model && "allowed_passthrough_parameters" in model && "endpoints" in model && Array.isArray(model.endpoints)) {
    const videoModel = model as VideoModel;
    return videoModel.endpoints?.find((endpoint) => endpoint.provider_slug === providerSlug)?.allowed_passthrough_parameters
      ?? videoModel.allowed_passthrough_parameters;
  }
  return undefined;
}

function validateProviderPassthrough(provider: Record<string, unknown> | undefined, model: GenerationModel, route?: GenerationRoute) {
  const options = provider?.options;
  if (options == null) return;
  if (!options || Array.isArray(options) || typeof options !== "object") {
    throw new Error("Provider options must be an object keyed by provider slug.");
  }
  for (const [providerSlug, rawConfig] of Object.entries(options as Record<string, unknown>)) {
    if (!rawConfig || Array.isArray(rawConfig) || typeof rawConfig !== "object") {
      throw new Error(`Provider configuration for ${providerSlug} must be an object.`);
    }
    for (const field of Object.keys(rawConfig as Record<string, unknown>)) {
      if (field !== "parameters") throw new Error(`Provider configuration field ${providerSlug}.${field} is not supported.`);
    }
    const parameters = (rawConfig as Record<string, unknown>).parameters;
    if (parameters == null) continue;
    if (route?.providerSlug && !providerMatches(route, providerSlug)) {
      throw new Error(`Provider configuration ${providerSlug} does not match the selected endpoint ${route.providerSlug}.`);
    }
    if (!parameters || Array.isArray(parameters) || typeof parameters !== "object") {
      throw new Error(`Passthrough parameters for ${providerSlug} must be an object.`);
    }
    const allowed = endpointPassthrough(model, route, providerSlug);
    for (const name of Object.keys(parameters as Record<string, unknown>)) {
      if (!allowed?.includes(name)) {
        throw new Error(`Provider passthrough parameter ${providerSlug}.${name} is not declared by the selected endpoint.`);
      }
    }
  }
}

export function validateProviderConfiguration(raw: string, model: GenerationModel, route?: GenerationRoute): void {
  validateProviderPassthrough(parseProviderConfiguration(raw), model, route);
}

export type GenerationRoute = {
  mode: GenerationMode;
  modelId: string;
  routeId: string;
  providerName?: string;
  providerSlug?: string;
  providerTag?: string | null;
  capabilities: Record<string, CapabilityDescriptor>;
  /** Route-specific size values; undefined means this endpoint did not declare size. */
  supportedSizes?: string[] | null;
  allowedPassthroughParameters?: string[];
  pricing?: ImagePricingLine[];
  pricingSkus?: Record<string, string>;
  supportsStreaming?: boolean;
  endpointVerified: boolean;
  privacy: EndpointPrivacy;
  endpoint?: ImageModelEndpoint | VideoModelEndpoint;
};

export type GenerationRouteResolution = {
  selected?: GenerationRoute;
  eligible: GenerationRoute[];
  definitive: boolean;
  provider: ProviderRoutingConfig;
  errors: CapabilityValidationIssue[];
  warnings: string[];
};

function normalizedProvider(value: unknown): string {
  return normalizeModelSearchText(value).replace(/\s+/g, "");
}

function providerMatches(route: GenerationRoute, value: string): boolean {
  const wanted = normalizedProvider(value);
  return [route.providerSlug, route.providerName, route.providerTag]
    .filter(Boolean)
    .some((candidate) => normalizedProvider(candidate) === wanted || normalizeModelSearchText(candidate).includes(normalizeModelSearchText(value)));
}

function videoCapabilityDescriptors(model: VideoModel, endpoint?: VideoModelEndpoint): Record<string, CapabilityDescriptor> {
  const output: Record<string, CapabilityDescriptor> = endpoint
    ? { ...(endpoint.supported_parameters ?? {}) }
    : { ...(model.supported_parameters ?? {}) };
  const addEnum = (name: string, values: string[] | null | undefined) => {
    if (!output[name] && values?.length) output[name] = { type: "enum", values };
  };
  // An endpoint's descriptor is authoritative. Model-level values are a
  // union and are only synthesized for the unhydrated model route.
  addEnum("duration", endpoint ? endpoint.supported_durations?.map(String) : model.supported_durations?.map(String));
  addEnum("resolution", endpoint ? endpoint.supported_resolutions : model.supported_resolutions);
  addEnum("aspect_ratio", endpoint ? endpoint.supported_aspect_ratios : model.supported_aspect_ratios);
  addEnum("size", endpoint ? endpoint.supported_sizes : model.supported_sizes);
  if (!endpoint && !output.generate_audio && model.generate_audio === true) output.generate_audio = { type: "boolean" };
  if (!endpoint && !output.seed && model.seed === true) output.seed = { type: "boolean" };
  return output;
}

function routePrivacy(endpoint: ImageModelEndpoint | VideoModelEndpoint | undefined, model: GenerationModel): EndpointPrivacy {
  const modelPrivacy = "privacy" in model ? model.privacy : undefined;
  return {
    ...(endpoint?.privacy?.zdr != null ? { zdr: endpoint.privacy.zdr } : endpoint?.zdr != null ? { zdr: endpoint.zdr } : modelPrivacy?.zdr != null ? { zdr: modelPrivacy.zdr } : {}),
    ...(endpoint?.privacy?.data_collection != null ? { data_collection: endpoint.privacy.data_collection } : endpoint?.data_collection != null ? { data_collection: endpoint.data_collection } : modelPrivacy?.data_collection != null ? { data_collection: modelPrivacy.data_collection } : {}),
  };
}

function imageRoute(model: ImageModel, endpoint?: ImageModelEndpoint): GenerationRoute {
  return {
    mode: "image",
    modelId: model.id,
    routeId: endpoint?.endpoint_id ?? endpoint?.id ?? `${model.id}:${endpoint?.provider_slug ?? "model"}`,
    providerName: endpoint?.provider_name,
    providerSlug: endpoint?.provider_slug,
    providerTag: endpoint?.provider_tag,
    capabilities: endpoint?.supported_parameters ?? model.supported_parameters,
    supportedSizes: endpoint ? endpoint.supported_sizes : model.supported_sizes,
    allowedPassthroughParameters: endpoint ? endpoint.allowed_passthrough_parameters : undefined,
    pricing: endpoint ? endpoint.pricing : model.pricing,
    supportsStreaming: endpoint?.supports_streaming,
    endpointVerified: Boolean(endpoint),
    privacy: routePrivacy(endpoint, model),
    ...(endpoint ? { endpoint } : {}),
  };
}

function videoRoute(model: VideoModel, endpoint?: VideoModelEndpoint): GenerationRoute {
  return {
    mode: "video",
    modelId: model.id,
    routeId: endpoint?.endpoint_id ?? endpoint?.id ?? `${model.id}:${endpoint?.provider_slug ?? "model"}`,
    providerName: endpoint?.provider_name,
    providerSlug: endpoint?.provider_slug,
    providerTag: endpoint?.provider_tag,
    capabilities: videoCapabilityDescriptors(model, endpoint),
    supportedSizes: endpoint ? endpoint.supported_sizes : model.supported_sizes,
    allowedPassthroughParameters: endpoint ? endpoint.allowed_passthrough_parameters : model.allowed_passthrough_parameters,
    pricingSkus: endpoint ? endpoint.pricing_skus ?? undefined : model.pricing_skus ?? undefined,
    supportsStreaming: endpoint?.supports_streaming,
    endpointVerified: Boolean(endpoint),
    privacy: routePrivacy(endpoint, model),
    ...(endpoint ? { endpoint } : {}),
  };
}

export type ResolveRouteInput = {
  mode: GenerationMode;
  model: GenerationModel;
  options?: DraftOptions;
  providerJson?: string;
  endpoint?: ImageModelEndpoint | VideoModelEndpoint;
};

export function resolveEligibleRoute(input: ResolveRouteInput): GenerationRouteResolution;
export function resolveEligibleRoute(mode: GenerationMode, model: GenerationModel, options?: DraftOptions, providerJson?: string): GenerationRouteResolution;
export function resolveEligibleRoute(mode: GenerationMode, model: GenerationModel, providerJson?: string, options?: DraftOptions): GenerationRouteResolution;
export function resolveEligibleRoute(
  inputOrMode: ResolveRouteInput | GenerationMode,
  modelArg?: GenerationModel,
  optionsArg?: DraftOptions | string,
  providerJsonArg?: string | DraftOptions,
): GenerationRouteResolution {
  const input: ResolveRouteInput = typeof inputOrMode === "string"
    ? {
      mode: inputOrMode,
      model: modelArg!,
      options: typeof optionsArg === "string"
        ? (providerJsonArg && typeof providerJsonArg === "object" ? providerJsonArg : undefined)
        : optionsArg,
      providerJson: typeof optionsArg === "string"
        ? optionsArg
        : (typeof providerJsonArg === "string" ? providerJsonArg : undefined),
    }
    : inputOrMode;
  let provider: ProviderRoutingConfig = {};
  const errors: CapabilityValidationIssue[] = [];
  const warnings: string[] = [];
  let providerParseFailed = false;
  try {
    provider = parseProviderConfiguration(input.providerJson) ?? {};
  } catch (error) {
    providerParseFailed = true;
    errors.push({ code: "invalid_type", field: "provider", value: input.providerJson, message: error instanceof Error ? error.message : String(error) });
  }
  const model = input.model;
  const requestedEndpoint = input.endpoint;
  const allRoutes = input.mode === "image"
    ? ((model as ImageModel).endpoint_details?.length
      ? (model as ImageModel).endpoint_details!.map((endpoint) => imageRoute(model as ImageModel, endpoint))
      : [imageRoute(model as ImageModel)])
    : ((model as VideoModel).endpoints?.length
      ? (model as VideoModel).endpoints!.map((endpoint) => videoRoute(model as VideoModel, endpoint))
      : [videoRoute(model as VideoModel)]);
  let eligible = requestedEndpoint
    ? allRoutes.filter((route) => route.endpoint === requestedEndpoint || route.routeId === (requestedEndpoint.endpoint_id ?? requestedEndpoint.id))
    : allRoutes;
  if (providerParseFailed) eligible = [];
  const only = provider.only ?? [];
  if (only.length) eligible = eligible.filter((route) => only.some((value) => providerMatches(route, value)));
  const optionProviders = isRecord(provider.options) ? Object.keys(provider.options) : [];
  if (optionProviders.length) eligible = eligible.filter((route) => optionProviders.some((value) => providerMatches(route, value)));
  if (provider.order?.length && eligible.length > 1) {
    const rank = (route: GenerationRoute) => {
      const index = provider.order!.findIndex((value) => providerMatches(route, value));
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    eligible = [...eligible].sort((left, right) => rank(left) - rank(right) || left.routeId.localeCompare(right.routeId));
  }
  if (!eligible.length) warnings.push(only.length ? "No endpoint matches the pinned provider." : "No eligible endpoint is available.");
  const optionIssues = new Map<string, CapabilityValidationIssue>();
  if (input.options && eligible.length) {
    const compatible = eligible.filter((route) => {
      const routeIssues = validateCapabilityOptions(input.options!, route.capabilities, {
        // `supportedSizes` is deliberately route-local. Passing the model
        // union here would allow a size absent from a selected endpoint.
        supportedSizes: route.supportedSizes,
        allowUnknown: false,
      });
      for (const issue of routeIssues) optionIssues.set(`${issue.code}:${issue.field}:${issue.with ?? ""}`, issue);
      return routeIssues.length === 0;
    });
    // A route which actually supports the chosen options is preferred over a
    // cheaper/earlier endpoint that only appeared in the model-level union.
    if (compatible.length) eligible = compatible;
    else {
      errors.push(...optionIssues.values());
      eligible = [];
    }
  }
  const selected = eligible[0];
  if (selected && !selected.endpointVerified) warnings.push("Endpoint metadata is not hydrated; model-level capability is a union and price/privacy may be uncertain.");
  return {
    selected,
    eligible,
    definitive: Boolean(selected?.endpointVerified && eligible.length === 1),
    provider,
    errors,
    warnings,
  };
}

export const resolveGenerationRoute = resolveEligibleRoute;

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
  payload?: Readonly<Record<string, unknown>>,
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

type BuildRequestContext = {
  strict?: boolean;
  route?: GenerationRoute;
};

function buildRequestInternal(
  draft: GenerationDraft,
  model: GenerationModel | null,
  context: BuildRequestContext = {},
): Record<string, unknown> {
  if (!model) return {};
  const strict = context.strict === true;
  const route = context.route;
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
    const capabilities = route?.capabilities ?? imageModel.supported_parameters;
    if (strict) {
      const optionIssues = validateCapabilityOptions(draft.options, capabilities, {
        supportedSizes: route ? route.supportedSizes : imageModel.supported_sizes,
        allowUnknown: false,
      });
      if (optionIssues.length) throw new Error(optionIssues[0].message);
    }
    for (const [key, value] of Object.entries(draft.options)) {
      if (draft.model === "openai/gpt-image-2" && key === "input_fidelity") continue;
      const sizeSupported = route ? route.supportedSizes?.length : imageModel.supported_sizes?.length;
      if ((capabilities[key] || (key === "size" && sizeSupported)) && value !== undefined && value !== "") payload[key] = value;
    }
    const limit = route ? capabilities.input_references?.max ?? 0 : capabilities.input_references?.max ?? imageReferenceLimit(imageModel);
    const minimum = route ? capabilities.input_references?.min ?? 0 : capabilities.input_references?.min ?? imageReferenceMinimum(imageModel);
    let images = draft.assets.filter((asset) => asset.mediaType.startsWith("image/"));
    if (images.length > limit) throw new Error(`This image model accepts at most ${limit} reference inputs; received ${images.length}.`);
    if (images.length && limit === 0) throw new Error("This image model does not accept reference inputs.");
    if (strict && images.length < minimum) throw new Error(`This image model requires at least ${minimum} reference inputs; received ${images.length}.`);
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
    const videoEndpoint = route?.endpoint && "provider_slug" in route.endpoint ? route.endpoint as VideoModelEndpoint : undefined;
    const supportedFrames = videoEndpoint ? videoEndpoint.supported_frame_images : videoModel.supported_frame_images;
    const capabilities = route?.capabilities ?? videoCapabilityDescriptors(videoModel);
    if (strict) {
      const optionIssues = validateCapabilityOptions(draft.options, capabilities, {
        supportedSizes: route ? route.supportedSizes : videoModel.supported_sizes,
        allowUnknown: false,
      });
      if (optionIssues.length) throw new Error(optionIssues[0].message);
    }
    for (const [key, value] of Object.entries(draft.options)) {
      if (capabilities[key] && value !== undefined && value !== "") payload[key] = value;
    }
    const referenceTypes = videoReferenceTypes(videoModel, videoEndpoint);
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
      && supportedFrames?.includes(asset.role),
    );
    const counts: Record<InputMediaKind, number> = { image: 0, video: 0, audio: 0 };
    for (const asset of references) counts[assetMediaKind(asset)] += 1;
    for (const kind of ["image", "video", "audio"] as const) {
      const limit = videoReferenceLimit(videoModel, kind, videoEndpoint);
      if (counts[kind] > limit) throw new Error(`This video model accepts at most ${limit} ${kind} references; received ${counts[kind]}.`);
    }
    const endpointLimit = videoEndpoint?.max_input_references
      ?? videoEndpoint?.supported_parameters?.input_references?.max;
    const aggregateLimit = route
      ? endpointLimit
      : videoModel.max_input_references ?? videoInputPolicy(videoModel.id).totalReferenceLimit;
    if (aggregateLimit != null && references.length > aggregateLimit) {
      throw new Error(`This video model accepts at most ${aggregateLimit} total reference inputs; received ${references.length}.`);
    }
    const unsupportedFrames = draft.assets.filter((asset) =>
      (asset.role === "first_frame" || asset.role === "last_frame")
      && (assetMediaKind(asset) !== "image" || !supportedFrames?.includes(asset.role))
    );
    if (unsupportedFrames.length) throw new Error(`This video model does not accept ${unsupportedFrames[0].role.replaceAll("_", " ")} inputs.`);
    if (strict && (references.length || frames.length)) {
      const transportIssues = assessVideoReferenceTransport(videoModel, [...references, ...frames].map((asset) => ({
        slot: asset.slot,
        kind: assetMediaKind(asset),
        transport: videoReferenceTransportForUrl(asset.dataUrl),
      })), videoEndpoint);
      if (transportIssues.length) throw new Error(transportIssues[0].message);
    }
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
  const provider = parseProviderConfiguration(draft.providerJson);
  validateProviderPassthrough(provider, model, route);
  if (strict && route && !route.providerSlug) {
    throw new Error("The selected endpoint has no provider slug and cannot be pinned to the reviewed request.");
  }
  // A reviewed request must not silently fall through to another eligible
  // provider. Preserve the user's provider options but narrow `only` to the
  // exact route selected for capability, price, and privacy review.
  payload.provider = {
    ...(provider ?? {}),
    ...(strict && route?.providerSlug ? { only: [route.providerSlug] } : {}),
    require_parameters: true,
  };
  if (draft.negativePrompt?.trim()) {
    const nativeCapabilities = route
      ? route.capabilities
      : draft.mode === "image"
        ? (model as ImageModel).supported_parameters
        : {};
    const nativeVideoPassthrough = route
      ? route.allowedPassthroughParameters
      : (model as VideoModel).allowed_passthrough_parameters;
    if (draft.mode === "image" && nativeCapabilities.negative_prompt) {
      payload.negative_prompt = draft.negativePrompt.trim();
    } else if (draft.mode === "video" && nativeVideoPassthrough?.includes("negative_prompt")) {
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

/** Legacy permissive request builder retained for callers that only need a preview. */
export function buildRequest(draft: GenerationDraft, model: GenerationModel | null): Record<string, unknown> {
  return buildRequestInternal(draft, model);
}

export const OPENROUTER_MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
export const OPENROUTER_MAX_REFERENCE_RAW_BYTES = 128 * 1024 * 1024;
export const OPENROUTER_MAX_REQUEST_JSON_BYTES = 48 * 1024 * 1024;

export type RequestSizeLimits = {
  perAssetBytes?: number;
  rawBytes?: number;
  base64Bytes?: number;
  jsonBytes?: number;
};

export type RequestSizeBudget = {
  perAssetBytes: number;
  rawBytes: number;
  base64Bytes: number;
  encodedBytes: number;
  jsonBytes: number;
  overheadBytes: number;
  rawLimitBytes: number;
  base64LimitBytes: number;
  jsonLimitBytes: number;
  withinLimit: boolean;
  issues: string[];
  assets: Array<{ slot: number; rawBytes: number; base64Bytes: number; encodedBytes: number }>;
};

function utf8Bytes(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  return unescape(encodeURIComponent(value)).length;
}

function dataUrlByteCounts(value: string, hintedRaw?: number): { rawBytes: number; base64Bytes: number } {
  const comma = value.indexOf(",");
  if (!value.startsWith("data:") || comma < 0) {
    const willInlineLocally = /^(?:local-asset|fruit-truck-local):/i.test(value);
    return {
      rawBytes: hintedRaw ?? 0,
      base64Bytes: willInlineLocally && hintedRaw != null ? Math.ceil(hintedRaw / 3) * 4 : 0,
    };
  }
  const header = value.slice(0, comma).toLowerCase();
  const body = value.slice(comma + 1).replace(/\s+/g, "");
  if (!header.includes(";base64")) return { rawBytes: hintedRaw ?? utf8Bytes(body), base64Bytes: 0 };
  const base64Bytes = body.length;
  const decoded = Math.max(0, Math.floor(base64Bytes * 3 / 4) - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0));
  return { rawBytes: hintedRaw ?? decoded, base64Bytes };
}

export function estimateReferenceRequestSize(
  assets: ReferenceAsset[],
  payload?: Record<string, unknown>,
  limits: RequestSizeLimits = {},
): RequestSizeBudget {
  const perAssetBytes = limits.perAssetBytes ?? OPENROUTER_MAX_REFERENCE_BYTES;
  const rawLimitBytes = limits.rawBytes ?? OPENROUTER_MAX_REFERENCE_RAW_BYTES;
  const base64LimitBytes = limits.base64Bytes ?? OPENROUTER_MAX_REQUEST_JSON_BYTES;
  const jsonLimitBytes = limits.jsonBytes ?? OPENROUTER_MAX_REQUEST_JSON_BYTES;
  const assetCounts = assets.map((asset) => {
    const count = dataUrlByteCounts(asset.dataUrl, asset.byteSize);
    const encodedBytes = Math.max(utf8Bytes(asset.dataUrl), count.base64Bytes);
    return { slot: asset.slot, rawBytes: count.rawBytes, base64Bytes: count.base64Bytes, encodedBytes };
  });
  const rawBytes = assetCounts.reduce((sum, asset) => sum + asset.rawBytes, 0);
  const base64Bytes = assetCounts.reduce((sum, asset) => sum + asset.base64Bytes, 0);
  const encodedBytes = assetCounts.reduce((sum, asset) => sum + asset.encodedBytes, 0);
  const serialized = payload ?? { input_references: assets.map(asReference) };
  let jsonBytes = 0;
  try {
    const literalJsonBytes = utf8Bytes(JSON.stringify(serialized));
    const projectedInlineGrowth = assets.reduce((sum, asset, index) =>
      sum + Math.max(0, assetCounts[index].encodedBytes - utf8Bytes(asset.dataUrl)), 0);
    jsonBytes = literalJsonBytes + projectedInlineGrowth;
  } catch { jsonBytes = Number.POSITIVE_INFINITY; }
  const overheadBytes = Math.max(0, jsonBytes - encodedBytes);
  const issues: string[] = [];
  const oversized = assetCounts.find((asset) => asset.rawBytes > perAssetBytes);
  if (oversized) issues.push(`Reference @${oversized.slot} exceeds the ${Math.round(perAssetBytes / 1024 / 1024)} MB per-file limit.`);
  if (rawBytes > rawLimitBytes) issues.push(`References use ${Math.ceil(rawBytes / 1024 / 1024)} MB raw, over the ${Math.round(rawLimitBytes / 1024 / 1024)} MB aggregate budget.`);
  if (base64Bytes > base64LimitBytes) issues.push(`Base64 references exceed the ${Math.round(base64LimitBytes / 1024 / 1024)} MB aggregate budget.`);
  if (jsonBytes > jsonLimitBytes) issues.push(`The serialized request is ${Math.ceil(jsonBytes / 1024 / 1024)} MB, over the ${Math.round(jsonLimitBytes / 1024 / 1024)} MB JSON budget.`);
  return {
    perAssetBytes,
    rawBytes,
    base64Bytes,
    encodedBytes,
    jsonBytes,
    overheadBytes,
    rawLimitBytes,
    base64LimitBytes,
    jsonLimitBytes,
    withinLimit: issues.length === 0,
    issues,
    assets: assetCounts,
  };
}

export function preflightRequestSize(
  draft: GenerationDraft,
  model: GenerationModel | null,
  limits: RequestSizeLimits = {},
): RequestSizeBudget {
  let payload: Record<string, unknown> | undefined;
  try { payload = buildRequest(draft, model); } catch { /* Other preflight checks own this error. */ }
  return estimateReferenceRequestSize(draft.assets, payload, limits);
}

export type PreparedRequestPlanner = {
  modelId?: string;
  costUsd?: number;
  route?: GenerationRoute;
  requested?: boolean;
  inheritsConstraints?: boolean;
};

export type PrepareRequestContext = {
  route?: GenerationRoute;
  planner?: PreparedRequestPlanner;
  /** Optional already-computed planner artifact; no hidden planner call occurs. */
  enhancement?: Pick<PromptEnhancementArtifact, "prompt" | "negativePrompt" | "signature">;
  catalogFingerprint?: string;
  sourceSignature?: string;
  sizeLimits?: RequestSizeLimits;
  final?: boolean;
};

export type PreparedRequestIssue = {
  code: "catalog" | "route" | "option" | "reference" | "transport" | "provider" | "size" | "prompt" | "unknown";
  message: string;
};

export type PreparedRequest = Readonly<{
  version: 1;
  kind: "prepared_request";
  mode: GenerationMode;
  modelId: string;
  status: "ready" | "blocked";
  phase: "draft" | "final";
  payload: Readonly<Record<string, unknown>>;
  /** Alias retained so preview and submission can consume the same object. */
  sanitizedPayload: Readonly<Record<string, unknown>>;
  route?: GenerationRoute;
  routeResolution: GenerationRouteResolution;
  cost: GenerationCostMetadata;
  privacy: RoutePrivacyMetadata;
  size: RequestSizeBudget;
  issues: readonly PreparedRequestIssue[];
  fingerprint: string;
  source: Readonly<{ mode: GenerationMode; modelId: string; catalogFingerprint?: string; signature?: string }>;
}>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]));
  }
  return value;
}

function stableHash(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `request-v1:${(hash >>> 0).toString(16).padStart(8, "0")}:${serialized.length}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function snapshotClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function issueCode(message: string): PreparedRequestIssue["code"] {
  const value = message.toLowerCase();
  if (value.includes("provider")) return "provider";
  if (value.includes("transport") || value.includes("unverified")) return "transport";
  if (value.includes("reference") || value.includes("frame")) return "reference";
  if (value.includes("option") || value.includes("size cannot") || value.includes("resolution")) return "option";
  if (value.includes("catalog") || value.includes("endpoint")) return "route";
  if (value.includes("request is") || value.includes("budget") || value.includes("aggregate")) return "size";
  if (value.includes("prompt")) return "prompt";
  return "unknown";
}

function prepareSource(draft: GenerationDraft, model: GenerationModel | null, context: PrepareRequestContext): unknown {
  return {
    mode: draft.mode,
    modelId: model?.id ?? draft.model,
    draftModel: draft.model,
    prompt: draft.prompt,
    negativePrompt: draft.negativePrompt ?? "",
    options: draft.options,
    providerJson: draft.providerJson,
    editTargetSlot: draft.editTargetSlot ?? null,
    assets: draft.assets.map((asset) => ({
      id: asset.id,
      slot: asset.slot,
      role: asset.role,
      purpose: asset.purpose,
      mediaType: asset.mediaType,
      dataUrl: asset.dataUrl,
      byteSize: asset.byteSize ?? null,
    })),
    catalogFingerprint: context.catalogFingerprint ?? null,
    sourceSignature: context.sourceSignature ?? null,
  };
}

/**
 * Prepare one immutable request snapshot. The returned payload is the exact
 * object callers should both render and submit; enhancement/catalog/provider
 * changes therefore require a new snapshot instead of mutating this one.
 */
export function prepareRequest(
  draft: GenerationDraft,
  model: GenerationModel | null,
  context: PrepareRequestContext = {},
): PreparedRequest {
  const effectiveDraft: GenerationDraft = context.enhancement
    ? {
      ...draft,
      prompt: context.enhancement.prompt,
      ...(context.enhancement.negativePrompt !== undefined ? { negativePrompt: context.enhancement.negativePrompt } : {}),
    }
    : draft;
  const routeResolution = model
    ? resolveEligibleRoute({ mode: effectiveDraft.mode, model, options: effectiveDraft.options, providerJson: effectiveDraft.providerJson, endpoint: context.route?.endpoint })
    : {
      selected: undefined,
      eligible: [],
      definitive: false,
      provider: {},
      errors: [{ code: "invalid_type" as const, field: "model", message: "No generation model is selected." }],
      warnings: ["No generation model is selected."],
    };
  const route = context.route ?? routeResolution.selected;
  const issues: PreparedRequestIssue[] = routeResolution.errors.map((issue) => ({ code: issueCode(issue.message), message: issue.message }));
  if (!model) issues.push({ code: "catalog", message: "No generation model is selected." });
  if (model && effectiveDraft.model !== model.id) issues.push({ code: "catalog", message: `Draft model ${effectiveDraft.model} does not match the selected catalog model ${model.id}.` });
  if (!effectiveDraft.prompt.trim()) issues.push({ code: "prompt", message: "A prompt is required before this request can be sent." });
  if (model && !route) issues.push({ code: "route", message: routeResolution.warnings[0] ?? "No eligible endpoint is available." });
  if (context.final && route && !routeResolution.definitive) {
    issues.push({ code: "route", message: "The final paid request requires one hydrated, definitive provider endpoint." });
  }
  let payload: Record<string, unknown> = { model: effectiveDraft.model, prompt: effectiveDraft.prompt.trim() };
  if (model && route) {
    try {
      payload = buildRequestInternal(effectiveDraft, model, { strict: true, route });
      // Streaming is selected only from the definitive endpoint contract and
      // becomes part of the immutable reviewed payload. No hidden transport
      // toggle is added after review.
      if (effectiveDraft.mode === "image" && route.supportsStreaming === true) {
        payload = { ...payload, stream: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push({ code: issueCode(message), message });
    }
  }
  const size = estimateReferenceRequestSize(effectiveDraft.assets, payload, context.sizeLimits);
  for (const message of size.issues) issues.push({ code: "size", message });
  const fallbackModel: GenerationModel = effectiveDraft.mode === "image"
    ? { id: effectiveDraft.model, name: effectiveDraft.model, supported_parameters: {} }
    : { id: effectiveDraft.model, name: effectiveDraft.model };
  const cost = generationCostMetadata(effectiveDraft.mode, model ?? fallbackModel, effectiveDraft.options, {
    route,
    providerJson: effectiveDraft.providerJson,
    imageInputCount: effectiveDraft.assets.filter((asset) => assetMediaKind(asset) === "image").length,
    plannerCostUsd: context.planner?.costUsd,
    plannerRoute: context.planner?.route,
  });
  const privacy = routePrivacyMetadata(route, {
    requested: context.planner?.requested ?? Boolean(context.planner),
    route: context.planner?.route,
    inheritsConstraints: context.planner?.inheritsConstraints,
  });
  const source = {
    mode: effectiveDraft.mode,
    modelId: model?.id ?? effectiveDraft.model,
    ...(context.catalogFingerprint ? { catalogFingerprint: context.catalogFingerprint } : {}),
    ...(context.sourceSignature ? { signature: context.sourceSignature } : {}),
  };
  const fingerprint = stableHash({
    source: prepareSource(effectiveDraft, model, context),
    payload,
    // Include the complete selected route, not only its id. Endpoint pricing,
    // capability, privacy, or provider metadata can change while an id stays
    // stable; such a catalog refresh must invalidate the snapshot.
    route: route ? snapshotClone(route) : null,
    enhancementSignature: context.enhancement?.signature ?? null,
  });
  const frozenPayload = deepFreeze(payload);
  const frozenRoute = route ? deepFreeze(snapshotClone(route)) : undefined;
  const frozenRouteResolution = deepFreeze(snapshotClone(routeResolution));
  const artifact = {
    version: 1 as const,
    kind: "prepared_request" as const,
    mode: effectiveDraft.mode,
    modelId: model?.id ?? effectiveDraft.model,
    status: issues.length ? "blocked" as const : "ready" as const,
    phase: context.final ? "final" as const : "draft" as const,
    payload: frozenPayload,
    sanitizedPayload: frozenPayload,
    ...(frozenRoute ? { route: frozenRoute } : {}),
    routeResolution: frozenRouteResolution,
    cost,
    privacy,
    size,
    issues: deepFreeze(issues),
    fingerprint,
    source: deepFreeze(source),
  } satisfies PreparedRequest;
  return deepFreeze(artifact);
}

export function preparedRequestPayload(prepared: PreparedRequest): Readonly<Record<string, unknown>> {
  if (prepared.status !== "ready") throw new Error(prepared.issues[0]?.message ?? "The prepared request is blocked.");
  return prepared.payload;
}

export function isPreparedRequestCurrent(
  prepared: PreparedRequest,
  draft: GenerationDraft,
  model: GenerationModel | null,
  context: PrepareRequestContext = {},
): boolean {
  return prepared.fingerprint === prepareRequest(draft, model, context).fingerprint;
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
    input.targetRoute
      ? `Resolved generation endpoint: ${input.targetRoute.providerName ?? input.targetRoute.providerSlug ?? "unverified"} (${input.targetRoute.routeId}); privacy metadata: ${JSON.stringify(input.targetRoute.privacy)}.`
      : "The generation endpoint is not yet verified; do not assume provider-specific capability or privacy behavior.",
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
  const inheritedPlannerProvider = input.plannerProvider ?? (() => {
    const targetPrivacy = input.targetRoute?.privacy ?? {};
    return {
      ...(targetPrivacy.zdr === true ? { zdr: true } : {}),
      ...(targetPrivacy.data_collection != null ? { data_collection: targetPrivacy.data_collection } : {}),
      require_parameters: true,
    };
  })();
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
        provider: inheritedPlannerProvider,
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
        ...(totalCost > 0 ? { actualCostUsd: totalCost } : {}),
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

const RECOVERY_PATH_MARKERS = [
  "(partial response retained at ",
  "(recovery response retained at ",
] as const;

/** Recover the native response path without treating arbitrary error text as a path. */
export function generationRecoveryPath(error: unknown): string | undefined {
  if (error && typeof error === "object" && "recoveryPath" in error) {
    const recoveryPath = (error as { recoveryPath?: unknown }).recoveryPath;
    if (typeof recoveryPath === "string" && recoveryPath.trim()) return recoveryPath.trim();
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const marker of RECOVERY_PATH_MARKERS) {
    const start = message.indexOf(marker);
    if (start < 0) continue;
    const pathStart = start + marker.length;
    const pathEnd = message.indexOf(")", pathStart);
    if (pathEnd < 0) continue;
    const recoveryPath = message.slice(pathStart, pathEnd).trim();
    if (recoveryPath) return recoveryPath;
  }
  return undefined;
}

/** Read cost metadata attached after a paid response was parsed successfully. */
export function generationActualCost(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("actualCostUsd" in error)) return undefined;
  const actualCostUsd = (error as { actualCostUsd?: unknown }).actualCostUsd;
  return typeof actualCostUsd === "number" && Number.isFinite(actualCostUsd) && actualCostUsd >= 0
    ? actualCostUsd
    : undefined;
}

export async function generateImage(
  payload: Readonly<Record<string, unknown>>,
  onActualCost?: ActualCostHandler,
  options: OpenRouterRequestOptions = {},
): Promise<ImageResult> {
  const response = await request<{
    data?: Array<{ b64_json?: string; url?: string; local_path?: string; media_type?: string }>;
    usage?: { cost?: number };
    _fruit_truck_recovery_path?: string;
    _fruit_truck_materialization_errors?: string[];
  }>("POST", "/images", payload, options);
  const actualCostUsd = reportActualCost(response, onActualCost);
  const urls = (response.data ?? []).flatMap((item) => {
    if (item.local_path) return [item.local_path];
    if (item.url) return [item.url];
    if (item.b64_json) return [`data:${item.media_type ?? "image/png"};base64,${item.b64_json}`];
    return [];
  });
  const materializationErrors = Array.isArray(response._fruit_truck_materialization_errors)
    ? response._fruit_truck_materialization_errors.filter((message): message is string => typeof message === "string")
    : [];
  if (!urls.length) {
    const recovery = response._fruit_truck_recovery_path ? ` Recovery payload: ${response._fruit_truck_recovery_path}.` : "";
    throw Object.assign(
      new Error(`OpenRouter returned no usable image data.${recovery} ${materializationErrors.join(" · ")}`.trim()),
      {
        ...(response._fruit_truck_recovery_path ? { recoveryPath: response._fruit_truck_recovery_path } : {}),
        materializationErrors,
        ...(actualCostUsd != null ? { actualCostUsd } : {}),
      },
    );
  }
  return {
    kind: "image",
    urls,
    actualCostUsd,
    materializationErrors,
    ...(response._fruit_truck_recovery_path ? { recoveryPath: response._fruit_truck_recovery_path } : {}),
  };
}

function serializedVideoError(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (!error) return undefined;
  try { return JSON.stringify({ error }); } catch { return String(error); }
}

export async function submitVideo(payload: Readonly<Record<string, unknown>>, onActualCost?: ActualCostHandler): Promise<VideoResult> {
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

export function prettyRequest(payload: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(payload, (_key, value) => {
    if (typeof value === "string" && value.startsWith("data:") && value.length > 120) {
      return `<media payload omitted · ${Math.round(value.length / 1024)} KB>`;
    }
    return value;
  }, 2);
}
