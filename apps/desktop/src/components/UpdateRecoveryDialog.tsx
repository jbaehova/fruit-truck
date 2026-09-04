import { useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, FolderOpen, LoaderCircle, LogOut, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

type RecoveryAction = "retry" | "restore" | "export" | "open_assets" | "exit";

export type UpdateRecoveryDialogLabels = {
  eyebrow: string;
  title: string;
  description: string;
  status: string;
  recoveryRequired: string;
  versions: string;
  transaction: string;
  failureCode: string;
  retryVerification: string;
  restoreWorkspace: string;
  exportSnapshot: string;
  openAssetFolder: string;
  exitWithoutChanges: string;
};

export type UpdateRecoveryDialogProps = {
  open?: boolean;
  fromVersion?: string;
  toVersion?: string;
  transactionId?: string;
  failureCode?: string;
  failureMessage?: string;
  labels?: Partial<UpdateRecoveryDialogLabels>;
  onRetryVerification: () => void | Promise<void>;
  onRestorePreUpdateWorkspace: () => void | Promise<void>;
  onExportPreUpdateSnapshot: () => void | Promise<void>;
  onOpenAssetFolder: () => void | Promise<void>;
  onExitWithoutChanges: () => void | Promise<void>;
};

const DEFAULT_LABELS: UpdateRecoveryDialogLabels = {
  eyebrow: "UPDATE RECOVERY",
  title: "Your workspace needs verification.",
  description: "Fruit Truck has kept the pre-update workspace unchanged. Choose a recovery action before returning to the workspace.",
  status: "Status",
  recoveryRequired: "Recovery required",
  versions: "App version",
  transaction: "Transaction",
  failureCode: "Failure code",
  retryVerification: "Retry verification",
  restoreWorkspace: "Restore pre-update workspace",
  exportSnapshot: "Export pre-update snapshot",
  openAssetFolder: "Open asset folder",
  exitWithoutChanges: "Exit without changes",
};

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function UpdateRecoveryDialog({
  open = true,
  fromVersion,
  toVersion,
  transactionId,
  failureCode,
  failureMessage,
  labels: labelOverrides,
  onRetryVerification,
  onRestorePreUpdateWorkspace,
  onExportPreUpdateSnapshot,
  onOpenAssetFolder,
  onExitWithoutChanges,
}: UpdateRecoveryDialogProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const [pendingAction, setPendingAction] = useState<RecoveryAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const runAction = async (action: RecoveryAction, callback: () => void | Promise<void>) => {
    if (pendingAction) return;
    setPendingAction(action);
    setActionError(null);
    try {
      await callback();
    } catch (error) {
      setActionError(asErrorMessage(error));
    } finally {
      setPendingAction(null);
    }
  };

  const actionIcon = (action: RecoveryAction, fallback: ReactNode) => pendingAction === action
    ? <LoaderCircle className="spin" />
    : fallback;
  const busy = pendingAction !== null;
  const error = actionError ?? failureMessage;

  return (
    <Dialog.Root open={open} onOpenChange={() => undefined} disablePointerDismissal>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup
            className="workspace-recovery-dialog"
            role="alertdialog"
            aria-describedby="update-recovery-description"
            aria-busy={busy || undefined}
          >
            <ShieldAlert className="workspace-recovery-mark" aria-hidden="true" />
            <div>
              <span className="dialog-eyebrow">{labels.eyebrow}</span>
              <Dialog.Title className="dialog-title">{labels.title}</Dialog.Title>
              <Dialog.Description id="update-recovery-description" className="dialog-description">{labels.description}</Dialog.Description>
            </div>
            <dl>
              <div><dt>{labels.status}</dt><dd>{labels.recoveryRequired}</dd></div>
              {fromVersion || toVersion ? <div><dt>{labels.versions}</dt><dd>{fromVersion ? `v${fromVersion}` : "?"} → {toVersion ? `v${toVersion}` : "?"}</dd></div> : null}
              {transactionId ? <div><dt>{labels.transaction}</dt><dd title={transactionId}>{transactionId}</dd></div> : null}
              {failureCode ? <div><dt>{labels.failureCode}</dt><dd title={failureCode}>{failureCode}</dd></div> : null}
            </dl>
            {error ? <pre role="alert">{error}</pre> : null}
            <div className="workspace-recovery-actions">
              <Button type="button" disabled={busy} onClick={() => void runAction("retry", onRetryVerification)}>
                {actionIcon("retry", <RefreshCw />)} {labels.retryVerification}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void runAction("restore", onRestorePreUpdateWorkspace)}>
                {actionIcon("restore", <RotateCcw />)} {labels.restoreWorkspace}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void runAction("export", onExportPreUpdateSnapshot)}>
                {actionIcon("export", <Download />)} {labels.exportSnapshot}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void runAction("open_assets", onOpenAssetFolder)}>
                {actionIcon("open_assets", <FolderOpen />)} {labels.openAssetFolder}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void runAction("exit", onExitWithoutChanges)}>
                {actionIcon("exit", <LogOut />)} {labels.exitWithoutChanges}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
