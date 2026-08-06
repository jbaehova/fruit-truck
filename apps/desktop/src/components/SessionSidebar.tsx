import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { Check, PanelLeftClose, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { activeGenerationAttempt, type StudioSession } from "@/studio";

const MIN_WIDTH = 210;
const MAX_WIDTH = 420;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

export function SessionSidebar({
  sessions,
  activeId,
  width,
  onWidthChange,
  onClose,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  searchInputRef,
}: {
  sessions: StudioSession[];
  activeId: string;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const renaming = sessions.find((session) => session.id === renameId) ?? null;
  const [name, setName] = useState("");
  const sessionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return sessions;
    return sessions.filter((session) => session.name.toLowerCase().includes(value));
  }, [query, sessions]);
  const tabbableSessionId = filtered.some((session) => session.id === activeId)
    ? activeId
    : filtered[0]?.id;

  useEffect(() => {
    if (renaming) setName(renaming.name);
  }, [renaming]);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: globalThis.PointerEvent) => onWidthChange(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("resizing-session-sidebar");
    };
    document.body.classList.add("resizing-session-sidebar");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onWidthChange(clampSidebarWidth(width + (event.key === "ArrowRight" ? 12 : -12)));
  };

  return (
    <>
      <aside className="session-sidebar" style={{ width }}>
        <header className="session-sidebar-header">
          <div>
            <span>{t("sessions")}</span>
            <small>{t("sessionCount", { count: sessions.length })}</small>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("closeSessionSidebar")} aria-keyshortcuts="Control+Meta+S" onClick={onClose}>
            <PanelLeftClose />
          </Button>
        </header>
        <div className="session-sidebar-tools">
          <Field.Root className="session-search">
            <Field.Label className="sr-only">{t("searchSessions")}</Field.Label>
            <Search aria-hidden="true" />
            <Input
              ref={searchInputRef}
              aria-label={t("searchSessions")}
              placeholder={t("searchSessions")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                if (query) setQuery("");
                else event.currentTarget.blur();
              }}
            />
          </Field.Root>
          <Button type="button" variant="default" size="icon" aria-label={t("newSession")} aria-keyshortcuts="Meta+N" onClick={onCreate}><Plus /></Button>
        </div>
        <ScrollArea className="session-list" aria-label={t("recentSessions")}>
          {!filtered.length ? <p className="session-empty">{t("noMatchingSessions")}</p> : null}
          {filtered.map((session) => {
            const active = session.id === activeId;
            const pendingUiDecisions = session.agent.decisions.filter((decision) =>
              decision.status === "pending" && decision.channel === "fruit_truck_ui"
            ).length;
            const runningThreads = [...session.threads.image, ...session.threads.video]
              .filter((thread) => Boolean(activeGenerationAttempt(thread))).length;
            return (
              <div className={`session-row ${active ? "active" : ""}`} key={session.id}>
                <button
                  type="button"
                  className="session-row-main"
                  ref={(element) => {
                    if (element) sessionButtonRefs.current.set(session.id, element);
                    else sessionButtonRefs.current.delete(session.id);
                  }}
                  tabIndex={session.id === tabbableSessionId ? 0 : -1}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(event) => {
                    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                      event.preventDefault();
                      const index = filtered.findIndex((item) => item.id === session.id);
                      const offset = event.key === "ArrowDown" ? 1 : -1;
                      const next = filtered[(index + offset + filtered.length) % filtered.length];
                      if (next) sessionButtonRefs.current.get(next.id)?.focus();
                    } else if ((event.metaKey || event.ctrlKey) && event.key === "Backspace" && sessions.length > 1) {
                      event.preventDefault();
                      onDelete(session.id);
                    }
                  }}
                >
                  <span className="session-state">{active ? <Check /> : null}</span>
                  <span>
                    <strong>{session.name}</strong>
                    <small>{runningThreads
                      ? t("parallelAgentActions", { count: runningThreads })
                      : pendingUiDecisions
                        ? t("pendingReviewCount", { count: pendingUiDecisions })
                        : new Date(session.updatedAt).toLocaleString(locale)}</small>
                  </span>
                </button>
                <div className="session-row-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("renameSessionNamed", { name: session.name })}
                    onClick={() => setRenameId(session.id)}
                  ><Pencil /></Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    disabled={sessions.length === 1}
                    aria-label={t("deleteSessionNamed", { name: session.name })}
                    onClick={() => onDelete(session.id)}
                  ><Trash2 /></Button>
                </div>
              </div>
            );
          })}
        </ScrollArea>
        <div
          className="session-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("resizeSessionSidebar")}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
        />
      </aside>

      <Dialog.Root open={Boolean(renameId)} onOpenChange={(open) => { if (!open) setRenameId(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Viewport className="dialog-viewport">
            <Dialog.Popup className="rename-dialog">
              <header className="dialog-header">
                <div>
                  <Dialog.Title className="dialog-title">{t("renameSession")}</Dialog.Title>
                  <Dialog.Description className="dialog-description">{t("renameSessionHint")}</Dialog.Description>
                </div>
                <Dialog.Close render={<Button variant="ghost" size="icon" />} aria-label={t("close")}><X /></Dialog.Close>
              </header>
              <Form onFormSubmit={() => {
                const value = name.trim();
                if (!value || !renaming) return;
                onRename(renaming.id, value);
                setRenameId(null);
              }}>
                <Field.Root name="sessionName">
                  <Field.Label className="sr-only">{t("sessionName")}</Field.Label>
                  <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
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
