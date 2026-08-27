import type { CapabilityDescriptor } from "./openrouter.ts";

export type CapabilityValidationIssue = {
  code: "unsupported_option" | "invalid_type" | "invalid_enum" | "below_minimum" | "above_maximum" | "conflicting_options";
  field: string;
  value?: unknown;
  limit?: number;
  with?: string;
  message: string;
};

export function normalizeRangeValue(raw: string, min?: number, max?: number): number | undefined {
  if (!raw.trim()) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
}

/**
 * Normalize user/catalog search text into the same punctuation-insensitive
 * representation. In particular, `FLUX.2`, `flux-2`, and `flux 2` all map
 * to the same search terms.
 */
export function normalizeModelSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export const normalizeSearchText = normalizeModelSearchText;

const PROVIDER_ALIASES: Record<string, string[]> = {
  bfl: ["black forest labs", "black-forest-labs", "blackforestlabs"],
  "black forest labs": ["bfl", "black-forest-labs", "blackforestlabs"],
  openai: ["open ai"],
  google: ["google vertex", "vertex ai", "google-vertex"],
  bytedance: ["byteplus", "seed", "seedance"],
  minimax: ["mini max"],
  xai: ["x ai", "x-ai"],
};

function searchAlternatives(value: string): string[] {
  const normalized = normalizeModelSearchText(value);
  const aliases = PROVIDER_ALIASES[normalized] ?? [];
  return [normalized, ...aliases.map(normalizeModelSearchText)];
}

export function modelSearchMatches(
  model: { id?: string; name?: string; description?: string; provider?: string; provider_name?: string; provider_slug?: string },
  query: string,
): boolean {
  const terms = normalizeModelSearchText(query).split(" ").filter(Boolean);
  if (!terms.length) return true;
  const fields = [model.id, model.name, model.description, model.provider, model.provider_name, model.provider_slug]
    .flatMap((value) => searchAlternatives(String(value ?? "")))
    .join(" ");
  return terms.every((term) => searchAlternatives(term).some((alternative) => fields.includes(alternative)));
}

export type NormalizedOptionDescriptor = CapabilityDescriptor & { name?: string };

function equalOptionValue(left: string | number, right: unknown): boolean {
  return typeof right === "number" && typeof left === "number"
    ? left === right
    : String(left) === String(right);
}

/** Validate values against the endpoint descriptor, without coercing them. */
export function validateCapabilityValue(
  field: string,
  value: unknown,
  descriptor: CapabilityDescriptor | undefined,
): CapabilityValidationIssue | null {
  if (!descriptor) {
    return {
      code: "unsupported_option",
      field,
      value,
      message: `Option ${field} is not supported by the selected endpoint.`,
    };
  }
  if (descriptor.type === "boolean") {
    // OpenRouter's legacy model metadata represents `seed` as a boolean
    // capability flag, while the request value itself is an integer.  Keep
    // the descriptor semantics strict for every real boolean option, but
    // preserve this one documented capability-marker exception.
    if (field === "seed" && typeof value === "number" && Number.isSafeInteger(value)) return null;
    // `negative_prompt: {type:"boolean"}` in the catalog means that the
    // endpoint exposes the field, not that the request should contain a
    // boolean marker. The actual text is supplied through the dedicated
    // negativePrompt draft field and serialized by the request builder.
    if (field === "negative_prompt") return {
      code: "invalid_type",
      field,
      value,
      message: "Use the negative prompt text field; a boolean capability marker cannot be sent as negative_prompt.",
    };
    return typeof value === "boolean" ? null : {
      code: "invalid_type",
      field,
      value,
      message: `Option ${field} must be a boolean.`,
    };
  }
  if (descriptor.type === "enum") {
    if (!descriptor.values?.some((candidate) => equalOptionValue(candidate, value))) {
      return {
        code: "invalid_enum",
        field,
        value,
        message: `Option ${field} must be one of the endpoint's supported values.`,
      };
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      code: "invalid_type",
      field,
      value,
      message: `Option ${field} must be a finite number.`,
    };
  }
  if (descriptor.min != null && value < descriptor.min) return {
    code: "below_minimum",
    field,
    value,
    limit: descriptor.min,
    message: `Option ${field} is below the endpoint minimum.`,
  };
  if (descriptor.max != null && value > descriptor.max) return {
    code: "above_maximum",
    field,
    value,
    limit: descriptor.max,
    message: `Option ${field} exceeds the endpoint maximum.`,
  };
  return null;
}

export function validateCapabilityOptions(
  options: Record<string, string | number | boolean | undefined>,
  descriptors: Record<string, CapabilityDescriptor>,
  extras: { supportedSizes?: string[] | null; allowUnknown?: boolean } = {},
): CapabilityValidationIssue[] {
  const issues: CapabilityValidationIssue[] = [];
  for (const [field, value] of Object.entries(options)) {
    if (value === undefined || value === "") continue;
    const descriptor = descriptors[field] ?? (field === "size" && extras.supportedSizes?.length
      ? { type: "enum" as const, values: extras.supportedSizes }
      : undefined);
    if (!descriptor) {
      if (!extras.allowUnknown) issues.push({
        code: "unsupported_option",
        field,
        value,
        message: `Option ${field} is not supported by the selected endpoint.`,
      });
      continue;
    }
    const issue = validateCapabilityValue(field, value, descriptor);
    if (issue) issues.push(issue);
  }
  const hasSize = options.size !== undefined && options.size !== "";
  const hasResolution = options.resolution !== undefined && options.resolution !== "";
  const hasAspect = options.aspect_ratio !== undefined && options.aspect_ratio !== "";
  if (hasSize && hasResolution) issues.push({
    code: "conflicting_options",
    field: "size",
    with: "resolution",
    message: "size cannot be combined with resolution.",
  });
  if (hasSize && hasAspect) issues.push({
    code: "conflicting_options",
    field: "size",
    with: "aspect_ratio",
    message: "size cannot be combined with aspect ratio.",
  });
  return issues;
}

export type ModelSearchFilter = {
  query?: string;
  provider?: string;
  inputKinds?: string[];
  priceKnown?: boolean;
  hasAudio?: boolean;
  resolution?: string;
};

/** Stable, non-visual catalog filtering primitive for model explorers. */
export function filterModels<T extends {
  id?: string;
  name?: string;
  description?: string;
  provider?: string;
  provider_name?: string;
  provider_slug?: string;
  pricing?: unknown[];
  pricing_skus?: Record<string, string> | null;
  architecture?: { input_modalities?: string[] };
  input_reference_types?: string[] | null;
  supported_sizes?: string[] | null;
  generate_audio?: boolean | null;
  supported_resolutions?: string[] | null;
  endpoint_details?: Array<{ provider_name?: string; provider_slug?: string; pricing?: unknown[] }>;
  endpoints?: Array<{ provider_name?: string; provider_slug?: string; pricing_skus?: Record<string, string> | null }>;
}>(models: T[], filter: ModelSearchFilter = {}): T[] {
  const providerQuery = filter.provider ? normalizeModelSearchText(filter.provider) : "";
  return models.filter((model) => {
    if (filter.query && !modelSearchMatches(model, filter.query)) return false;
    if (providerQuery) {
      const endpointProviders = [
        ...(model.endpoint_details ?? []).flatMap((endpoint) => [endpoint.provider_name, endpoint.provider_slug]),
        ...(model.endpoints ?? []).flatMap((endpoint) => [endpoint.provider_name, endpoint.provider_slug]),
      ].filter(Boolean).join(" ");
      const providerText = normalizeModelSearchText(`${model.provider ?? ""} ${model.provider_name ?? ""} ${model.provider_slug ?? ""} ${model.id?.split("/", 1)[0] ?? ""} ${endpointProviders}`);
      if (!searchAlternatives(providerQuery).some((alternative) => providerText.includes(alternative))) return false;
    }
    if (filter.inputKinds?.length) {
      const modalities = [
        ...(model.architecture?.input_modalities ?? []),
        ...(model.input_reference_types ?? []),
      ].map(normalizeModelSearchText);
      if (!filter.inputKinds.every((kind) => modalities.includes(normalizeModelSearchText(kind)))) return false;
    }
    if (filter.priceKnown != null) {
      const endpointPricing = (model.endpoint_details ?? []).some((endpoint) => (endpoint.pricing?.length ?? 0) > 0)
        || (model.endpoints ?? []).some((endpoint) => Object.keys(endpoint.pricing_skus ?? {}).length > 0);
      const known = Boolean((model.pricing?.length ?? 0) || Object.keys(model.pricing_skus ?? {}).length || endpointPricing);
      if (known !== filter.priceKnown) return false;
    }
    if (filter.hasAudio != null && Boolean(model.generate_audio) !== filter.hasAudio) return false;
    if (filter.resolution && ![
      ...(model.supported_resolutions ?? []),
      ...(model.supported_sizes ?? []),
    ].some((value) => normalizeModelSearchText(value) === normalizeModelSearchText(filter.resolution))) return false;
    return true;
  });
}

export function sortModelsByName<T extends { id?: string; name?: string }>(models: T[]): T[] {
  return [...models].sort((left, right) => normalizeModelSearchText(left.name ?? left.id).localeCompare(normalizeModelSearchText(right.name ?? right.id)));
}
