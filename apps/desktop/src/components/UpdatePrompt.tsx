import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Progress } from "@base-ui/react/progress";
import { ArrowRight, Download, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { bindUpdateCheckLifecycle, createUpdateCheckController, prepareUpdateInstall } from "@/updateCheck";
import { toast } from "@/components/ui/toast-manager";

export type UpdatePromptPhase =
  | "update_available"
  | "preparing_workspace"
  | "verifying_assets"
  | "downloading"
  | "installing"
  | "restarting"
  | "failed";

export type UpdatePreparationPhase = Extract<
  UpdatePromptPhase,
  "preparing_workspace" | "verifying_assets"
>;

export type UpdateInstallPhase = Extract<
  UpdatePromptPhase,
  "downloading" | "installing" | "restarting"
>;

export type UpdatePreparationContext = {
  fromVersion: string;
  toVersion: string;
  signal: AbortSignal;
  /** Progress is expressed as a percentage from 0 through 100. */
  onProgress: (phase: UpdatePreparationPhase, progress?: number) => void;
};

export type UpdatePromptLabels = Partial<Record<
  "preparingWorkspace" | "verifyingAssets" | "downloading" | "installing" | "restarting" | "cancel" | "cancelling",
  string
>>;

export type UpdatePromptProps = {
  getActiveAttemptCount?: () => number;
  isDurableSavePending?: () => boolean;
  getDurableSaveError?: () => unknown;
  /** Legacy save-only preparation hook. Prefer onPrepareInstall for lossless updates. */
  onBeforeInstall?: () => void | Promise<void>;
  onPrepareInstall?: (context: UpdatePreparationContext) => Promise<void>;
  /** Releases update-only locks after any unsuccessful install attempt. */
  onInstallAborted?: () => void | Promise<void>;
  /** Enters recovery after installation may have started and the workspace must stay locked. */
  onInstallRecoveryRequired?: (error: unknown) => void | Promise<void>;
  /** Persists lifecycle changes after preparation has successfully completed. */
  onInstallPhaseChange?: (phase: UpdateInstallPhase) => void | Promise<void>;
  onPhaseChange?: (phase: UpdatePromptPhase) => void;
  labels?: UpdatePromptLabels;
};


function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function clampPercent(progress: number | undefined): number | null {
  if (progress == null || !Number.isFinite(progress)) return null;
  return Math.min(100, Math.max(0, progress));
}

export function UpdatePrompt({
  getActiveAttemptCount = () => 0,
  isDurableSavePending = () => false,
  getDurableSaveError,
  onBeforeInstall,
  onPrepareInstall,
  onInstallAborted,
  onInstallRecoveryRequired,
  onInstallPhaseChange,
  onPhaseChange,
  labels: labelOverrides,
}: UpdatePromptProps) {
  const { t } = useI18n();
  const labels = {
    preparingWorkspace: t("updatePreparingWorkspace"), verifyingAssets: t("updateVerifyingAssets"),
    downloading: t("downloading"), installing: t("installing"), restarting: t("updateRestarting"),
    cancel: t("cancel"), cancelling: t("updateCancelling"), ...labelOverrides,
  };
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePromptPhase>("update_available");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [preparationProgress, setPreparationProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const downloadedRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activePreparationRef = useRef<{ runId: number; promise: Promise<void> } | null>(null);
  const installRunRef = useRef(0);
  const installInFlightRef = useRef(false);
  const cancelRequestedRunsRef = useRef(new Set<number>());
  const abortedRunsRef = useRef(new Map<number, Promise<void>>());

  const transition = (next: UpdatePromptPhase) => {
    setPhase(next);
    onPhaseChange?.(next);
  };

  const notifyInstallAborted = (runId: number) => {
    const existing = abortedRunsRef.current.get(runId);
    if (existing) return existing;
    let notification: Promise<void>;
    try {
      notification = Promise.resolve(onInstallAborted?.());
    } catch (error) {
      notification = Promise.reject(error);
    }
    abortedRunsRef.current.set(runId, notification);
    return notification;
  };

  const enterInstallPhase = async (next: UpdateInstallPhase) => {
    transition(next);
    await onInstallPhaseChange?.(next);
  };

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
    }).catch((error) => toast.error(t("updateCheckFailed", { error: asErrorMessage(error) })));
    window.addEventListener("fruit-truck:check-update", manual);
    void controller.check().catch((error) => console.warn("Fruit Truck update check failed", error));
    return () => {
      window.removeEventListener("fruit-truck:check-update", manual);
      unbind();
      unsubscribe();
      controller.dispose();
    };
  }, [t]);

  const isPreparing = phase === "preparing_workspace" || phase === "verifying_assets";
  const canDismiss = phase === "update_available" || phase === "failed";

  const dismiss = () => {
    if (!canDismiss) return;
    void update?.close();
    setUpdate(null);
  };

  const cancelPreparation = async () => {
    if (!isPreparing || cancelling) return;
    const runId = installRunRef.current;
    const controller = abortControllerRef.current;
    const preparation = activePreparationRef.current?.runId === runId
      ? activePreparationRef.current.promise
      : null;
    setCancelling(true);
    cancelRequestedRunsRef.current.add(runId);
    controller?.abort();
    try {
      if (preparation) {
        try {
          await preparation;
        } catch {
          // The install flow reports preparation errors after releasing its lock.
        }
      }
      await notifyInstallAborted(runId);
      if (installRunRef.current === runId) {
        setMessage("");
        setPreparationProgress(null);
        transition("update_available");
      }
    } catch (error) {
      if (installRunRef.current === runId) {
        setMessage(asErrorMessage(error));
        transition("failed");
      }
    } finally {
      if (installRunRef.current === runId) setCancelling(false);
    }
  };

  const install = async () => {
    if (!update || installInFlightRef.current) return;
    installInFlightRef.current = true;
    const runId = installRunRef.current + 1;
    installRunRef.current = runId;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setMessage("");
    setDownloaded(0);
    setTotal(null);
    setPreparationProgress(null);
    setCancelling(false);
    downloadedRef.current = 0;
    transition("preparing_workspace");
    let updaterCompleted = false;
    let installMayHaveStarted = false;
    let installingPhasePromise: Promise<void> | null = null;
    try {
      let gateAllowed = true;
      let gateReason: "active_attempts" | "durable_save_pending" | "durable_save_failed" | undefined;
      let gateActiveAttemptCount = 0;
      if (onPrepareInstall) {
        const preparation = onPrepareInstall({
          fromVersion: update.currentVersion,
          toVersion: update.version,
          signal: abortController.signal,
          onProgress: (nextPhase, progress) => {
            if (installRunRef.current !== runId || abortController.signal.aborted) return;
            setPreparationProgress(clampPercent(progress));
            transition(nextPhase);
          },
        });
        activePreparationRef.current = { runId, promise: preparation };
        try {
          await preparation;
        } finally {
          if (activePreparationRef.current?.runId === runId) activePreparationRef.current = null;
        }
      } else {
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
        gateAllowed = gate.allowed;
        gateReason = gate.reason;
        gateActiveAttemptCount = gate.activeAttemptCount;
      }

      if (abortController.signal.aborted || installRunRef.current !== runId) {
        await notifyInstallAborted(runId);
        return;
      }
      if (!gateAllowed) {
        let failureMessage = gateReason === "active_attempts"
          ? t("updateBlockedAttempts", { count: gateActiveAttemptCount })
          : t("updateDurableSaveFailed");
        try {
          await notifyInstallAborted(runId);
        } catch (cleanupError) {
          failureMessage = `${failureMessage} ${asErrorMessage(cleanupError)}`;
        }
        setMessage(failureMessage);
        transition("failed");
        return;
      }

      setPreparationProgress(null);
      await enterInstallPhase("downloading");
      const persistInstallingPhase = () => {
        if (!installingPhasePromise) {
          installingPhasePromise = enterInstallPhase("installing");
          void installingPhasePromise.catch(() => undefined);
        }
        return installingPhasePromise;
      };
      await update.downloadAndInstall((event) => {
        if (installRunRef.current !== runId) return;
        if (event.event === "Started") {
          setTotal(event.data.contentLength ?? null);
          return;
        }
        if (event.event === "Progress") {
          downloadedRef.current += event.data.chunkLength;
          setDownloaded(downloadedRef.current);
          return;
        }
        if (event.event === "Finished") {
          installMayHaveStarted = true;
          void persistInstallingPhase();
        }
      });
      updaterCompleted = true;
      await persistInstallingPhase();
      await enterInstallPhase("restarting");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      if (abortController.signal.aborted && installRunRef.current === runId) {
        try {
          await notifyInstallAborted(runId);
          if (!cancelRequestedRunsRef.current.has(runId)) {
            setMessage("");
            transition("update_available");
          }
        } catch (cleanupError) {
          setMessage(asErrorMessage(cleanupError));
          transition("failed");
        }
        return;
      }
      if (installRunRef.current !== runId) return;
      let failureMessage = asErrorMessage(error);
      if (!updaterCompleted && installingPhasePromise) {
        try {
          await installingPhasePromise;
        } catch (phaseError) {
          if (asErrorMessage(phaseError) !== failureMessage) {
            failureMessage = `${failureMessage} ${asErrorMessage(phaseError)}`;
          }
        }
      }
      try {
        if (updaterCompleted || installMayHaveStarted) await onInstallRecoveryRequired?.(error);
        else await notifyInstallAborted(runId);
      } catch (cleanupError) {
        failureMessage = `${failureMessage} ${asErrorMessage(cleanupError)}`;
      }
      setMessage(failureMessage);
      transition("failed");
    } finally {
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
      if (!updaterCompleted && !installMayHaveStarted && installRunRef.current === runId) installInFlightRef.current = false;
    }
  };

  if (!update) return null;
  const downloadPercent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const progress = isPreparing ? preparationProgress : phase === "downloading" ? downloadPercent : null;
  const progressLabel = phase === "preparing_workspace"
    ? labels.preparingWorkspace
    : phase === "verifying_assets"
      ? labels.verifyingAssets
      : phase === "downloading"
        ? (labelOverrides?.downloading ?? t("downloading"))
        : phase === "installing"
          ? (labelOverrides?.installing ?? t("installing"))
          : labels.restarting;
  const showProgress = isPreparing || phase === "downloading" || phase === "installing" || phase === "restarting";

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) dismiss(); }} disablePointerDismissal={!canDismiss}>
      <Dialog.Portal>
        <Dialog.Backdrop className="update-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="update-dialog" aria-busy={showProgress || undefined}>
            <div className="update-art" aria-hidden="true"><Sparkles /><i /><i /><i /></div>
            <div className="update-copy">
              <p className="update-kicker">{t("updateAvailable")}</p>
              <Dialog.Title className="update-title">{t("updateReady")}</Dialog.Title>
              <Dialog.Description className="sr-only">{t("installVersion", { version: update.version })}</Dialog.Description>
              <p className="update-version"><span>v{update.currentVersion}</span><ArrowRight /><strong>v{update.version}</strong></p>
              <ScrollArea className="update-notes">
                <p>{update.body ?? t("updateFallback")}</p>
              </ScrollArea>

              {showProgress ? (
                <Progress.Root className="update-progress" value={progress} aria-live="polite">
                  <div><Progress.Label>{progressLabel}</Progress.Label><Progress.Value /></div>
                  <Progress.Track className="update-progress-track"><Progress.Indicator /></Progress.Track>
                </Progress.Root>
              ) : null}
              {phase === "failed" ? <p className="update-error" role="alert">{t("updateFailed", { message })}</p> : null}

              <div className="update-actions">
                {isPreparing ? (
                  <Button type="button" variant="ghost" disabled={cancelling} onClick={() => void cancelPreparation()}>
                    {cancelling ? <LoaderCircle className="spin" /> : <X />}
                    {cancelling ? labels.cancelling : labels.cancel}
                  </Button>
                ) : (
                  <Dialog.Close render={<Button type="button" variant="ghost" disabled={!canDismiss} />}>{t("later")}</Dialog.Close>
                )}
                <Button type="button" disabled={!canDismiss} onClick={() => void install()}>
                  {showProgress ? <LoaderCircle className="spin" /> : phase === "failed" ? <RefreshCw /> : <Download />}
                  {showProgress ? progressLabel : phase === "failed" ? t("tryAgain") : t("updateRestart")}
                </Button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
