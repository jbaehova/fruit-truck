import { Checkbox } from "@base-ui/react/checkbox";
import { Archive, Check, Copy, LoaderCircle, Pencil, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { activeGenerationAttempt, latestGenerationAttempt, type GenerationThread } from "@/studio";

export function GenerationThreadRail({
  threads,
  activeId,
  selectedIds,
  disabled,
  onActivate,
  onSelectionChange,
  onCreate,
  onDuplicate,
  onRename,
  onArchive,
  onRestore,
  onRunSelected,
}: {
  threads: GenerationThread[];
  activeId: string;
  selectedIds: Set<string>;
  disabled?: boolean;
  onActivate: (id: string) => void;
  onSelectionChange: (ids: Set<string>) => void;
  onCreate: () => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onRunSelected: () => void;
}) {
  const { t } = useI18n();
  const visible = threads.filter((thread) => !thread.archivedAt);
  const archived = threads.filter((thread) => thread.archivedAt);
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange(next);
  };

  return (
    <section className="thread-rail" aria-label={t("generationThreads")}>
      <div className="thread-rail-scroll">
        {visible.map((thread) => {
          const activeAttempt = activeGenerationAttempt(thread);
          const latest = latestGenerationAttempt(thread);
          const state = activeAttempt?.status ?? latest?.status ?? "idle";
          const stateKey = state === "idle" ? "threadReady"
            : state === "awaiting_host" ? "threadAwaitingHost"
              : state === "uncertain" ? "threadUncertain"
                : state === "canceled" ? "statusCanceled"
                  : ["queued", "enhancing", "submitting", "in_progress"].includes(state) ? "statusInProgress"
                  : state === "completed" ? "statusCompleted" : "statusFailed";
          return (
            <article className={`thread-tab ${thread.id === activeId ? "active" : ""}`} key={thread.id}>
              <Checkbox.Root className="thread-check" checked={selectedIds.has(thread.id)} disabled={Boolean(activeAttempt)} aria-label={t("selectThread", { name: thread.name })} onCheckedChange={(checked) => toggle(thread.id, checked)}>
                <Checkbox.Indicator><Check /></Checkbox.Indicator>
              </Checkbox.Root>
              <button type="button" className="thread-tab-main" onClick={() => onActivate(thread.id)}>
                <span className={`thread-status ${state}`}>
                  {activeAttempt ? <LoaderCircle className="spin" /> : state === "failed" || state === "uncertain" ? <TriangleAlert /> : state === "completed" ? <Check /> : null}
                </span>
                <span><strong>{thread.name}</strong><small>{t(stateKey)}{activeAttempt?.progress != null ? ` · ${activeAttempt.progress}%` : ""}</small></span>
              </button>
              <div className="thread-tab-actions">
                <Button variant="ghost" size="icon-xs" disabled={disabled} aria-label={t("renameThreadNamed", { name: thread.name })} onClick={() => onRename(thread.id)}><Pencil /></Button>
                <Button variant="ghost" size="icon-xs" disabled={disabled} aria-label={t("duplicateThread", { name: thread.name })} onClick={() => onDuplicate(thread.id)}><Copy /></Button>
                <Button variant="ghost" size="icon-xs" disabled={disabled || visible.length === 1 || Boolean(activeAttempt)} aria-label={t("archiveThread", { name: thread.name })} onClick={() => onArchive(thread.id)}><Archive /></Button>
              </div>
            </article>
          );
        })}
        <Button className="thread-add" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("newThread")} onClick={onCreate}><Plus /></Button>
      </div>
      <Button className="parallel-run" size="sm" disabled={disabled || selectedIds.size < 2} onClick={onRunSelected}>
        <span className="parallel-run-mark" /> {t("runParallel", { count: selectedIds.size })}
      </Button>
      {archived.length ? (
        <details className="archived-threads">
          <summary>{t("archivedThreads", { count: archived.length })}</summary>
          <div>
            {archived.map((thread) => (
              <Button key={thread.id} variant="ghost" size="xs" disabled={disabled} onClick={() => onRestore(thread.id)}>
                <RotateCcw /> {t("restoreThread", { name: thread.name })}
              </Button>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
