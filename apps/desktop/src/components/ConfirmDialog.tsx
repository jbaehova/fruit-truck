import { AlertDialog } from "@base-ui/react/alert-dialog";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

export type Confirmation = {
  title: string;
  description: string;
  confirmLabel?: string;
  resolve: (confirmed: boolean) => void;
};

export function ConfirmDialog({
  confirmation,
  onClose,
}: {
  confirmation: Confirmation | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const finish = (confirmed: boolean) => {
    confirmation?.resolve(confirmed);
    onClose();
  };

  return (
    <AlertDialog.Root
      open={Boolean(confirmation)}
      onOpenChange={(open) => { if (!open && confirmation) finish(false); }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Viewport className="dialog-viewport">
          <AlertDialog.Popup className="confirm-dialog">
            <span className="dialog-icon"><AlertTriangle /></span>
            <div>
              <AlertDialog.Title className="dialog-title">{confirmation?.title}</AlertDialog.Title>
              <AlertDialog.Description className="dialog-description">{confirmation?.description}</AlertDialog.Description>
            </div>
            <footer className="dialog-actions">
              <AlertDialog.Close render={<Button variant="outline" />} onClick={() => finish(false)}>{t("cancel")}</AlertDialog.Close>
              <AlertDialog.Close render={<Button />} onClick={() => finish(true)}>{confirmation?.confirmLabel ?? t("continue")}</AlertDialog.Close>
            </footer>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
