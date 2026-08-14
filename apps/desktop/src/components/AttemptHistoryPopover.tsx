import { Popover } from "@base-ui/react/popover";
import { History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n, type MessageKey } from "@/i18n";
import { formatUsd } from "@/openrouter";
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

export function AttemptHistoryPopover({ attempts }: { attempts: GenerationAttempt[] }) {
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
              {attempts.length ? attempts.toReversed().map((attempt) => (
                <article key={attempt.id}>
                  <div><span>{new Date(attempt.createdAt).toLocaleString(language === "ko" ? "ko-KR" : "en-US")}</span><strong data-status={attempt.status}>{t(STATUS_KEYS[attempt.status] ?? "statusInProgress")}</strong></div>
                  <small>{attempt.modelId ?? attempt.snapshot?.modelId}{attempt.actualCostUsd != null || attempt.estimatedCostUsd != null ? ` · ${formatUsd(attempt.actualCostUsd ?? attempt.estimatedCostUsd ?? 0)}` : ""}</small>
                  {attempt.error ? <div className="attempt-error-detail">
                    <p>{attempt.error}</p>
                    {attempt.errorAction ? <small>{attempt.errorAction}</small> : null}
                    {attempt.errorDetails && attempt.errorDetails !== attempt.error ? (
                      <details>
                        <summary>{t("technicalDetails")}</summary>
                        <code>{attempt.errorDetails}</code>
                      </details>
                    ) : null}
                  </div> : null}
                </article>
              )) : <p className="attempt-history-empty">{t("noAttempts")}</p>}
            </ScrollArea>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
