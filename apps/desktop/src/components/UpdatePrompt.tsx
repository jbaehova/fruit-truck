import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Progress } from "@base-ui/react/progress";
import { ArrowRight, Download, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { bindUpdateCheckLifecycle, createUpdateCheckController, prepareUpdateInstall } from "@/updateCheck";
import { toast } from "@/components/ui/toast-manager";

type UpdatePhase = "ready" | "installing" | "failed";

export function UpdatePrompt({
  getActiveAttemptCount = () => 0,
  isDurableSavePending = () => false,
  getDurableSaveError,
  onBeforeInstall,
}: {
  getActiveAttemptCount?: () => number;
  isDurableSavePending?: () => boolean;
  getDurableSaveError?: () => unknown;
  onBeforeInstall?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("ready");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const downloadedRef = useRef(0);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const controller = createUpdateCheckController<Update>({
      check: async () => {
        const { check } = await import("@tauri-apps/plugin-updater");
        return check();
      },
      isOnline: () => navigator.onLine,
    });
    const unsubscribe = controller.subscribe((state) => {
      localStorage.setItem("fruit-truck.update.last-state", JSON.stringify({ status: state.status, lastCheckedAt: state.lastCheckedAt }));
      window.dispatchEvent(new CustomEvent("fruit-truck:update-state", { detail: { status: state.status, lastCheckedAt: state.lastCheckedAt } }));
      if (state.value) setUpdate(state.value);
    });
    const unbind = bindUpdateCheckLifecycle(controller, window);
    const manual = () => void controller.manualCheck().then((available) => {
      if (!available) toast.info(t("appUpToDate"));
    }).catch((error) => toast.error(t("updateCheckFailed", { error: error instanceof Error ? error.message : String(error) })));
    window.addEventListener("fruit-truck:check-update", manual);
    void controller.check().catch((error) => console.warn("Fruit Truck update check failed", error));
    return () => {
      window.removeEventListener("fruit-truck:check-update", manual);
      unbind();
      unsubscribe();
      controller.dispose();
    };
  }, [t]);

  const dismiss = () => {
    if (phase === "installing") return;
    void update?.close();
    setUpdate(null);
  };

  const install = async () => {
    if (!update) return;
    setPhase("installing");
    setMessage("");
    setDownloaded(0);
    setTotal(null);
    downloadedRef.current = 0;
    try {
      let forcedSnapshotPending = true;
      const gate = await prepareUpdateInstall({
        getActiveAttemptCount,
        isDurableSavePending: () => forcedSnapshotPending || isDurableSavePending(),
        getDurableSaveError,
        flushDurableSave: async () => {
          await onBeforeInstall?.();
          forcedSnapshotPending = false;
        },
      });
      if (!gate.allowed) {
        setPhase("failed");
        setMessage(gate.reason === "active_attempts"
          ? t("updateBlockedAttempts", { count: gate.activeAttemptCount })
          : t("updateDurableSaveFailed"));
        return;
      }
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setTotal(event.data.contentLength ?? null);
          return;
        }
        if (event.event === "Progress") {
          downloadedRef.current += event.data.chunkLength;
          setDownloaded(downloadedRef.current);
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setPhase("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (!update) return null;
  const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) dismiss(); }} disablePointerDismissal={phase === "installing"}>
      <Dialog.Portal>
        <Dialog.Backdrop className="update-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="update-dialog">
            <div className="update-art" aria-hidden="true"><Sparkles /><i /><i /><i /></div>
            <div className="update-copy">
          <p className="update-kicker">{t("updateAvailable")}</p>
          <Dialog.Title className="update-title">{t("updateReady")}</Dialog.Title>
          <Dialog.Description className="sr-only">{t("installVersion", { version: update.version })}</Dialog.Description>
          <p className="update-version"><span>v{update.currentVersion}</span><ArrowRight /><strong>v{update.version}</strong></p>
          <ScrollArea className="update-notes">
            <p>{update.body ?? t("updateFallback")}</p>
          </ScrollArea>

          {phase === "installing" ? (
            <Progress.Root className="update-progress" value={percent} aria-live="polite">
              <div><Progress.Label>{t("downloading")}</Progress.Label><Progress.Value /></div>
              <Progress.Track className="update-progress-track"><Progress.Indicator /></Progress.Track>
            </Progress.Root>
          ) : null}
          {phase === "failed" ? <p className="update-error" role="alert">{t("updateFailed", { message })}</p> : null}

          <div className="update-actions">
            <Dialog.Close render={<Button type="button" variant="ghost" disabled={phase === "installing"} />}>{t("later")}</Dialog.Close>
            <Button type="button" disabled={phase === "installing"} onClick={() => void install()}>
              {phase === "installing" ? <LoaderCircle className="spin" /> : phase === "failed" ? <RefreshCw /> : <Download />}
              {phase === "installing" ? t("installing") : phase === "failed" ? t("tryAgain") : t("updateRestart")}
            </Button>
          </div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
