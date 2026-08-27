import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { Archive, Check, Copy, LoaderCircle, Pencil, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { activeGenerationAttempt, latestGenerationAttempt, type GenerationThread } from "@/studio";
import { formatElapsedClock } from "@/videoPolling";

function localizedThreadName(threadName: string, t: ReturnType<typeof useI18n>["t"]) {
  const match = /^(Image|Video) (\d+)( copy)?$/.exec(threadName);
  if (!match) return threadName;
  const base = `${t(match[1] === "Image" ? "image" : "video")} ${match[2]}`;
  return match[3] ? `${base} ${t("threadCopySuffix")}` : base;
}

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
  onRename: (id: string, name: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const { t } = useI18n();
  const visible = threads.filter((thread) => !thread.archivedAt);
  const archived = threads.filter((thread) => thread.archivedAt);
  const [renameId, setRenameId] = useState<string | null>(null);
  const renaming = threads.find((thread) => thread.id === renameId);
  const [name, setName] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasLiveVideoJob = visible.some((thread) => Boolean(activeGenerationAttempt(thread)?.jobId));
  useEffect(() => setName(renaming ? localizedThreadName(renaming.name, t) : ""), [renaming, t]);
  useEffect(() => {
    if (!hasLiveVideoJob) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasLiveVideoJob]);

  return (
    <>
    <section className="thread-rail" aria-label={t("generationThreads")}>
      <div className="thread-rail-scroll">
        {visible.map((thread) => {
          const displayName = localizedThreadName(thread.name, t);
          const activeAttempt = activeGenerationAttempt(thread);
          const latest = latestGenerationAttempt(thread);
          const state = activeAttempt?.status ?? latest?.status ?? "idle";
          const stateKey = state === "idle" ? "threadReady"
            : state === "uncertain" ? "threadUncertain"
                : state === "canceled" ? "statusCanceled"
                  : ["enhancing", "submitting", "in_progress"].includes(state) ? "statusInProgress"
                  : state === "completed" ? "statusCompleted" : "statusFailed";
          const timing = activeAttempt?.jobId
            ? [
              t("videoElapsed", { time: formatElapsedClock(activeAttempt.submittedAt ?? activeAttempt.createdAt, nowMs) }),
              activeAttempt.lastPolledAt
                ? t("videoLastChecked", { time: formatElapsedClock(activeAttempt.lastPolledAt, nowMs) })
                : t("videoFirstCheckPending"),
            ].join(" · ")
            : "";
          const status = [t(stateKey), activeAttempt?.progress != null ? `${activeAttempt.progress}%` : "", timing].filter(Boolean).join(" · ");
          return (
            <article className={`thread-tab ${thread.id === activeId ? "active" : ""}`} key={thread.id}>
              <button type="button" className="thread-tab-main" onClick={() => onActivate(thread.id)}>
                <span className={`thread-status ${state}`}>
                  {activeAttempt ? <LoaderCircle className="spin" /> : state === "failed" || state === "uncertain" ? <TriangleAlert /> : state === "completed" ? <Check /> : null}
                </span>
                <span><strong>{displayName}</strong><small title={status}>{status}</small></span>
              </button>
              <div className="thread-tab-actions">
                <Button variant="ghost" size="icon-xs" disabled={disabled} aria-label={t("renameThreadNamed", { name: displayName })} onClick={() => setRenameId(thread.id)}><Pencil /></Button>
                <Button variant="ghost" size="icon-xs" disabled={disabled} aria-label={t("duplicateThread", { name: displayName })} aria-keyshortcuts="Meta+D" onClick={() => onDuplicate(thread.id)}><Copy /></Button>
                <Button variant="ghost" size="icon-xs" disabled={disabled || Boolean(activeAttempt) || visible.length <= 1} aria-label={t("archiveThread", { name: displayName })} aria-keyshortcuts="Meta+W" onClick={() => onArchive(thread.id)}><Archive /></Button>
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
                  <RotateCcw /> {t("restoreThread", { name: localizedThreadName(thread.name, t) })}
                </Button>
              ))}
            </div>
          </details>
        </div>
      ) : null}
    </section>
    <Dialog.Root open={Boolean(renameId)} onOpenChange={(open) => { if (!open) setRenameId(null); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="rename-dialog">
            <Dialog.Title className="dialog-title">{t("renameThread")}</Dialog.Title>
            <Form onFormSubmit={() => {
              const next = name.trim();
              if (!next || !renaming) return;
              onRename(renaming.id, next.slice(0, 100));
              setRenameId(null);
            }}>
              <Field.Root name="threadName">
                <Field.Label className="sr-only">{t("renameThread")}</Field.Label>
                <Input autoFocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
              </Field.Root>
              <div className="dialog-actions">
                <Dialog.Close render={<Button variant="outline" />}>{t("cancel")}</Dialog.Close>
                <Button type="submit" disabled={!name.trim()}>{t("saveName")}</Button>
              </div>
            </Form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
    </>
  );
}
