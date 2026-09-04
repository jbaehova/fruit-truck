import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  clampNormalizedPoint,
  computeCameraPreviewTransform,
  computeSubjectPreviewTransform,
  directorPointDistance,
  normalizePointToContent,
  simplifyDirectorPath,
  type ContentBounds,
} from "@/director/preview";
import type {
  DirectorMotion,
  DirectorMotionTarget,
  DirectorPlan,
  DirectorRegion,
  DirectorSubject,
  NormalizedPoint,
} from "@/director/types";
import { useI18n } from "@/i18n";

export type DirectorCanvasTool = "select" | "subject" | "subject_polygon" | "object_path" | "camera_path";
export type DirectorCanvasSelection =
  | { type: "subject"; id: string }
  | { type: "motion"; id: string }
  | null;

export type DirectorCanvasProps = {
  plan: DirectorPlan;
  sourceUrl?: string;
  assetUrls?: Readonly<Record<string, string>>;
  sourceAlt: string;
  tool: DirectorCanvasTool;
  selection: DirectorCanvasSelection;
  previewProgress: number;
  visibleMotionIds?: ReadonlySet<string>;
  availableAssetIds?: ReadonlySet<string>;
  disabled?: boolean;
  onSelect: (selection: DirectorCanvasSelection) => void;
  onCreateSubject: (region: DirectorRegion) => void;
  onCreateMotion: (targetType: DirectorMotionTarget, path: NormalizedPoint[]) => void;
  onNudgeSelection: (delta: NormalizedPoint) => void;
  onDeleteSelection: () => void;
};

type ActiveGesture =
  | { type: "subject"; regionType: "box" | "polygon"; start: NormalizedPoint; points: NormalizedPoint[] }
  | { type: "motion"; targetType: DirectorMotionTarget; start: NormalizedPoint; points: NormalizedPoint[] };

function boxFromPoints(start: NormalizedPoint, end: NormalizedPoint): Extract<DirectorRegion, { type: "box" }> {
  return {
    type: "box",
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x),
    height: Math.abs(start.y - end.y),
  };
}

function pathPoints(points: readonly NormalizedPoint[]) {
  return points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ");
}

function regionBounds(region: DirectorRegion) {
  if (region.type === "box") return region;
  const xs = region.points.map((point) => point.x);
  const ys = region.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function regionStyle(region: DirectorRegion) {
  const bounds = regionBounds(region);
  return {
    left: `${bounds.x * 100}%`,
    top: `${bounds.y * 100}%`,
    width: `${bounds.width * 100}%`,
    height: `${bounds.height * 100}%`,
    ...(region.type === "polygon" && bounds.width > 0 && bounds.height > 0 ? {
      clipPath: `polygon(${region.points.map((point) => `${(point.x - bounds.x) / bounds.width * 100}% ${(point.y - bounds.y) / bounds.height * 100}%`).join(", ")})`,
    } : {}),
  };
}

function previewTransformStyle(transform: ReturnType<typeof computeCameraPreviewTransform>) {
  return {
    opacity: transform.opacity,
    transform: `translate(${transform.translateX * 100}%, ${transform.translateY * 100}%) scale(${transform.scale}) rotate(${transform.rotateDegrees}deg)`,
  };
}

export function DirectorCanvas({
  plan,
  sourceUrl,
  assetUrls,
  sourceAlt,
  tool,
  selection,
  previewProgress,
  visibleMotionIds,
  availableAssetIds,
  disabled = false,
  onSelect,
  onCreateSubject,
  onCreateMotion,
  onNudgeSelection,
  onDeleteSelection,
}: DirectorCanvasProps) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const [draftPoints, setDraftPoints] = useState<NormalizedPoint[]>([]);
  const [keyboardCursor, setKeyboardCursor] = useState<NormalizedPoint>({ x: 0.5, y: 0.5 });
  const [keyboardPoints, setKeyboardPoints] = useState<NormalizedPoint[]>([]);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [intrinsicSize, setIntrinsicSize] = useState({
    width: plan.canvas?.sourceWidth ?? 16,
    height: plan.canvas?.sourceHeight ?? 9,
  });
  const [contentBounds, setContentBounds] = useState<ContentBounds>({ left: 0, top: 0, width: 1, height: 1 });

  const measureContent = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    if (!width || !height || !intrinsicSize.width || !intrinsicSize.height) return;
    const scale = Math.min(width / intrinsicSize.width, height / intrinsicSize.height);
    const renderedWidth = intrinsicSize.width * scale;
    const renderedHeight = intrinsicSize.height * scale;
    setContentBounds({
      left: (width - renderedWidth) / 2,
      top: (height - renderedHeight) / 2,
      width: renderedWidth,
      height: renderedHeight,
    });
  }, [intrinsicSize.height, intrinsicSize.width]);

  useEffect(() => {
    measureContent();
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(measureContent);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [measureContent]);

  const visibleMotions = useMemo(
    () => visibleMotionIds ? plan.motions.filter((motion) => visibleMotionIds.has(motion.id)) : plan.motions,
    [plan.motions, visibleMotionIds],
  );
  const cameraTransform = useMemo(() => computeCameraPreviewTransform(visibleMotions, previewProgress), [previewProgress, visibleMotions]);

  useEffect(() => {
    setKeyboardPoints([]);
  }, [tool]);

  const pointFor = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return normalizePointToContent(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      contentBounds,
    );
  };

  const finishGesture = (event: PointerEvent<HTMLDivElement>) => {
    const active = gestureRef.current;
    if (!active) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    gestureRef.current = null;
    setDraftPoints([]);
    const last = active.points.at(-1) ?? active.start;
    if (active.type === "subject") {
      if (active.regionType === "polygon") {
        const polygon = simplifyDirectorPath(active.points);
        if (polygon.length >= 3) onCreateSubject({ type: "polygon", points: polygon });
        return;
      }
      const box = boxFromPoints(active.start, last);
      if (box.width >= 0.01 && box.height >= 0.01) onCreateSubject(box);
      return;
    }
    const simplified = simplifyDirectorPath(active.points);
    if (simplified.length >= 2 && directorPointDistance(simplified[0], simplified.at(-1)!) >= 0.01) {
      onCreateMotion(active.targetType, simplified);
    }
  };

  const canDraw = Boolean(sourceUrl) && !disabled;
  const finishKeyboardPath = (points: NormalizedPoint[]) => {
    const simplified = simplifyDirectorPath(points);
    if (tool === "subject_polygon") {
      if (simplified.length >= 3) onCreateSubject({ type: "polygon", points: simplified });
    } else if (tool === "object_path" || tool === "camera_path") {
      if (simplified.length >= 2 && directorPointDistance(simplified[0], simplified.at(-1)!) >= 0.01) {
        onCreateMotion(tool === "camera_path" ? "camera" : "subject", simplified);
      }
    }
    setKeyboardPoints([]);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.currentTarget !== surfaceRef.current) event.stopPropagation();
    if (tool !== "select" && canDraw) {
      if (event.key === "Escape") {
        event.preventDefault();
        setKeyboardPoints([]);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        setKeyboardPoints((points) => points.slice(0, -1));
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 0.05 : 0.01;
        setKeyboardCursor((cursor) => clampNormalizedPoint({
          x: cursor.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
          y: cursor.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
        }));
        return;
      }
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (tool === "subject") {
          const start = keyboardPoints[0];
          if (!start) setKeyboardPoints([keyboardCursor]);
          else {
            const box = boxFromPoints(start, keyboardCursor);
            if (box.width >= 0.01 && box.height >= 0.01) onCreateSubject(box);
            setKeyboardPoints([]);
          }
          return;
        }
        const points = [...keyboardPoints];
        if (!points.length || directorPointDistance(points.at(-1)!, keyboardCursor) >= 0.003) points.push(keyboardCursor);
        if (event.key === " " || points.length < (tool === "subject_polygon" ? 3 : 2)) setKeyboardPoints(points);
        else finishKeyboardPath(points);
        return;
      }
      return;
    }
    if (!selection || disabled) return;
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      onDeleteSelection();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onSelect(null);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.05 : 0.01;
    onNudgeSelection({
      x: event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0,
      y: event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0,
    });
  };

  const draftBox = gestureRef.current?.type === "subject" && draftPoints.length
    && gestureRef.current.regionType === "box"
    ? boxFromPoints(gestureRef.current.start, draftPoints.at(-1)!)
    : undefined;
  const draftPolygon = gestureRef.current?.type === "subject" && gestureRef.current.regionType === "polygon"
    ? draftPoints
    : [];
  const keyboardDraftPoints = keyboardPoints.length
    ? directorPointDistance(keyboardPoints.at(-1)!, keyboardCursor) >= 0.001 ? [...keyboardPoints, keyboardCursor] : keyboardPoints
    : [];
  const keyboardDraftBox = tool === "subject" && keyboardPoints[0] ? boxFromPoints(keyboardPoints[0], keyboardCursor) : undefined;
  const describedBy = !sourceUrl ? "director-canvas-missing" : "director-canvas-help";

  return (
    <section className="director-canvas-shell" aria-labelledby="director-canvas-title">
      <header className="director-canvas-heading">
        <div>
          <p className="director-eyebrow">{t("directorSourceFrame")}</p>
          <h2 id="director-canvas-title">{t("directorCanvas")}</h2>
        </div>
        <p id="director-canvas-help">{tool === "select" ? t("directorCanvasKeyboardHint") : t("directorCanvasKeyboardDrawHint")}</p>
      </header>
      <div
        ref={surfaceRef}
        className="director-canvas-surface"
        data-tool={tool}
        data-empty={!sourceUrl || undefined}
        role="application"
        aria-label={t("directorCanvasAria")}
        aria-describedby={describedBy}
        aria-disabled={!canDraw}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onFocus={() => setKeyboardFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardFocused(false);
        }}
        onPointerDown={(event) => {
          if (!canDraw) return;
          if (tool === "select") {
            if (!(event.target as Element).closest("button")) onSelect(null);
            return;
          }
          const point = pointFor(event);
          if (!point) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          gestureRef.current = tool === "subject" || tool === "subject_polygon"
            ? { type: "subject", regionType: tool === "subject_polygon" ? "polygon" : "box", start: point, points: [point] }
            : { type: "motion", targetType: tool === "camera_path" ? "camera" : "subject", start: point, points: [point] };
          setDraftPoints([point]);
        }}
        onPointerMove={(event) => {
          const active = gestureRef.current;
          if (!active || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const point = pointFor(event);
          if (!point) return;
          const previous = active.points.at(-1);
          if (previous && directorPointDistance(previous, point) < 0.003) return;
          active.points.push(point);
          setDraftPoints([...active.points]);
        }}
        onPointerUp={finishGesture}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          gestureRef.current = null;
          setDraftPoints([]);
        }}
      >
        {!sourceUrl ? (
          <div id="director-canvas-missing" className="director-canvas-empty">
            <strong>{t("directorFirstFrameRequired")}</strong>
            <span>{t("directorSourceFrameMissing")}</span>
          </div>
        ) : (
          <div
            className="director-canvas-content"
            style={{ left: contentBounds.left, top: contentBounds.top, width: contentBounds.width, height: contentBounds.height }}
          >
            <div className="director-preview-scene" style={previewTransformStyle(cameraTransform)} aria-hidden="true">
              <img
                src={sourceUrl}
                alt=""
                draggable={false}
                onLoad={(event) => setIntrinsicSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              />
              {plan.subjects.map((subject) => {
                const subjectUrl = assetUrls?.[subject.sourceAssetId]
                  ?? (subject.sourceAssetId === plan.sourceAssetId ? sourceUrl : undefined);
                return subjectUrl ? (
                  <SubjectPreview
                    key={subject.id}
                    subject={subject}
                    sourceUrl={subjectUrl}
                    transform={computeSubjectPreviewTransform(visibleMotions, subject.id, previewProgress)}
                  />
                ) : null;
              })}
            </div>
            <svg className="director-path-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id="director-object-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L0,6 L9,3 z" />
                </marker>
                <marker id="director-camera-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L0,6 L9,3 z" />
                </marker>
              </defs>
              {visibleMotions.filter((motion) => motion.path && motion.path.length > 1).map((motion) => (
                <MotionPath key={motion.id} motion={motion} selected={selection?.type === "motion" && selection.id === motion.id} />
              ))}
              {draftPoints.length > 1 && gestureRef.current?.type === "motion" ? (
                <polyline className="director-path-draft" data-target={gestureRef.current.targetType} points={pathPoints(draftPoints)} />
              ) : null}
              {draftPolygon.length > 1 ? <polyline className="director-region-draft" points={pathPoints(draftPolygon)} /> : null}
              {keyboardDraftPoints.length > 1 && (tool === "object_path" || tool === "camera_path") ? <polyline className="director-path-draft" data-target={tool === "camera_path" ? "camera" : "subject"} points={pathPoints(keyboardDraftPoints)} /> : null}
              {keyboardDraftPoints.length > 1 && tool === "subject_polygon" ? <polyline className="director-region-draft" points={pathPoints(keyboardDraftPoints)} /> : null}
            </svg>
            <div className="director-interaction-overlay">
              {plan.subjects.map((subject, index) => (
                <button
                  key={subject.id}
                  type="button"
                  className="director-subject-box"
                  data-region={subject.region.type}
                  data-missing={availableAssetIds && !availableAssetIds.has(subject.sourceAssetId) || undefined}
                  data-selected={selection?.type === "subject" && selection.id === subject.id || undefined}
                  style={regionStyle(subject.region)}
                  aria-label={`${t("directorSubject")} ${index + 1}: ${subject.label}${availableAssetIds && !availableAssetIds.has(subject.sourceAssetId) ? `, ${t("directorSubjectSourceMissing")}` : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect({ type: "subject", id: subject.id });
                  }}
                  onKeyDown={handleKeyDown}
                >
                  <span>{index + 1}</span>
                  <strong>{subject.label}</strong>
                  {availableAssetIds && !availableAssetIds.has(subject.sourceAssetId) ? <small>{t("directorMissingAssetShort")}</small> : null}
                </button>
              ))}
              {visibleMotions.filter((motion) => motion.path && motion.path.length > 1).map((motion) => {
                const start = motion.path![0];
                return (
                  <button
                    key={motion.id}
                    type="button"
                    className="director-path-hit-target"
                    data-target={motion.targetType}
                    data-selected={selection?.type === "motion" && selection.id === motion.id || undefined}
                    style={{ left: `${start.x * 100}%`, top: `${start.y * 100}%` }}
                    aria-label={`${motion.targetType === "camera" ? t("directorCameraPath") : t("directorObjectPath")} ${motion.order}: ${motion.actionLabel || motion.kind}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect({ type: "motion", id: motion.id });
                    }}
                    onKeyDown={handleKeyDown}
                  >
                    <span>{motion.order}</span>
                    <small>{motion.targetType === "camera" ? t("directorCamera") : t("directorObject")}</small>
                  </button>
                );
              })}
              {draftBox ? <span className="director-subject-box director-subject-draft" style={regionStyle(draftBox)} aria-hidden="true" /> : null}
              {keyboardDraftBox ? <span className="director-subject-box director-subject-draft" style={regionStyle(keyboardDraftBox)} aria-hidden="true" /> : null}
              {keyboardFocused && tool !== "select" ? <span className="director-keyboard-cursor" style={{ left: `${keyboardCursor.x * 100}%`, top: `${keyboardCursor.y * 100}%` }} aria-hidden="true" /> : null}
            </div>
          </div>
        )}
        <span className="sr-only">{sourceAlt}</span>
      </div>
    </section>
  );
}

function MotionPath({ motion, selected }: { motion: DirectorMotion; selected: boolean }) {
  return (
    <g className="director-motion-path" data-target={motion.targetType} data-selected={selected || undefined}>
      <polyline className="director-motion-path-line" points={pathPoints(motion.path ?? [])} markerEnd={`url(#director-${motion.targetType === "subject" ? "object" : "camera"}-arrow)`} />
    </g>
  );
}

function SubjectPreview({
  subject,
  sourceUrl,
  transform,
}: {
  subject: DirectorSubject;
  sourceUrl: string;
  transform: ReturnType<typeof computeSubjectPreviewTransform>;
}) {
  const bounds = regionBounds(subject.region);
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return (
    <span className="director-subject-preview" style={{
      ...regionStyle(subject.region),
      opacity: transform.opacity,
      transform: `translate(${transform.translateX / bounds.width * 100}%, ${transform.translateY / bounds.height * 100}%) scale(${transform.scale}) rotate(${transform.rotateDegrees}deg)`,
    }}>
      <img
        src={sourceUrl}
        alt=""
        style={{
          width: `${100 / bounds.width}%`,
          maxWidth: "none",
          left: `${-(bounds.x / bounds.width) * 100}%`,
          top: `${-(bounds.y / bounds.height) * 100}%`,
        }}
      />
    </span>
  );
}

// oxlint-disable-next-line react/only-export-components
export function nudgeDirectorRegion(region: DirectorRegion, delta: NormalizedPoint): DirectorRegion {
  if (region.type === "polygon") {
    const bounds = regionBounds(region);
    const bounded = {
      x: Math.min(1 - bounds.x - bounds.width, Math.max(-bounds.x, delta.x)),
      y: Math.min(1 - bounds.y - bounds.height, Math.max(-bounds.y, delta.y)),
    };
    return { type: "polygon", points: region.points.map((point) => clampNormalizedPoint({ x: point.x + bounded.x, y: point.y + bounded.y })) };
  }
  return {
    ...region,
    x: Math.min(1 - region.width, Math.max(0, region.x + delta.x)),
    y: Math.min(1 - region.height, Math.max(0, region.y + delta.y)),
  };
}
