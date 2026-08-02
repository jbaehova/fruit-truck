import { Dialog } from "@base-ui/react/dialog";
import { Check, ChevronRight, Film, ImageIcon, LoaderCircle, Sparkles, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentDecision } from "@/agent";
import type { SessionAsset } from "@/studio";
import { AssetPreview } from "@/components/AssetPreview";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";

type Props = {
  open: boolean;
  decision?: AgentDecision;
  assets: SessionAsset[];
  onClose: () => void;
  onPick: () => Promise<SessionAsset[]>;
  onOpenAssembly: () => void;
  onResolve: (selectedOptionIds: string[], selectedAssetIds: string[], note?: string) => Promise<void>;
};

export function DecisionWorkspace({
  open,
  decision,
  assets,
  onClose,
  onPick,
  onOpenAssembly,
  onResolve,
}: Props) {
  const { t } = useI18n();
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const relatedAssets = useMemo(() => {
    if (!decision) return [];
    const ids = new Set([
      ...decision.relatedAssetIds,
      ...decision.options.flatMap((option) => option.assetId ? [option.assetId] : []),
    ]);
    return assets.filter((asset) => ids.has(asset.id));
  }, [assets, decision]);

  useEffect(() => {
    if (!open || !decision?.id) return;
    setSelectedOptionIds([]);
    setSelectedAssetIds([]);
    setNote("");
    setError(undefined);
  }, [decision?.id, open]);

  if (!decision) return null;

  const toggleOption = (id: string) => {
    if (decision.selectionMode === "multiple") {
      setSelectedOptionIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
      return;
    }
    if (decision.selectionMode === "one_per_group") {
      const option = decision.options.find((item) => item.id === id);
      setSelectedOptionIds((current) => [
        ...current.filter((selectedId) => {
          const selected = decision.options.find((item) => item.id === selectedId);
          return !option?.groupId || selected?.groupId !== option.groupId;
        }),
        id,
      ]);
      return;
    }
    setSelectedOptionIds([id]);
  };

  const toggleAsset = (id: string) => {
    if (decision.selectionMode === "multiple") {
      setSelectedAssetIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    } else {
      setSelectedAssetIds([id]);
    }
  };

  const choiceCount = decision.kind === "approval"
    ? selectedOptionIds.length
    : selectedAssetIds.length || selectedOptionIds.length;
  const canSubmit = decision.presentation === "assembly_review"
    ? selectedOptionIds.includes("revise")
    : (decision.minSelections ?? 0) <= choiceCount
      && (decision.maxSelections == null || choiceCount <= decision.maxSelections);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const optionAssetIds = decision.options.flatMap((option) =>
        selectedOptionIds.includes(option.id) && option.assetId ? [option.assetId] : []
      );
      await onResolve(
        selectedOptionIds,
        [...new Set([...selectedAssetIds, ...optionAssetIds])],
        note.trim() || undefined,
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="decision-workspace-backdrop" />
        <Dialog.Viewport className="decision-workspace-viewport">
          <Dialog.Popup className="decision-workspace">
            <header className="decision-workspace-header">
              <span className="decision-workspace-mark"><Sparkles /></span>
              <span>
                <small>{t("agentCheckpoint")}</small>
                <Dialog.Title>{decision.title}</Dialog.Title>
                <Dialog.Description>{decision.prompt}</Dialog.Description>
              </span>
              <Dialog.Close render={<Button variant="ghost" size="icon" />} aria-label={t("closeDecision")}><X /></Dialog.Close>
            </header>

            <div className="decision-workspace-body">
              {decision.presentation === "assembly_review" ? (
                <section className="decision-assembly-callout">
                  <Film />
                  <div>
                    <strong>{t("assemblyReady", { count: relatedAssets.length })}</strong>
                    <p>{t("assemblyReviewHint")}</p>
                  </div>
                  <Button onClick={() => {
                    onClose();
                    onOpenAssembly();
                  }}>{t("reviewAssembly")} <ChevronRight /></Button>
                  <Button variant="ghost" onClick={() => toggleOption("revise")}>{t("requestNewPlan")}</Button>
                </section>
              ) : null}

              {relatedAssets.length && decision.presentation !== "assembly_review" ? (
                <section className="decision-media-grid" aria-label={t("decisionMedia")}>
                  {relatedAssets.map((asset) => {
                    const option = decision.options.find((item) => item.assetId === asset.id);
                    const selected = selectedAssetIds.includes(asset.id) || Boolean(option && selectedOptionIds.includes(option.id));
                    return (
                      <button
                        type="button"
                        className={`decision-media-item ${selected ? "selected" : ""}`}
                        key={asset.id}
                        onClick={() => {
                          if (option) toggleOption(option.id);
                          else if (decision.kind !== "approval") toggleAsset(asset.id);
                        }}
                      >
                        <AssetPreview asset={asset} controls={asset.kind === "video"} />
                        <span className="decision-media-copy">
                          <i>{selected ? <Check /> : asset.kind === "image" ? <ImageIcon /> : <Film />}</i>
                          <span><strong>{option?.label ?? asset.name}</strong><small>{option?.description ?? asset.name}</small></span>
                        </span>
                      </button>
                    );
                  })}
                </section>
              ) : null}

              {decision.presentation === "upload" ? (
                <button
                  type="button"
                  className="decision-upload"
                  onClick={() => void onPick().then((imported) => setSelectedAssetIds(imported.map((asset) => asset.id)))}
                >
                  <Upload />
                  <strong>{t("addReferenceFiles")}</strong>
                  <span>{t("uploadDecisionHint")}</span>
                  {selectedAssetIds.length ? <small>{t("filesSelected", { count: selectedAssetIds.length })}</small> : null}
                </button>
              ) : null}

              {decision.options.length && decision.presentation !== "assembly_review" ? (
                <section className={`decision-options ${decision.presentation === "model_picker" ? "models" : ""}`}>
                  {decision.options.filter((option) => !option.assetId).map((option) => {
                    const selected = selectedOptionIds.includes(option.id);
                    return (
                      <button type="button" className={selected ? "selected" : ""} key={option.id} onClick={() => toggleOption(option.id)}>
                        <i>{selected ? <Check /> : null}</i>
                        <span>
                          <strong>{option.label}{option.recommended ? <em>{t("recommended")}</em> : null}</strong>
                          {option.description ? <small>{option.description}</small> : null}
                          <span className="decision-option-meta">
                            {option.inputStructure ? <b>{option.inputStructure}</b> : null}
                            {option.compatibility ? <b>{option.compatibility}</b> : null}
                            <b className="price">{option.price || t("priceUnavailable")}</b>
                          </span>
                          {option.constraints ? <small>{option.constraints}</small> : null}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ) : null}

              {decision.allowNote || decision.kind === "feedback" || decision.kind === "approval" ? (
                <label className="decision-note">
                  <span>{t("feedback")} <small>{t("optional")}</small></span>
                  <Textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("feedbackPlaceholder")} />
                </label>
              ) : null}
              {error ? <p className="decision-error" role="alert">{error}</p> : null}
            </div>

            {decision.presentation !== "assembly_review" || selectedOptionIds.includes("revise") ? (
              <footer className="decision-workspace-footer">
                <span>{t("decisionCloseHint")}</span>
                <Button disabled={busy || !canSubmit} onClick={() => void submit()}>
                  {busy ? <LoaderCircle className="spin" /> : <Check />} {t("confirmChoice")}
                </Button>
              </footer>
            ) : null}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
