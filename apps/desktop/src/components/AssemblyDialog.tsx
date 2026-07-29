import { Dialog } from "@base-ui/react/dialog";
import { ArrowDown, ArrowUp, Eye, Film, Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentSessionState, VideoAssemblyClip } from "@/agent";
import type { SessionAsset } from "@/studio";
import { AssetPreview } from "@/components/AssetPreview";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

export function AssemblyDialog({
  open,
  state,
  assets,
  onClose,
  onRender,
}: {
  open: boolean;
  state: AgentSessionState;
  assets: SessionAsset[];
  onClose: () => void;
  onRender: (clips: VideoAssemblyClip[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const approvedVideos = useMemo(() => assets.filter((asset) =>
    asset.kind === "video"
      && state.artifacts.find((artifact) => artifact.assetId === asset.id)?.approval === "approved"
  ), [assets, state.artifacts]);
  const [clips, setClips] = useState<VideoAssemblyClip[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const existing = state.assembly.clips.filter((clip) => approvedVideos.some((asset) => asset.id === clip.assetId));
    setClips(existing.length ? existing : approvedVideos.map((asset, order) => ({
      id: crypto.randomUUID(),
      assetId: asset.id,
      startSeconds: 0,
      endSeconds: asset.duration ?? 5,
      order,
    })));
    setSelectedAssetId(existing[0]?.assetId ?? approvedVideos[0]?.id);
    setError(undefined);
  }, [approvedVideos, open, state.assembly.clips]);

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= clips.length) return;
    const next = [...clips];
    [next[index], next[target]] = [next[target], next[index]];
    setClips(next.map((clip, order) => ({ ...clip, order })));
  };
  const selectedAsset = approvedVideos.find((asset) => asset.id === selectedAssetId)
    ?? approvedVideos.find((asset) => clips.some((clip) => clip.assetId === asset.id));
  const availableVideos = approvedVideos.filter((asset) => !clips.some((clip) => clip.assetId === asset.id));
  const invalidClip = clips.find((clip) => {
    const duration = approvedVideos.find((asset) => asset.id === clip.assetId)?.duration;
    return clip.startSeconds < 0
      || clip.endSeconds <= clip.startSeconds
      || (duration != null && clip.endSeconds > duration);
  });

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="assembly-dialog-viewport">
          <Dialog.Popup className="assembly-dialog">
            <header>
              <div><Film /><span><Dialog.Title>{t("makeFinalVideo")}</Dialog.Title><Dialog.Description>{t("assemblyDialogHint")}</Dialog.Description></span></div>
              <Dialog.Close render={<Button variant="ghost" size="icon" />} aria-label={t("closeAssembly")}><X /></Dialog.Close>
            </header>
            <div className="assembly-workspace">
              <section className="assembly-preview" aria-label={t("clipPreview")}>
                {selectedAsset ? (
                  <>
                    <AssetPreview asset={selectedAsset} controls />
                    <div><strong>{selectedAsset.name}</strong><small>{selectedAsset.duration ? t("seconds", { value: selectedAsset.duration.toFixed(1) }) : t("durationUnknown")}</small></div>
                  </>
                ) : <div className="assembly-preview-empty"><Film /><span>{t("chooseClipPreview")}</span></div>}
              </section>
              <div className="assembly-editor">
                {clips.map((clip, index) => {
                  const asset = assets.find((item) => item.id === clip.assetId);
                  return (
                    <article key={clip.id} className={selectedAssetId === clip.assetId ? "selected" : ""}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div><strong>{asset?.name ?? t("missingAsset")}</strong><small>{Math.max(0, clip.endSeconds - clip.startSeconds).toFixed(1)}s</small></div>
                      <label>{t("clipIn")}<input type="number" min="0" max={asset?.duration} step=".1" value={clip.startSeconds} onChange={(event) => setClips((current) => current.map((item) => item.id === clip.id ? { ...item, startSeconds: Number(event.target.value) } : item))} /></label>
                      <label>{t("clipOut")}<input type="number" min=".1" max={asset?.duration} step=".1" value={clip.endSeconds} onChange={(event) => setClips((current) => current.map((item) => item.id === clip.id ? { ...item, endSeconds: Number(event.target.value) } : item))} /></label>
                      <div>
                        <Button size="icon-xs" variant="ghost" aria-label={t("previewClip", { name: asset?.name ?? "" })} onClick={() => setSelectedAssetId(clip.assetId)}><Eye /></Button>
                        <Button size="icon-xs" variant="ghost" disabled={index === 0} aria-label={t("moveEarlier")} onClick={() => move(index, -1)}><ArrowUp /></Button>
                        <Button size="icon-xs" variant="ghost" disabled={index === clips.length - 1} aria-label={t("moveLater")} onClick={() => move(index, 1)}><ArrowDown /></Button>
                        <Button size="icon-xs" variant="ghost" aria-label={t("removeClip")} onClick={() => setClips((current) => current.filter((item) => item.id !== clip.id).map((item, order) => ({ ...item, order }))) }><Trash2 /></Button>
                      </div>
                    </article>
                  );
                })}
                {!clips.length ? <div className="assembly-empty"><Plus /><strong>{t("noClipsSelected")}</strong><p>{t("addApprovedVideosHint")}</p></div> : null}
                {availableVideos.length ? (
                  <div className="assembly-available">
                    <span>{t("availableApprovedVideos")}</span>
                    {availableVideos.map((asset) => (
                      <Button key={asset.id} size="xs" variant="outline" onClick={() => {
                        setClips((current) => [...current, {
                          id: crypto.randomUUID(),
                          assetId: asset.id,
                          startSeconds: 0,
                          endSeconds: asset.duration ?? 5,
                          order: current.length,
                        }]);
                        setSelectedAssetId(asset.id);
                      }}><Plus /> {asset.name}</Button>
                    ))}
                  </div>
                ) : null}
                {error ?? state.assembly.error ? <p className="assembly-error" role="alert">{error ?? state.assembly.error}</p> : null}
              </div>
            </div>
            <footer>
              <span>{t("assemblySummary", { count: clips.length, duration: clips.reduce((sum, clip) => sum + Math.max(0, clip.endSeconds - clip.startSeconds), 0).toFixed(1) })}</span>
              <Button disabled={busy || !clips.length || Boolean(invalidClip)} onClick={() => void (async () => {
                setBusy(true);
                setError(undefined);
                try {
                  await onRender(clips);
                  onClose();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setBusy(false);
                }
              })()}>{busy ? t("rendering") : t("renderFinal")} <Play /></Button>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
