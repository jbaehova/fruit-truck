import { Archive, Check, Copy, LoaderCircle, Pencil, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { activeGenerationAttempt, latestGenerationAttempt, type GenerationThread } from "@/studio";

export function GenerationThreadRail({
  threads,
  activeId,
  disabled,
  onActivate,
  onCreate,
  onDuplicate,
  onRename,
  onArchive,
  onRestore,
}: {
  threads: GenerationThread[];
  activeId: string;
  disabled?: boolean;
  onActivate: (id: string) => void;
  onCreate: () => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const { t } = useI18n();
  const visible = threads.filter((thread) => !thread.archivedAt);
  const archived = threads.filter((thread) => thread.archivedAt);

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
              <button type="button" className="thread-tab-main" onClick={() => onActivate(thread.id)}>
                <span className={`thread-status ${state}`}>
                  {activeAttempt ? <LoaderCircle className="spin" /> : state === "failed" || state === "uncertain" ? <TriangleAlert /> : state === "completed" ? <Check /> : null}
                </span>
                <span><strong>{thread.name}</strong><small>{t(stateKey)}{activeAttempt?.progress != null ? ` · ${activeAttempt.progress}%` : ""}</small></span>
              </button>
              <div className="thread-tab-actions">
                <Button variant="ghost" size="icon-xs" disabled={disabled} aria-label={t("renameThreadNamed", { name: thread.name })} onClick={() => onRename(thread.id)}><Pencil /></Button>
                <Button variant="ghost" size="icon-xs" disabled={disabled} aria-label={t("duplicateThread", { name: thread.name })} aria-keyshortcuts="Meta+D" onClick={() => onDuplicate(thread.id)}><Copy /></Button>
                <Button variant="ghost" size="icon-xs" disabled={disabled || Boolean(activeAttempt)} aria-label={t("archiveThread", { name: thread.name })} aria-keyshortcuts="Meta+W" onClick={() => onArchive(thread.id)}><Archive /></Button>
              </div>
            </article>
          );
        })}
        <Button className="thread-add" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("newThread")} aria-keyshortcuts="Meta+T" onClick={onCreate}><Plus /></Button>
      </div>
      {archived.length ? (
        <div className="thread-rail-actions">
          <details className="archived-threads">
            <summary>{t("archivedThreads", { count: archived.length })}</summary>
            <div>
              {archived.map((thread) => (
                <Button key={thread.id} variant="ghost" size="xs" disabled={disabled} aria-keyshortcuts="Meta+Shift+T" onClick={() => onRestore(thread.id)}>
                  <RotateCcw /> {t("restoreThread", { name: thread.name })}
                </Button>
              ))}
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}
