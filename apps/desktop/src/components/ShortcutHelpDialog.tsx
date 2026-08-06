import { Dialog } from "@base-ui/react/dialog";
import { Command, X } from "lucide-react";
import { APP_COMMANDS, type ShortcutGroup } from "@/shortcuts";
import { Button } from "@/components/ui/button";
import { useI18n, type MessageKey } from "@/i18n";

const GROUP_LABELS: Record<ShortcutGroup, MessageKey> = {
  app: "shortcutGroupApp",
  sessions: "shortcutGroupSessions",
  workspace: "shortcutGroupWorkspace",
  assets: "shortcutGroupAssets",
};

const CONTEXT_SHORTCUTS: Array<{ labelKey: MessageKey; display: string }> = [
  { labelKey: "shortcutNavigateItems", display: "↑ ↓ ← →" },
  { labelKey: "shortcutOpenPreview", display: "Space / Enter" },
  { labelKey: "shortcutDeleteSelection", display: "⌘Delete" },
  { labelKey: "shortcutCloseDialog", display: "Esc / ⌘W" },
  { labelKey: "shortcutUndoMask", display: "⌘Z" },
];

export function ShortcutHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="shortcut-help-dialog">
            <header className="dialog-header">
              <div>
                <span className="dialog-eyebrow"><Command /> Fruit Truck</span>
                <Dialog.Title className="dialog-title">{t("keyboardShortcuts")}</Dialog.Title>
                <Dialog.Description className="dialog-description">{t("keyboardShortcutsHint")}</Dialog.Description>
              </div>
              <Dialog.Close render={<Button variant="ghost" size="icon" />} aria-label={t("closeKeyboardShortcuts")}><X /></Dialog.Close>
            </header>
            <div className="shortcut-help-grid">
              {(Object.keys(GROUP_LABELS) as ShortcutGroup[]).map((group) => (
                <section key={group}>
                  <h2>{t(GROUP_LABELS[group])}</h2>
                  <dl>
                    {APP_COMMANDS.filter((command) => command.group === group).map((command) => (
                      <div key={command.id}>
                        <dt>{t(command.labelKey)}</dt>
                        <dd><kbd>{command.display}</kbd></dd>
                      </div>
                    ))}
                    {group === "assets" ? CONTEXT_SHORTCUTS.slice(0, 3).map((shortcut) => (
                      <div key={shortcut.labelKey}><dt>{t(shortcut.labelKey)}</dt><dd><kbd>{shortcut.display}</kbd></dd></div>
                    )) : null}
                  </dl>
                </section>
              ))}
              <section>
                <h2>{t("shortcutGroupContext")}</h2>
                <dl>
                  {CONTEXT_SHORTCUTS.slice(3).map((shortcut) => (
                    <div key={shortcut.labelKey}><dt>{t(shortcut.labelKey)}</dt><dd><kbd>{shortcut.display}</kbd></dd></div>
                  ))}
                </dl>
              </section>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
