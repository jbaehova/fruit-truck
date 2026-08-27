import { Dialog } from "@base-ui/react/dialog";
import { Download, FolderSearch, RotateCcw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import type { StudioRecoveryState } from "@/studio";

export function WorkspaceRecoveryDialog({
  recovery,
  onExport,
  onRestoreLastKnownGood,
  onReindex,
  onOpenSafeWorkspace,
}: {
  recovery: StudioRecoveryState;
  onExport: () => void;
  onRestoreLastKnownGood: () => void;
  onReindex: () => void;
  onOpenSafeWorkspace: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="workspace-recovery-dialog" aria-describedby="workspace-recovery-description">
            <ShieldAlert className="workspace-recovery-mark" />
            <div>
              <span className="dialog-eyebrow">{t("workspaceRecoveryEyebrow")}</span>
              <Dialog.Title className="dialog-title">{t("workspaceRecoveryTitle")}</Dialog.Title>
              <Dialog.Description id="workspace-recovery-description" className="dialog-description">{t("workspaceRecoveryHint")}</Dialog.Description>
            </div>
            <dl>
              <div><dt>{t("status")}</dt><dd>{recovery.kind}</dd></div>
              {recovery.sourceSchemaVersion ? <div><dt>Schema</dt><dd>v{recovery.sourceSchemaVersion} → v{recovery.targetSchemaVersion}</dd></div> : null}
              {recovery.backupKey ? <div><dt>{t("workspaceBackup")}</dt><dd>{recovery.backupKey}</dd></div> : null}
            </dl>
            {recovery.error || recovery.reason ? <pre>{recovery.error ?? recovery.reason}</pre> : null}
            <div className="workspace-recovery-actions">
              <Button type="button" variant="outline" onClick={onExport}><Download /> {t("exportWorkspaceBackup")}</Button>
              <Button type="button" variant="outline" onClick={onRestoreLastKnownGood}><RotateCcw /> {t("restoreLastKnownGood")}</Button>
              <Button type="button" variant="outline" onClick={onReindex}><FolderSearch /> {t("reindexManagedMedia")}</Button>
              <Button type="button" onClick={onOpenSafeWorkspace}>{t("openSafeWorkspace")}</Button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
