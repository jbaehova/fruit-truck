import { Tooltip } from "@base-ui/react/tooltip";
import { LoaderCircle, Redo2, Sparkles, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useI18n, type MessageKey } from "@/i18n";

export type PromptEnhancementAvailability = "checking" | "available" | "unavailable" | "unknown";

type Props = {
  modelLabel: string;
  effortLabel: string;
  availability: PromptEnhancementAvailability;
  canEnhance: boolean;
  enhancing: boolean;
  canUndo: boolean;
  canRedo: boolean;
  resultReady: boolean;
  onEnhance: () => void;
  onUndo: () => void;
  onRedo: () => void;
};

const availabilityMessage: Record<PromptEnhancementAvailability, MessageKey> = {
  checking: "promptModelAvailabilityChecking",
  available: "promptModelAvailabilityAvailable",
  unavailable: "promptModelAvailabilityUnavailable",
  unknown: "promptModelAvailabilityUnknown",
};

function ActionTooltip({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={(
          <span
            className="prompt-enhancement-tooltip-trigger"
            tabIndex={disabled ? 0 : undefined}
            aria-label={disabled ? label : undefined}
            data-disabled={disabled ? "" : undefined}
          />
        )}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="prompt-enhancement-tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function PromptEnhancementToolbar({
  modelLabel,
  effortLabel,
  availability,
  canEnhance,
  enhancing,
  canUndo,
  canRedo,
  resultReady,
  onEnhance,
  onUndo,
  onRedo,
}: Props) {
  const { t } = useI18n();
  const enhanceDisabled = !canEnhance || enhancing || availability === "unavailable";

  return (
    <div
      className="prompt-enhancement-toolbar"
      role="toolbar"
      aria-label={t("promptEnhancementToolbar")}
      data-availability={availability}
      data-result-ready={resultReady ? "" : undefined}
    >
      <div className="prompt-enhancement-history">
        <ActionTooltip label={t("undoPromptEnhancement")} disabled={!canUndo}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("undoPromptEnhancement")}
            disabled={!canUndo}
            onClick={onUndo}
          >
            <Undo2 />
          </Button>
        </ActionTooltip>
        <ActionTooltip label={t("redoPromptEnhancement")} disabled={!canRedo}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("redoPromptEnhancement")}
            disabled={!canRedo}
            onClick={onRedo}
          >
            <Redo2 />
          </Button>
        </ActionTooltip>
      </div>

      <div className="prompt-enhancement-meta">
        <strong title={`${modelLabel} | ${effortLabel}`}>{modelLabel} | {effortLabel}</strong>
        <span className="prompt-enhancement-status" role="status" aria-live="polite">
          <span data-status={availability}>{t(availabilityMessage[availability])}</span>
          {resultReady ? <span data-status="result-ready">{t("promptEnhancementResultReady")}</span> : null}
        </span>
      </div>

      <ActionTooltip label={t("enhancePromptPaidTooltip")} disabled={enhanceDisabled}>
        <Button
          className="prompt-enhancement-action"
          type="button"
          size="sm"
          disabled={enhanceDisabled}
          onClick={onEnhance}
        >
          {enhancing ? <LoaderCircle className="spin" /> : <Sparkles />}
          {t(enhancing ? "enhancingPrompt" : "enhancePrompt")}
        </Button>
      </ActionTooltip>
      {resultReady ? <Button className="prompt-ready-action" type="button" variant="outline" size="sm" disabled={!canRedo || enhancing} onClick={onRedo}><Redo2 />{t("applyEnhancedPrompt")}</Button> : null}
    </div>
  );
}
