import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { Progress } from "@base-ui/react/progress";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { AudioLines, Check, Download, Eye, FolderOpen, ImageIcon, Paintbrush, Plus, RefreshCw, Trash2, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AssetPreview } from "@/components/AssetPreview";
import { beginAssetPointerDrag, clearAssetDragData } from "@/assetDrag";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast-manager";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n, type MessageKey } from "@/i18n";
import { isTauriRuntime } from "@/openrouter";
import { exportAssetToDownloads, type SessionAsset, type SessionVideoJob } from "@/studio";
import { formatElapsedClock } from "@/videoPolling";

const ORIGIN_KEYS: Record<SessionAsset["origin"], MessageKey> = {
  upload: "originUpload",
  generated: "originGenerated",
  edited: "originEdited",
};

const STATUS_KEYS: Record<string, MessageKey> = {
  pending: "statusPending",
  in_progress: "statusInProgress",
  failed: "statusFailed",
  completed: "statusCompleted",
};

export function AssetLibrary({
  assets,
  selectedIds,
  onSelectedIdsChange,
  onImport,
  onPick,
  onUse,
  onEdit,
  onDelete,
  onReimport,
  jobs,
  highlightedIds = new Set(),
  onFocusedAssetChange,
  onPreviewAssetChange,
}: {
  assets: SessionAsset[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onImport: (files: FileList | File[]) => Promise<void>;
  onPick: () => Promise<void>;
  onUse: (assetId: string) => void;
  onEdit: (assetId: string) => void;
  onDelete: (ids: string[]) => void;
  onReimport: (assetId: string) => void;
  jobs: SessionVideoJob[];
  highlightedIds?: Set<string>;
  onFocusedAssetChange?: (assetId: string | null) => void;
  onPreviewAssetChange?: (assetId: string | null) => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<SessionAsset | null>(null);
  const [filter, setFilter] = useState<"all" | "image" | "video" | "audio">("all");
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [rovingAssetId, setRovingAssetId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const tileRefs = useRef(new Map<string, HTMLElement>());
  const visibleAssets = assets
    .filter((asset) => filter === "all" || asset.kind === filter)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visibleIds = new Set(visibleAssets.map((asset) => asset.id));
  const visibleSelectedIds = [...selectedIds].filter((id) => visibleIds.has(id));
  const allVisibleSelected = visibleAssets.length > 0 && visibleAssets.every((asset) => selectedIds.has(asset.id));
  const storageBytes = assets.reduce((total, asset) => total + (asset.byteSize ?? 0), 0);
  const previewAsset = preview ? assets.find((asset) => asset.id === preview.id) ?? preview : null;

  useEffect(() => {
    if (!jobs.length) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [jobs.length]);

  useEffect(() => {
    if (!visibleAssets.length) {
      setRovingAssetId(null);
      return;
    }
    if (!rovingAssetId || !visibleAssets.some((asset) => asset.id === rovingAssetId)) {
      setRovingAssetId(visibleAssets[0].id);
    }
  }, [rovingAssetId, visibleAssets]);

  useEffect(() => {
    const firstId = highlightedIds.values().next().value as string | undefined;
    if (!firstId) return;
    const firstAsset = assets.find((asset) => asset.id === firstId);
    if (firstAsset && filter !== "all" && filter !== firstAsset.kind) {
      setFilter("all");
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      tileRefs.current.get(firstId)?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [assets, filter, highlightedIds]);

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedIdsChange(next);
  };

  const exportAsset = async (asset: SessionAsset) => {
    try {
      const path = await exportAssetToDownloads(asset);
      toast.success(t("downloadComplete", { name: asset.name, path }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const revealAsset = async (asset: SessionAsset) => {
    if (!asset.localPath || !isTauriRuntime()) return;
    try {
      await revealItemInDir(asset.localPath);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    onPreviewAssetChange?.(previewAsset?.id ?? null);
    if (!previewAsset) return;
    onFocusedAssetChange?.(previewAsset.id);
    const handlePreviewKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = visibleAssets.findIndex((asset) => asset.id === previewAsset.id);
      if (index < 0 || visibleAssets.length < 2) return;
      const offset = event.key === "ArrowRight" ? 1 : -1;
      setPreview(visibleAssets[(index + offset + visibleAssets.length) % visibleAssets.length]);
    };
    window.addEventListener("keydown", handlePreviewKey, true);
    return () => window.removeEventListener("keydown", handlePreviewKey, true);
  }, [onFocusedAssetChange, onPreviewAssetChange, previewAsset, visibleAssets]);

  return (
    <aside
      className={`asset-library ${draggingFiles ? "dragging-files" : ""}`}
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.matches("input, textarea, select, [contenteditable='true']")) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
          event.preventDefault();
          onSelectedIdsChange(new Set(visibleAssets.map((asset) => asset.id)));
        } else if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
          const ids = visibleSelectedIds.length
            ? visibleSelectedIds
            : target.closest<HTMLElement>("[data-asset-id]")?.dataset.assetId
              ? [target.closest<HTMLElement>("[data-asset-id]")!.dataset.assetId!]
              : [];
          if (ids.length) {
            event.preventDefault();
            onDelete(ids);
          }
        }
      }}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        setDraggingFiles(false);
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        void onImport(event.dataTransfer.files);
      }}
    >
      <header className="asset-library-header">
        <div>
          <span className="panel-eyebrow">{t("currentSession")}</span>
          <strong>{t("assetLibrary")} <small>{assets.length}</small></strong>
          <p>{t("assetLibraryHint")}</p>
        </div>
        <div className="asset-library-actions">
          <Button size="icon-sm" variant="outline" aria-label={t("importAssets")} aria-keyshortcuts="Meta+O" onClick={() => void onPick()}><Plus /></Button>
        </div>
      </header>

      <div className="asset-toolbar">
        <ToggleGroup
          className="asset-filters"
          value={[filter]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "all" || next === "image" || next === "video" || next === "audio") {
              const nextVisible = new Set(assets.filter((asset) => next === "all" || asset.kind === next).map((asset) => asset.id));
              const intersection = new Set([...selectedIds].filter((id) => nextVisible.has(id)));
              if (intersection.size !== selectedIds.size) toast.info(t("hiddenSelectionCleared"));
              onSelectedIdsChange(intersection);
              setFilter(next);
            }
          }}
        >
          {(["all", "image", "video", "audio"] as const).map((value) => (
            <Toggle className="asset-filter" aria-label={t("showAssets", { kind: value === "all" ? t("all") : t(value) })} value={value} key={value}>
              {value === "all" ? t("all") : t(value)}
            </Toggle>
          ))}
        </ToggleGroup>
        {selectedIds.size ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`${t("deleteAssets")} (${visibleSelectedIds.length})`}
            aria-keyshortcuts="Meta+Backspace"
            onClick={() => onDelete(visibleSelectedIds)}
          >
            <Trash2 /> {visibleSelectedIds.length}
          </Button>
        ) : null}
      </div>

      <ScrollArea className="asset-grid" contentClassName="asset-grid-content">
        {!assets.length ? (
          <Button variant="ghost" className="asset-empty" onClick={() => void onPick()}>
            <Plus />
            <span>{t("importMedia")}</span>
            <small>{t("dropFilesHint")}</small>
          </Button>
        ) : null}
        {jobs.map((job) => (
          <Progress.Root className="asset-job" key={job.jobId} value={job.progress ?? null} render={<article />}>
            <span className="asset-job-icon"><Video /></span>
            <Progress.Label className="asset-job-label"><strong>{job.status === "failed" ? t("videoJobFailed") : t("generatingVideo")}</strong></Progress.Label>
            <Progress.Value className="asset-job-value">{() => job.progress == null ? t(STATUS_KEYS[job.status] ?? "statusPending") : `${job.progress}%`}</Progress.Value>
            <small className="asset-job-timing">
              {t("videoElapsed", { time: formatElapsedClock(job.submittedAt, nowMs) })}
              {" · "}
              {job.lastPolledAt
                ? t("videoLastChecked", { time: formatElapsedClock(job.lastPolledAt, nowMs) })
                : t("videoFirstCheckPending")}
            </small>
            <Progress.Track className="asset-job-progress"><Progress.Indicator /></Progress.Track>
          </Progress.Root>
        ))}
        {visibleAssets.map((asset) => (
          <article
            key={asset.id}
            data-asset-id={asset.id}
            ref={(element) => {
              if (element) tileRefs.current.set(asset.id, element);
              else tileRefs.current.delete(asset.id);
            }}
            onFocusCapture={() => {
              setRovingAssetId(asset.id);
              onFocusedAssetChange?.(asset.id);
            }}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusedAssetChange?.(null);
            }}
            className={`asset-tile ${selectedIds.has(asset.id) ? "selected" : ""} ${highlightedIds.has(asset.id) ? "just-added" : ""} ${asset.storageAvailability === "missing" ? "storage-missing" : ""}`}
          >
            <Checkbox.Root
              className="asset-select"
              checked={selectedIds.has(asset.id)}
              onCheckedChange={(checked) => toggle(asset.id, checked)}
              aria-label={t("selectAsset", { name: asset.name })}
            >
              <Checkbox.Indicator><Check /></Checkbox.Indicator>
            </Checkbox.Root>
            <Button
              variant="ghost"
              className="asset-visual"
              onPointerDown={(event) => {
                if (event.button === 0) beginAssetPointerDrag(asset.id);
              }}
              onPointerUp={clearAssetDragData}
              onPointerCancel={clearAssetDragData}
              tabIndex={rovingAssetId === asset.id ? 0 : -1}
              onKeyDown={(event) => {
                if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
                if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault();
                const index = visibleAssets.findIndex((candidate) => candidate.id === asset.id);
                const offset = event.key === "ArrowRight" ? 1
                  : event.key === "ArrowLeft" ? -1
                    : event.key === "ArrowDown" ? 2 : -2;
                const next = visibleAssets[(index + offset + visibleAssets.length) % visibleAssets.length];
                const target = next && tileRefs.current.get(next.id)?.querySelector<HTMLButtonElement>(".asset-visual");
                if (next) setRovingAssetId(next.id);
                target?.focus();
              }}
              onClick={() => setPreview(asset)}
            >
              <AssetPreview asset={asset} />
              <span>{asset.storageAvailability === "missing" ? <><X />{t("managedFileMissing")}</> : <>{asset.kind === "image" ? <ImageIcon /> : asset.kind === "video" ? <Video /> : <AudioLines />}{t(ORIGIN_KEYS[asset.origin])}</>}</span>
            </Button>
            <footer>
              <span title={asset.name}>{asset.name}</span>
              <div>
                <Button variant="ghost" size="icon-xs" aria-label={t("export")} aria-keyshortcuts="Meta+Shift+E" disabled={asset.storageAvailability === "missing"} onClick={() => void exportAsset(asset)}><Download /></Button>
                <Button variant="ghost" size="icon-xs" aria-label={t("preview")} onClick={() => setPreview(asset)}><Eye /></Button>
                <Button variant="ghost" size="icon-xs" aria-label={t("useInput")} disabled={asset.storageAvailability === "missing"} onClick={() => onUse(asset.id)}><Plus /></Button>
                {asset.kind === "image" ? <Button variant="ghost" size="icon-xs" aria-label={t("editOnCanvas")} disabled={asset.storageAvailability === "missing"} onClick={() => onEdit(asset.id)}><Paintbrush /></Button> : null}
              </div>
            </footer>
          </article>
        ))}
      </ScrollArea>

      <footer className="asset-library-footer">
        {visibleAssets.length ? (
          <Button size="xs" variant="ghost" onClick={() => onSelectedIdsChange(allVisibleSelected ? new Set() : new Set(visibleAssets.map((asset) => asset.id)))}>
            {allVisibleSelected ? t("clearSelection") : t("selectVisible")}
          </Button>
        ) : <span>{t("noAssets", { kind: filter === "all" ? "" : `${t(filter)} ` })}</span>}
        <span>{(storageBytes / 1024 / 1024).toFixed(1)} MB · {t("localStorage")}</span>
      </footer>
      {draggingFiles ? <div className="asset-library-drop-overlay"><Plus /> <strong>{t("releaseToImport")}</strong><small>{t("dropFilesHint")}</small></div> : null}

      <Dialog.Root open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="preview-backdrop" />
          <Dialog.Viewport className="preview-viewport">
            <Dialog.Popup className="asset-preview-dialog">
              <header>
                <span>
                  <Dialog.Title>{previewAsset?.name}</Dialog.Title>
                  <Dialog.Description>{previewAsset ? t(previewAsset.kind) : ""} · {previewAsset ? t(ORIGIN_KEYS[previewAsset.origin]) : ""} · {previewAsset?.byteSize ? `${(previewAsset.byteSize / 1024 / 1024).toFixed(2)} MB · ` : ""}{previewAsset?.storageAvailability === "missing" ? t("managedFileMissing") : t("localStorage")}</Dialog.Description>
                </span>
                <div>
                  {previewAsset?.storageAvailability === "missing" ? <Button variant="outline" size="sm" onClick={() => onReimport(previewAsset.id)}><RefreshCw /> {t("reimportAsset")}</Button> : null}
                  {previewAsset?.localPath && previewAsset.storageAvailability !== "missing" && isTauriRuntime() ? <Button variant="ghost" size="sm" onClick={() => void revealAsset(previewAsset)}><FolderOpen /> {t("revealInFinder")}</Button> : null}
                  {previewAsset && previewAsset.storageAvailability !== "missing" ? <Button variant="ghost" size="sm" onClick={() => void exportAsset(previewAsset)}><Download /> {t("export")}</Button> : null}
                  <Dialog.Close render={<Button variant="ghost" size="icon" />} aria-label={t("closePreview")}><X /></Dialog.Close>
                </div>
              </header>
              {previewAsset ? <AssetPreview asset={previewAsset} controls transparentControls interactiveError /> : null}
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </aside>
  );
}
