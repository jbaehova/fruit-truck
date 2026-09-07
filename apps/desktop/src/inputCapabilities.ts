import {
  resolveEligibleRoute,
  type DraftOptions,
  type GenerationMode,
  type GenerationModel,
  type GenerationRoute,
  type ImageModel,
  type ReferenceRole,
  type VideoModel,
  type VideoModelEndpoint,
} from "./openrouter.ts";
import { resolveVideoInputRules, videoReferenceCapability, videoReferenceTransportForUrl, type InputMediaKind, type VideoInputRules } from "./modelPolicies.ts";
import type { DraftReference, SessionAsset } from "./studio.ts";

const KINDS = ["image", "video", "audio"] as const;
type InputAsset = Pick<SessionAsset, "id" | "kind"> & Partial<Pick<SessionAsset, "externalUrl" | "localPath" | "blobKey" | "storageAvailability">>;

export type InputCapabilities = {
  mode: GenerationMode;
  model: GenerationModel | null;
  route?: GenerationRoute;
  endpoint?: VideoModelEndpoint;
  rules?: VideoInputRules;
  roles: Record<InputMediaKind, ReferenceRole[]>;
  referenceLimits: Record<InputMediaKind, number>;
  referenceLimit: number;
  minimum: number;
  limit: number;
  mixFramesAndReferences: boolean;
};

/** Resolve the same provider contract used by request preparation. */
export function resolveInputCapabilities(
  mode: GenerationMode,
  model: GenerationModel | null,
  options: DraftOptions = {},
  providerJson = "",
): InputCapabilities {
  // Keep controls available to repair an incompatible saved option. Provider
  // restrictions still apply, so a pinned route never falls back to its union.
  const route = model ? resolveEligibleRoute({ mode, model, options, providerJson }).selected
    ?? resolveEligibleRoute({ mode, model, providerJson }).selected : undefined;
  const result: InputCapabilities = {
    mode, model, route,
    roles: { image: [], video: [], audio: [] },
    referenceLimits: { image: 0, video: 0, audio: 0 },
    referenceLimit: 0, minimum: 0, limit: 0, mixFramesAndReferences: false,
  };
  if (!model || !route) return result;
  if (mode === "image") {
    const limit = route.capabilities.input_references?.max ?? 0;
    return {
      ...result,
      roles: { image: limit > 0 ? ["reference"] : [], video: [], audio: [] },
      referenceLimits: { image: limit, video: 0, audio: 0 },
      referenceLimit: limit, limit,
      minimum: route.capabilities.input_references?.min ?? 0,
    };
  }
  const video = model as VideoModel;
  const endpoint = route.endpoint as VideoModelEndpoint | undefined;
  const rules = resolveVideoInputRules(video, endpoint);
  const frames = rules.frameImages;
  const referenceLimits = rules.referenceLimits;
  const referenceLimit = Math.min(rules.totalReferenceLimit, Object.values(referenceLimits).reduce((sum, count) => sum + count, 0));
  const mixFramesAndReferences = rules.combination !== "exclusive";
  return {
    ...result, endpoint, rules, referenceLimits, referenceLimit, mixFramesAndReferences,
    roles: Object.fromEntries(KINDS.map((kind) => [kind, [
      ...(referenceLimits[kind] > 0 ? ["reference" as const] : []),
      ...(kind === "image" ? frames : []),
    ]])) as InputCapabilities["roles"],
    limit: mixFramesAndReferences ? referenceLimit + frames.length : Math.max(referenceLimit, frames.length),
  };
}

/** Slot-aware quotas apply equally to file uploads, drops, role changes, and the library. */
export function availableInputRoles(
  support: InputCapabilities,
  references: readonly DraftReference[],
  assets: readonly InputAsset[],
  asset: InputAsset,
  replacingSlot?: number,
): ReferenceRole[] {
  if (asset.storageAvailability === "missing") return [];
  const remaining = references.filter((reference) => reference.slot !== replacingSlot);
  if (remaining.length >= support.limit) return [];
  const transport = !asset.localPath && !asset.blobKey && asset.externalUrl
    ? videoReferenceTransportForUrl(asset.externalUrl) : "data_url";
  const general = remaining.filter((reference) => reference.role === "reference");
  return support.roles[asset.kind].filter((role) => {
    if (support.mode === "video" && support.model
      && !videoReferenceCapability(support.model as VideoModel, asset.kind, transport, support.endpoint, role).supported) return false;
    if (role === "last_frame" && support.rules?.lastFrameRequiresFirstFrame
      && !remaining.some((reference) => reference.role === "first_frame")) return false;
    if (role !== "reference") {
      return !remaining.some((reference) => reference.role === role)
        && (support.mixFramesAndReferences || !general.length);
    }
    return (support.mixFramesAndReferences || remaining.length === general.length)
      && general.length < support.referenceLimit
      && general.filter((reference) => assets.find((candidate) => candidate.id === reference.assetId)?.kind === asset.kind).length < support.referenceLimits[asset.kind];
  });
}

/** Reuse a generated image without introducing an unsupported frame role. */
export function videoImageReferences(
  support: InputCapabilities,
  references: readonly DraftReference[],
  assets: readonly InputAsset[],
  asset: InputAsset,
): DraftReference[] | null {
  if (asset.kind !== "image") return null;
  const priorFirst = references.find((reference) => reference.role === "first_frame");
  const existing = references.find((reference) => reference.assetId === asset.id);
  const firstReferences = references.filter((reference) => reference.role !== "first_frame"
    && !(reference.assetId === asset.id && reference.role === "reference"));
  const firstAllowed = availableInputRoles(support, firstReferences, assets, asset).includes("first_frame");
  const remaining = firstAllowed ? firstReferences : references.filter((reference) => reference.slot !== existing?.slot);
  const role = firstAllowed ? "first_frame" : availableInputRoles(support, remaining, assets, asset)[0];
  if (!role) return null;
  const slot = firstAllowed ? priorFirst?.slot ?? (existing?.role === "reference" ? existing.slot : undefined) : existing?.slot;
  const used = new Set(remaining.map((reference) => reference.slot));
  let nextSlot = slot ?? 1;
  while (used.has(nextSlot)) nextSlot += 1;
  return [...remaining, { assetId: asset.id, slot: nextSlot, role, purpose: role === "reference" ? "composition" as const : role }]
    .sort((left, right) => left.slot - right.slot);
}

/** Present output controls using endpoint descriptors instead of model unions. */
export function modelForInputControls(support: InputCapabilities, references: readonly Pick<DraftReference, "role">[] = []): GenerationModel | null {
  const { model, route } = support;
  if (!model || !route) return model;
  if (support.mode === "image") return { ...model, supported_parameters: route.capabilities, supported_sizes: route.supportedSizes } as ImageModel;
  const capabilities = { ...route.capabilities };
  const restrictions = references.some((reference) => reference.role === "reference") ? support.rules?.referenceOptions : undefined;
  for (const [name, allowed] of Object.entries({ duration: restrictions?.durations, resolution: restrictions?.resolutions, aspect_ratio: restrictions?.aspectRatios })) {
    if (!allowed?.length) continue;
    const descriptor = capabilities[name];
    const values = allowed.filter((value) => (!descriptor?.values || descriptor.values.map(String).includes(String(value)))
      && (descriptor?.min == null || Number(value) >= descriptor.min)
      && (descriptor?.max == null || Number(value) <= descriptor.max));
    capabilities[name] = { type: "enum", values };
  }
  const values = (name: string) => capabilities[name]?.values?.map(String);
  return {
    ...model,
    supported_parameters: capabilities,
    supported_durations: values("duration")?.map(Number),
    supported_resolutions: values("resolution"),
    supported_aspect_ratios: values("aspect_ratio"),
    supported_sizes: route.supportedSizes,
    generate_audio: Boolean(route.capabilities.generate_audio),
    seed: Boolean(route.capabilities.seed),
    allowed_passthrough_parameters: route.allowedPassthroughParameters,
  } as VideoModel;
}


/** A newly attached reference uses supported workflow options immediately. */
export function optionsForInputReferences(
  support: InputCapabilities,
  references: readonly Pick<DraftReference, "role">[],
  options: DraftOptions,
): DraftOptions {
  if (support.mode !== "video" || !references.some((reference) => reference.role === "reference") || !support.rules?.referenceOptions) return options;
  const model = modelForInputControls(support, references) as VideoModel;
  const next = { ...options };
  for (const name of ["duration", "resolution", "aspect_ratio"]) {
    const values = model.supported_parameters?.[name]?.values;
    if (values?.length && !values.map(String).includes(String(options[name]))) next[name] = values[0];
  }
  return next;
}
