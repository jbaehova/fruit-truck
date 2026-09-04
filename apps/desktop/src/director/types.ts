export const DIRECTOR_PLAN_SCHEMA_VERSION = 1 as const;
export const DIRECTOR_LIMITS = Object.freeze({
  maxSubjects: 8,
  maxPathPoints: 128,
  maxShots: 6,
  maxCameraMovesPerShot: 2,
  maxActionOrder: 3,
  maxKeyframes: 8,
  maxSerializedBytes: 512 * 1024,
});

export type DirectorPlanSchemaVersion = typeof DIRECTOR_PLAN_SCHEMA_VERSION;
export type DirectorControlId = string;

export type CameraSensorPreset = "neutral" | "cinema" | "film" | "digital_crisp";
export type CameraLensPreset = "neutral" | "spherical" | "anamorphic" | "vintage" | "macro";
export type DirectorEasing = "linear" | "ease_in" | "ease_out" | "ease_in_out";
export type DirectorMotionTarget = "subject" | "camera";
export type DirectorMotionKind =
  | "translate"
  | "depth_in"
  | "depth_out"
  | "pan"
  | "tilt"
  | "truck"
  | "dolly"
  | "zoom"
  | "orbit"
  | "crane"
  | "roll"
  | "handheld"
  | "static";
export type DirectorDirection = "left" | "right" | "up" | "down" | "in" | "out";
export type DirectorActionOrder = 1 | 2 | 3;
export type DirectorKeyframeRole = "first" | "middle" | "last" | "timestamped";
export type DirectorShotSpeed = "slow_motion" | "linear" | "speed_up";
export type DirectorFidelity = "native" | "keyframe" | "visual" | "prompt" | "unsupported";

export type NormalizedPoint = {
  x: number;
  y: number;
};

export type DirectorRegion =
  | { type: "box"; x: number; y: number; width: number; height: number }
  | { type: "polygon"; points: NormalizedPoint[] };

/** The rig has an ID so every editable control can receive an explicit fidelity result. */
export type CameraRig = {
  id: DirectorControlId;
  sensorPreset: CameraSensorPreset;
  lensPreset: CameraLensPreset;
  focalLengthMm?: number;
  aperture?: number;
  focusSubjectId?: string;
  aspectRatio?: string;
};

export type DirectorSubject = {
  id: DirectorControlId;
  label: string;
  region: DirectorRegion;
  sourceAssetId: string;
};

export type DirectorMotion = {
  id: DirectorControlId;
  targetType: DirectorMotionTarget;
  targetId?: string;
  kind: DirectorMotionKind;
  path?: NormalizedPoint[];
  direction?: DirectorDirection;
  intensity: number;
  start: number;
  end: number;
  easing: DirectorEasing;
  order: DirectorActionOrder;
  actionLabel?: string;
};

export type DirectorKeyframe = {
  id: DirectorControlId;
  assetId: string;
  role: DirectorKeyframeRole;
  time: number;
};

export type DirectorShot = {
  id: DirectorControlId;
  order: number;
  durationSeconds: number;
  promptFragment: string;
  motionIds: string[];
  keyframeIds: string[];
  speed: DirectorShotSpeed;
};

export type DirectorCanvas = {
  sourceWidth: number;
  sourceHeight: number;
};

export type DirectorPlan = {
  schemaVersion: DirectorPlanSchemaVersion;
  enabled: boolean;
  sourceAssetId?: string;
  canvas?: DirectorCanvas;
  cameraRig: CameraRig;
  subjects: DirectorSubject[];
  motions: DirectorMotion[];
  keyframes: DirectorKeyframe[];
  shots: DirectorShot[];
  updatedAt: string;
};

export type DirectorPresetPlan = Omit<DirectorPlan, "sourceAssetId" | "subjects" | "keyframes">;

export type DirectorPreset = {
  id: string;
  name: string;
  plan: DirectorPresetPlan;
  createdAt: string;
  updatedAt: string;
};

export type DirectorCapability = {
  cameraParameters: ReadonlySet<string>;
  supportsFirstFrame: boolean;
  supportsLastFrame: boolean;
  maxKeyframes: number;
  supportsTimestampedKeyframes: boolean;
  supportsMultiShot: boolean;
  /** Exact provider field and container shape for the canonical Director shot list. */
  multiShotContract?: {
    parameter: string;
    shape: "array" | "object_with_shots";
  };
  supportsVisualInstruction: boolean;
  supportsNativeTrajectory: boolean;
  allowedPassthroughParameters: ReadonlySet<string>;
  parameterDescriptors?: Readonly<Record<string, {
    type: "enum" | "range" | "boolean";
    values?: Array<string | number>;
    min?: number;
    max?: number;
  }>>;
};

export type DirectorFrameBinding = {
  assetId: string;
  role: "first_frame" | "last_frame" | "reference";
  timestampSeconds?: number;
};

export type DirectorVisualInstruction = {
  sourceAssetId: string;
  overlay: string;
};

export type CompiledDirector = {
  fidelityByControlId: Record<DirectorControlId, DirectorFidelity>;
  providerOptions: Record<string, unknown>;
  frameBindings: DirectorFrameBinding[];
  visualInstructions: DirectorVisualInstruction[];
  promptBrief: string;
  warnings: string[];
};

export type DirectorControl =
  | { type: "camera_rig"; control: CameraRig }
  | { type: "subject"; control: DirectorSubject }
  | { type: "motion"; control: DirectorMotion }
  | { type: "keyframe"; control: DirectorKeyframe }
  | { type: "shot"; control: DirectorShot };

export function listDirectorControls(plan: DirectorPlan): DirectorControl[] {
  return [
    { type: "camera_rig", control: plan.cameraRig },
    ...plan.subjects.map((control): DirectorControl => ({ type: "subject", control })),
    ...plan.motions.map((control): DirectorControl => ({ type: "motion", control })),
    ...plan.keyframes.map((control): DirectorControl => ({ type: "keyframe", control })),
    ...plan.shots.map((control): DirectorControl => ({ type: "shot", control })),
  ];
}
