import { Check, Circle, Cloud, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

export function WorkflowGuide({
  open,
  hasAsset,
  hasMention,
  hasFinalRequest,
  hasResult,
  onImport,
  onLoadSample,
  onFocusPrompt,
  onOpenRequest,
  onClose,
}: {
  open: boolean;
  hasAsset: boolean;
  hasMention: boolean;
  hasFinalRequest: boolean;
  hasResult: boolean;
  onImport: () => void;
  onLoadSample: () => void;
  onFocusPrompt: () => void;
  onOpenRequest: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  if (!open) return null;
  const steps = [
    { done: hasAsset, label: t("guideAttachAsset"), action: onImport },
    { done: hasMention, label: t("guideBindMention"), action: onFocusPrompt },
    { done: hasFinalRequest, label: t("guideReviewRequest"), action: onOpenRequest },
    { done: hasResult, label: t("guideReuseResult"), action: onFocusPrompt },
  ];
  return (
    <aside className="workflow-guide" aria-label={t("workflowGuide")}>
      <header>
        <span><strong>{t("workflowGuide")}</strong><small>{t("workflowGuideHint")}</small></span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("close")} onClick={onClose}><X /></Button>
      </header>
      <ol>
        {steps.map((step, index) => (
          <li key={step.label} data-complete={step.done || undefined}>
            {step.done ? <Check /> : <Circle />}
            <button type="button" onClick={step.action}><small>0{index + 1}</small>{step.label}</button>
          </li>
        ))}
      </ol>
      {!hasAsset ? <Button type="button" size="xs" variant="outline" onClick={onLoadSample}><ImagePlus /> {t("loadGuideSample")}</Button> : null}
      <p><Cloud /> {t("workflowGuideDisclosure")}</p>
    </aside>
  );
}
