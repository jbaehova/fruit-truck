import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import type { StudioSession } from "@/studio";

export function SessionSwitcher({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  sessions: StudioSession[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(active?.name ?? "");

  useEffect(() => {
    if (renameOpen) setName(active?.name ?? "");
  }, [active?.name, renameOpen]);

  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="session-trigger">
          <span><small>{t("session")}</small><strong>{active?.name ?? t("session")}</strong></span>
          <ChevronDown />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="menu-positioner" sideOffset={7} align="start">
            <Menu.Popup className="session-menu">
              <Menu.Group>
                <Menu.GroupLabel className="session-menu-title">{t("recentSessions")}</Menu.GroupLabel>
                {sessions.map((session) => (
                  <Menu.Item className="session-menu-item" key={session.id} onClick={() => onSelect(session.id)}>
                    <span className="session-check">{session.id === activeId ? <Check /> : null}</span>
                    <span>
                      <strong>{session.name}</strong>
                      <small>{new Date(session.updatedAt).toLocaleString(locale)}</small>
                    </span>
                  </Menu.Item>
                ))}
              </Menu.Group>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="session-action" onClick={() => setRenameOpen(true)}><Pencil /> {t("renameCurrent")}</Menu.Item>
              <Menu.Item className="session-action" disabled={sessions.length === 1} onClick={() => onDelete(activeId)}><Trash2 /> {t("deleteCurrent")}</Menu.Item>
              <Menu.Item className="session-action" onClick={onCreate}><Plus /> {t("newSession")}</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <Dialog.Root open={renameOpen} onOpenChange={setRenameOpen}>
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
                if (!value) return;
                onRename(activeId, value);
                setRenameOpen(false);
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
