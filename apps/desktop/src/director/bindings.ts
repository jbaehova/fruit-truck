import type { DirectorPlan, DirectorSubject } from "./types.ts";
import { defaultReferencePurpose, type ReferencePurpose } from "../prompting/types.ts";
import { createDirectorId, type DirectorIdFactory } from "./defaults.ts";

export type DirectorFrameReference = {
  assetId: string;
  slot: number;
  role: "reference" | "first_frame" | "last_frame";
  purpose: ReferencePurpose;
  purposeBeforeEdit?: ReferencePurpose;
};

/**
 * Adds a newly marked subject and maps exactly one unresolved portable target
 * group to it. Other groups remain identifiable for later mapping.
 */
export function appendAndBindDirectorSubject(
  plan: DirectorPlan,
  subject: DirectorSubject,
): DirectorPlan {
  const knownSubjectIds = new Set(plan.subjects.map((item) => item.id));
  const unresolvedMotion = plan.motions.find((motion) => motion.targetType === "subject"
    && (!motion.targetId || !knownSubjectIds.has(motion.targetId)));
  const focusSubjectId = plan.cameraRig.focusSubjectId;
  const unresolvedTargetId = unresolvedMotion
    ? unresolvedMotion.targetId
    : focusSubjectId && !knownSubjectIds.has(focusSubjectId) ? focusSubjectId : undefined;
  const shouldBindMotion = (targetId: string | undefined) => (
    (!targetId || !knownSubjectIds.has(targetId))
    && targetId === unresolvedTargetId
  );
  const shouldBindFocus = focusSubjectId !== undefined
    && !knownSubjectIds.has(focusSubjectId)
    && focusSubjectId === unresolvedTargetId;
  return {
    ...plan,
    cameraRig: shouldBindFocus ? { ...plan.cameraRig, focusSubjectId: subject.id } : plan.cameraRig,
    subjects: [...plan.subjects, subject],
    motions: plan.motions.map((motion) => motion.targetType === "subject" && shouldBindMotion(motion.targetId)
      ? { ...motion, targetId: subject.id }
      : motion),
  };
}

/** Keeps the Input Tray's first and last frame roles aligned with the plan. */
export function synchronizeDirectorFrameReferences(
  plan: DirectorPlan,
  references: readonly DirectorFrameReference[],
): DirectorFrameReference[] {
  const next: DirectorFrameReference[] = references.map((reference) => ({ ...reference }));
  const nextSlot = () => {
    const used = new Set(next.map((reference) => reference.slot));
    let slot = 1;
    while (used.has(slot)) slot += 1;
    return slot;
  };
  const synchronizeRole = (role: "first" | "last") => {
    const referenceRole = role === "first" ? "first_frame" : "last_frame";
    const desiredAssetId = plan.keyframes.find((keyframe) => keyframe.role === role)?.assetId;
    for (let index = 0; index < next.length; index += 1) {
      const reference = next[index]!;
      if (reference.role !== referenceRole) continue;
      next[index] = {
        ...reference,
        role: "reference",
        purpose: defaultReferencePurpose("image", "reference"),
      };
    }
    if (!desiredAssetId) return;
    const reusableIndex = next.findIndex((reference) => reference.assetId === desiredAssetId && reference.role === "reference");
    if (reusableIndex >= 0) {
      next[reusableIndex] = {
        ...next[reusableIndex]!,
        role: referenceRole,
        purpose: defaultReferencePurpose("image", referenceRole),
      };
      return;
    }
    next.push({
      assetId: desiredAssetId,
      slot: nextSlot(),
      role: referenceRole,
      purpose: defaultReferencePurpose("image", referenceRole),
    });
  };
  synchronizeRole("first");
  synchronizeRole("last");
  return next;
}

/** Keeps the plan's first and last keyframes aligned with Input Tray roles. */
export function synchronizeDirectorPlanFrames(
  plan: DirectorPlan,
  previousReferences: readonly DirectorFrameReference[],
  nextReferences: readonly DirectorFrameReference[],
  createId: DirectorIdFactory = createDirectorId,
): DirectorPlan {
  const frameAssetId = (
    references: readonly DirectorFrameReference[],
    role: "first_frame" | "last_frame",
  ) => references.find((reference) => reference.role === role)?.assetId;
  const previousFirst = frameAssetId(previousReferences, "first_frame");
  const previousLast = frameAssetId(previousReferences, "last_frame");
  const nextFirst = frameAssetId(nextReferences, "first_frame");
  const nextLast = frameAssetId(nextReferences, "last_frame");
  if (previousFirst === nextFirst && previousLast === nextLast) return plan;

  let keyframes = [...plan.keyframes];
  let shots = plan.shots.map((shot) => ({ ...shot, keyframeIds: [...shot.keyframeIds] }));
  const synchronizeRole = (role: "first" | "last", assetId: string | undefined) => {
    const existing = keyframes.find((keyframe) => keyframe.role === role);
    keyframes = keyframes.filter((keyframe) => keyframe.role !== role);
    if (!assetId) {
      if (existing) shots = shots.map((shot) => ({ ...shot, keyframeIds: shot.keyframeIds.filter((id) => id !== existing.id) }));
      return;
    }
    const id = existing?.id ?? createId("keyframe");
    keyframes.push({ id, assetId, role, time: role === "first" ? 0 : 1 });
    const orderedShots = shots.toSorted((left, right) => left.order - right.order);
    const targetShotId = role === "first" ? orderedShots[0]?.id : orderedShots.at(-1)?.id;
    shots = shots.map((shot) => ({
      ...shot,
      keyframeIds: [
        ...shot.keyframeIds.filter((candidate) => candidate !== existing?.id && candidate !== id),
        ...(shot.id === targetShotId ? [id] : []),
      ],
    }));
  };
  if (previousFirst !== nextFirst) synchronizeRole("first", nextFirst);
  if (previousLast !== nextLast) synchronizeRole("last", nextLast);
  return {
    ...plan,
    ...(previousFirst === nextFirst ? {} : { sourceAssetId: nextFirst }),
    subjects: previousFirst !== nextFirst && nextFirst
      ? plan.subjects.map((subject) => plan.sourceAssetId === undefined || subject.sourceAssetId === plan.sourceAssetId || subject.sourceAssetId === previousFirst
        ? { ...subject, sourceAssetId: nextFirst }
        : subject)
      : plan.subjects,
    keyframes,
    shots,
    updatedAt: new Date().toISOString(),
  };
}
