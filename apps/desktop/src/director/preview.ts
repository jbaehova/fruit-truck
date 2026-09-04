import {
  DIRECTOR_LIMITS,
  type DirectorEasing,
  type DirectorMotion,
  type DirectorPlan,
  type DirectorShot,
  type NormalizedPoint,
} from "./types.ts";

const POINT_EPSILON = 1e-9;

export type ContentBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type DirectorMotionSample = {
  active: boolean;
  progress: number;
  easedProgress: number;
  position?: NormalizedPoint;
};

/** Translation values are normalized viewport fractions, not CSS pixels. */
export type DirectorPreviewTransform = {
  translateX: number;
  translateY: number;
  scale: number;
  rotateDegrees: number;
  opacity: number;
};

export type DirectorSubjectPreview = {
  subjectId: string;
  transform: DirectorPreviewTransform;
};

export type DirectorKeyframeMarker = {
  id: string;
  assetId: string;
  role: "first" | "middle" | "last" | "timestamped";
  normalizedTime: number;
  timeSeconds: number;
};

export type DirectorShotPreview = {
  shotId: string;
  elapsedSeconds: number;
  normalizedTime: number;
  cameraTransform: DirectorPreviewTransform;
  subjects: DirectorSubjectPreview[];
  keyframes: DirectorKeyframeMarker[];
};

export type DirectorAnimaticSample = DirectorShotPreview & {
  totalDurationSeconds: number;
  shotIndex: number;
  shotElapsedSeconds: number;
};

export const IDENTITY_PREVIEW_TRANSFORM: Readonly<DirectorPreviewTransform> = Object.freeze({
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotateDegrees: 0,
  opacity: 1,
});

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampNormalizedPoint(point: NormalizedPoint): NormalizedPoint {
  return { x: clamp01(point.x), y: clamp01(point.y) };
}

/** Returns null for pointer positions in a letterbox or outside the rendered content. */
export function normalizePointToContent(
  point: { x: number; y: number },
  bounds: ContentBounds,
): NormalizedPoint | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const x = (point.x - bounds.left) / bounds.width;
  const y = (point.y - bounds.top) / bounds.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: clamp01(x), y: clamp01(y) };
}

export function pointFromNormalizedContent(
  point: NormalizedPoint,
  bounds: ContentBounds,
): NormalizedPoint {
  const normalized = clampNormalizedPoint(point);
  return {
    x: bounds.left + normalized.x * Math.max(0, bounds.width),
    y: bounds.top + normalized.y * Math.max(0, bounds.height),
  };
}

export function directorPointDistance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function distanceToSegment(
  point: NormalizedPoint,
  start: NormalizedPoint,
  end: NormalizedPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= POINT_EPSILON) return directorPointDistance(point, start);
  const projection = clamp01(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared);
  return directorPointDistance(point, {
    x: start.x + projection * dx,
    y: start.y + projection * dy,
  });
}

function deduplicatePath(points: readonly NormalizedPoint[]): NormalizedPoint[] {
  const result: NormalizedPoint[] = [];
  for (const rawPoint of points) {
    const point = clampNormalizedPoint(rawPoint);
    const previous = result.at(-1);
    if (!previous || directorPointDistance(previous, point) > POINT_EPSILON) result.push(point);
  }
  return result;
}

function rdp(points: readonly NormalizedPoint[], tolerance: number): NormalizedPoint[] {
  if (points.length <= 2) return [...points];
  let farthestIndex = 0;
  let farthestDistance = -1;
  const first = points[0];
  const last = points[points.length - 1];
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = distanceToSegment(points[index], first, last);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthestIndex = index;
    }
  }
  if (farthestDistance <= tolerance) return [first, last];
  const left = rdp(points.slice(0, farthestIndex + 1), tolerance);
  const right = rdp(points.slice(farthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

/**
 * Reduces pointer samples with Ramer-Douglas-Peucker and enforces the persisted
 * 128 point bound without changing the first or last point.
 */
export function simplifyDirectorPath(
  points: readonly NormalizedPoint[],
  tolerance = 0.002,
  maxPoints = DIRECTOR_LIMITS.maxPathPoints,
): NormalizedPoint[] {
  const deduplicated = deduplicatePath(points);
  if (deduplicated.length <= 2) return deduplicated;
  const simplified = rdp(deduplicated, Math.max(0, Number.isFinite(tolerance) ? tolerance : 0));
  const boundedMax = Math.max(2, Math.min(DIRECTOR_LIMITS.maxPathPoints, Math.floor(maxPoints)));
  if (simplified.length <= boundedMax) return simplified;
  return resampleDirectorPath(simplified, boundedMax);
}

function pathArcLengths(points: readonly NormalizedPoint[]): { lengths: number[]; total: number } {
  const lengths = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += directorPointDistance(points[index - 1], points[index]);
    lengths.push(total);
  }
  return { lengths, total };
}

/** Samples a polyline at equal arc-length intervals. */
export function resampleDirectorPath(
  points: readonly NormalizedPoint[],
  sampleCount: number,
): NormalizedPoint[] {
  const path = deduplicatePath(points);
  if (path.length <= 1) return path;
  const count = Math.max(
    2,
    Math.min(DIRECTOR_LIMITS.maxPathPoints, Math.floor(Number.isFinite(sampleCount) ? sampleCount : 2)),
  );
  const { lengths, total } = pathArcLengths(path);
  if (total <= POINT_EPSILON) return [path[0]];

  const result: NormalizedPoint[] = [];
  let segmentIndex = 1;
  for (let index = 0; index < count; index += 1) {
    const targetDistance = (total * index) / (count - 1);
    while (segmentIndex < lengths.length - 1 && lengths[segmentIndex] < targetDistance) {
      segmentIndex += 1;
    }
    const segmentStartDistance = lengths[segmentIndex - 1];
    const segmentLength = lengths[segmentIndex] - segmentStartDistance;
    const amount = segmentLength <= POINT_EPSILON
      ? 0
      : (targetDistance - segmentStartDistance) / segmentLength;
    const start = path[segmentIndex - 1];
    const end = path[segmentIndex];
    result.push({
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
    });
  }
  return result;
}

/** Returns a point on a polyline using arc length, not point-array index. */
export function sampleDirectorPath(
  points: readonly NormalizedPoint[],
  progress: number,
): NormalizedPoint | undefined {
  const path = deduplicatePath(points);
  if (!path.length) return undefined;
  if (path.length === 1) return path[0];
  const { lengths, total } = pathArcLengths(path);
  if (total <= POINT_EPSILON) return path[0];
  const targetDistance = total * clamp01(progress);
  let index = 1;
  while (index < lengths.length - 1 && lengths[index] < targetDistance) index += 1;
  const segmentDistance = lengths[index] - lengths[index - 1];
  const amount = segmentDistance <= POINT_EPSILON
    ? 0
    : (targetDistance - lengths[index - 1]) / segmentDistance;
  return {
    x: path[index - 1].x + (path[index].x - path[index - 1].x) * amount,
    y: path[index - 1].y + (path[index].y - path[index - 1].y) * amount,
  };
}

export function applyDirectorEasing(progress: number, easing: DirectorEasing): number {
  const value = clamp01(progress);
  switch (easing) {
    case "ease_in":
      return value * value;
    case "ease_out":
      return 1 - (1 - value) * (1 - value);
    case "ease_in_out":
      return value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
    case "linear":
    default:
      return value;
  }
}

export function sampleDirectorMotion(
  motion: DirectorMotion,
  normalizedTime: number,
): DirectorMotionSample {
  const time = clamp01(normalizedTime);
  const start = clamp01(Math.min(motion.start, motion.end));
  const end = clamp01(Math.max(motion.start, motion.end));
  const duration = end - start;
  const progress = duration <= POINT_EPSILON ? (time >= end ? 1 : 0) : clamp01((time - start) / duration);
  const easedProgress = applyDirectorEasing(progress, motion.easing);
  const position = motion.path?.length ? sampleDirectorPath(motion.path, easedProgress) : undefined;
  return {
    active: duration > POINT_EPSILON && time >= start && time <= end,
    progress,
    easedProgress,
    ...(position ? { position } : {}),
  };
}

function mutableIdentityTransform(): DirectorPreviewTransform {
  return { ...IDENTITY_PREVIEW_TRANSFORM };
}

function directionSign(motion: DirectorMotion): number {
  return motion.direction === "left" || motion.direction === "up" || motion.direction === "out" ? -1 : 1;
}

function addCameraMotionTransform(
  transform: DirectorPreviewTransform,
  motion: DirectorMotion,
  sample: DirectorMotionSample,
): void {
  const amount = clamp01(motion.intensity) * sample.easedProgress;
  const sign = directionSign(motion);
  switch (motion.kind) {
    case "pan":
    case "truck":
      transform.translateX -= sign * amount * 0.12;
      break;
    case "tilt":
    case "crane":
      transform.translateY -= sign * amount * 0.12;
      break;
    case "dolly":
    case "zoom":
      transform.scale *= motion.direction === "out" ? 1 - amount * 0.18 : 1 + amount * 0.24;
      break;
    case "orbit":
      transform.translateX -= sign * amount * 0.08;
      transform.rotateDegrees += sign * amount * 3;
      break;
    case "roll":
      transform.rotateDegrees += sign * amount * 12;
      break;
    case "handheld": {
      const phase = sample.easedProgress * Math.PI * 12 + motion.order;
      transform.translateX += Math.sin(phase) * amount * 0.008;
      transform.translateY += Math.cos(phase * 1.37) * amount * 0.008;
      transform.rotateDegrees += Math.sin(phase * 0.73) * amount;
      break;
    }
    case "static":
    case "depth_in":
    case "depth_out":
      break;
    case "translate":
      if (sample.position && motion.path?.[0]) {
        transform.translateX -= (sample.position.x - motion.path[0].x) * clamp01(motion.intensity);
        transform.translateY -= (sample.position.y - motion.path[0].y) * clamp01(motion.intensity);
      }
      break;
  }
}

export function computeCameraPreviewTransform(
  motions: readonly DirectorMotion[],
  normalizedTime: number,
): DirectorPreviewTransform {
  const transform = mutableIdentityTransform();
  for (const motion of motions) {
    if (motion.targetType !== "camera") continue;
    addCameraMotionTransform(transform, motion, sampleDirectorMotion(motion, normalizedTime));
  }
  transform.scale = Math.max(0.25, transform.scale);
  return transform;
}

export function computeSubjectPreviewTransform(
  motions: readonly DirectorMotion[],
  subjectId: string,
  normalizedTime: number,
): DirectorPreviewTransform {
  const transform = mutableIdentityTransform();
  for (const motion of motions) {
    if (motion.targetType !== "subject" || motion.targetId !== subjectId) continue;
    const sample = sampleDirectorMotion(motion, normalizedTime);
    const amount = clamp01(motion.intensity) * sample.easedProgress;
    if (sample.position && motion.path?.[0]) {
      transform.translateX += (sample.position.x - motion.path[0].x) * clamp01(motion.intensity);
      transform.translateY += (sample.position.y - motion.path[0].y) * clamp01(motion.intensity);
    } else if (motion.kind === "translate") {
      const sign = directionSign(motion);
      if (motion.direction === "up" || motion.direction === "down") transform.translateY += sign * amount * 0.25;
      else transform.translateX += sign * amount * 0.25;
    }
    if (motion.kind === "depth_in") {
      transform.scale *= 1 + amount * 0.35;
      transform.opacity = Math.min(1, 0.82 + amount * 0.18);
    } else if (motion.kind === "depth_out") {
      transform.scale *= 1 - amount * 0.25;
      transform.opacity = Math.max(0.55, 1 - amount * 0.35);
    }
  }
  transform.scale = Math.max(0.25, transform.scale);
  return transform;
}

export function getDirectorKeyframeMarkers(
  plan: DirectorPlan,
  shot: DirectorShot,
): DirectorKeyframeMarker[] {
  const ids = new Set(shot.keyframeIds);
  return plan.keyframes
    .filter((keyframe) => ids.has(keyframe.id))
    .map((keyframe) => ({
      id: keyframe.id,
      assetId: keyframe.assetId,
      role: keyframe.role,
      normalizedTime: clamp01(keyframe.time),
      timeSeconds: clamp01(keyframe.time) * Math.max(0, shot.durationSeconds),
    }))
    .sort((a, b) => a.normalizedTime - b.normalizedTime);
}

export function sampleDirectorShot(
  plan: DirectorPlan,
  shot: DirectorShot,
  elapsedSeconds: number,
): DirectorShotPreview {
  const duration = Math.max(0, Number.isFinite(shot.durationSeconds) ? shot.durationSeconds : 0);
  const linearTime = duration <= POINT_EPSILON ? 0 : clamp01(elapsedSeconds / duration);
  const normalizedTime = shot.speed === "speed_up"
    ? linearTime * linearTime
    : shot.speed === "slow_motion"
      ? (1 - Math.cos(Math.PI * linearTime)) / 2
      : linearTime;
  const motionIds = new Set(shot.motionIds);
  const motions = plan.motions.filter((motion) => motionIds.has(motion.id));
  return {
    shotId: shot.id,
    elapsedSeconds: Math.min(duration, Math.max(0, elapsedSeconds)),
    normalizedTime,
    cameraTransform: computeCameraPreviewTransform(motions, normalizedTime),
    subjects: plan.subjects.map((subject) => ({
      subjectId: subject.id,
      transform: computeSubjectPreviewTransform(motions, subject.id, normalizedTime),
    })),
    keyframes: getDirectorKeyframeMarkers(plan, shot),
  };
}

export function getDirectorPlanDuration(plan: DirectorPlan): number {
  return plan.shots.reduce(
    (total, shot) => total + Math.max(0, Number.isFinite(shot.durationSeconds) ? shot.durationSeconds : 0),
    0,
  );
}

/** Resolves global animatic time to the ordered shot and returns renderer-ready transforms. */
export function sampleDirectorAnimatic(
  plan: DirectorPlan,
  elapsedSeconds: number,
  options: { loop?: boolean } = {},
): DirectorAnimaticSample | undefined {
  const shots = [...plan.shots].sort((a, b) => a.order - b.order);
  if (!shots.length) return undefined;
  const totalDurationSeconds = getDirectorPlanDuration({ ...plan, shots });
  if (totalDurationSeconds <= POINT_EPSILON) {
    return {
      ...sampleDirectorShot(plan, shots[0], 0),
      totalDurationSeconds,
      shotIndex: 0,
      shotElapsedSeconds: 0,
    };
  }
  const safeElapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const timelineElapsed = options.loop
    ? safeElapsed % totalDurationSeconds
    : Math.min(safeElapsed, totalDurationSeconds);
  let shotStart = 0;
  let shotIndex = shots.length - 1;
  for (let index = 0; index < shots.length; index += 1) {
    const end = shotStart + Math.max(0, shots[index].durationSeconds);
    if (timelineElapsed < end || index === shots.length - 1) {
      shotIndex = index;
      break;
    }
    shotStart = end;
  }
  const shotElapsedSeconds = Math.max(0, timelineElapsed - shotStart);
  return {
    ...sampleDirectorShot(plan, shots[shotIndex], shotElapsedSeconds),
    totalDurationSeconds,
    shotIndex,
    shotElapsedSeconds,
  };
}
