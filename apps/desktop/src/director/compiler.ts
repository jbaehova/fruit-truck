import {
  DIRECTOR_LIMITS,
  listDirectorControls,
  type CompiledDirector,
  type DirectorCapability,
  type DirectorFidelity,
  type DirectorFrameBinding,
  type DirectorKeyframe,
  type DirectorMotion,
  type DirectorPlan,
  type DirectorSubject,
} from "./types.ts";
import {
  validateDirectorPlan,
  type DirectorValidationIssue,
  type DirectorValidationResult,
} from "./validation.ts";
import { sampleDirectorPath } from "./preview.ts";

export type CompileDirectorPlanInput = {
  plan: DirectorPlan;
  capability: DirectorCapability;
  availableAssetIds?: ReadonlySet<string> | readonly string[];
  /** Selected generation duration or the route's maximum accepted duration. */
  durationSeconds?: number;
  /** Explicit alias for callers that know this value is a route limit. */
  maxDurationSeconds?: number;
  basePrompt?: string;
  /** Reviewed prompt profile selected for the target model. */
  promptProfileId?: string;
  /** Existing draft bindings are considered for de-duplication but are not returned. */
  existingFrameBindings?: readonly DirectorFrameBinding[];
  /** Provider capacity for general references. Frame images are counted separately. */
  maxInputReferences?: number;
  /** Whether the selected provider contract accepts frame roles beside general visual references. */
  allowMixedFrameAndReferences?: boolean;
};

export type DirectorCompilationResult = CompiledDirector & {
  validation: DirectorValidationResult;
  blockingIssues: DirectorValidationIssue[];
  canGenerate: boolean;
};

type MutableCompilation = {
  fidelityByControlId: Record<string, DirectorFidelity>;
  providerOptions: Record<string, unknown>;
  frameBindings: DirectorFrameBinding[];
  visualInstructions: Array<{ sourceAssetId: string; overlay: string }>;
  promptLines: string[];
  warnings: string[];
};

type DirectorPromptVocabulary = {
  cameraRig: string;
  cameraTarget: string;
  cameraGroup: string;
};

function promptVocabulary(profileId: string | undefined): DirectorPromptVocabulary {
  if (profileId === "runway-video-v1") return { cameraRig: "Cinematography", cameraTarget: "Camera movement", cameraGroup: "camera movements" };
  if (profileId === "google-veo-video-v1") return { cameraRig: "Camera and lens", cameraTarget: "Camera choreography", cameraGroup: "camera moves" };
  if (profileId === "bytedance-seedance-video-v1") return { cameraRig: "Camera language", cameraTarget: "Camera motion", cameraGroup: "camera motions" };
  return { cameraRig: "Camera rig", cameraTarget: "Camera", cameraGroup: "camera motions" };
}

const RIG_PARAMETER_CANDIDATES = {
  sensorPreset: ["sensor_preset", "sensor"],
  lensPreset: ["lens_preset", "lens"],
  focalLengthMm: ["focal_length_mm", "focal_length"],
  aperture: ["aperture"],
  focusSubjectId: ["focus_subject_id", "focus_subject"],
  aspectRatio: ["aspect_ratio"],
} as const;

const CAMERA_MOTION_KINDS = new Set([
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
]);

function setFidelity(output: MutableCompilation, controlId: string, fidelity: DirectorFidelity): void {
  output.fidelityByControlId[controlId] = fidelity;
}

function availableParameter(capability: DirectorCapability, candidates: readonly string[]): string | undefined {
  return candidates.find((name) => capability.cameraParameters.has(name) || capability.allowedPassthroughParameters.has(name));
}

function compatibleScalarValue(
  capability: DirectorCapability,
  name: string,
  value: unknown,
): unknown | undefined {
  const descriptor = capability.parameterDescriptors?.[name];
  if (!descriptor) return capability.allowedPassthroughParameters.has(name) ? value : undefined;
  if (descriptor.type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (descriptor.type === "range") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (descriptor.min !== undefined && value < descriptor.min) return undefined;
    if (descriptor.max !== undefined && value > descriptor.max) return undefined;
    return value;
  }
  return descriptor.values?.some((candidate) => candidate === value) ? value : undefined;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function directionText(motion: DirectorMotion): string {
  return motion.direction ? ` ${motion.direction.replaceAll("_", " ")}` : "";
}

function timingText(motion: DirectorMotion): string {
  return `${percent(motion.start)} to ${percent(motion.end)}`;
}

function motionLabel(motion: DirectorMotion): string {
  return motion.actionLabel?.trim() || `${motion.kind.replaceAll("_", " ")}${directionText(motion)}`;
}

function controlLabel(plan: DirectorPlan, controlId: string): string {
  if (controlId === plan.cameraRig.id) return "Camera rig";
  const subject = plan.subjects.find((candidate) => candidate.id === controlId);
  if (subject) return `Subject ${subject.label}`;
  const motion = plan.motions.find((candidate) => candidate.id === controlId);
  if (motion) return `${motion.targetType === "camera" ? "Camera" : "Object"} motion ${motion.order} (${motionLabel(motion)})`;
  const keyframe = plan.keyframes.find((candidate) => candidate.id === controlId);
  if (keyframe) return `${keyframe.role.replaceAll("_", " ")} keyframe`;
  const shot = plan.shots.find((candidate) => candidate.id === controlId);
  if (shot) return `Shot ${shot.order}`;
  return "Director control";
}

function cameraParameterCandidates(motion: DirectorMotion): string[] {
  const direction = motion.direction;
  return [
    direction ? `camera_${motion.kind}_${direction}` : "",
    direction ? `${motion.kind}_${direction}` : "",
    `camera_${motion.kind}`,
    motion.kind,
    "camera_motion",
    "camera_control",
  ].filter(Boolean);
}

function normalizedOptionName(value: string | number): string {
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function cameraMotionNativeOption(
  capability: DirectorCapability,
  motion: DirectorMotion,
): { name: string; value: unknown } | undefined {
  const desired = motion.direction ? `${motion.kind}_${motion.direction}` : motion.kind;
  for (const name of cameraParameterCandidates(motion)) {
    if (!capability.cameraParameters.has(name) && !capability.allowedPassthroughParameters.has(name)) continue;
    const descriptor = capability.parameterDescriptors?.[name];
    if (!descriptor) continue;
    if (descriptor.type === "boolean" && normalizedOptionName(name) === normalizedOptionName(desired)) {
      return { name, value: true };
    }
    if (descriptor.type !== "enum") continue;
    const match = descriptor.values?.find((candidate) => normalizedOptionName(candidate) === normalizedOptionName(desired));
    if (match !== undefined) return { name, value: match };
  }
  return undefined;
}

function compactPathText(path: readonly { x: number; y: number }[]): string {
  if (!path.length) return "";
  const indexes = [...new Set([0, Math.floor((path.length - 1) / 2), path.length - 1])];
  return indexes
    .map((index) => path[index]!)
    .map((point) => `(${point.x.toFixed(2)}, ${point.y.toFixed(2)})`)
    .join(" to ");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function subjectForMotion(plan: DirectorPlan, motion: DirectorMotion): DirectorSubject | undefined {
  return motion.targetType === "subject" ? plan.subjects.find((subject) => subject.id === motion.targetId) : undefined;
}

function sourceAssetForMotion(plan: DirectorPlan, motion: DirectorMotion): string | undefined {
  return subjectForMotion(plan, motion)?.sourceAssetId ?? plan.sourceAssetId;
}

function regionSvg(subject: DirectorSubject): string {
  if (subject.region.type === "box") {
    return `<rect x="${subject.region.x * 1000}" y="${subject.region.y * 1000}" width="${subject.region.width * 1000}" height="${subject.region.height * 1000}" fill="none" stroke="#42f5b6" stroke-width="8" />`;
  }
  const points = subject.region.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ");
  return `<polygon points="${points}" fill="none" stroke="#42f5b6" stroke-width="8" />`;
}

function overlayForMotions(plan: DirectorPlan, motions: DirectorMotion[], shotOrder: number | undefined): string {
  const subjectIds = new Set(motions.map((motion) => motion.targetId).filter((id): id is string => Boolean(id)));
  const regions = plan.subjects
    .filter((subject) => subjectIds.has(subject.id))
    .map((subject) => `${regionSvg(subject)}<text x="24" y="${50 + plan.subjects.indexOf(subject) * 34}" fill="#42f5b6" font-size="26">${escapeXml(subject.label)}</text>`);
  const paths = motions.flatMap((motion) => {
    if (!motion.path?.length) return [];
    const points = motion.path.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ");
    const shotPrefix = shotOrder === undefined ? "" : `Shot ${shotOrder}, `;
    return [`<polyline points="${points}" fill="none" stroke="#ffb347" stroke-width="10" marker-end="url(#arrow)" /><text x="24" y="${900 + motion.order * 28}" fill="#ffb347" font-size="24">${escapeXml(`${shotPrefix}${motion.order}. ${motionLabel(motion)}`)}</text>`];
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ffb347" /></marker></defs>${[...regions, ...paths].join("")}</svg>`;
}

function roleForKeyframe(keyframe: DirectorKeyframe): DirectorFrameBinding["role"] {
  return keyframe.role === "first" ? "first_frame" : keyframe.role === "last" ? "last_frame" : "reference";
}

function timestampForKeyframe(plan: DirectorPlan, keyframe: DirectorKeyframe, fallbackDuration: number | undefined): number | undefined {
  if (keyframe.role === "first" || keyframe.role === "last") return undefined;
  let elapsed = 0;
  for (const shot of [...plan.shots].sort((left, right) => left.order - right.order)) {
    if (shot.keyframeIds.includes(keyframe.id)) return elapsed + shot.durationSeconds * keyframe.time;
    elapsed += shot.durationSeconds;
  }
  const duration = fallbackDuration ?? elapsed;
  return duration > 0 ? duration * keyframe.time : undefined;
}

function bindingKey(binding: DirectorFrameBinding): string {
  const timestamp = binding.timestampSeconds == null ? "" : binding.timestampSeconds.toFixed(6);
  return `${binding.assetId}\u0000${binding.role}\u0000${timestamp}`;
}

function compileCameraRig(plan: DirectorPlan, output: MutableCompilation, capability: DirectorCapability, vocabulary: DirectorPromptVocabulary): void {
  const rig = plan.cameraRig;
  const fallback: string[] = [];
  let nativeCount = 0;
  const compileField = (field: keyof typeof RIG_PARAMETER_CANDIDATES, value: unknown, fallbackText: string | undefined) => {
    if (value === undefined) return;
    const key = `cameraRig.${field}`;
    const parameter = availableParameter(capability, RIG_PARAMETER_CANDIDATES[field]);
    const nativeValue = parameter ? compatibleScalarValue(capability, parameter, value) : undefined;
    if (parameter && nativeValue !== undefined && output.providerOptions[parameter] === undefined) {
      output.providerOptions[parameter] = nativeValue;
      setFidelity(output, key, "native");
      nativeCount += 1;
    } else if (fallbackText) {
      fallback.push(fallbackText);
      setFidelity(output, key, "prompt");
    } else {
      setFidelity(output, key, "unsupported");
    }
  };

  compileField("sensorPreset", rig.sensorPreset === "neutral" ? undefined : rig.sensorPreset, rig.sensorPreset === "neutral" ? undefined : `${rig.sensorPreset.replaceAll("_", " ")} sensor look`);
  compileField("lensPreset", rig.lensPreset === "neutral" ? undefined : rig.lensPreset, rig.lensPreset === "neutral" ? undefined : `${rig.lensPreset.replaceAll("_", " ")} lens character`);
  compileField("focalLengthMm", rig.focalLengthMm, rig.focalLengthMm == null ? undefined : `${rig.focalLengthMm}mm focal-length feel`);
  compileField("aperture", rig.aperture, rig.aperture == null ? undefined : `f/${rig.aperture} depth-of-field feel`);
  const focusLabel = rig.focusSubjectId ? plan.subjects.find((subject) => subject.id === rig.focusSubjectId)?.label ?? rig.focusSubjectId : undefined;
  compileField("focusSubjectId", rig.focusSubjectId, focusLabel ? `focus on ${focusLabel}` : undefined);
  compileField("aspectRatio", rig.aspectRatio, rig.aspectRatio ? `${rig.aspectRatio} framing` : undefined);
  if (fallback.length) {
    output.promptLines.push(`${vocabulary.cameraRig}: ${fallback.join(", ")}. Treat these as visual intent, not exact physical camera simulation.`);
  }
  const fieldFidelities = Object.entries(output.fidelityByControlId)
    .filter(([id]) => id.startsWith("cameraRig."))
    .map(([, fidelity]) => fidelity);
  setFidelity(output, rig.id, fallback.length ? "prompt" : nativeCount ? "native" : fieldFidelities[0] ?? "unsupported");
}

function compileKeyframes(
  plan: DirectorPlan,
  output: MutableCompilation,
  capability: DirectorCapability,
  fallbackDuration: number | undefined,
  existingBindings: readonly DirectorFrameBinding[],
): Set<string> {
  const seen = new Set(existingBindings.map(bindingKey));
  const boundIds = new Set<string>();
  let used = 0;
  const assignedKeyframeIds = new Set(plan.shots.flatMap((shot) => shot.keyframeIds));
  for (const keyframe of plan.keyframes
    .filter((candidate) => assignedKeyframeIds.has(candidate.id))
    .toSorted((left, right) => left.time - right.time)) {
    const supported = keyframe.role === "first"
      ? capability.supportsFirstFrame
      : keyframe.role === "last"
        ? capability.supportsLastFrame
        : capability.supportsTimestampedKeyframes;
    if (!supported || used >= capability.maxKeyframes) {
      setFidelity(output, keyframe.id, "unsupported");
      output.warnings.push(`${controlLabel(plan, keyframe.id)} remains in the plan but is unsupported by the selected capability contract.`);
      continue;
    }
    const binding: DirectorFrameBinding = {
      assetId: keyframe.assetId,
      role: roleForKeyframe(keyframe),
      ...(timestampForKeyframe(plan, keyframe, fallbackDuration) == null
        ? {}
        : { timestampSeconds: timestampForKeyframe(plan, keyframe, fallbackDuration) }),
    };
    const key = bindingKey(binding);
    if (!seen.has(key)) {
      output.frameBindings.push(binding);
      seen.add(key);
    }
    used += 1;
    boundIds.add(keyframe.id);
    setFidelity(output, keyframe.id, "keyframe");
  }
  return boundIds;
}

function compileMotions(
  plan: DirectorPlan,
  output: MutableCompilation,
  capability: DirectorCapability,
  boundKeyframes: Set<string>,
  existingBindings: readonly DirectorFrameBinding[],
  maxInputReferences: number | undefined,
  allowMixedFrameAndReferences: boolean,
  vocabulary: DirectorPromptVocabulary,
): void {
  const shotIdByMotionId = new Map<string, string>();
  const shotOrderById = new Map<string, number>();
  for (const shot of [...plan.shots].sort((left, right) => left.order - right.order)) {
    shotOrderById.set(shot.id, shot.order);
    for (const motionId of shot.motionIds) {
      if (!shotIdByMotionId.has(motionId)) shotIdByMotionId.set(motionId, shot.id);
    }
  }
  const visualGroups = new Map<string, { sourceAssetId: string; shotId: string; motions: DirectorMotion[] }>();
  const promptMotions: DirectorMotion[] = [];
  const keyframeAnchorPlan = (motion: DirectorMotion) => {
    if (!motion.path?.length) return undefined;
    const orderedShots = [...plan.shots].sort((left, right) => left.order - right.order);
    const shot = orderedShots.find((candidate) => candidate.motionIds.includes(motion.id));
    if (!shot) return undefined;
    const keyframes = plan.keyframes
      .filter((keyframe) => shot.keyframeIds.includes(keyframe.id) && boundKeyframes.has(keyframe.id))
      .toSorted((left, right) => left.time - right.time);
    const start = keyframes.filter((keyframe) => keyframe.time <= motion.start).at(-1);
    const end = keyframes.find((keyframe) => keyframe.time >= motion.end);
    const middle = keyframes
      .filter((keyframe) => keyframe.time > motion.start && keyframe.time < motion.end)
      .toSorted((left, right) => Math.abs(left.time - (motion.start + motion.end) / 2)
        - Math.abs(right.time - (motion.start + motion.end) / 2))[0];
    if (!start || !middle || !end) return undefined;
    const shotStartSeconds = orderedShots
      .slice(0, orderedShots.indexOf(shot))
      .reduce((total, candidate) => total + candidate.durationSeconds, 0);
    const anchor = (
      position: "start" | "middle" | "end",
      keyframe: DirectorKeyframe,
      progress: number,
    ) => ({
      position,
      keyframeId: keyframe.id,
      timestampSeconds: shotStartSeconds + shot.durationSeconds * keyframe.time,
      point: sampleDirectorPath(motion.path!, progress)!,
    });
    const middleProgress = (middle.time - motion.start) / (motion.end - motion.start);
    return {
      shotId: shot.id,
      anchors: [
        anchor("start", start, 0),
        anchor("middle", middle, middleProgress),
        anchor("end", end, 1),
      ],
    };
  };

  const assignedMotionIds = new Set(plan.shots.flatMap((shot) => shot.motionIds));
  const hasFrameBindings = [...existingBindings, ...output.frameBindings]
    .some((binding) => binding.role === "first_frame" || binding.role === "last_frame");
  const visualTransportCompatible = !hasFrameBindings || allowMixedFrameAndReferences;
  for (const motion of plan.motions
    .filter((candidate) => assignedMotionIds.has(candidate.id))
    .toSorted((left, right) => left.order - right.order || left.start - right.start)) {
    if (motion.path?.length && capability.supportsNativeTrajectory) {
      output.warnings.push(`Native trajectory support was declared for ${controlLabel(plan, motion.id)}, but no structured path payload contract was provided. A verified fallback is used instead.`);
    }

    if (motion.targetType === "camera" && CAMERA_MOTION_KINDS.has(motion.kind)) {
      const nativeOption = cameraMotionNativeOption(capability, motion);
      if (nativeOption && output.providerOptions[nativeOption.name] === undefined) {
        output.providerOptions[nativeOption.name] = nativeOption.value;
        setFidelity(output, motion.id, "native");
        continue;
      }
    }

    const anchorPlan = capability.supportsTimestampedKeyframes ? keyframeAnchorPlan(motion) : undefined;
    if (anchorPlan) {
      setFidelity(output, motion.id, "keyframe");
      output.warnings.push(`${controlLabel(plan, motion.id)} is represented by start, middle, and end keyframe anchors linked to its shot; exact path adherence is not guaranteed.`);
      const shotOrder = shotOrderById.get(anchorPlan.shotId);
      output.promptLines.push(`${shotOrder === undefined ? "" : `Shot ${shotOrder} `}keyframe path anchor plan for ${controlLabel(plan, motion.id)}: ${anchorPlan.anchors.map((anchor) => `${anchor.position} frame ${anchor.keyframeId} at ${anchor.timestampSeconds.toFixed(2)}s maps to (${anchor.point.x.toFixed(2)}, ${anchor.point.y.toFixed(2)})`).join("; ")}. Follow the three anchors in order while preserving the drawn path intent.`);
      continue;
    }

    const sourceAssetId = sourceAssetForMotion(plan, motion);
    if (motion.path?.length && capability.supportsVisualInstruction && sourceAssetId && visualTransportCompatible) {
      const shotId = shotIdByMotionId.get(motion.id) ?? "__unassigned__";
      const key = `${sourceAssetId}\u0000${shotId}`;
      const group = visualGroups.get(key) ?? { sourceAssetId, shotId, motions: [] };
      group.motions.push(motion);
      visualGroups.set(key, group);
      continue;
    }

    if (motion.path?.length && capability.supportsVisualInstruction && sourceAssetId && !visualTransportCompatible) {
      output.warnings.push(`Visual instruction fallback for ${controlLabel(plan, motion.id)} cannot be combined with first-frame or last-frame inputs on the selected route, so prompt guidance is used.`);
    }

    promptMotions.push(motion);
    setFidelity(output, motion.id, "prompt");
  }

  let remainingVisualSlots = maxInputReferences === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, maxInputReferences
      - existingBindings.filter((binding) => binding.role === "reference").length
      - output.frameBindings.filter((binding) => binding.role === "reference").length);
  const alreadyAttachedAssetIds = new Set([
    ...existingBindings.map((binding) => binding.assetId),
    ...output.frameBindings.map((binding) => binding.assetId),
  ]);
  for (const { sourceAssetId, shotId, motions } of visualGroups.values()) {
    const requiredSlots = 1 + Number(!alreadyAttachedAssetIds.has(sourceAssetId));
    if (requiredSlots > remainingVisualSlots) {
      promptMotions.push(...motions);
      motions.forEach((motion) => setFidelity(output, motion.id, "prompt"));
      output.warnings.push(`Visual instruction fallback for ${motions.map((motion) => controlLabel(plan, motion.id)).join("; ")} exceeds the selected route's attachment capacity, so prompt guidance is used.`);
      continue;
    }
    remainingVisualSlots -= requiredSlots;
    alreadyAttachedAssetIds.add(sourceAssetId);
    const shotOrder = shotOrderById.get(shotId);
    output.visualInstructions.push({ sourceAssetId, overlay: overlayForMotions(plan, motions, shotOrder) });
    output.promptLines.push(`Visual motion guide${shotOrder === undefined ? "" : ` for Shot ${shotOrder}`}: follow the labeled regions and numbered arrows in the attached Director guide paired with its original source image.`);
    for (const motion of motions) {
      setFidelity(output, motion.id, "visual");
      const subject = subjectForMotion(plan, motion);
      if (subject) setFidelity(output, subject.id, "visual");
    }
  }

  const cameraGroups: Array<{ shotId: string; motions: DirectorMotion[] }> = [];
  for (const motion of promptMotions.filter((item) => item.targetType === "camera")) {
    const shotId = shotIdByMotionId.get(motion.id) ?? "__unassigned__";
    const overlappingIndexes = cameraGroups.flatMap((group, index) =>
      group.shotId === shotId
      && group.motions.every((candidate) => candidate.start < motion.end && motion.start < candidate.end)
        ? [index]
        : []);
    if (!overlappingIndexes.length) {
      cameraGroups.push({ shotId, motions: [motion] });
      continue;
    }
    const merged = [motion, ...overlappingIndexes.flatMap((index) => cameraGroups[index]!.motions)];
    for (const index of [...overlappingIndexes].sort((left, right) => right - left)) cameraGroups.splice(index, 1);
    cameraGroups.push({ shotId, motions: merged });
  }
  const consumed = new Set<string>();
  for (const { motions } of cameraGroups) {
    if (motions.length < 2) continue;
    motions.forEach((motion) => consumed.add(motion.id));
    const overlapStart = Math.max(...motions.map((motion) => motion.start));
    const overlapEnd = Math.min(...motions.map((motion) => motion.end));
    const shotOrder = shotOrderById.get(shotIdByMotionId.get(motions[0].id) ?? "");
    const shotPrefix = shotOrder === undefined ? "" : `Shot ${shotOrder} `;
    output.promptLines.push(`${shotPrefix}${vocabulary.cameraGroup} overlap from ${percent(overlapStart)} to ${percent(overlapEnd)}: ${motions.map(motionLabel).join(" and ")} simultaneously, with ${motions.map((motion) => `${motion.easing.replaceAll("_", " ")} easing at intensity ${motion.intensity}`).join(" and ")}.`);
  }
  for (const motion of promptMotions) {
    if (consumed.has(motion.id)) continue;
    const subject = subjectForMotion(plan, motion);
    const shotOrder = shotOrderById.get(shotIdByMotionId.get(motion.id) ?? "");
    const shotPrefix = shotOrder === undefined ? "" : `Shot ${shotOrder} `;
    const target = motion.targetType === "camera" ? `${shotPrefix}${vocabulary.cameraTarget}` : `${shotPrefix}Subject ${subject?.label ?? motion.targetId ?? "unassigned"}`;
    const path = motion.path?.length ? ` Follow the normalized screen path ${compactPathText(motion.path)}.` : "";
    output.promptLines.push(`${target} action ${motion.order}: ${motionLabel(motion)} from ${timingText(motion)}, intensity ${motion.intensity}, ${motion.easing.replaceAll("_", " ")} easing.${path}`);
    if (subject && output.fidelityByControlId[subject.id] === "unsupported") setFidelity(output, subject.id, "prompt");
  }
}

function compileShots(plan: DirectorPlan, output: MutableCompilation, capability: DirectorCapability): void {
  if (!plan.shots.length) return;
  const shots = [...plan.shots].sort((left, right) => left.order - right.order);
  const nativeShots = shots.map((shot) => ({
      id: shot.id,
      order: shot.order,
      durationSeconds: shot.durationSeconds,
      prompt: shot.promptFragment,
      motionIds: [...shot.motionIds],
      keyframeIds: [...shot.keyframeIds],
      speed: shot.speed,
  }));
  const multiShotContract = capability.multiShotContract;
  const protectedFields = new Set(["model", "prompt", "provider", "input_references", "frame_images"]);
  const nativeParameter = multiShotContract?.parameter.trim();
  if (capability.supportsMultiShot
    && multiShotContract
    && nativeParameter
    && /^[a-z][a-z0-9_]*$/i.test(nativeParameter)
    && !protectedFields.has(nativeParameter)) {
    output.providerOptions[nativeParameter] = multiShotContract.shape === "array"
      ? nativeShots
      : { shots: nativeShots };
    shots.forEach((shot) => setFidelity(output, shot.id, "native"));
    return;
  }
  output.promptLines.push("Shot sequence:");
  for (const shot of shots) {
    output.promptLines.push(`Shot ${shot.order} (${shot.durationSeconds}s, ${shot.speed.replaceAll("_", " ")}): ${shot.promptFragment.trim() || "Follow the linked Director controls."}`);
    setFidelity(output, shot.id, "prompt");
  }
  if (shots.length > 1) {
    output.warnings.push(capability.supportsMultiShot
      ? "Hard warning: native multi-shot support was declared without an exact provider field and shape contract. The shot sequence remains represented as prompt guidance and may be treated as one continuous shot."
      : "Hard warning: native multi-shot support is not proven. The shot sequence remains represented as prompt guidance and may be treated as one continuous shot.");
  }
}

function addFallbackWarnings(plan: DirectorPlan, output: MutableCompilation): void {
  const byFidelity = new Map<DirectorFidelity, string[]>();
  for (const { control } of listDirectorControls(plan)) {
    const fidelity = output.fidelityByControlId[control.id] ?? "unsupported";
    const bucket = byFidelity.get(fidelity) ?? [];
    bucket.push(controlLabel(plan, control.id));
    byFidelity.set(fidelity, bucket);
  }
  const prompt = byFidelity.get("prompt") ?? [];
  const visual = byFidelity.get("visual") ?? [];
  const unsupported = byFidelity.get("unsupported") ?? [];
  if (prompt.length) output.warnings.push(`Prompt fallback is used for Director controls: ${prompt.join("; ")}.`);
  if (visual.length) output.warnings.push(`Visual instruction fallback is used for Director controls: ${visual.join("; ")}. Exact path adherence is not guaranteed.`);
  if (unsupported.length) output.warnings.push(`Unsupported Director controls remain in the plan: ${unsupported.join("; ")}.`);
}

const OPPOSITE_DIRECTIONS: Partial<Record<NonNullable<DirectorMotion["direction"]>, NonNullable<DirectorMotion["direction"]>>> = {
  left: "right",
  right: "left",
  up: "down",
  down: "up",
  in: "out",
  out: "in",
};

const CAMERA_KIND_TERMS: Partial<Record<DirectorMotion["kind"], string[]>> = {
  pan: ["pan", "팬"],
  tilt: ["tilt", "틸트"],
  truck: ["truck", "트럭"],
  dolly: ["dolly", "달리"],
  zoom: ["zoom", "줌"],
  orbit: ["orbit", "오빗", "궤도"],
  crane: ["crane", "크레인"],
  roll: ["roll", "롤"],
};

const DIRECTION_TERMS: Record<NonNullable<DirectorMotion["direction"]>, string[]> = {
  left: ["left", "왼쪽"],
  right: ["right", "오른쪽"],
  up: ["up", "위쪽", "위로"],
  down: ["down", "아래쪽", "아래로"],
  in: ["in", "안쪽", "들어가"],
  out: ["out", "바깥쪽", "빠져나"],
};

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptRequestsCameraMove(prompt: string, kind: DirectorMotion["kind"], direction: NonNullable<DirectorMotion["direction"]>): boolean {
  const kinds = CAMERA_KIND_TERMS[kind];
  if (!kinds) return false;
  const kindPattern = kinds.map(escapedPattern).join("|");
  const directionPattern = DIRECTION_TERMS[direction].map(escapedPattern).join("|");
  return new RegExp(`(?:${kindPattern})[^.\\n]{0,24}(?:${directionPattern})`, "iu").test(prompt);
}

function detectPromptConflicts(plan: DirectorPlan, basePrompt: string | undefined, output: MutableCompilation): void {
  const assignedMotionIds = new Set(plan.shots.flatMap((shot) => shot.motionIds));
  const scopes = [
    ...(basePrompt?.trim() ? [{ label: "The base prompt", resolutionLabel: "the base prompt", prompt: basePrompt, motionIds: assignedMotionIds }] : []),
    ...plan.shots.flatMap((shot) => shot.promptFragment.trim() ? [{
      label: `Shot ${shot.order} prompt`,
      resolutionLabel: `the Shot ${shot.order} prompt`,
      prompt: shot.promptFragment,
      motionIds: new Set(shot.motionIds),
    }] : []),
  ];
  for (const scope of scopes) {
    const cameraMotions = plan.motions.filter((motion) => scope.motionIds.has(motion.id)
      && motion.targetType === "camera"
      && motion.kind !== "static");
    const staticRequest = /(?:static|locked[- ]?off|fixed)\s+camera|camera\s+(?:is|remains|stays)\s+(?:static|fixed)|(?:고정된?\s*카메라|카메라[^.\n]{0,16}(?:고정|움직이지))/iu.test(scope.prompt);
    if (staticRequest && cameraMotions.length) {
      output.warnings.push(`${scope.label} requests a static camera while ${controlLabel(plan, cameraMotions[0].id)} requests movement. The structured Director control takes precedence.`);
      output.promptLines.push(`Conflict resolution: ignore static-camera wording in ${scope.resolutionLabel} and follow the structured Director camera movement controls.`);
    }

    for (const motion of cameraMotions) {
      if (!motion.direction) continue;
      const opposite = OPPOSITE_DIRECTIONS[motion.direction];
      if (!opposite || !promptRequestsCameraMove(scope.prompt, motion.kind, opposite)) continue;
      output.warnings.push(`${scope.label} requests ${motion.kind.replaceAll("_", " ")} ${opposite}, while ${controlLabel(plan, motion.id)} requests ${motion.direction}. The Director direction takes precedence.`);
      output.promptLines.push(`Conflict resolution: ignore ${motion.kind.replaceAll("_", " ")} ${opposite} wording in ${scope.resolutionLabel} and use ${motion.kind.replaceAll("_", " ")} ${motion.direction}.`);
    }

    const focalMatches = [...scope.prompt.matchAll(/(?:^|\s)(\d{2,3}(?:\.\d+)?)\s*mm\b/giu)];
    if (plan.cameraRig.focalLengthMm !== undefined
      && focalMatches.some((match) => Number(match[1]) !== plan.cameraRig.focalLengthMm)) {
      output.warnings.push(`${scope.label} names a focal length that conflicts with the Camera rig. The Director focal length takes precedence.`);
      output.promptLines.push(`Conflict resolution: use the Director focal length of ${plan.cameraRig.focalLengthMm}mm.`);
    }
    const apertureMatch = scope.prompt.match(/\bf\s*\/\s*(\d+(?:\.\d+)?)/iu);
    if (plan.cameraRig.aperture !== undefined
      && apertureMatch
      && Number(apertureMatch[1]) !== plan.cameraRig.aperture) {
      output.warnings.push(`${scope.label} names an aperture that conflicts with the Camera rig. The Director aperture takes precedence.`);
      output.promptLines.push(`Conflict resolution: use the Director aperture of f/${plan.cameraRig.aperture}.`);
    }
  }
}

export function compileDirectorPlan(input: CompileDirectorPlanInput): DirectorCompilationResult {
  const durationLimits = [input.durationSeconds, input.maxDurationSeconds]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const maximumDuration = durationLimits.length ? Math.min(...durationLimits) : undefined;
  const validation = validateDirectorPlan(input.plan, {
    availableAssetIds: input.availableAssetIds,
    maxDurationSeconds: maximumDuration,
    maxKeyframes: Math.min(DIRECTOR_LIMITS.maxKeyframes, input.capability.maxKeyframes),
  });
  const blockingIssues = validation.issues.filter((issue) => issue.severity === "error");
  const output: MutableCompilation = {
    fidelityByControlId: Object.fromEntries(listDirectorControls(input.plan).map(({ control }) => [control.id, "unsupported"])),
    providerOptions: {},
    frameBindings: [],
    visualInstructions: [],
    promptLines: [],
    warnings: validation.warnings.map((issue) => issue.message),
  };

  if (input.plan.enabled) {
    const vocabulary = promptVocabulary(input.promptProfileId);
    compileCameraRig(input.plan, output, input.capability, vocabulary);
    const boundKeyframes = compileKeyframes(
      input.plan,
      output,
      input.capability,
      input.durationSeconds,
      input.existingFrameBindings ?? [],
    );
    compileMotions(
      input.plan,
      output,
      input.capability,
      boundKeyframes,
      input.existingFrameBindings ?? [],
      input.maxInputReferences,
      input.allowMixedFrameAndReferences === true,
      vocabulary,
    );
    compileShots(input.plan, output, input.capability);
    detectPromptConflicts(input.plan, input.basePrompt, output);
    addFallbackWarnings(input.plan, output);
  }

  const capabilityWarnings = "warnings" in input.capability && Array.isArray(input.capability.warnings)
    ? input.capability.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  return {
    fidelityByControlId: output.fidelityByControlId,
    providerOptions: output.providerOptions,
    frameBindings: output.frameBindings,
    visualInstructions: output.visualInstructions,
    promptBrief: output.promptLines.join("\n"),
    warnings: [...new Set([...capabilityWarnings, ...output.warnings])],
    validation,
    blockingIssues,
    canGenerate: input.plan.enabled ? blockingIssues.length === 0 : true,
  };
}

export const compileDirector = compileDirectorPlan;
