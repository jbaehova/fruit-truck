import {
  resolveEligibleRoute,
  videoReferenceLimit,
  type DraftOptions,
  type GenerationMode,
  type GenerationModel,
  type GenerationRoute,
  type ImageModel,
  type ReferenceRole,
  type VideoModel,
  type VideoModelEndpoint,
} from "./openrouter.ts";
import { videoInputPolicy, videoReferenceCapability, videoReferenceTransportForUrl, type InputMediaKind } from "./modelPolicies.ts";
import type { DraftReference, SessionAsset } from "./studio.ts";

const KINDS = ["image", "video", "audio"] as const;
type InputAsset = Pick<SessionAsset, "id" | "kind"> & Partial<Pick<SessionAsset, "externalUrl" | "localPath" | "blobKey" | "storageAvailability">>;

export type InputCapabilities = {
  mode: GenerationMode;
  model: GenerationModel | null;
  route?: GenerationRoute;
  endpoint?: VideoModelEndpoint;
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
  const frames = [...new Set((endpoint ? endpoint.supported_frame_images : video.supported_frame_images) ?? [])];
  const referenceLimits = Object.fromEntries(KINDS.map((kind) => [kind, videoReferenceLimit(video, kind, endpoint)])) as InputCapabilities["referenceLimits"];
  const declaredReferenceLimit = endpoint
    ? endpoint.max_input_references ?? route.capabilities.input_references?.max ?? Math.max(...Object.values(referenceLimits))
    : video.max_input_references ?? videoInputPolicy(video.id).totalReferenceLimit ?? Math.max(...Object.values(referenceLimits));
  const referenceLimit = Math.min(declaredReferenceLimit, Object.values(referenceLimits).reduce((sum, count) => sum + count, 0));
  const mixFramesAndReferences = videoInputPolicy(video.id).combination === "allow";
  return {
    ...result, endpoint, referenceLimits, referenceLimit, mixFramesAndReferences,
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
  if (support.mode === "video" && support.model) {
    const transport = !asset.localPath && !asset.blobKey && asset.externalUrl
      ? videoReferenceTransportForUrl(asset.externalUrl) : "data_url";
    if (!videoReferenceCapability(support.model as VideoModel, asset.kind, transport, support.endpoint).supported) return [];
  }
  const general = remaining.filter((reference) => reference.role === "reference");
  // Let users change existing roles one at a time. Preflight reports mixed
  // styles until the transition is complete; adding new mixed inputs is closed.
  const changingRole = replacingSlot !== undefined;
  return support.roles[asset.kind].filter((role) => {
    if (role !== "reference") {
      return !remaining.some((reference) => reference.role === role)
        && (changingRole || support.mixFramesAndReferences || !general.length);
    }
    return (changingRole || support.mixFramesAndReferences || remaining.length === general.length)
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
export function modelForInputControls(support: InputCapabilities): GenerationModel | null {
  const { model, route } = support;
  if (!model || !route) return model;
  if (support.mode === "image") return { ...model, supported_parameters: route.capabilities, supported_sizes: route.supportedSizes } as ImageModel;
  const values = (name: string) => route.capabilities[name]?.values?.map(String);
  return {
    ...model,
    supported_parameters: route.capabilities,
    supported_durations: values("duration")?.map(Number),
    supported_resolutions: values("resolution"),
    supported_aspect_ratios: values("aspect_ratio"),
    supported_sizes: route.supportedSizes,
    generate_audio: Boolean(route.capabilities.generate_audio),
    seed: Boolean(route.capabilities.seed),
    allowed_passthrough_parameters: route.allowedPassthroughParameters,
  } as VideoModel;
}
