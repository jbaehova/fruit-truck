import {
  videoReferenceTypes,
  type GenerationRoute,
  type CapabilityDescriptor,
  type VideoModel,
  type VideoModelEndpoint,
} from "../openrouter.ts";
import { buildVideoSupportMatrix } from "../modelPolicies.ts";
import { DIRECTOR_LIMITS, type DirectorCapability } from "./types.ts";

export type { DirectorCapability } from "./types.ts";

export type DirectorCapabilityField =
  | "cameraParameters"
  | "supportsFirstFrame"
  | "supportsLastFrame"
  | "maxKeyframes"
  | "supportsTimestampedKeyframes"
  | "supportsMultiShot"
  | "supportsVisualInstruction"
  | "supportsNativeTrajectory"
  | "allowedPassthroughParameters";

export type DirectorCapabilityProvenance = "live_endpoint" | "live_catalog" | "contract_fixture" | "unsupported";

/**
 * A fixture is accepted only when its identity, review date, and source are all
 * explicit. This prevents a stale model-name heuristic from silently becoming
 * a capability contract.
 */
export type DirectorCapabilityFixture = Omit<Partial<DirectorCapability>, "cameraParameters" | "allowedPassthroughParameters"> & {
  modelId: string;
  endpointId?: string;
  reviewedAt: string;
  source: string;
  cameraParameters?: Iterable<string>;
  allowedPassthroughParameters?: Iterable<string>;
};

/** A narrow live adapter for callers that already normalized provider data. */
export type DirectorLiveCapabilityMetadata = {
  cameraParameters?: Iterable<string>;
  supportsFirstFrame?: boolean;
  supportsLastFrame?: boolean;
  maxKeyframes?: number;
  supportsTimestampedKeyframes?: boolean;
  supportsMultiShot?: boolean;
  multiShotContract?: DirectorCapability["multiShotContract"];
  supportsVisualInstruction?: boolean;
  supportsNativeTrajectory?: boolean;
  allowedPassthroughParameters?: Iterable<string>;
  supportedParameters?: Record<string, CapabilityDescriptor>;
  supportedFrameImages?: Array<"first_frame" | "last_frame"> | null;
};

export type ResolveDirectorCapabilityInput = {
  model?: VideoModel | null;
  endpoint?: VideoModelEndpoint | null;
  route?: GenerationRoute | null;
  live?: DirectorLiveCapabilityMetadata | null;
  fixture?: DirectorCapabilityFixture | null;
  fixtures?: DirectorCapabilityFixture[];
};

export type ResolvedDirectorCapability = DirectorCapability & {
  provenance: Record<DirectorCapabilityField, DirectorCapabilityProvenance>;
  warnings: string[];
};

type PartialEvidence = {
  values: Partial<DirectorCapability>;
  present: Set<DirectorCapabilityField>;
};

const CAMERA_PARAMETER_NAMES = new Set([
  "camera",
  "camera_control",
  "camera_controls",
  "camera_motion",
  "camera_move",
  "camera_trajectory",
  "pan",
  "tilt",
  "truck",
  "dolly",
  "zoom",
  "orbit",
  "crane",
  "roll",
  "handheld",
  "static_camera",
  "sensor_preset",
  "lens_preset",
  "focal_length",
  "focal_length_mm",
  "aperture",
  "focus_subject",
  "focus_subject_id",
  "aspect_ratio",
]);

const TRAJECTORY_PARAMETER_NAMES = new Set(["trajectory", "motion_path", "camera_trajectory", "native_trajectory"]);
const MULTI_SHOT_PARAMETER_NAMES = new Set(["shots", "shot_sequence", "multi_shot", "storyboard"]);
const TIMESTAMPED_KEYFRAME_PARAMETER_NAMES = new Set(["timestamped_keyframes", "keyframe_timestamps"]);
const KEYFRAME_PARAMETER_NAMES = new Set(["keyframes", "input_keyframes", "frame_images"]);
const VISUAL_INSTRUCTION_PARAMETER_NAMES = new Set(["visual_instruction", "visual_instructions", "instruction_image", "instruction_images"]);

const CAPABILITY_FIELDS: DirectorCapabilityField[] = [
  "cameraParameters",
  "supportsFirstFrame",
  "supportsLastFrame",
  "maxKeyframes",
  "supportsTimestampedKeyframes",
  "supportsMultiShot",
  "supportsVisualInstruction",
  "supportsNativeTrajectory",
  "allowedPassthroughParameters",
];

function normalizedStrings(values: Iterable<string> | null | undefined): Set<string> {
  if (!values) return new Set();
  return new Set(Array.from(values, (value) => value.trim()).filter(Boolean));
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function descriptorMaximum(descriptor: CapabilityDescriptor | undefined): number | undefined {
  if (!descriptor) return undefined;
  if (descriptor.type === "range") return finiteNonNegativeInteger(descriptor.max);
  if (descriptor.type !== "enum" || !descriptor.values?.length) return undefined;
  const numeric = descriptor.values
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return numeric.length ? Math.max(...numeric) : undefined;
}

function hasAny(parameters: Record<string, CapabilityDescriptor>, names: Set<string>): boolean {
  return Object.keys(parameters).some((name) => names.has(name));
}

function metadataEvidence(metadata: DirectorLiveCapabilityMetadata | null | undefined): PartialEvidence {
  const present = new Set<DirectorCapabilityField>();
  const values: Partial<DirectorCapability> = {};
  if (!metadata) return { present, values };

  const parameters = metadata.supportedParameters;
  const explicitCamera = metadata.cameraParameters;
  if (explicitCamera !== undefined) {
    values.cameraParameters = normalizedStrings(explicitCamera);
    present.add("cameraParameters");
  } else if (parameters) {
    const cameraParameters = Object.keys(parameters).filter((name) => CAMERA_PARAMETER_NAMES.has(name));
    if (cameraParameters.length) {
      values.cameraParameters = new Set(cameraParameters);
      present.add("cameraParameters");
    }
  }

  if (metadata.supportedFrameImages !== undefined) {
    values.supportsFirstFrame = metadata.supportedFrameImages?.includes("first_frame") === true;
    values.supportsLastFrame = metadata.supportedFrameImages?.includes("last_frame") === true;
    present.add("supportsFirstFrame");
    present.add("supportsLastFrame");
  } else if (parameters) {
    const frameDescriptor = parameters.frame_images;
    const frameValues = frameDescriptor?.type === "enum" ? frameDescriptor.values?.map(String) ?? [] : [];
    if (parameters.first_frame || frameValues.includes("first_frame")) {
      values.supportsFirstFrame = true;
      present.add("supportsFirstFrame");
    }
    if (parameters.last_frame || frameValues.includes("last_frame")) {
      values.supportsLastFrame = true;
      present.add("supportsLastFrame");
    }
  }
  for (const field of [
    "supportsFirstFrame",
    "supportsLastFrame",
    "supportsTimestampedKeyframes",
    "supportsMultiShot",
    "supportsVisualInstruction",
    "supportsNativeTrajectory",
  ] as const) {
    if (metadata[field] !== undefined) {
      values[field] = metadata[field];
      present.add(field);
    }
  }

  const explicitMaximum = finiteNonNegativeInteger(metadata.maxKeyframes);
  if (metadata.maxKeyframes !== undefined) {
    values.maxKeyframes = explicitMaximum ?? 0;
    present.add("maxKeyframes");
  } else if (parameters) {
    const declaredMaximum = Array.from(KEYFRAME_PARAMETER_NAMES)
      .map((name) => descriptorMaximum(parameters[name]))
      .find((value) => value !== undefined);
    if (declaredMaximum !== undefined) {
      values.maxKeyframes = declaredMaximum;
      present.add("maxKeyframes");
    }
  }
  if (parameters) {
    if (!present.has("supportsTimestampedKeyframes") && hasAny(parameters, TIMESTAMPED_KEYFRAME_PARAMETER_NAMES)) {
      values.supportsTimestampedKeyframes = true;
      present.add("supportsTimestampedKeyframes");
    }
    if (!present.has("supportsMultiShot") && hasAny(parameters, MULTI_SHOT_PARAMETER_NAMES)) {
      values.supportsMultiShot = true;
      present.add("supportsMultiShot");
    }
    if (!present.has("supportsVisualInstruction") && hasAny(parameters, VISUAL_INSTRUCTION_PARAMETER_NAMES)) {
      values.supportsVisualInstruction = true;
      present.add("supportsVisualInstruction");
    }
    if (!present.has("supportsNativeTrajectory") && hasAny(parameters, TRAJECTORY_PARAMETER_NAMES)) {
      values.supportsNativeTrajectory = true;
      present.add("supportsNativeTrajectory");
    }
  }

  if (metadata.allowedPassthroughParameters !== undefined) {
    values.allowedPassthroughParameters = normalizedStrings(metadata.allowedPassthroughParameters);
    present.add("allowedPassthroughParameters");
  }
  if (metadata.multiShotContract) values.multiShotContract = { ...metadata.multiShotContract };
  return { present, values };
}

function recordValue(record: Record<string, unknown>, snakeName: string, camelName: string): unknown {
  return record[snakeName] ?? record[camelName];
}

function embeddedDirectorMetadata(value: unknown): DirectorLiveCapabilityMetadata {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nestedValue = record.director_capabilities ?? record.directorCapabilities;
  const nested = nestedValue && typeof nestedValue === "object" ? nestedValue as Record<string, unknown> : {};
  const strings = (input: unknown): string[] | undefined => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string")
    : undefined;
  const boolean = (snake: string, camel: string): boolean | undefined => {
    const raw = recordValue(nested, snake, camel) ?? recordValue(record, snake, camel);
    return typeof raw === "boolean" ? raw : undefined;
  };
  const rawMaximum = recordValue(nested, "max_keyframes", "maxKeyframes") ?? recordValue(record, "max_keyframes", "maxKeyframes");
  const rawMultiShotContract = recordValue(nested, "multi_shot_contract", "multiShotContract");
  const multiShotRecord = rawMultiShotContract && typeof rawMultiShotContract === "object"
    ? rawMultiShotContract as Record<string, unknown>
    : undefined;
  const multiShotParameter = multiShotRecord?.parameter;
  const multiShotShape = multiShotRecord?.shape;
  return {
    cameraParameters: strings(recordValue(nested, "camera_parameters", "cameraParameters")),
    supportsFirstFrame: boolean("supports_first_frame", "supportsFirstFrame"),
    supportsLastFrame: boolean("supports_last_frame", "supportsLastFrame"),
    maxKeyframes: finiteNonNegativeInteger(rawMaximum),
    supportsTimestampedKeyframes: boolean("supports_timestamped_keyframes", "supportsTimestampedKeyframes"),
    supportsMultiShot: boolean("supports_multi_shot", "supportsMultiShot"),
    ...(typeof multiShotParameter === "string"
      && multiShotParameter.trim()
      && (multiShotShape === "array" || multiShotShape === "object_with_shots")
      ? { multiShotContract: { parameter: multiShotParameter.trim(), shape: multiShotShape } }
      : {}),
    supportsVisualInstruction: boolean("supports_visual_instruction", "supportsVisualInstruction"),
    supportsNativeTrajectory: boolean("supports_native_trajectory", "supportsNativeTrajectory"),
    allowedPassthroughParameters: strings(
      recordValue(nested, "allowed_passthrough_parameters", "allowedPassthroughParameters")
      ?? recordValue(record, "allowed_passthrough_parameters", "allowedPassthroughParameters"),
    ),
    supportedParameters: record.supported_parameters && typeof record.supported_parameters === "object"
      ? record.supported_parameters as Record<string, CapabilityDescriptor>
      : undefined,
    supportedFrameImages: Array.isArray(record.supported_frame_images)
      ? record.supported_frame_images.filter((item): item is "first_frame" | "last_frame" => item === "first_frame" || item === "last_frame")
      : record.supported_frame_images === null ? null : undefined,
  };
}

function validFixture(fixture: DirectorCapabilityFixture, modelId: string, endpointId: string | undefined): boolean {
  if (fixture.modelId !== modelId) return false;
  if (fixture.endpointId && fixture.endpointId !== endpointId) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fixture.reviewedAt)) return false;
  const reviewedAt = new Date(`${fixture.reviewedAt}T00:00:00Z`);
  if (Number.isNaN(reviewedAt.valueOf()) || reviewedAt.toISOString().slice(0, 10) !== fixture.reviewedAt) return false;
  return fixture.source.trim().length > 0;
}

function fixtureEvidence(fixture: DirectorCapabilityFixture | undefined): PartialEvidence {
  if (!fixture) return { values: {}, present: new Set() };
  const present = new Set<DirectorCapabilityField>();
  const values: Partial<DirectorCapability> = {};
  for (const field of CAPABILITY_FIELDS) {
    if (fixture[field] === undefined) continue;
    present.add(field);
    if (field === "cameraParameters" || field === "allowedPassthroughParameters") {
      values[field] = normalizedStrings(fixture[field]);
    } else {
      (values as Record<string, unknown>)[field] = fixture[field];
    }
  }
  if (fixture.multiShotContract) values.multiShotContract = { ...fixture.multiShotContract };
  return { values, present };
}

export function unsupportedDirectorCapability(): ResolvedDirectorCapability {
  return {
    cameraParameters: new Set(),
    supportsFirstFrame: false,
    supportsLastFrame: false,
    maxKeyframes: 0,
    supportsTimestampedKeyframes: false,
    supportsMultiShot: false,
    supportsVisualInstruction: false,
    supportsNativeTrajectory: false,
    allowedPassthroughParameters: new Set(),
    parameterDescriptors: {},
    provenance: Object.fromEntries(CAPABILITY_FIELDS.map((field) => [field, "unsupported"])) as Record<DirectorCapabilityField, DirectorCapabilityProvenance>,
    warnings: [],
  };
}

/**
 * Resolves each capability independently. Explicit live evidence wins, a
 * dated fixture fills only missing fields, and everything else fails closed.
 */
export function resolveDirectorCapability(input: ResolveDirectorCapabilityInput): ResolvedDirectorCapability {
  const endpoint = input.endpoint ?? (input.route?.endpoint && "provider_slug" in input.route.endpoint
    ? input.route.endpoint as VideoModelEndpoint
    : undefined);
  const model = input.model ?? undefined;
  const modelId = model?.id ?? input.route?.modelId ?? "";
  const endpointId = endpoint?.endpoint_id ?? endpoint?.id ?? input.route?.routeId;
  const liveMetadata = input.live ?? embeddedDirectorMetadata(endpoint ?? model ?? input.route);
  if (!input.live) {
    liveMetadata.supportedParameters ??= endpoint
      ? endpoint.supported_parameters
      : model?.supported_parameters ?? input.route?.capabilities;
    liveMetadata.supportedFrameImages ??= endpoint
      ? endpoint.supported_frame_images
      : model?.supported_frame_images;
    liveMetadata.allowedPassthroughParameters ??= endpoint
      ? endpoint.allowed_passthrough_parameters
      : input.route?.allowedPassthroughParameters ?? model?.allowed_passthrough_parameters;
  }
  const live = metadataEvidence(liveMetadata);
  const fixtures = [input.fixture, ...(input.fixtures ?? [])].filter((candidate): candidate is DirectorCapabilityFixture => Boolean(candidate));
  const fixture = fixtures.find((candidate) => validFixture(candidate, modelId, endpointId));
  const checked = fixtureEvidence(fixture);
  const output = unsupportedDirectorCapability();
  const liveProvenance: DirectorCapabilityProvenance = endpoint ? "live_endpoint" : "live_catalog";

  for (const field of CAPABILITY_FIELDS) {
    if (live.present.has(field)) {
      (output as unknown as Record<string, unknown>)[field] = live.values[field];
      output.provenance[field] = liveProvenance;
    } else if (checked.present.has(field)) {
      (output as unknown as Record<string, unknown>)[field] = checked.values[field];
      output.provenance[field] = "contract_fixture";
    }
  }
  const multiShotContract = live.values.multiShotContract ?? checked.values.multiShotContract;
  if (output.supportsMultiShot && multiShotContract) output.multiShotContract = { ...multiShotContract };
  output.parameterDescriptors = { ...(liveMetadata.supportedParameters ?? {}) };
  const frameDescriptor = liveMetadata.supportedParameters?.frame_images;
  const enumFrames = frameDescriptor?.type === "enum"
    ? new Set(frameDescriptor.values?.map(String).filter((value) => value === "first_frame" || value === "last_frame"))
    : new Set<string>();
  const parameterFrames = Math.max(
    enumFrames.size,
    liveMetadata.supportedParameters
      ? Number(Boolean(liveMetadata.supportedParameters.first_frame)) + Number(Boolean(liveMetadata.supportedParameters.last_frame))
      : 0,
  );
  const declaredFrameMinimum = Math.max(liveMetadata.supportedFrameImages?.length ?? 0, parameterFrames);
  if (output.maxKeyframes < declaredFrameMinimum) {
    output.maxKeyframes = declaredFrameMinimum;
    output.provenance.maxKeyframes = liveProvenance;
  }
  output.maxKeyframes = Math.min(DIRECTOR_LIMITS.maxKeyframes, Math.max(0, output.maxKeyframes));
  if (!fixture && fixtures.some((candidate) => candidate.modelId === modelId)) {
    output.warnings.push("A Director capability fixture was ignored because its endpoint identity, review date, or source was invalid.");
  }
  return output;
}

/**
 * Applies route-level transport evidence to execution capabilities. Visual
 * overlays are data URL image references, so catalog intent alone cannot
 * enable them for a paid request.
 */
export function resolveRunnableDirectorCapability(
  model: VideoModel | null,
  route: GenerationRoute | null | undefined,
): ResolvedDirectorCapability {
  const capability = resolveDirectorCapability({ model, route });
  if (!capability.supportsVisualInstruction || !model) return capability;
  const endpoint = route?.mode === "video" ? route.endpoint as VideoModelEndpoint | undefined : undefined;
  const hasAmbiguousEndpoint = !endpoint && Boolean(model.endpoints?.length);
  const hasVerifiedImageDataTransport = !hasAmbiguousEndpoint
    && videoReferenceTypes(model, endpoint).includes("image")
    && buildVideoSupportMatrix(model, endpoint).entries.some((entry) => (
      entry.kind === "image"
      && entry.transport === "data_url"
      && entry.supported
      && entry.verified
    ));
  if (hasVerifiedImageDataTransport) return capability;
  return {
    ...capability,
    supportsVisualInstruction: false,
    provenance: {
      ...capability.provenance,
      supportsVisualInstruction: "unsupported",
    },
    warnings: [
      ...capability.warnings,
      "Visual instruction fallback is disabled because the selected route has no verified image data URL transport.",
    ],
  };
}

export const resolveDirectorCapabilities = resolveDirectorCapability;
