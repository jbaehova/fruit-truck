import {
  ArrowLeftRight,
  BoxSelect,
  Camera,
  LassoSelect,
  MousePointer2,
  Redo2,
  Route,
  Save,
  Trash2,
  Undo2,
  Video,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CameraMoveControls } from "@/components/CameraMoveControls";
import { CameraRigControls } from "@/components/CameraRigControls";
import {
  DirectorCanvas,
  nudgeDirectorRegion,
  type DirectorCanvasSelection,
  type DirectorCanvasTool,
} from "@/components/DirectorCanvas";
import { DirectorTimeline, type DirectorAssetOption } from "@/components/DirectorTimeline";
import { DirectorShotTimeline } from "@/components/DirectorShotTimeline";
import { Button } from "@/components/ui/button";
import { appendAndBindDirectorSubject } from "@/director/bindings";
import { createDefaultDirectorShot, createDirectorId } from "@/director/defaults";
import {
  createDirectorHistory,
  pushDirectorHistory,
  redoDirectorHistory,
  undoDirectorHistory,
  type DirectorHistory,
} from "@/director/history";
import { clampNormalizedPoint, getDirectorPlanDuration, sampleDirectorAnimatic } from "@/director/preview";
import type {
  DirectorCapability,
  DirectorDirection,
  DirectorFidelity,
  DirectorKeyframe,
  DirectorKeyframeRole,
  DirectorMotion,
  DirectorMotionKind,
  DirectorPlan,
  DirectorPreset,
  DirectorRegion,
  DirectorShot,
  DirectorSubject,
  NormalizedPoint,
} from "@/director/types";
import { DIRECTOR_LIMITS } from "@/director/types";
import { useI18n, type MessageKey } from "@/i18n";

export type DirectorPanelProps = {
  plan: DirectorPlan | null;
  sourceAsset: DirectorAssetOption | null;
  assetUrls?: Readonly<Record<string, string>>;
  availableAssets: DirectorAssetOption[];
  capability?: DirectorCapability;
  fidelityByControlId?: Record<string, DirectorFidelity>;
  warnings?: string[];
  presets?: DirectorPreset[];
  onPlanChange: (plan: DirectorPlan) => void;
  onCreatePlan: () => void;
  onSavePreset?: (name: string) => void;
  onApplyPreset?: (preset: DirectorPreset) => void;
  onDeletePreset?: (presetId: string) => void;
  onClose: () => void;
};

const TOOL_OPTIONS: Array<{ value: DirectorCanvasTool; label: MessageKey; icon: typeof MousePointer2 }> = [
  { value: "select", label: "directorSelectTool", icon: MousePointer2 },
  { value: "subject", label: "directorBoxTool", icon: BoxSelect },
  { value: "subject_polygon", label: "directorMaskTool", icon: LassoSelect },
  { value: "object_path", label: "directorObjectPath", icon: Route },
  { value: "camera_path", label: "directorCameraPath", icon: Video },
];

const FIDELITY_KEYS: Record<DirectorFidelity, MessageKey> = {
  native: "directorFidelityNative", keyframe: "directorFidelityKeyframe", visual: "directorFidelityVisual",
  prompt: "directorFidelityPrompt", unsupported: "directorFidelityUnsupported",
};

function now() {
  return new Date().toISOString();
}

function primaryShot(plan: DirectorPlan) {
  return [...plan.shots].sort((a, b) => a.order - b.order)[0];
}

function orderedShots(plan: DirectorPlan) {
  return [...plan.shots].sort((left, right) => left.order - right.order);
}

function normalizeShotOrder(shots: DirectorShot[]): DirectorShot[] {
  return [...shots].sort((left, right) => left.order - right.order).map((shot, index) => ({ ...shot, order: index + 1 }));
}

function normalizeAnchorBindings(shots: DirectorShot[], keyframes: DirectorKeyframe[]): DirectorShot[] {
  const ordered = normalizeShotOrder(shots);
  if (!ordered.length) return ordered;
  const firstIds = keyframes.filter((keyframe) => keyframe.role === "first").map((keyframe) => keyframe.id);
  const lastIds = keyframes.filter((keyframe) => keyframe.role === "last").map((keyframe) => keyframe.id);
  const anchorIds = new Set([...firstIds, ...lastIds]);
  return ordered.map((shot, index) => ({
    ...shot,
    keyframeIds: [
      ...(index === 0 ? firstIds : []),
      ...shot.keyframeIds.filter((id) => !anchorIds.has(id)),
      ...(index === ordered.length - 1 ? lastIds : []),
    ],
  }));
}

function withPrimaryShot(plan: DirectorPlan): DirectorPlan {
  if (plan.shots.length) return plan;
  return { ...plan, shots: [createDefaultDirectorShot()] };
}

function translatePath(path: NormalizedPoint[], delta: NormalizedPoint) {
  if (!path.length) return path;
  const minX = Math.min(...path.map((point) => point.x));
  const maxX = Math.max(...path.map((point) => point.x));
  const minY = Math.min(...path.map((point) => point.y));
  const maxY = Math.max(...path.map((point) => point.y));
  const bounded = {
    x: Math.min(1 - maxX, Math.max(-minX, delta.x)),
    y: Math.min(1 - maxY, Math.max(-minY, delta.y)),
  };
  return path.map((point) => clampNormalizedPoint({ x: point.x + bounded.x, y: point.y + bounded.y }));
}

export function DirectorPanel({
  plan,
  sourceAsset,
  assetUrls,
  availableAssets,
  capability,
  fidelityByControlId,
  warnings = [],
  presets = [],
  onPlanChange,
  onCreatePlan,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  onClose,
}: DirectorPanelProps) {
  const { t } = useI18n();
  const sourceUrl = sourceAsset ? assetUrls?.[sourceAsset.id] : undefined;
  const [tool, setTool] = useState<DirectorCanvasTool>("select");
  const [selection, setSelection] = useState<DirectorCanvasSelection>(null);
  const [activeShotId, setActiveShotId] = useState<string | undefined>(() => plan ? primaryShot(plan)?.id : undefined);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const historyRef = useRef<DirectorHistory | null>(plan ? createDirectorHistory(plan) : null);
  const [, setHistoryRevision] = useState(0);
  const animationFrameRef = useRef<number | null>(null);
  const animationTimestampRef = useRef<number | null>(null);
  const shotSequence = useMemo(() => plan ? orderedShots(plan) : [], [plan]);
  const activeShot = shotSequence.find((shot) => shot.id === activeShotId) ?? shotSequence[0];
  const totalDurationSeconds = plan ? Math.max(0.1, getDirectorPlanDuration(plan)) : 0.1;
  const animaticSample = useMemo(
    () => plan ? sampleDirectorAnimatic(plan, previewProgress * totalDurationSeconds, { loop: true }) : undefined,
    [plan, previewProgress, totalDurationSeconds],
  );
  const previewShot = animaticSample ? shotSequence[animaticSample.shotIndex] : activeShot;
  const canvasShot = playing ? previewShot : activeShot;
  const canvasProgress = playing ? animaticSample?.normalizedTime ?? 0 : activeShot && previewShot?.id === activeShot.id ? animaticSample?.normalizedTime ?? 0 : 0;

  useEffect(() => {
    if (!playing || !plan?.enabled) return;
    const animate = (timestamp: number) => {
      const previous = animationTimestampRef.current ?? timestamp;
      animationTimestampRef.current = timestamp;
      const elapsed = Math.max(0, timestamp - previous) / 1000;
      setPreviewProgress((current) => (current + elapsed / totalDurationSeconds) % 1);
      animationFrameRef.current = requestAnimationFrame(animate);
    };
    animationFrameRef.current = requestAnimationFrame(animate);
    return () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      animationTimestampRef.current = null;
    };
  }, [plan?.enabled, playing, totalDurationSeconds]);

  useEffect(() => {
    if (!shotSequence.length) {
      setActiveShotId(undefined);
      return;
    }
    if (!shotSequence.some((shot) => shot.id === activeShotId)) setActiveShotId(shotSequence[0].id);
  }, [activeShotId, shotSequence]);

  useEffect(() => {
    if (playing && previewShot && previewShot.id !== activeShotId) {
      setActiveShotId(previewShot.id);
      setSelection(null);
    }
  }, [activeShotId, playing, previewShot]);

  useEffect(() => {
    if (selection?.type === "motion" && !plan?.motions.some((motion) => motion.id === selection.id)) setSelection(null);
    if (selection?.type === "subject" && !plan?.subjects.some((subject) => subject.id === selection.id)) setSelection(null);
  }, [plan?.motions, plan?.subjects, selection]);

  useEffect(() => {
    if (!plan) {
      if (historyRef.current) {
        historyRef.current = null;
        setHistoryRevision((value) => value + 1);
      }
      return;
    }
    if (historyRef.current?.present !== plan) {
      historyRef.current = createDirectorHistory(plan);
      setHistoryRevision((value) => value + 1);
    }
  }, [plan]);

  const selectedSubject = selection?.type === "subject"
    ? plan?.subjects.find((subject) => subject.id === selection.id)
    : undefined;
  const selectedMotion = selection?.type === "motion"
    ? plan?.motions.find((motion) => motion.id === selection.id)
    : undefined;
  const activeMotionIds = useMemo(() => new Set(activeShot?.motionIds ?? []), [activeShot?.motionIds]);
  const activeMotions = useMemo(() => plan?.motions.filter((motion) => activeMotionIds.has(motion.id)) ?? [], [activeMotionIds, plan?.motions]);
  const cameraMotions = useMemo(() => activeMotions.filter((motion) => motion.targetType === "camera"), [activeMotions]);
  const availableAssetIds = useMemo(() => new Set(availableAssets.map((asset) => asset.id)), [availableAssets]);
  const fidelityCounts = useMemo(() => {
    const result: Partial<Record<DirectorFidelity, number>> = {};
    for (const fidelity of Object.values(fidelityByControlId ?? {})) result[fidelity] = (result[fidelity] ?? 0) + 1;
    return result;
  }, [fidelityByControlId]);

  if (!plan) {
    return (
      <section className="director-panel director-panel-empty" aria-labelledby="director-panel-title">
        <header className="director-panel-header">
          <div><p className="director-eyebrow">{t("directorTools")}</p><h1 id="director-panel-title">{t("directorPanelTitle")}</h1></div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("closeDirector")} onClick={onClose}><X /></Button>
        </header>
        <div className="director-welcome">
          <Camera aria-hidden="true" />
          <h2>{t("directorCreatePlanTitle")}</h2>
          <p>{t("directorCreatePlanHint")}</p>
          <Button type="button" disabled={!sourceAsset} onClick={onCreatePlan}>{t("directorCreatePlan")}</Button>
          {!sourceAsset ? <p className="director-warning" role="status">{t("directorSourceFrameMissing")}</p> : null}
        </div>
      </section>
    );
  }

  const commit = (next: DirectorPlan) => {
    const finalized = { ...next, updatedAt: now() };
    const currentHistory = historyRef.current?.present === plan
      ? historyRef.current
      : createDirectorHistory(plan);
    historyRef.current = pushDirectorHistory(currentHistory, finalized);
    setHistoryRevision((value) => value + 1);
    onPlanChange(finalized);
  };
  const undo = () => {
    const history = historyRef.current;
    if (!history?.past.length) return;
    const next = undoDirectorHistory(history);
    historyRef.current = next;
    setHistoryRevision((value) => value + 1);
    onPlanChange(next.present);
  };
  const redo = () => {
    const history = historyRef.current;
    if (!history?.future.length) return;
    const next = redoDirectorHistory(history);
    historyRef.current = next;
    setHistoryRevision((value) => value + 1);
    onPlanChange(next.present);
  };
  const updateMotion = (motionId: string, patch: Partial<DirectorMotion>) => {
    commit({ ...plan, motions: plan.motions.map((motion) => motion.id === motionId ? { ...motion, ...patch } : motion) });
  };
  const deleteMotion = (motionId: string) => {
    commit({
      ...plan,
      motions: plan.motions.filter((motion) => motion.id !== motionId),
      shots: plan.shots.map((shot) => ({ ...shot, motionIds: shot.motionIds.filter((id) => id !== motionId) })),
    });
    if (selection?.type === "motion" && selection.id === motionId) setSelection(null);
  };
  const reverseMotion = (motionId: string) => {
    const motion = plan.motions.find((item) => item.id === motionId);
    if (!motion) return;
    const directionPairs: Partial<Record<NonNullable<DirectorMotion["direction"]>, DirectorMotion["direction"]>> = {
      left: "right", right: "left", up: "down", down: "up", in: "out", out: "in",
    };
    updateMotion(motionId, {
      path: motion.path ? [...motion.path].reverse() : undefined,
      direction: motion.direction ? directionPairs[motion.direction] : undefined,
    });
  };
  const addMotion = (
    targetType: DirectorMotion["targetType"],
    options: { path?: NormalizedPoint[]; kind?: DirectorMotionKind; direction?: DirectorDirection } = {},
  ) => {
    const next = withPrimaryShot(plan);
    const targetShot = next.shots.find((shot) => shot.id === activeShot?.id) ?? primaryShot(next)!;
    const shotMotions = next.motions.filter((motion) => targetShot.motionIds.includes(motion.id));
    if (targetType === "camera" && shotMotions.filter((motion) => motion.targetType === "camera").length >= 2) return;
    if (targetType === "subject" && shotMotions.filter((motion) => motion.targetType === "subject").length >= 3) return;
    if (targetType === "subject" && !selectedSubject) return;
    const id = createDirectorId("motion");
    const order = Math.min(3, shotMotions.filter((motion) => motion.targetType === targetType).length + 1) as DirectorMotion["order"];
    const motion: DirectorMotion = {
      id,
      targetType,
      ...(targetType === "subject" ? { targetId: selectedSubject!.id } : {}),
      kind: options.kind ?? "translate",
      ...(options.path ? { path: options.path } : {}),
      ...(options.direction ? { direction: options.direction } : {}),
      intensity: 0.65,
      start: 0,
      end: 1,
      easing: "ease_in_out",
      order,
      actionLabel: targetType === "camera" ? t("directorCameraMove") : `${selectedSubject!.label} ${t("directorMotionPath")}`,
    };
    commit({
      ...next,
      motions: [...next.motions, motion],
      shots: next.shots.map((shot) => shot.id === targetShot.id ? { ...shot, motionIds: [...shot.motionIds, id] } : shot),
    });
    setSelection({ type: "motion", id });
    setTool("select");
  };
  const addSubject = (region: DirectorRegion) => {
    if (!plan.sourceAssetId || plan.subjects.length >= 8) return;
    const id = createDirectorId("subject");
    const subject: DirectorSubject = {
      id,
      label: `${t("directorSubject")} ${plan.subjects.length + 1}`,
      region,
      sourceAssetId: plan.sourceAssetId,
    };
    commit(appendAndBindDirectorSubject(plan, subject));
    setSelection({ type: "subject", id });
    setTool("object_path");
  };
  const updateSubject = (subjectId: string, patch: Partial<DirectorSubject>) => {
    commit({ ...plan, subjects: plan.subjects.map((subject) => subject.id === subjectId ? { ...subject, ...patch } : subject) });
  };
  const deleteSubject = (subjectId: string) => {
    const motionIds = new Set(plan.motions.filter((motion) => motion.targetId === subjectId).map((motion) => motion.id));
    commit({
      ...plan,
      cameraRig: plan.cameraRig.focusSubjectId === subjectId ? { ...plan.cameraRig, focusSubjectId: undefined } : plan.cameraRig,
      subjects: plan.subjects.filter((subject) => subject.id !== subjectId),
      motions: plan.motions.filter((motion) => !motionIds.has(motion.id)),
      shots: plan.shots.map((shot) => ({ ...shot, motionIds: shot.motionIds.filter((id) => !motionIds.has(id)) })),
    });
    setSelection(null);
  };
  const deleteSelection = () => {
    if (selection?.type === "motion") deleteMotion(selection.id);
    if (selection?.type === "subject") deleteSubject(selection.id);
  };
  const nudgeSelection = (delta: NormalizedPoint) => {
    if (selectedSubject) updateSubject(selectedSubject.id, { region: nudgeDirectorRegion(selectedSubject.region, delta) });
    if (selectedMotion?.path) updateMotion(selectedMotion.id, { path: translatePath(selectedMotion.path, delta) });
  };
  const keyframeMaximum = Math.min(DIRECTOR_LIMITS.maxKeyframes, Math.max(0, capability?.maxKeyframes ?? DIRECTOR_LIMITS.maxKeyframes));
  const addKeyframe = (role: DirectorKeyframeRole, assetId: string, time: number) => {
    const next = withPrimaryShot(plan);
    const prior = role === "first" || role === "last"
      ? next.keyframes.find((keyframe) => keyframe.role === role)
      : undefined;
    if (!prior && next.keyframes.length >= keyframeMaximum) return;
    const keyframe: DirectorKeyframe = {
      id: prior?.id ?? createDirectorId("keyframe"),
      assetId,
      role,
      time: role === "first" ? 0 : role === "last" ? 1 : Math.min(0.99, Math.max(0.01, time)),
    };
    const keyframes = [...next.keyframes.filter((item) => item.id !== prior?.id), keyframe];
    const targetShot = role === "first"
      ? orderedShots(next)[0]
      : role === "last"
        ? orderedShots(next).at(-1)
        : next.shots.find((shot) => shot.id === activeShot?.id) ?? primaryShot(next);
    let shots = next.shots.map((shot) => ({
      ...shot,
      keyframeIds: shot.keyframeIds.filter((id) => id !== prior?.id && id !== keyframe.id),
    }));
    shots = shots.map((shot) => shot.id === targetShot?.id ? { ...shot, keyframeIds: [...shot.keyframeIds, keyframe.id] } : shot);
    commit({
      ...next,
      ...(role === "first" ? {
        sourceAssetId: assetId,
        subjects: next.subjects.map((subject) => subject.sourceAssetId === next.sourceAssetId ? { ...subject, sourceAssetId: assetId } : subject),
      } : {}),
      keyframes,
      shots: normalizeAnchorBindings(shots, keyframes),
    });
  };
  const updateKeyframe = (keyframeId: string, patch: Partial<DirectorKeyframe>) => {
    const existing = plan.keyframes.find((keyframe) => keyframe.id === keyframeId);
    if (!existing) return;
    const role = patch.role ?? existing.role;
    const updated: DirectorKeyframe = {
      ...existing,
      ...patch,
      role,
      time: role === "first" ? 0 : role === "last" ? 1 : Math.min(0.99, Math.max(0.01, patch.time ?? existing.time)),
    };
    const keyframes = plan.keyframes.map((keyframe) => keyframe.id === keyframeId ? updated : keyframe);
    commit({
      ...plan,
      ...(existing.role === "first" && updated.assetId !== existing.assetId ? {
        sourceAssetId: updated.assetId,
        subjects: plan.subjects.map((subject) => subject.sourceAssetId === plan.sourceAssetId ? { ...subject, sourceAssetId: updated.assetId } : subject),
      } : {}),
      keyframes,
      shots: normalizeAnchorBindings(plan.shots, keyframes),
    });
  };
  const deleteKeyframe = (keyframeId: string) => {
    const keyframes = plan.keyframes.filter((keyframe) => keyframe.id !== keyframeId);
    commit({
      ...plan,
      keyframes,
      shots: normalizeAnchorBindings(plan.shots.map((shot) => ({ ...shot, keyframeIds: shot.keyframeIds.filter((id) => id !== keyframeId) })), keyframes),
    });
  };
  const moveKeyframe = (keyframeId: string, direction: -1 | 1) => {
    if (!activeShot) return;
    const interiorIds = activeShot.keyframeIds.filter((id) => {
      const keyframe = plan.keyframes.find((item) => item.id === id);
      return keyframe?.role === "middle" || keyframe?.role === "timestamped";
    });
    const index = interiorIds.indexOf(keyframeId);
    const targetId = interiorIds[index + direction];
    if (index < 0 || !targetId) return;
    const keyframeIds = [...activeShot.keyframeIds];
    const from = keyframeIds.indexOf(keyframeId);
    const to = keyframeIds.indexOf(targetId);
    [keyframeIds[from], keyframeIds[to]] = [keyframeIds[to], keyframeIds[from]];
    const currentTime = plan.keyframes.find((keyframe) => keyframe.id === keyframeId)?.time;
    const targetTime = plan.keyframes.find((keyframe) => keyframe.id === targetId)?.time;
    commit({
      ...plan,
      keyframes: plan.keyframes.map((keyframe) => keyframe.id === keyframeId && targetTime !== undefined
        ? { ...keyframe, time: targetTime }
        : keyframe.id === targetId && currentTime !== undefined
          ? { ...keyframe, time: currentTime }
          : keyframe),
      shots: plan.shots.map((shot) => shot.id === activeShot.id ? { ...shot, keyframeIds } : shot),
    });
  };
  const relinkSource = (assetId: string) => {
    addKeyframe("first", assetId, 0);
  };
  const updateShot = (shotId: string, patch: Partial<DirectorShot>) => {
    commit({ ...plan, shots: plan.shots.map((shot) => shot.id === shotId ? { ...shot, ...patch, order: shot.order } : shot) });
  };
  const showShotStart = (shots: DirectorShot[], shotId: string) => {
    const sequence = [...shots].sort((left, right) => left.order - right.order);
    const index = sequence.findIndex((shot) => shot.id === shotId);
    if (index < 0) return;
    const elapsedBefore = sequence.slice(0, index).reduce((total, shot) => total + shot.durationSeconds, 0);
    const duration = sequence.reduce((total, shot) => total + shot.durationSeconds, 0);
    setPlaying(false);
    setPreviewProgress(elapsedBefore / Math.max(0.1, duration));
    setActiveShotId(shotId);
    setSelection(null);
  };
  const selectShot = (shotId: string) => {
    showShotStart(plan.shots, shotId);
  };
  const addShot = () => {
    if (plan.shots.length >= DIRECTOR_LIMITS.maxShots) return;
    const shot = createDefaultDirectorShot(plan.shots.length + 1);
    const shots = normalizeAnchorBindings([...plan.shots, shot], plan.keyframes);
    commit({ ...plan, shots });
    showShotStart(shots, shot.id);
  };
  const moveShot = (shotId: string, direction: -1 | 1) => {
    const sequence = orderedShots(plan);
    const index = sequence.findIndex((shot) => shot.id === shotId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sequence.length) return;
    [sequence[index], sequence[target]] = [sequence[target], sequence[index]];
    const shots = normalizeAnchorBindings(sequence.map((shot, order) => ({ ...shot, order: order + 1 })), plan.keyframes);
    commit({ ...plan, shots });
    showShotStart(shots, shotId);
  };
  const deleteShot = (shotId: string) => {
    if (plan.shots.length <= 1) return;
    const removing = plan.shots.find((shot) => shot.id === shotId);
    if (!removing) return;
    const remainingShots = plan.shots.filter((shot) => shot.id !== shotId);
    const remainingMotionIds = new Set(remainingShots.flatMap((shot) => shot.motionIds));
    const removingMotionIds = new Set(removing.motionIds.filter((id) => !remainingMotionIds.has(id)));
    const remainingKeyframeIds = new Set(remainingShots.flatMap((shot) => shot.keyframeIds));
    const removingInteriorKeyframeIds = new Set(removing.keyframeIds.filter((id) => {
      if (remainingKeyframeIds.has(id)) return false;
      const keyframe = plan.keyframes.find((item) => item.id === id);
      return keyframe?.role === "middle" || keyframe?.role === "timestamped";
    }));
    const keyframes = plan.keyframes.filter((keyframe) => !removingInteriorKeyframeIds.has(keyframe.id));
    const shots = normalizeAnchorBindings(remainingShots, keyframes);
    commit({
      ...plan,
      motions: plan.motions.filter((motion) => !removingMotionIds.has(motion.id)),
      keyframes,
      shots,
    });
    const removedIndex = orderedShots(plan).findIndex((shot) => shot.id === shotId);
    const nextShot = shots[Math.min(Math.max(0, removedIndex), shots.length - 1)];
    if (nextShot) showShotStart(shots, nextShot.id);
  };
  const duplicateShot = (shotId: string) => {
    if (plan.shots.length >= DIRECTOR_LIMITS.maxShots) return;
    const source = plan.shots.find((shot) => shot.id === shotId);
    if (!source) return;
    const motionClones = source.motionIds.flatMap((id) => {
      const motion = plan.motions.find((item) => item.id === id);
      return motion ? [{ ...motion, id: createDirectorId("motion"), path: motion.path?.map((point) => ({ ...point })) }] : [];
    });
    const interiorKeyframeClones = source.keyframeIds.flatMap((id) => {
      const keyframe = plan.keyframes.find((item) => item.id === id);
      return keyframe && (keyframe.role === "middle" || keyframe.role === "timestamped")
        ? [{ ...keyframe, id: createDirectorId("keyframe") }]
        : [];
    });
    const clone: DirectorShot = {
      ...source,
      id: createDirectorId("shot"),
      order: source.order + 0.5,
      motionIds: motionClones.map((motion) => motion.id),
      keyframeIds: interiorKeyframeClones.map((keyframe) => keyframe.id),
    };
    const keyframes = [...plan.keyframes, ...interiorKeyframeClones];
    const shots = normalizeAnchorBindings([...plan.shots, clone], keyframes);
    commit({
      ...plan,
      motions: [...plan.motions, ...motionClones],
      keyframes,
      shots,
    });
    showShotStart(shots, clone.id);
  };
  const toggleShotMotion = (shotId: string, motionId: string, assigned: boolean) => {
    const motion = plan.motions.find((item) => item.id === motionId);
    const shot = plan.shots.find((item) => item.id === shotId);
    if (!motion || !shot) return;
    if (assigned && motion.targetType === "camera") {
      const cameraCount = shot.motionIds.filter((id) => plan.motions.find((item) => item.id === id)?.targetType === "camera").length;
      if (cameraCount >= DIRECTOR_LIMITS.maxCameraMovesPerShot) return;
    }
    commit({
      ...plan,
      shots: plan.shots.map((item) => ({
        ...item,
        motionIds: item.id === shotId
          ? assigned ? [...item.motionIds.filter((id) => id !== motionId), motionId] : item.motionIds.filter((id) => id !== motionId)
          : assigned ? item.motionIds.filter((id) => id !== motionId) : item.motionIds,
      })),
    });
  };
  const sourceMissing = !plan.sourceAssetId || !sourceAsset || sourceAsset.id !== plan.sourceAssetId;

  return (
    <section className="director-panel" aria-labelledby="director-panel-title">
      <header className="director-panel-header">
        <div>
          <p className="director-eyebrow">{t("directorTools")}</p>
          <h1 id="director-panel-title">{t("directorPanelTitle")}</h1>
          <p>{t("directorPanelHint")}</p>
        </div>
        <div className="director-panel-actions">
          <label className="director-enabled-toggle">
            <input type="checkbox" checked={plan.enabled} onChange={(event) => commit({ ...plan, enabled: event.target.checked })} />
            <span>{t("directorEnabled")}</span>
          </label>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("closeDirector")} onClick={onClose}><X /></Button>
        </div>
      </header>

      <div className="director-source-bar">
        <span><strong>{t("directorSourceFrame")}</strong><small>{sourceAsset?.name ?? t("directorMissingAssetShort")}</small></span>
        <label>
          <span className="sr-only">{t("directorRelinkAsset")}</span>
          <select value={sourceMissing ? "" : plan.sourceAssetId ?? ""} onChange={(event) => event.target.value && relinkSource(event.target.value)}>
            <option value="">{t("directorRelinkAsset")}</option>
            {availableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select>
        </label>
        <small>{t("directorOverlayNonDestructive")}</small>
      </div>

      {sourceMissing ? <p className="director-warning" role="alert">{t("directorMissingAsset")}</p> : null}
      {!plan.enabled ? <p className="director-info" role="status">{t("directorDisabledHint")}</p> : null}
      {warnings.length ? (
        <section className="director-warning-list" aria-label={t("directorWarnings")}>
          {warnings.map((warning, index) => <p key={`${index}-${warning}`} role="status">{warning}</p>)}
        </section>
      ) : null}

      <div className="director-workspace" data-disabled={!plan.enabled || undefined}>
        <nav className="director-toolbar" aria-label={t("directorCanvasTools")}>
          {TOOL_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isObjectPath = option.value === "object_path";
            const isCameraPath = option.value === "camera_path";
            const isSubjectTool = option.value === "subject" || option.value === "subject_polygon";
            const isDisabled = !plan.enabled
              || !sourceUrl
              || (isObjectPath && !selectedSubject)
              || (isObjectPath && activeMotions.filter((motion) => motion.targetType === "subject").length >= 3)
              || (isCameraPath && cameraMotions.length >= 2)
              || (isSubjectTool && plan.subjects.length >= 8);
            return (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={tool === option.value ? "default" : "outline"}
                aria-pressed={tool === option.value}
                disabled={isDisabled}
                title={isObjectPath && !selectedSubject ? t("directorSelectSubjectFirst") : undefined}
                onClick={() => setTool(option.value)}
              >
                <Icon /> {t(option.label)}
              </Button>
            );
          })}
          <span className="director-toolbar-divider" />
          <Button type="button" size="icon-sm" variant="ghost" disabled={!historyRef.current?.past.length} aria-label={t("directorUndo")} onClick={undo}><Undo2 /></Button>
          <Button type="button" size="icon-sm" variant="ghost" disabled={!historyRef.current?.future.length} aria-label={t("directorRedo")} onClick={redo}><Redo2 /></Button>
          <Button type="button" size="icon-sm" variant="ghost" disabled={!selectedMotion?.path || !plan.enabled} aria-label={t("directorReversePath")} onClick={() => selectedMotion && reverseMotion(selectedMotion.id)}><ArrowLeftRight /></Button>
          <Button type="button" size="icon-sm" variant="ghost" disabled={!selection || !plan.enabled} aria-label={t("shortcutDeleteSelection")} onClick={deleteSelection}><Trash2 /></Button>
        </nav>

        <DirectorShotTimeline
          shots={plan.shots}
          motions={plan.motions}
          keyframes={plan.keyframes}
          activeShotId={activeShot?.id}
          totalDurationSeconds={totalDurationSeconds}
          previewProgress={previewProgress}
          playing={playing}
          capability={capability}
          fidelityByControlId={fidelityByControlId}
          disabled={!plan.enabled}
          onPreviewToggle={() => setPlaying((value) => !value)}
          onPreviewProgressChange={(progress) => {
            setPlaying(false);
            setPreviewProgress(progress);
            const sample = sampleDirectorAnimatic(plan, progress * totalDurationSeconds);
            const shot = sample ? shotSequence[sample.shotIndex] : undefined;
            if (shot) setActiveShotId(shot.id);
            setSelection(null);
          }}
          onSelectShot={selectShot}
          onAddShot={addShot}
          onDuplicateShot={duplicateShot}
          onDeleteShot={deleteShot}
          onMoveShot={moveShot}
          onShotChange={updateShot}
          onToggleMotion={toggleShotMotion}
        />

        <DirectorCanvas
          plan={plan}
          sourceUrl={sourceUrl}
          assetUrls={assetUrls}
          sourceAlt={sourceAsset?.name ?? t("directorSourceFrame")}
          tool={tool}
          selection={selection}
          previewProgress={canvasProgress}
          visibleMotionIds={new Set(canvasShot?.motionIds ?? [])}
          availableAssetIds={availableAssetIds}
          disabled={!plan.enabled || sourceMissing}
          onSelect={setSelection}
          onCreateSubject={addSubject}
          onCreateMotion={(targetType, path) => addMotion(targetType, { path })}
          onNudgeSelection={nudgeSelection}
          onDeleteSelection={deleteSelection}
        />

        <aside className="director-inspector" aria-label={t("directorControls")}>
          {selectedSubject ? (
            <section className="director-control-section director-subject-controls" aria-labelledby="director-subject-title">
              <div className="director-section-heading">
                <h3 id="director-subject-title">{t("directorSelectedSubject")}</h3>
                <Button type="button" size="icon-xs" variant="ghost" disabled={!plan.enabled} aria-label={`${t("directorDeleteSubject")}: ${selectedSubject.label}`} onClick={() => deleteSubject(selectedSubject.id)}><Trash2 /></Button>
              </div>
              <label className="director-field">
                <span>{t("directorSubjectLabel")}</span>
                <input value={selectedSubject.label} disabled={!plan.enabled} onChange={(event) => updateSubject(selectedSubject.id, { label: event.target.value })} />
              </label>
              <label className="director-field">
                <span>{t("directorSubjectSource")}</span>
                <select value={availableAssetIds.has(selectedSubject.sourceAssetId) ? selectedSubject.sourceAssetId : ""} disabled={!plan.enabled} onChange={(event) => event.target.value && updateSubject(selectedSubject.id, { sourceAssetId: event.target.value })}>
                  <option value="">{t("directorRelinkAsset")}</option>
                  {availableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </select>
              </label>
              {!availableAssetIds.has(selectedSubject.sourceAssetId) ? <p className="director-limit-note" role="alert">{t("directorSubjectSourceMissing")}</p> : null}
              <p className="director-control-note">{t("directorDrawPathForSubject")}</p>
            </section>
          ) : null}
          <CameraMoveControls
            motions={cameraMotions}
            selectedMotionId={selectedMotion?.id}
            fidelityByControlId={fidelityByControlId}
            disabled={!plan.enabled}
            onAdd={(kind, direction) => addMotion("camera", { kind, direction })}
            onChange={updateMotion}
            onDelete={deleteMotion}
            onSelect={(id) => setSelection({ type: "motion", id })}
          />
          <CameraRigControls
            rig={plan.cameraRig}
            subjects={plan.subjects}
            fidelityByControlId={fidelityByControlId}
            disabled={!plan.enabled}
            onChange={(cameraRig) => commit({ ...plan, cameraRig })}
          />
        </aside>

        <DirectorTimeline
          motions={activeMotions}
          keyframes={activeShot?.keyframeIds.flatMap((keyframeId) => {
            const keyframe = plan.keyframes.find((candidate) => candidate.id === keyframeId);
            return keyframe ? [keyframe] : [];
          }) ?? []}
          totalKeyframeCount={plan.keyframes.length}
          showFirstAnchor={activeShot?.id === shotSequence[0]?.id}
          showLastAnchor={activeShot?.id === shotSequence.at(-1)?.id}
          assets={availableAssets}
          selectedMotionId={selectedMotion?.id}
          capability={capability}
          fidelityByControlId={fidelityByControlId}
          disabled={!plan.enabled}
          onSelectMotion={(id) => setSelection({ type: "motion", id })}
          onMotionChange={updateMotion}
          onReverseMotion={reverseMotion}
          onDeleteMotion={deleteMotion}
          onAddKeyframe={addKeyframe}
          onKeyframeChange={updateKeyframe}
          onMoveKeyframe={moveKeyframe}
          onDeleteKeyframe={deleteKeyframe}
        />
      </div>

      <footer className="director-panel-footer">
        <section className="director-fidelity-summary" aria-labelledby="director-fidelity-title">
          <div><strong id="director-fidelity-title">{t("directorFidelity")}</strong><small>{t("directorFidelityHint")}</small></div>
          <div>
            {(Object.entries(fidelityCounts) as Array<[DirectorFidelity, number]>).map(([fidelity, count]) => (
              <span key={fidelity} className="director-fidelity" data-fidelity={fidelity}>{t(FIDELITY_KEYS[fidelity])} {count}</span>
            ))}
            {!Object.keys(fidelityCounts).length ? <small>{t("directorNoFidelityData")}</small> : null}
          </div>
        </section>
        <section className="director-presets" aria-labelledby="director-presets-title">
          <strong id="director-presets-title">{t("directorPresets")}</strong>
          <label>
            <span className="sr-only">{t("directorPresetName")}</span>
            <input value={presetName} placeholder={t("directorPresetName")} onChange={(event) => setPresetName(event.target.value)} />
          </label>
          <Button type="button" size="sm" variant="outline" disabled={!onSavePreset || !presetName.trim()} onClick={() => {
            onSavePreset?.(presetName.trim());
            setPresetName("");
          }}><Save /> {t("directorSavePreset")}</Button>
          <label>
            <span className="sr-only">{t("directorSavedPresets")}</span>
            <select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)}>
              <option value="">{presets.length ? t("directorChoosePreset") : t("directorNoPresets")}</option>
              {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <Button type="button" size="sm" variant="outline" disabled={!onApplyPreset || !selectedPresetId} onClick={() => {
            const preset = presets.find((item) => item.id === selectedPresetId);
            if (preset) onApplyPreset?.(preset);
          }}>{t("directorApplyPreset")}</Button>
          <Button type="button" size="icon-sm" variant="ghost" disabled={!onDeletePreset || !selectedPresetId} aria-label={t("directorDeletePreset")} onClick={() => {
            onDeletePreset?.(selectedPresetId);
            setSelectedPresetId("");
          }}><Trash2 /></Button>
        </section>
      </footer>
    </section>
  );
}
