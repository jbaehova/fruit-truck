import {
  DIRECTOR_LIMITS,
  DIRECTOR_PLAN_SCHEMA_VERSION,
  type CameraLensPreset,
  type CameraSensorPreset,
  type DirectorDirection,
  type DirectorEasing,
  type DirectorKeyframeRole,
  type DirectorMotion,
  type DirectorMotionKind,
  type DirectorPlan,
  type DirectorRegion,
  type DirectorShotSpeed,
  type NormalizedPoint,
} from "./types.ts";

export const DIRECTOR_VALIDATION_CODES = {
  invalidPlan: "director.invalid_plan",
  unsupportedSchema: "director.schema.unsupported",
  invalidField: "director.field.invalid",
  duplicateId: "director.id.duplicate",
  planTooLarge: "director.plan.size_limit",
  missingAsset: "director.asset.missing",
  sourceAssetRequired: "director.asset.source_required",
  subjectLimit: "director.subject.limit",
  invalidRegion: "director.subject.region_invalid",
  pathPointLimit: "director.motion.path_point_limit",
  missingMotionTarget: "director.motion.target_missing",
  incompatibleMotionTarget: "director.motion.target_incompatible",
  invalidMotionTime: "director.motion.time_invalid",
  staticCameraConflict: "director.motion.static_conflict",
  opposingCameraConflict: "director.motion.opposing_direction_conflict",
  shotLimit: "director.shot.limit",
  cameraMoveLimit: "director.shot.camera_move_limit",
  invalidShotDuration: "director.shot.duration_invalid",
  totalDurationLimit: "director.shot.total_duration_limit",
  missingMotionReference: "director.shot.motion_missing",
  missingKeyframeReference: "director.shot.keyframe_missing",
  duplicateReference: "director.shot.reference_duplicate",
  duplicateShotOrder: "director.shot.order_duplicate",
  nonSequentialShotOrder: "director.shot.order_nonsequential",
  multipleShotAssignment: "director.shot.control_multiple_assignment",
  keyframeLimit: "director.keyframe.limit",
  keyframeRoleConflict: "director.keyframe.role_conflict",
  duplicateKeyframeBinding: "director.keyframe.binding_duplicate",
  focusSubjectMissing: "director.camera.focus_subject_missing",
  orphanedControl: "director.control.orphaned",
} as const;

export type DirectorValidationCode =
  (typeof DIRECTOR_VALIDATION_CODES)[keyof typeof DIRECTOR_VALIDATION_CODES];
export type DirectorValidationSeverity = "error" | "warning";

export type DirectorValidationIssue = {
  code: DirectorValidationCode;
  path: string;
  message: string;
  severity: DirectorValidationSeverity;
  controlId?: string;
};

export type DirectorValidationResult = {
  valid: boolean;
  errors: DirectorValidationIssue[];
  warnings: DirectorValidationIssue[];
  issues: DirectorValidationIssue[];
};

export type DirectorAssetAvailability =
  | ReadonlySet<string>
  | readonly string[]
  | ((assetId: string) => boolean);

export type DirectorValidationOptions = {
  /** Asset existence is checked only when the caller provides an authoritative snapshot. */
  availableAssetIds?: DirectorAssetAvailability;
  /** Provider limit. It is combined with the hard release limit of eight. */
  maxKeyframes?: number;
  /** Provider clip limit in seconds. Omit when unknown. */
  maxDurationSeconds?: number;
  maxSerializedBytes?: number;
  requireSourceAssetForMotionPaths?: boolean;
};

export type DirectorAssetReference = {
  assetId: string;
  path: string;
  role: "source" | "subject" | "keyframe";
  controlId?: string;
};

const SENSOR_PRESETS: readonly CameraSensorPreset[] = ["neutral", "cinema", "film", "digital_crisp"];
const LENS_PRESETS: readonly CameraLensPreset[] = ["neutral", "spherical", "anamorphic", "vintage", "macro"];
const EASINGS: readonly DirectorEasing[] = ["linear", "ease_in", "ease_out", "ease_in_out"];
const MOTION_KINDS: readonly DirectorMotionKind[] = [
  "translate",
  "depth_in",
  "depth_out",
  "pan",
  "tilt",
  "truck",
  "dolly",
  "zoom",
  "orbit",
  "crane",
  "roll",
  "handheld",
  "static",
];
const DIRECTIONS: readonly DirectorDirection[] = ["left", "right", "up", "down", "in", "out"];
const KEYFRAME_ROLES: readonly DirectorKeyframeRole[] = ["first", "middle", "last", "timestamped"];
const SHOT_SPEEDS: readonly DirectorShotSpeed[] = ["slow_motion", "linear", "speed_up"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNormalizedNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function addIssue(
  issues: DirectorValidationIssue[],
  code: DirectorValidationCode,
  path: string,
  message: string,
  severity: DirectorValidationSeverity = "error",
  controlId?: string,
): void {
  issues.push({ code, path, message, severity, ...(controlId ? { controlId } : {}) });
}

function validateControlId(
  value: unknown,
  path: string,
  issues: DirectorValidationIssue[],
  seenIds: Map<string, string>,
): value is string {
  if (!isNonEmptyString(value)) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, path, "Control ID must be a non-empty string.");
    return false;
  }
  const existingPath = seenIds.get(value);
  if (existingPath) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.duplicateId,
      path,
      `Control ID is already used at ${existingPath}.`,
      "error",
      value,
    );
  } else {
    seenIds.set(value, path);
  }
  return true;
}

function validateNormalizedPoint(
  value: unknown,
  path: string,
  issues: DirectorValidationIssue[],
  controlId?: string,
): value is NormalizedPoint {
  if (!isRecord(value) || !isNormalizedNumber(value.x) || !isNormalizedNumber(value.y)) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.invalidField,
      path,
      "Point coordinates must be finite numbers from 0 through 1.",
      "error",
      controlId,
    );
    return false;
  }
  return true;
}

function validateRegion(
  value: unknown,
  path: string,
  issues: DirectorValidationIssue[],
  controlId?: string,
): value is DirectorRegion {
  if (!isRecord(value)) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidRegion, path, "Subject region must be a box or polygon.", "error", controlId);
    return false;
  }
  if (value.type === "box") {
    const valid = isNormalizedNumber(value.x)
      && isNormalizedNumber(value.y)
      && isNormalizedNumber(value.width)
      && isNormalizedNumber(value.height)
      && value.width > 0
      && value.height > 0
      && value.x + value.width <= 1 + Number.EPSILON
      && value.y + value.height <= 1 + Number.EPSILON;
    if (!valid) {
      addIssue(
        issues,
        DIRECTOR_VALIDATION_CODES.invalidRegion,
        path,
        "Box regions must have positive normalized dimensions and stay inside the source frame.",
        "error",
        controlId,
      );
    }
    return valid;
  }
  if (value.type === "polygon") {
    if (!Array.isArray(value.points) || value.points.length < 3) {
      addIssue(
        issues,
        DIRECTOR_VALIDATION_CODES.invalidRegion,
        `${path}.points`,
        "Polygon regions require at least three normalized points.",
        "error",
        controlId,
      );
      return false;
    }
    return value.points.every((point, index) => validateNormalizedPoint(point, `${path}.points[${index}]`, issues, controlId));
  }
  addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidRegion, `${path}.type`, "Subject region type must be box or polygon.", "error", controlId);
  return false;
}

function validateUniqueReferences(
  values: readonly string[],
  path: string,
  issues: DirectorValidationIssue[],
  controlId: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      addIssue(
        issues,
        DIRECTOR_VALIDATION_CODES.duplicateReference,
        `${path}[${index}]`,
        "A shot cannot reference the same control more than once.",
        "error",
        controlId,
      );
    }
    seen.add(value);
  });
}

function intervalsOverlap(a: DirectorMotion, b: DirectorMotion): boolean {
  return a.start < b.end && b.start < a.end;
}

function byteLength(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return undefined;
  }
}

function assetPredicate(availability: DirectorAssetAvailability): (assetId: string) => boolean {
  if (typeof availability === "function") return availability;
  const ids = availability instanceof Set ? availability : new Set(availability);
  return (assetId) => ids.has(assetId);
}

export function collectDirectorAssetReferences(plan: DirectorPlan): DirectorAssetReference[] {
  const references: DirectorAssetReference[] = [];
  if (plan.sourceAssetId) {
    references.push({ assetId: plan.sourceAssetId, path: "sourceAssetId", role: "source" });
  }
  plan.subjects.forEach((subject, index) => {
    references.push({
      assetId: subject.sourceAssetId,
      path: `subjects[${index}].sourceAssetId`,
      role: "subject",
      controlId: subject.id,
    });
  });
  plan.keyframes.forEach((keyframe, index) => {
    references.push({
      assetId: keyframe.assetId,
      path: `keyframes[${index}].assetId`,
      role: "keyframe",
      controlId: keyframe.id,
    });
  });
  return references;
}

export function validateDirectorAssetReferences(
  plan: DirectorPlan,
  availability: DirectorAssetAvailability,
): DirectorValidationIssue[] {
  const hasAsset = assetPredicate(availability);
  return collectDirectorAssetReferences(plan)
    .filter((reference) => !hasAsset(reference.assetId))
    .map((reference) => ({
      code: DIRECTOR_VALIDATION_CODES.missingAsset,
      path: reference.path,
      message: `Referenced ${reference.role} asset is missing and must be relinked.`,
      severity: "error" as const,
      ...(reference.controlId ? { controlId: reference.controlId } : {}),
    }));
}

export function validateDirectorPlan(
  input: unknown,
  options: DirectorValidationOptions = {},
): DirectorValidationResult {
  const issues: DirectorValidationIssue[] = [];
  if (!isRecord(input)) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidPlan, "", "Director Plan must be an object.");
    return makeResult(issues);
  }
  if (input.schemaVersion !== DIRECTOR_PLAN_SCHEMA_VERSION) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.unsupportedSchema,
      "schemaVersion",
      `Director Plan schema must be version ${DIRECTOR_PLAN_SCHEMA_VERSION}.`,
    );
  }
  if (typeof input.enabled !== "boolean") {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "enabled", "Enabled must be a boolean.");
  }
  if (input.sourceAssetId !== undefined && !isNonEmptyString(input.sourceAssetId)) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "sourceAssetId", "Source asset ID must be a non-empty string.");
  }
  if (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "updatedAt", "Updated timestamp must be a valid date string.");
  }
  if (input.canvas !== undefined) {
    if (!isRecord(input.canvas)
      || !isFiniteNumber(input.canvas.sourceWidth)
      || input.canvas.sourceWidth <= 0
      || !isFiniteNumber(input.canvas.sourceHeight)
      || input.canvas.sourceHeight <= 0) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "canvas", "Canvas source dimensions must be positive finite numbers.");
    }
  }

  const seenIds = new Map<string, string>();
  const cameraRig = isRecord(input.cameraRig) ? input.cameraRig : undefined;
  if (!cameraRig) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "cameraRig", "Camera rig is required.");
  } else {
    const controlId = validateControlId(cameraRig.id, "cameraRig.id", issues, seenIds) ? cameraRig.id : undefined;
    if (!includes(SENSOR_PRESETS, cameraRig.sensorPreset)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "cameraRig.sensorPreset", "Camera sensor preset is invalid.", "error", controlId);
    }
    if (!includes(LENS_PRESETS, cameraRig.lensPreset)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "cameraRig.lensPreset", "Camera lens preset is invalid.", "error", controlId);
    }
    if (cameraRig.focalLengthMm !== undefined
      && (!isFiniteNumber(cameraRig.focalLengthMm) || cameraRig.focalLengthMm <= 0)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "cameraRig.focalLengthMm", "Focal length must be a positive finite number.", "error", controlId);
    }
    if (cameraRig.aperture !== undefined
      && (!isFiniteNumber(cameraRig.aperture) || cameraRig.aperture <= 0)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "cameraRig.aperture", "Aperture must be a positive finite number.", "error", controlId);
    }
    if (cameraRig.focusSubjectId !== undefined && !isNonEmptyString(cameraRig.focusSubjectId)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "cameraRig.focusSubjectId", "Focus subject ID must be a non-empty string.", "error", controlId);
    }
    if (cameraRig.aspectRatio !== undefined && !isNonEmptyString(cameraRig.aspectRatio)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "cameraRig.aspectRatio", "Aspect ratio must be a non-empty string.", "error", controlId);
    }
  }

  const subjectRecords = Array.isArray(input.subjects) ? input.subjects : [];
  if (!Array.isArray(input.subjects)) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "subjects", "Subjects must be an array.");
  } else if (input.subjects.length > DIRECTOR_LIMITS.maxSubjects) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.subjectLimit,
      "subjects",
      `A Director Plan supports at most ${DIRECTOR_LIMITS.maxSubjects} subjects.`,
    );
  }
  const subjectIds = new Set<string>();
  subjectRecords.forEach((value, index) => {
    const path = `subjects[${index}]`;
    if (!isRecord(value)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, path, "Subject must be an object.");
      return;
    }
    const controlId = validateControlId(value.id, `${path}.id`, issues, seenIds) ? value.id : undefined;
    if (controlId) subjectIds.add(controlId);
    if (!isNonEmptyString(value.label)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.label`, "Subject label must be a non-empty string.", "error", controlId);
    }
    if (!isNonEmptyString(value.sourceAssetId)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.sourceAssetId`, "Subject source asset ID is required.", "error", controlId);
    }
    validateRegion(value.region, `${path}.region`, issues, controlId);
  });

  if (cameraRig && typeof cameraRig.focusSubjectId === "string" && !subjectIds.has(cameraRig.focusSubjectId)) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.focusSubjectMissing,
      "cameraRig.focusSubjectId",
      "Camera focus target does not reference a subject in this plan.",
      "error",
      typeof cameraRig.id === "string" ? cameraRig.id : undefined,
    );
  }

  const motionRecords = Array.isArray(input.motions) ? input.motions : [];
  if (!Array.isArray(input.motions)) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "motions", "Motions must be an array.");
  }
  const motionsById = new Map<string, DirectorMotion>();
  motionRecords.forEach((value, index) => {
    const path = `motions[${index}]`;
    if (!isRecord(value)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, path, "Motion must be an object.");
      return;
    }
    const controlId = validateControlId(value.id, `${path}.id`, issues, seenIds) ? value.id : undefined;
    if (value.targetType !== "subject" && value.targetType !== "camera") {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.targetType`, "Motion target must be subject or camera.", "error", controlId);
    }
    if (!includes(MOTION_KINDS, value.kind)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.kind`, "Motion kind is invalid.", "error", controlId);
    }
    if (value.direction !== undefined && !includes(DIRECTIONS, value.direction)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.direction`, "Motion direction is invalid.", "error", controlId);
    }
    if (!isNormalizedNumber(value.intensity)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.intensity`, "Motion intensity must be from 0 through 1.", "error", controlId);
    }
    if (!isNormalizedNumber(value.start) || !isNormalizedNumber(value.end) || value.start >= value.end) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidMotionTime, path, "Motion start and end must define an increasing range from 0 through 1.", "error", controlId);
    }
    if (!includes(EASINGS, value.easing)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.easing`, "Motion easing is invalid.", "error", controlId);
    }
    if (value.order !== 1 && value.order !== 2 && value.order !== 3) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.order`, "Motion action order must be 1, 2, or 3.", "error", controlId);
    }
    if (value.actionLabel !== undefined && typeof value.actionLabel !== "string") {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.actionLabel`, "Motion action label must be text.", "error", controlId);
    }
    if (value.path !== undefined) {
      if (!Array.isArray(value.path)) {
        addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.path`, "Motion path must be an array.", "error", controlId);
      } else {
        if (value.path.length > DIRECTOR_LIMITS.maxPathPoints) {
          addIssue(
            issues,
            DIRECTOR_VALIDATION_CODES.pathPointLimit,
            `${path}.path`,
            `A motion path supports at most ${DIRECTOR_LIMITS.maxPathPoints} points.`,
            "error",
            controlId,
          );
        }
        value.path.forEach((point, pointIndex) => validateNormalizedPoint(point, `${path}.path[${pointIndex}]`, issues, controlId));
      }
    }
    if (value.targetType === "subject") {
      if (!isNonEmptyString(value.targetId) || !subjectIds.has(value.targetId)) {
        addIssue(issues, DIRECTOR_VALIDATION_CODES.missingMotionTarget, `${path}.targetId`, "Subject motion must reference a subject in this plan.", "error", controlId);
      }
      if (includes(MOTION_KINDS, value.kind)
        && !["translate", "depth_in", "depth_out", "static"].includes(value.kind)) {
        addIssue(issues, DIRECTOR_VALIDATION_CODES.incompatibleMotionTarget, `${path}.kind`, "This motion kind can only target the camera.", "error", controlId);
      }
    } else if (value.targetType === "camera") {
      if (value.targetId !== undefined) {
        addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.targetId`, "Camera motion must not have a subject target ID.", "error", controlId);
      }
      if (value.kind === "depth_in" || value.kind === "depth_out") {
        addIssue(issues, DIRECTOR_VALIDATION_CODES.incompatibleMotionTarget, `${path}.kind`, "Depth motion must target a subject.", "error", controlId);
      }
    }
    if (controlId
      && (value.targetType === "subject" || value.targetType === "camera")
      && includes(MOTION_KINDS, value.kind)
      && isNormalizedNumber(value.intensity)
      && isNormalizedNumber(value.start)
      && isNormalizedNumber(value.end)
      && includes(EASINGS, value.easing)
      && (value.order === 1 || value.order === 2 || value.order === 3)) {
      motionsById.set(controlId, value as DirectorMotion);
    }
  });

  const keyframeRecords = Array.isArray(input.keyframes) ? input.keyframes : [];
  if (!Array.isArray(input.keyframes)) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "keyframes", "Keyframes must be an array.");
  }
  const keyframeLimit = Math.min(
    DIRECTOR_LIMITS.maxKeyframes,
    options.maxKeyframes === undefined
      ? DIRECTOR_LIMITS.maxKeyframes
      : Math.max(0, Math.floor(options.maxKeyframes)),
  );
  if (keyframeRecords.length > keyframeLimit) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.keyframeLimit, "keyframes", `The current Director configuration supports at most ${keyframeLimit} keyframes.`);
  }
  const keyframeIds = new Set<string>();
  const globalFrameBindings = new Map<"first" | "last", { assetId: string; path: string }>();
  keyframeRecords.forEach((value, index) => {
    const path = `keyframes[${index}]`;
    if (!isRecord(value)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, path, "Keyframe must be an object.");
      return;
    }
    const controlId = validateControlId(value.id, `${path}.id`, issues, seenIds) ? value.id : undefined;
    if (controlId) keyframeIds.add(controlId);
    if (!isNonEmptyString(value.assetId)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.assetId`, "Keyframe asset ID is required.", "error", controlId);
    }
    if (!includes(KEYFRAME_ROLES, value.role)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.role`, "Keyframe role is invalid.", "error", controlId);
    }
    if (!isNormalizedNumber(value.time)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.time`, "Keyframe time must be from 0 through 1.", "error", controlId);
    } else if ((value.role === "first" && value.time !== 0) || (value.role === "last" && value.time !== 1)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.time`, "First keyframes use time 0 and last keyframes use time 1.", "error", controlId);
    }
    if ((value.role === "first" || value.role === "last") && typeof value.assetId === "string") {
      const prior = globalFrameBindings.get(value.role);
      if (prior && prior.assetId !== value.assetId) {
        addIssue(
          issues,
          DIRECTOR_VALIDATION_CODES.keyframeRoleConflict,
          `${path}.assetId`,
          `Director Plan cannot bind different assets to the ${value.role} frame role.`,
          "error",
          controlId,
        );
      } else if (prior) {
        addIssue(
          issues,
          DIRECTOR_VALIDATION_CODES.duplicateKeyframeBinding,
          `${path}.assetId`,
          `The same ${value.role} frame binding is duplicated and will be sent once.`,
          "warning",
          controlId,
        );
      } else if (!prior) {
        globalFrameBindings.set(value.role, { assetId: value.assetId, path });
      }
    }
  });

  const shotRecords = Array.isArray(input.shots) ? input.shots : [];
  if (!Array.isArray(input.shots)) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, "shots", "Shots must be an array.");
  } else if (input.shots.length > DIRECTOR_LIMITS.maxShots) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.shotLimit, "shots", `A Director Plan supports at most ${DIRECTOR_LIMITS.maxShots} shots.`);
  }
  const referencedMotionIds = new Set<string>();
  const referencedKeyframeIds = new Set<string>();
  const motionShotAssignments = new Map<string, string>();
  const keyframeShotAssignments = new Map<string, string>();
  const shotOrders = new Set<number>();
  let totalDuration = 0;
  shotRecords.forEach((value, index) => {
    const path = `shots[${index}]`;
    if (!isRecord(value)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, path, "Shot must be an object.");
      return;
    }
    const controlId = validateControlId(value.id, `${path}.id`, issues, seenIds) ? value.id : undefined;
    if (!Number.isInteger(value.order) || (value.order as number) < 1) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.order`, "Shot order must be a positive integer.", "error", controlId);
    } else if (shotOrders.has(value.order as number)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.duplicateShotOrder, `${path}.order`, "Shot order values must be unique.", "error", controlId);
    } else {
      shotOrders.add(value.order as number);
    }
    if (!isFiniteNumber(value.durationSeconds) || value.durationSeconds <= 0) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidShotDuration, `${path}.durationSeconds`, "Shot duration must be a positive finite number.", "error", controlId);
    } else {
      totalDuration += value.durationSeconds;
    }
    if (typeof value.promptFragment !== "string") {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.promptFragment`, "Shot prompt fragment must be text.", "error", controlId);
    }
    if (!includes(SHOT_SPEEDS, value.speed)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.speed`, "Shot speed is invalid.", "error", controlId);
    }
    const motionIds = isStringArray(value.motionIds) ? value.motionIds : [];
    if (!isStringArray(value.motionIds)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.motionIds`, "Shot motion IDs must be an array of strings.", "error", controlId);
    }
    validateUniqueReferences(motionIds, `${path}.motionIds`, issues, controlId ?? "");
    const cameraMotions: DirectorMotion[] = [];
    motionIds.forEach((motionId, motionIndex) => {
      const motion = motionsById.get(motionId);
      if (!motion) {
        addIssue(issues, DIRECTOR_VALIDATION_CODES.missingMotionReference, `${path}.motionIds[${motionIndex}]`, "Shot references a motion that is not in this plan.", "error", controlId);
      } else {
        const priorShot = motionShotAssignments.get(motionId);
        if (priorShot && priorShot !== controlId) {
          addIssue(issues, DIRECTOR_VALIDATION_CODES.multipleShotAssignment, `${path}.motionIds[${motionIndex}]`, "A motion can belong to only one shot.", "error", motionId);
        } else if (controlId) {
          motionShotAssignments.set(motionId, controlId);
        }
        referencedMotionIds.add(motionId);
        if (motion.targetType === "camera") cameraMotions.push(motion);
      }
    });
    if (cameraMotions.length > DIRECTOR_LIMITS.maxCameraMovesPerShot) {
      addIssue(
        issues,
        DIRECTOR_VALIDATION_CODES.cameraMoveLimit,
        `${path}.motionIds`,
        `A shot supports at most ${DIRECTOR_LIMITS.maxCameraMovesPerShot} camera moves.`,
        "error",
        controlId,
      );
    }
    for (let first = 0; first < cameraMotions.length; first += 1) {
      for (let second = first + 1; second < cameraMotions.length; second += 1) {
        const a = cameraMotions[first];
        const b = cameraMotions[second];
        if (intervalsOverlap(a, b) && (a.kind === "static" || b.kind === "static") && a.kind !== b.kind) {
          addIssue(
            issues,
            DIRECTOR_VALIDATION_CODES.staticCameraConflict,
            `${path}.motionIds`,
            "Static camera cannot overlap another camera move in the same shot.",
            "error",
            controlId,
          );
        }
        const opposingDirections: Partial<Record<DirectorDirection, DirectorDirection>> = {
          left: "right", right: "left", up: "down", down: "up", in: "out", out: "in",
        };
        if (intervalsOverlap(a, b)
          && a.kind === b.kind
          && a.direction
          && b.direction === opposingDirections[a.direction]) {
          addIssue(
            issues,
            DIRECTOR_VALIDATION_CODES.opposingCameraConflict,
            `${path}.motionIds`,
            `Overlapping ${a.kind.replaceAll("_", " ")} moves use opposing directions in the same shot. Review this Motion Stack combination.`,
            "warning",
            controlId,
          );
        }
      }
    }

    const shotKeyframeIds = isStringArray(value.keyframeIds) ? value.keyframeIds : [];
    if (!isStringArray(value.keyframeIds)) {
      addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidField, `${path}.keyframeIds`, "Shot keyframe IDs must be an array of strings.", "error", controlId);
    }
    validateUniqueReferences(shotKeyframeIds, `${path}.keyframeIds`, issues, controlId ?? "");
    shotKeyframeIds.forEach((keyframeId, keyframeIndex) => {
      const keyframeIndexInPlan = keyframeRecords.findIndex((candidate) => isRecord(candidate) && candidate.id === keyframeId);
      const keyframe = keyframeIndexInPlan >= 0 ? keyframeRecords[keyframeIndexInPlan] : undefined;
      if (!isRecord(keyframe) || !keyframeIds.has(keyframeId)) {
        addIssue(issues, DIRECTOR_VALIDATION_CODES.missingKeyframeReference, `${path}.keyframeIds[${keyframeIndex}]`, "Shot references a keyframe that is not in this plan.", "error", controlId);
        return;
      }
      const priorShot = keyframeShotAssignments.get(keyframeId);
      if (priorShot && priorShot !== controlId) {
        addIssue(issues, DIRECTOR_VALIDATION_CODES.multipleShotAssignment, `${path}.keyframeIds[${keyframeIndex}]`, "A keyframe can belong to only one shot.", "error", keyframeId);
      } else if (controlId) {
        keyframeShotAssignments.set(keyframeId, controlId);
      }
      referencedKeyframeIds.add(keyframeId);
    });
  });

  const expectedOrders = Array.from({ length: shotRecords.length }, (_, index) => index + 1);
  if (shotOrders.size === shotRecords.length
    && expectedOrders.some((order) => !shotOrders.has(order))) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.nonSequentialShotOrder,
      "shots",
      "Shot order has gaps. Playback will still sort shots by their order values.",
      "warning",
    );
  }
  if (options.maxDurationSeconds !== undefined
    && isFiniteNumber(options.maxDurationSeconds)
    && options.maxDurationSeconds >= 0
    && totalDuration > options.maxDurationSeconds) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.totalDurationLimit,
      "shots",
      `Total shot duration ${totalDuration} seconds exceeds the model limit of ${options.maxDurationSeconds} seconds.`,
    );
  }

  motionsById.forEach((motion, id) => {
    if (!referencedMotionIds.has(id)) {
      addIssue(
        issues,
        DIRECTOR_VALIDATION_CODES.orphanedControl,
        "motions",
        "Motion is not assigned to a shot and will not affect the animatic or request.",
        "warning",
        motion.id,
      );
    }
  });
  keyframeIds.forEach((id) => {
    if (!referencedKeyframeIds.has(id)) {
      addIssue(
        issues,
        DIRECTOR_VALIDATION_CODES.orphanedControl,
        "keyframes",
        "Keyframe is not assigned to a shot and will not affect the animatic or request.",
        "warning",
        id,
      );
    }
  });

  const hasMotionPath = motionRecords.some((motion) => isRecord(motion) && Array.isArray(motion.path) && motion.path.length > 0);
  if ((options.requireSourceAssetForMotionPaths ?? true) && hasMotionPath && !isNonEmptyString(input.sourceAssetId)) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.sourceAssetRequired,
      "sourceAssetId",
      "A source frame asset is required before a motion path can be used.",
    );
  }

  if (options.availableAssetIds && isDirectorPlanShape(input)) {
    issues.push(...validateDirectorAssetReferences(input, options.availableAssetIds));
  }

  const serializedBytes = byteLength(input);
  const maxBytes = options.maxSerializedBytes ?? DIRECTOR_LIMITS.maxSerializedBytes;
  if (serializedBytes === undefined) {
    addIssue(issues, DIRECTOR_VALIDATION_CODES.invalidPlan, "", "Director Plan must be serializable.");
  } else if (serializedBytes > maxBytes) {
    addIssue(
      issues,
      DIRECTOR_VALIDATION_CODES.planTooLarge,
      "",
      `Serialized Director Plan is ${serializedBytes} bytes and exceeds the ${maxBytes} byte limit.`,
    );
  }
  return makeResult(issues);
}

function makeResult(issues: DirectorValidationIssue[]): DirectorValidationResult {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { valid: errors.length === 0, errors, warnings, issues };
}

/** Lightweight structural check used after detailed validation has already reported fields. */
function isDirectorPlanShape(value: Record<string, unknown>): value is unknown & DirectorPlan {
  return value.schemaVersion === DIRECTOR_PLAN_SCHEMA_VERSION
    && typeof value.enabled === "boolean"
    && isRecord(value.cameraRig)
    && Array.isArray(value.subjects)
    && Array.isArray(value.motions)
    && Array.isArray(value.keyframes)
    && Array.isArray(value.shots)
    && typeof value.updatedAt === "string";
}

export function isDirectorPlan(value: unknown): value is DirectorPlan {
  return validateDirectorPlan(value, { requireSourceAssetForMotionPaths: false }).valid;
}

export function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function normalizeDirectorPoint(point: NormalizedPoint): NormalizedPoint {
  return { x: clampNormalized(point.x), y: clampNormalized(point.y) };
}

export function normalizeDirectorRegion(region: DirectorRegion): DirectorRegion {
  if (region.type === "polygon") {
    return { type: "polygon", points: region.points.map(normalizeDirectorPoint) };
  }
  const start = normalizeDirectorPoint({ x: region.x, y: region.y });
  const end = normalizeDirectorPoint({ x: region.x + region.width, y: region.y + region.height });
  return {
    type: "box",
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/**
 * Clamps coordinates, intensities, and shot-relative times without dropping any
 * control. Limit violations remain visible to validation and the UI.
 */
export function normalizeDirectorPlan(plan: DirectorPlan): DirectorPlan {
  return {
    ...plan,
    canvas: plan.canvas
      ? {
          sourceWidth: Math.max(1, Number.isFinite(plan.canvas.sourceWidth) ? plan.canvas.sourceWidth : 1),
          sourceHeight: Math.max(1, Number.isFinite(plan.canvas.sourceHeight) ? plan.canvas.sourceHeight : 1),
        }
      : undefined,
    cameraRig: { ...plan.cameraRig },
    subjects: plan.subjects.map((subject) => ({
      ...subject,
      region: normalizeDirectorRegion(subject.region),
    })),
    motions: plan.motions.map((motion) => {
      const firstTime = clampNormalized(motion.start);
      const secondTime = clampNormalized(motion.end);
      return {
        ...motion,
        intensity: clampNormalized(motion.intensity),
        start: Math.min(firstTime, secondTime),
        end: Math.max(firstTime, secondTime),
        path: motion.path?.map(normalizeDirectorPoint),
      };
    }),
    keyframes: plan.keyframes.map((keyframe) => ({
      ...keyframe,
      time: keyframe.role === "first" ? 0 : keyframe.role === "last" ? 1 : clampNormalized(keyframe.time),
    })),
    shots: plan.shots.map((shot) => ({
      ...shot,
      durationSeconds: Math.max(0, Number.isFinite(shot.durationSeconds) ? shot.durationSeconds : 0),
      motionIds: [...shot.motionIds],
      keyframeIds: [...shot.keyframeIds],
    })),
  };
}
