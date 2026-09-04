import {
  DIRECTOR_PLAN_SCHEMA_VERSION,
  type CameraRig,
  type DirectorPlan,
  type DirectorShot,
} from "./types.ts";

export type DirectorIdFactory = (prefix: string) => string;

export type CreateDirectorPlanOptions = {
  sourceAssetId?: string;
  now?: string | (() => string);
  createId?: DirectorIdFactory;
};

let fallbackIdSequence = 0;

export function createDirectorId(prefix = "director"): string {
  const safePrefix = prefix.trim().replace(/[^a-z0-9_-]+/gi, "-") || "director";
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${safePrefix}-${uuid}`;
  fallbackIdSequence += 1;
  return `${safePrefix}-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`;
}

function resolveNow(now: CreateDirectorPlanOptions["now"]): string {
  if (typeof now === "function") return now();
  return now ?? new Date().toISOString();
}

export function createDefaultCameraRig(createId: DirectorIdFactory = createDirectorId): CameraRig {
  return {
    id: createId("camera-rig"),
    sensorPreset: "neutral",
    lensPreset: "neutral",
  };
}

export function createDefaultDirectorShot(
  order = 1,
  createId: DirectorIdFactory = createDirectorId,
): DirectorShot {
  return {
    id: createId("shot"),
    order,
    durationSeconds: 5,
    promptFragment: "",
    motionIds: [],
    keyframeIds: [],
    speed: "linear",
  };
}

/** Creates the asset-independent empty plan used when Director is first opened. */
export function createDefaultDirectorPlan(options: CreateDirectorPlanOptions = {}): DirectorPlan {
  const createId = options.createId ?? createDirectorId;
  return {
    schemaVersion: DIRECTOR_PLAN_SCHEMA_VERSION,
    enabled: true,
    ...(options.sourceAssetId ? { sourceAssetId: options.sourceAssetId } : {}),
    cameraRig: createDefaultCameraRig(createId),
    subjects: [],
    motions: [],
    keyframes: [],
    shots: [],
    updatedAt: resolveNow(options.now),
  };
}

/** Returns an existing plan unchanged, creating a default only for an absent draft value. */
export function ensureDirectorPlan(
  plan: DirectorPlan | undefined,
  options: CreateDirectorPlanOptions = {},
): DirectorPlan {
  return plan ?? createDefaultDirectorPlan(options);
}

/** Attempt snapshots and presets must never retain references to an editable draft plan. */
export function cloneDirectorPlan(plan: DirectorPlan): DirectorPlan {
  if (typeof structuredClone === "function") return structuredClone(plan);
  return JSON.parse(JSON.stringify(plan)) as DirectorPlan;
}
