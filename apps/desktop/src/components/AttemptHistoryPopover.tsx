import { Popover } from "@base-ui/react/popover";
import { Ban, Copy, History, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n, type MessageKey } from "@/i18n";
import { formatUsd } from "@/openrouter";
import { localizedAttemptAction, localizedAttemptMessage } from "@/attemptPresentation";
import type { GenerationAttempt } from "@/studio";

const STATUS_KEYS: Record<string, MessageKey> = {
  enhancing: "statusInProgress",
  submitting: "statusInProgress",
  in_progress: "statusInProgress",
  completed: "statusCompleted",
  failed: "statusFailed",
  uncertain: "threadUncertain",
  canceled: "statusCanceled",
};

export function AttemptHistoryPopover({
  attempts,
  onCancel,
  onDuplicate,
  onRestore,
  onRecheck,
  onRepairInputs,
  onRecoverResults,
  availableAssetIds,
}: {
  attempts: GenerationAttempt[];
  onCancel?: (attempt: GenerationAttempt) => void;
  onDuplicate?: (attempt: GenerationAttempt) => void;
  onRestore?: (attempt: GenerationAttempt) => void;
  onRecheck?: (attempt: GenerationAttempt) => void;
  onRepairInputs?: (attempt: GenerationAttempt) => void;
  onRecoverResults?: (attempt: GenerationAttempt) => void;
  availableAssetIds: ReadonlySet<string>;
}) {
  const { language, t } = useI18n();
  const failures = attempts.filter((attempt) => attempt.status === "failed" || attempt.status === "uncertain");
  const errorCounts = [...failures.reduce((counts, attempt) => {
    const code = attempt.errorCode ?? "unknown";
    counts.set(code, (counts.get(code) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())].toSorted((left, right) => right[1] - left[1]);
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button type="button" className="attempt-history-trigger" variant="ghost" size="xs" />}>
        <History /> {t("attemptHistory")} <span>{attempts.length}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="attempt-history-positioner" side="bottom" sideOffset={8} align="end">
          <Popover.Popup className="attempt-history-popover">
            <header>
              <div><strong>{t("attemptHistory")}</strong><small>{failures.length ? t("failureSummary", { count: failures.length, categories: errorCounts.map(([code, count]) => `${code} ${count}`).join(" · ") }) : t("attemptHistoryHint")}</small></div>
              <Popover.Close render={<Button type="button" variant="ghost" size="icon-xs" />} aria-label={t("closeAttemptHistory")}><X /></Popover.Close>
            </header>
            <ScrollArea className="attempt-history-list">
              {attempts.length ? attempts.toReversed().map((attempt) => {
                const missingInputIds = attempt.inputAssetIds.filter((id) => !availableAssetIds.has(id));
                const missingResultIds = attempt.assetIds.filter((id) => !availableAssetIds.has(id));
                const plannerCostUsd = attempt.snapshot?.enhancementArtifact?.actualCostUsd;
                const canRecheck = Boolean(attempt.jobId && ["in_progress", "uncertain", "failed"].includes(attempt.status) && !missingResultIds.length);
                const canRecoverResults = Boolean(missingResultIds.length && (attempt.jobId || attempt.resultSources?.length));
                const displayedError = localizedAttemptMessage(attempt, t);
                const displayedAction = localizedAttemptAction(attempt.errorAction, t);
                return <article key={attempt.id}>
                  <div><span>{new Date(attempt.createdAt).toLocaleString(language === "ko" ? "ko-KR" : "en-US")}</span><strong data-status={attempt.status}>{t(STATUS_KEYS[attempt.status] ?? "statusInProgress")}</strong></div>
                  <small>{attempt.modelId ?? attempt.snapshot?.modelId}</small>
                  {attempt.actualCostUsd != null || attempt.estimatedCostUsd != null || plannerCostUsd != null ? <dl className="attempt-cost-breakdown">
                    {attempt.actualCostUsd != null ? <><dt>{t("generationActualCost")}</dt><dd>{formatUsd(attempt.actualCostUsd)}</dd></> : null}
                    {attempt.actualCostUsd == null && attempt.estimatedCostUsd != null ? <><dt>{t("generationEstimatedCost")}</dt><dd>{formatUsd(attempt.estimatedCostUsd)}</dd></> : null}
                    {plannerCostUsd != null ? <><dt>{t("plannerActualCost")}</dt><dd>{formatUsd(plannerCostUsd)}</dd></> : null}
                  </dl> : null}
                  {missingInputIds.length ? <p className="attempt-missing-assets" role="alert">{t("attemptMissingInputs", { count: missingInputIds.length })}</p> : null}
                  {missingResultIds.length ? <p className="attempt-missing-assets" role="alert">{t("attemptMissingResults", { count: missingResultIds.length })}</p> : null}
                  {attempt.recoveryPath ? <div className="attempt-recovery-payload" role="status">
                    <small>{t("attemptRecoveryPayload")}</small>
                    <code>{attempt.recoveryPath}</code>
                    <small>{t("attemptRecoveryPayloadHint")}</small>
                  </div> : null}
                  {displayedError ? <div className="attempt-error-detail">
                    <p>{displayedError}</p>
                    {displayedAction ? <small>{t("recoveryActionLabel")}: {displayedAction}</small> : null}
                    {attempt.errorDetails && attempt.errorDetails !== displayedError ? (
                      <details>
                        <summary>{t("technicalDetails")}</summary>
                        <code>{attempt.errorDetails}</code>
                      </details>
                    ) : null}
                  </div> : null}
                  {attempt.request || attempt.snapshot ? (
                    <details className="attempt-request-detail">
                      <summary>{t("exactRequest")}</summary>
                      <pre>{JSON.stringify(attempt.request ?? attempt.snapshot, null, 2)}</pre>
                    </details>
                  ) : null}
                  <div className="attempt-actions">
                    {missingInputIds.length && attempt.snapshot ? <Button type="button" variant="ghost" size="xs" onClick={() => onRepairInputs?.(attempt)}><RotateCcw /> {t("repairMissingInputs")}</Button> : null}
                    {canRecoverResults ? <Button type="button" variant="ghost" size="xs" onClick={() => onRecoverResults?.(attempt)}><RefreshCw /> {t("recoverResult")}</Button> : null}
                    {attempt.snapshot ? <Button type="button" variant="ghost" size="xs" onClick={() => onRestore?.(attempt)}><RotateCcw /> {t("restoreAttempt")}</Button> : null}
                    {attempt.snapshot ? <Button type="button" variant="ghost" size="xs" onClick={() => onDuplicate?.(attempt)}><Copy /> {t("duplicateAttempt")}</Button> : null}
                    {canRecheck ? <Button type="button" variant="ghost" size="xs" onClick={() => onRecheck?.(attempt)}><RefreshCw /> {t("requestStatusRecheck")}</Button> : null}
                    {["submitting", "in_progress"].includes(attempt.status) ? <Button type="button" variant="ghost" size="xs" onClick={() => onCancel?.(attempt)}><Ban /> {attempt.jobId ? t("cancelLocalAttempt") : t("stopLocalTransfer")}</Button> : null}
                  </div>
                </article>
              }) : <p className="attempt-history-empty">{t("noAttempts")}</p>}
            </ScrollArea>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
