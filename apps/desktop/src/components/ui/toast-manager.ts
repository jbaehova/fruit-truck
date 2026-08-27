import { Toast } from "@base-ui/react/toast";

export const toastManager = Toast.createToastManager();

type ToastKind = "success" | "error" | "info";

function addToast(kind: ToastKind, description: string) {
  return toastManager.add({
    type: kind,
    // The visible title is resolved through i18n by BaseToaster. Keep only a
    // semantic fallback here so notifications never freeze an English label.
    title: kind,
    description,
    priority: kind === "error" ? "high" : "low",
  });
}

export const toast = {
  success: (description: string) => addToast("success", description),
  error: (description: string) => addToast("error", description),
  info: (description: string) => addToast("info", description),
};
