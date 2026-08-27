import { Field } from "@base-ui/react/field";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Brush, Eraser, Eye, ImagePlus, RotateCcw, Undo2, Upload } from "lucide-react";
import {
  useEffect,
  useCallback,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clearAssetDragData, hasAssetDragData, readActiveAssetDragId, readAssetDragId, subscribeToAssetPointerDrop } from "@/assetDrag";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";
import { renderSelectionMask } from "@/mask";
import { resolveAssetSource, type MaskPoint, type MaskStroke, type SessionAsset } from "@/studio";

const BRUSH_SIZES = [0.025, 0.05, 0.09] as const;
const maskBuffers = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

function renderStrokes(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  strokes: MaskStroke[],
  preview: boolean,
  viewMode: "fit" | "actual",
) {
  const stage = canvas.parentElement;
  if (!stage || !image.naturalWidth || !image.naturalHeight) return;
  const scale = viewMode === "fit"
    ? Math.min(stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight)
    : 1;
  image.style.width = `${Math.max(1, Math.round(image.naturalWidth * scale))}px`;
  image.style.height = `${Math.max(1, Math.round(image.naturalHeight * scale))}px`;
  const stageRect = stage.getBoundingClientRect();
  const imageRect = image.getBoundingClientRect();
  if (!imageRect.width || !imageRect.height) return;
  canvas.style.left = `${imageRect.left - stageRect.left + stage.scrollLeft}px`;
  canvas.style.top = `${imageRect.top - stageRect.top + stage.scrollTop}px`;
  canvas.style.width = `${imageRect.width}px`;
  canvas.style.height = `${imageRect.height}px`;
  const pixelScale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(imageRect.width * pixelScale));
  const height = Math.max(1, Math.round(imageRect.height * pixelScale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  const mask = maskBuffers.get(canvas) ?? document.createElement("canvas");
  maskBuffers.set(canvas, mask);
  mask.width = width;
  mask.height = height;
  const maskContext = mask.getContext("2d");
  if (!maskContext) return;
  renderSelectionMask(maskContext, strokes, width, height);
  if (preview) {
    context.fillStyle = "rgba(8, 8, 10, .86)";
    context.fillRect(0, 0, width, height);
    context.drawImage(mask, 0, 0);
  } else {
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = "source-in";
    context.fillStyle = "rgba(255, 58, 92, .72)";
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "source-over";
  }
}

function MaskCanvas({
  asset,
  strokes,
  brushSize,
  editing,
  tool,
  preview,
  viewMode,
  onChange,
}: {
  asset: SessionAsset;
  strokes: MaskStroke[];
  brushSize: number;
  editing: boolean;
  tool: "paint" | "erase";
  preview: boolean;
  viewMode: "fit" | "actual";
  onChange: (strokes: MaskStroke[]) => void;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const activeStroke = useRef<MaskStroke | null>(null);
  const workingStrokes = useRef<MaskStroke[]>(strokes);
  const [source, setSource] = useState(asset.externalUrl ?? "");
  const [keyboardCursor, setKeyboardCursor] = useState<MaskPoint>({ x: .5, y: .5 });
  const [keyboardFocused, setKeyboardFocused] = useState(false);

  const redraw = useCallback((nextStrokes = workingStrokes.current) => {
    if (canvasRef.current && imageRef.current) {
      renderStrokes(canvasRef.current, imageRef.current, nextStrokes, preview, viewMode);
    }
  }, [preview, viewMode]);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    void resolveAssetSource(asset).then((value) => {
      if (!active) {
        if (value.startsWith("blob:")) URL.revokeObjectURL(value);
        return;
      }
      objectUrl = value;
      setSource(value);
    });
    return () => {
      active = false;
      if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [asset]);

  useEffect(() => {
    if (!activeStroke.current) workingStrokes.current = strokes;
    redraw(strokes);
  }, [redraw, source, strokes, viewMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    const handleResize = () => renderStrokes(canvas, image, workingStrokes.current, preview, viewMode);
    const observer = new ResizeObserver(handleResize);
    observer.observe(image);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, [source, preview, viewMode]);

  const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>): MaskPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const finishStroke = () => {
    if (!activeStroke.current) return;
    const committed = workingStrokes.current.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        x: Number(point.x.toFixed(4)),
        y: Number(point.y.toFixed(4)),
      })),
    }));
    activeStroke.current = null;
    workingStrokes.current = committed;
    onChange(committed);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && strokes.length) {
      event.preventDefault();
      onChange(strokes.slice(0, -1));
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? .05 : .01;
      setKeyboardCursor((current) => ({
        x: Math.max(0, Math.min(1, current.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0))),
        y: Math.max(0, Math.min(1, current.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0))),
      }));
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      const point = { x: Number(keyboardCursor.x.toFixed(4)), y: Number(keyboardCursor.y.toFixed(4)) };
      onChange([...strokes, { size: brushSize, operation: tool, points: [point, point] }]);
    }
  };

  useEffect(() => {
    if (!editing || preview || !strokes.length) return;
    const undoMask = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      event.stopPropagation();
      onChange(strokes.slice(0, -1));
      canvasRef.current?.focus();
    };
    window.addEventListener("keydown", undoMask, true);
    return () => window.removeEventListener("keydown", undoMask, true);
  }, [editing, onChange, preview, strokes]);

  return (
    <div className={`mask-stage ${viewMode}`}>
      {source ? <img ref={imageRef} src={source} alt={asset.name} onLoad={() => {
        redraw();
      }} /> : <span className="asset-missing" />}
      <canvas
        ref={canvasRef}
        className={editing && !preview ? `drawing ${tool}` : ""}
        aria-label={t("maskDrawingCanvas")}
        aria-description={t("maskKeyboardHint")}
        aria-disabled={!editing || preview}
        tabIndex={editing && !preview ? 0 : -1}
        onKeyDown={handleKeyDown}
        onFocus={() => setKeyboardFocused(true)}
        onBlur={() => setKeyboardFocused(false)}
        onPointerDown={(event) => {
          if (!editing || preview) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          activeStroke.current = { size: brushSize, operation: tool, points: [pointFor(event)] };
          workingStrokes.current = [...strokes, activeStroke.current];
          redraw();
        }}
        onPointerMove={(event) => {
          if (!editing || preview || !activeStroke.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const point = pointFor(event);
          const previous = activeStroke.current.points.at(-1);
          if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < .0025) return;
          if (activeStroke.current.points.length < 1500) activeStroke.current.points.push(point);
          redraw();
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          finishStroke();
        }}
        onPointerCancel={finishStroke}
      />
      {keyboardFocused && editing && !preview ? <span className="mask-keyboard-cursor" aria-hidden="true" style={{ left: `${keyboardCursor.x * 100}%`, top: `${keyboardCursor.y * 100}%`, width: brushSize, height: brushSize }} /> : null}
    </div>
  );
}

export function ImageEditPanel({
  asset,
  targetLabel,
  maskStrokes,
  maskInstructions,
  maskError,
  onMaskStrokesChange,
  onMaskInstructionsChange,
  onDropAsset,
  onImport,
  onPick,
}: {
  asset: SessionAsset | null;
  targetLabel: string;
  maskStrokes?: MaskStroke[];
  maskInstructions?: string;
  maskError?: string | null;
  onMaskStrokesChange: (strokes: MaskStroke[]) => void;
  onMaskInstructionsChange: (instructions: string) => void;
  onDropAsset: (assetId: string) => void;
  onImport: (files: FileList | File[]) => Promise<void>;
  onPick: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);
  const [editingMask, setEditingMask] = useState(false);
  const [maskTool, setMaskTool] = useState<"paint" | "erase">("paint");
  const [previewMask, setPreviewMask] = useState(false);
  const [viewMode, setViewMode] = useState<"fit" | "actual">("fit");
  const [brushSize, setBrushSize] = useState<number>(BRUSH_SIZES[1]);
  const strokes = maskStrokes ?? [];
  const supportsMask = Boolean(asset);

  useEffect(() => subscribeToAssetPointerDrop("edit", (assetId) => {
    setDragging(false);
    onDropAsset(assetId);
  }), [onDropAsset]);

  const acceptDrop = (event: ReactDragEvent) =>
    hasAssetDragData(event.dataTransfer) || Array.from(event.dataTransfer.types).includes("Files");

  return (
    <section
      className={`edit-media-panel ${dragging ? "dragging" : ""}`}
      data-asset-drop-target="edit"
      onDragEnter={(event) => {
        if (!acceptDrop(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!acceptDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onPointerEnter={(event) => {
        if ((event.buttons & 1) && readActiveAssetDragId()) setDragging(true);
      }}
      onPointerMove={(event) => {
        if ((event.buttons & 1) && readActiveAssetDragId()) setDragging(true);
      }}
      onPointerLeave={() => {
        if (readActiveAssetDragId()) setDragging(false);
      }}
      onPointerUp={(event) => {
        const assetId = readActiveAssetDragId();
        if (!assetId) return;
        event.preventDefault();
        setDragging(false);
        onDropAsset(assetId);
        clearAssetDragData();
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const assetId = readAssetDragId(event.dataTransfer);
        if (assetId) onDropAsset(assetId);
        else if (event.dataTransfer.files.length) void onImport(event.dataTransfer.files);
      }}
    >
      <header className="edit-media-header">
        <div>
          <span className="panel-eyebrow">{t("editCanvas")}</span>
          <strong>{asset ? asset.name : t("chooseEditImage")}</strong>
          <small>{asset ? targetLabel : t("editCanvasDropHint")}</small>
        </div>
        <div className="edit-media-actions">
          {asset ? (
            <ToggleGroup
              className="canvas-view-switch"
              aria-label={t("canvasView")}
              value={[viewMode]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "fit" || next === "actual") setViewMode(next);
              }}
            >
              <Toggle value="fit">{t("fitView")}</Toggle>
              <Toggle value="actual">{t("actualSize")}</Toggle>
            </ToggleGroup>
          ) : null}
          {supportsMask ? (
            <Button
              type="button"
              size="sm"
              variant={editingMask ? "default" : "outline"}
              aria-pressed={editingMask}
              onClick={() => {
                setPreviewMask(false);
                setEditingMask((value) => !value);
              }}
            >
              <Brush /> {editingMask ? t("finishMask") : t("drawMask")}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={() => void onPick()}>
            <Upload /> {asset ? t("replace") : t("chooseFiles")}
          </Button>
        </div>
      </header>

      {asset ? (
        <MaskCanvas
          asset={asset}
          strokes={strokes}
          brushSize={brushSize}
          editing={editingMask}
          tool={maskTool}
          preview={previewMask}
          viewMode={viewMode}
          onChange={onMaskStrokesChange}
        />
      ) : (
        <Button type="button" variant="ghost" className="edit-media-empty" onClick={() => void onPick()}>
          <ImagePlus />
          <strong>{t("dropEditImage")}</strong>
          <small>{t("editCanvasDropHint")}</small>
        </Button>
      )}

      {supportsMask ? (
        <div className={`mask-controls ${strokes.length ? "active" : ""}`}>
          <div className="mask-status" aria-live="polite">
            <span className={strokes.length ? "ready" : ""} />
            <strong>{strokes.length ? t("maskReady", { count: strokes.length }) : t("noMask")}</strong>
            <small>{strokes.length ? t("maskTransparencyHint") : t("drawMaskHint")}</small>
          </div>
          <div className="mask-toolbar" aria-label={t("maskTools")}>
            <ToggleGroup
              className="mask-tool-switch"
              aria-label={t("maskTools")}
              value={[maskTool]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "paint" || next === "erase") {
                  setMaskTool(next);
                  setEditingMask(true);
                  setPreviewMask(false);
                }
              }}
            >
              <Toggle value="paint"><Brush /> {t("paintMask")}</Toggle>
              <Toggle value="erase" disabled={!strokes.length}><Eraser /> {t("eraseMask")}</Toggle>
            </ToggleGroup>
            <span className="mask-size-label">{t("brushSize")}</span>
            {BRUSH_SIZES.map((size, index) => (
              <Button
                type="button"
                key={size}
                variant={brushSize === size ? "default" : "outline"}
                size="icon-sm"
                aria-label={t("brushSizeValue", { value: index + 1 })}
                onClick={() => setBrushSize(size)}
              >
                <i style={{ width: 4 + index * 4, height: 4 + index * 4 }} />
              </Button>
            ))}
            <span className="mask-toolbar-spacer" />
            <Button
              type="button"
              variant={previewMask ? "default" : "ghost"}
              size="sm"
              disabled={!strokes.length}
              aria-pressed={previewMask}
              onClick={() => {
                setEditingMask(false);
                setPreviewMask((value) => !value);
              }}
            >
              <Eye /> {t("previewMask")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={!strokes.length} onClick={() => onMaskStrokesChange(strokes.slice(0, -1))}>
              <Undo2 /> {t("undo")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={!strokes.length} onClick={() => {
              onMaskStrokesChange([]);
              onMaskInstructionsChange("");
              setMaskTool("paint");
              setPreviewMask(false);
            }}>
              <Eraser /> {t("clearMask")}
            </Button>
          </div>
          <Field.Root className="mask-instructions" invalid={Boolean(maskError)}>
            <Field.Label><RotateCcw /> {t("maskInstructions")}</Field.Label>
            <Field.Description>{strokes.length ? t("maskInstructionsHint") : t("drawMaskHint")}</Field.Description>
            <Textarea
              rows={3}
              disabled={!strokes.length}
              value={maskInstructions}
              placeholder={t("maskInstructionsPlaceholder")}
              onChange={(event) => onMaskInstructionsChange(event.target.value)}
            />
            {maskError ? <Field.Error className="field-error mask-field-error" match>{maskError}</Field.Error> : null}
          </Field.Root>
        </div>
      ) : null}
      {dragging ? <div className="edit-media-drop-overlay"><Upload /> {t("releaseToUse")}</div> : null}
    </section>
  );
}
