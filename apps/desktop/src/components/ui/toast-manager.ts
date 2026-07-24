import { Toast } from "@base-ui/react/toast";

export const toastManager = Toast.createToastManager();

type ToastKind = "success" | "error" | "info";

function addToast(kind: ToastKind, description: string) {
  return toastManager.add({
    type: kind,
    title: kind === "success" ? "Completed" : kind === "error" ? "Something went wrong" : "Notice",
    description,
    priority: kind === "error" ? "high" : "low",
  });
}

export const toast = {
  success: (description: string) => addToast("success", description),
  error: (description: string) => addToast("error", description),
  info: (description: string) => addToast("info", description),
};
