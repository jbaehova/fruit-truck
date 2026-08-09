import { Dialog } from "@base-ui/react/dialog";
import { Check, Film, Library, Pencil, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AssetPreview } from "@/components/AssetPreview";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import type { SessionAsset } from "@/studio";

export interface GenerationResultNotice {
  sessionId: string;
  sessionName: string;
  threadId: string;
  threadName: string;
  attemptId: string;
  assetIds: string[];
  completedAt: string;
}

export function GenerationResultDialog({
  notice,
  assets,
  open,
  handingOff,
  onDismiss,
  onEditImage,
  onUseInVideo,
  onUseAsInput,
}: {
  notice: GenerationResultNotice | null;
  assets: SessionAsset[];
  open: boolean;
  handingOff: boolean;
  onDismiss: () => void;
  onEditImage: (assetId: string) => void;
  onUseInVideo: (assetId: string) => void;
  onUseAsInput: (assetId: string) => void;
}) {
  const { t } = useI18n();
  const resultAssets = useMemo(() => notice?.assetIds.flatMap((id) => {
    const asset = assets.find((candidate) => candidate.id === id);
    return asset ? [asset] : [];
  }) ?? [], [assets, notice?.assetIds]);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    setSelectedId(notice?.assetIds[0] ?? "");
  }, [notice?.attemptId, notice?.assetIds]);

  const selected = resultAssets.find((asset) => asset.id === selectedId) ?? resultAssets[0] ?? null;
  const selectedIndex = selected ? resultAssets.findIndex((asset) => asset.id === selected.id) : -1;

  useEffect(() => {
    if (!open || !resultAssets.length) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const currentIndex = Math.max(0, resultAssets.findIndex((asset) => asset.id === selectedId));
      const offset = event.key === "ArrowRight" ? 1 : -1;
      setSelectedId(resultAssets[(currentIndex + offset + resultAssets.length) % resultAssets.length].id);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, resultAssets, selectedId]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && open) onDismiss(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="generation-result-backdrop" data-handoff={handingOff || undefined} />
        <Dialog.Viewport className="generation-result-viewport">
          <Dialog.Popup className="generation-result-dialog" data-handoff={handingOff || undefined}>
            <header className="generation-result-header">
              <div>
                <span className="generation-result-eyebrow"><Check /> {t("generationComplete")}</span>
                <Dialog.Title>{notice?.threadName ?? t("generationResult")}</Dialog.Title>
                <Dialog.Description>
                  {notice ? `${notice.sessionName} · ${t("resultCount", { count: resultAssets.length })}` : ""}
                </Dialog.Description>
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label={t("closeGenerationResult")} onClick={onDismiss}><X /></Button>
            </header>

            <main className="generation-result-stage">
              {selected ? <AssetPreview key={selected.id} asset={selected} controls={selected.kind === "video"} transparentControls={selected.kind === "video"} /> : null}
              {resultAssets.length > 1 ? (
                <div className="generation-result-candidates" role="group" aria-label={t("generationCandidates")}>
                  {resultAssets.map((asset, index) => (
                    <button
                      type="button"
                      className={asset.id === selected?.id ? "selected" : ""}
                      aria-label={t("viewCandidate", { index: index + 1 })}
                      aria-pressed={asset.id === selected?.id}
                      onClick={() => setSelectedId(asset.id)}
                      key={asset.id}
                    >
                      <AssetPreview asset={asset} />
                      <span>{String(index + 1).padStart(2, "0")}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </main>

            <footer className="generation-result-footer">
              <div className="generation-result-saved"><Library /><span><strong>{t("savedToAssetLibrary")}</strong><small>{selected?.name}</small></span></div>
              <div className="generation-result-actions">
                {selected?.kind === "image" ? (
                  <>
                    <Button type="button" variant="outline" onClick={() => onEditImage(selected.id)}><Pencil /> {t("editThisImage")}</Button>
                    <Button type="button" variant="outline" onClick={() => onUseInVideo(selected.id)}><Film /> {t("useInVideo")}</Button>
                  </>
                ) : null}
                {selected ? <Button type="button" variant="outline" onClick={() => onUseAsInput(selected.id)}><Plus /> {t("useAsInput")}</Button> : null}
                <Button type="button" autoFocus onClick={onDismiss}>{t("done")}{selectedIndex >= 0 && resultAssets.length > 1 ? ` · ${selectedIndex + 1}/${resultAssets.length}` : ""}</Button>
              </div>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
