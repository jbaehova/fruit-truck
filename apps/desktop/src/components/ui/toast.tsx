import { Toast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { toastManager } from "@/components/ui/toast-manager";
import { useI18n } from "@/i18n";

function ToastIcon({ type }: { type?: string }) {
  if (type === "success") return <CircleCheck />;
  if (type === "error") return <CircleAlert />;
  return <Info />;
}

function ToastList() {
  const { t } = useI18n();
  const { toasts } = Toast.useToastManager();

  return toasts.map((item) => (
    <Toast.Root className="base-toast" key={item.id} toast={item}>
      <Toast.Content className="base-toast-content">
        <span className="base-toast-icon"><ToastIcon type={item.type} /></span>
        <span className="base-toast-copy">
          <Toast.Title className="base-toast-title" />
          <Toast.Description className="base-toast-description" />
        </span>
        <Toast.Close className="base-toast-close" aria-label={t("dismissNotification")}><X /></Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}

export function BaseToaster() {
  return (
    <Toast.Provider toastManager={toastManager} timeout={4_500} limit={4}>
      <Toast.Portal>
        <Toast.Viewport className="base-toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
