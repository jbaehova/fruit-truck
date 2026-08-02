import { Checkbox } from "@base-ui/react/checkbox";
import { Dialog } from "@base-ui/react/dialog";
import { Progress } from "@base-ui/react/progress";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Check, Download, Eye, Film, ImageIcon, Plus, Trash2, Video, X } from "lucide-react";
import { useState } from "react";
import { AssetPreview } from "@/components/AssetPreview";
import { beginAssetPointerDrag, clearAssetDragData } from "@/assetDrag";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast-manager";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n, type MessageKey } from "@/i18n";
import { exportAssetToDownloads, type SessionAsset, type SessionVideoJob } from "@/studio";
import type { ArtifactNode } from "@/agent";

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
  onDelete,
  jobs,
  artifacts,
  approvedVideoCount,
  onOpenAssembly,
}: {
  assets: SessionAsset[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onImport: (files: FileList | File[]) => Promise<void>;
  onPick: () => Promise<void>;
  onUse: (assetId: string) => void;
  onDelete: (ids: string[]) => void;
  jobs: SessionVideoJob[];
  artifacts: ArtifactNode[];
  approvedVideoCount: number;
  onOpenAssembly: () => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<SessionAsset | null>(null);
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [draggingFiles, setDraggingFiles] = useState(false);
  const visibleAssets = assets
    .filter((asset) => filter === "all" || asset.kind === filter)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

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

  return (
    <aside
      className={`asset-library ${draggingFiles ? "dragging-files" : ""}`}
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
          {approvedVideoCount > 0 ? <Button size="xs" variant="outline" onClick={onOpenAssembly}><Film /> {t("makeFinalVideo")}</Button> : null}
          <Button size="icon-sm" variant="outline" aria-label={t("importAssets")} onClick={() => void onPick()}><Plus /></Button>
        </div>
      </header>

      <div className="asset-toolbar">
        <ToggleGroup
          className="asset-filters"
          value={[filter]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "all" || next === "image" || next === "video") setFilter(next);
          }}
        >
          {(["all", "image", "video"] as const).map((value) => (
            <Toggle className="asset-filter" aria-label={t("showAssets", { kind: value === "all" ? t("all") : t(value) })} value={value} key={value}>
              {value === "all" ? t("all") : t(value)}
            </Toggle>
          ))}
        </ToggleGroup>
        {selectedIds.size ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`${t("deleteAssets")} (${selectedIds.size})`}
            onClick={() => onDelete([...selectedIds])}
          >
            <Trash2 /> {selectedIds.size}
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
            <Progress.Track className="asset-job-progress"><Progress.Indicator /></Progress.Track>
          </Progress.Root>
        ))}
        {visibleAssets.map((asset) => (
          <article
            key={asset.id}
            className={`asset-tile ${selectedIds.has(asset.id) ? "selected" : ""}`}
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
              onClick={() => setPreview(asset)}
            >
              <AssetPreview asset={asset} />
              <span>{asset.kind === "image" ? <ImageIcon /> : <Video />}{t(ORIGIN_KEYS[asset.origin])}</span>
            </Button>
            <footer>
              <span title={asset.name}>{asset.name}</span>
              <div>
                <Button variant="ghost" size="icon-xs" aria-label={t("export")} onClick={() => void exportAsset(asset)}><Download /></Button>
                <Button variant="ghost" size="icon-xs" aria-label={t("preview")} onClick={() => setPreview(asset)}><Eye /></Button>
                <Button variant="ghost" size="icon-xs" aria-label={t("useInput")} onClick={() => onUse(asset.id)}><Plus /></Button>
              </div>
            </footer>
          </article>
        ))}
      </ScrollArea>

      <footer className="asset-library-footer">
        {visibleAssets.length ? (
          <Button size="xs" variant="ghost" onClick={() => onSelectedIdsChange(selectedIds.size === visibleAssets.length ? new Set() : new Set(visibleAssets.map((asset) => asset.id)))}>
            {selectedIds.size === visibleAssets.length ? t("clearSelection") : t("selectVisible")}
          </Button>
        ) : <span>{t("noAssets", { kind: filter === "all" ? "" : `${t(filter)} ` })}</span>}
      </footer>
      {draggingFiles ? <div className="asset-library-drop-overlay"><Plus /> <strong>{t("releaseToImport")}</strong><small>{t("dropFilesHint")}</small></div> : null}

      <Dialog.Root open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="preview-backdrop" />
          <Dialog.Viewport className="preview-viewport">
            <Dialog.Popup className="asset-preview-dialog">
              <header>
                <span>
                  <Dialog.Title>{preview?.name}</Dialog.Title>
                  <Dialog.Description>{preview ? t(preview.kind) : ""} · {preview ? t(ORIGIN_KEYS[preview.origin]) : ""} · {preview?.byteSize ? `${(preview.byteSize / 1024 / 1024).toFixed(2)} MB · ` : ""}{t("localStorage")}</Dialog.Description>
                </span>
                <div>
                  {preview ? <Button variant="ghost" size="sm" onClick={() => void exportAsset(preview)}><Download /> {t("export")}</Button> : null}
                  <Dialog.Close render={<Button variant="ghost" size="icon" />} aria-label={t("closePreview")}><X /></Dialog.Close>
                </div>
              </header>
              {preview ? <AssetPreview asset={preview} controls /> : null}
              {preview ? (() => {
                const artifact = artifacts.find((item) => item.assetId === preview.id);
                return artifact ? (
                  <details className="asset-provenance">
                    <summary>{t("provenanceDetails")}</summary>
                    <dl>
                      <div><dt>{t("role")}</dt><dd>{artifact.role}</dd></div>
                      <div><dt>{t("approval")}</dt><dd>{artifact.approval}</dd></div>
                      {artifact.generationBackend ? <div><dt>{t("generationBackend")}</dt><dd>{artifact.generationBackend === "codex_builtin" ? t("codexBuiltIn") : "OpenRouter"}</dd></div> : null}
                      {artifact.modelId ? <div><dt>{t("model")}</dt><dd>{artifact.modelId}</dd></div> : null}
                      {artifact.planStepId ? <div><dt>{t("sourceStep")}</dt><dd>{artifact.planStepId}</dd></div> : null}
                      <div><dt>{t("parentAssets")}</dt><dd>{artifact.parentAssetIds.length || t("none")}</dd></div>
                    </dl>
                    {artifact.evaluation ? <div className="asset-evaluation"><strong>{t("agentEvaluation")}</strong><p>{artifact.evaluation.technical}</p><p>{artifact.evaluation.aesthetic}</p><small>{artifact.evaluation.recommendation}</small></div> : null}
                  </details>
                ) : null;
              })() : null}
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </aside>
  );
}
