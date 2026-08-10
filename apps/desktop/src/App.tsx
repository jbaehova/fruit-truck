import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { Field } from "@base-ui/react/field";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  ChevronRight,
  CircleAlert,
  ImageIcon,
  LoaderCircle,
  PanelLeftOpen,
  PanelRightOpen,
  Play,
  RefreshCw,
  Settings,
  Sparkles,
  Video,
} from "lucide-react";
import "./App.css";
import {
  assemblyDurationSeconds,
  expectedVideoDurationSeconds,
  recordActualCost,
  recordAgentActivity,
  exposeAgentSession,
  resolveAgentDecisionFromDesktop,
  setControlMode,
  validateAssemblyDuration,
  type AgentSessionState,
  type VideoAssemblyClip,
} from "@/agent";
import {
  commitAgentOperations,
  commitAgentOperationsWithConflictRetry,
  diffAgentBridgeSession,
  materializeAgentSession,
  preserveLocalAssetMetadata,
  readAgentBridge,
  readAgentBridgeSession,
  recordAgentTelemetry,
  serializeAgentSessionForBridge,
  waitForAgentBridgeEvents,
  writeSerializedAgentBridgeSession,
  type AgentBridgeSession,
} from "@/agentBridge";
import { mergeBridgeSession } from "@/bridgeMerge";
import { AgentPanel, type BatchSummary } from "@/components/AgentPanel";
import { AttemptHistoryPopover } from "@/components/AttemptHistoryPopover";
import { AssetLibrary } from "@/components/AssetLibrary";
import { AssetPreview } from "@/components/AssetPreview";
import { ConfirmDialog, type Confirmation } from "@/components/ConfirmDialog";
import { ImageEditPanel } from "@/components/EditMediaPanel";
import { GenerationThreadRail } from "@/components/GenerationThreadRail";
import { GenerationResultDialog, type GenerationResultNotice } from "@/components/GenerationResultDialog";
import { InputTray } from "@/components/InputTray";
import { ModelSelector } from "@/components/ModelSelector";
import { Onboarding } from "@/components/Onboarding";
import { OptionsFields } from "@/components/OptionsFields";
import { RequestPreviewDialog } from "@/components/RequestPreviewDialog";
import { RightPanel } from "@/components/RightPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ShortcutHelpDialog } from "@/components/ShortcutHelpDialog";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast-manager";
import { useI18n } from "@/i18n";
import { findInputMentions, mentionedInputSlots } from "@/inputMentions";
import { createNativeAppMenu, type NativeAppMenu, type NativeMenuState } from "@/appMenu";
import { applyAlphaMaskBlob, composeEditPrompt, hasGenerationInstructions, renderMaskGuide } from "@/mask";
import { invoke } from "@tauri-apps/api/core";
import {
  allowedAssetRoles,
  buildRequest,
  cacheVideo,
  defaultOptions,
  enhancePrompt,
  estimateGenerationCost,
  formatUsd,
  generateImage,
  getCredentialStatus,
  imageReferenceLimit,
  hydrateImageModelPricing,
  isTauriRuntime,
  loadModels,
  loadImageModelEndpoints,
  pollVideo,
  prettyRequest,
  removeApiKey,
  saveApiKey,
  submitVideo,
  validateEnhancedPrompt,
  videoReferenceLimit,
  type CredentialStatus,
  type GenerationMode,
  type GenerationModel,
  type ImageModel,
  type ImageModelEndpoint,
  type PromptEnhancementVisual,
  type ReferenceAsset,
  type VideoModel,
} from "@/openrouter";
import {
  createSession,
  createSiblingGenerationThread,
  assetRequestUrl,
  deleteManagedAsset,
  deleteSessionBlobs,
  importFileAsset,
  importGeneratedImage,
  importGeneratedVideo,
  initializeSessionCatalogDefaults,
  loadStudioState,
  managedDroppedAssets,
  materializeRequestBlob,
  migrateLegacyAsset,
  nextReferenceSlot,
  nextAvailableSessionName,
  pickManagedAssets,
  resolveAssetMaskSource,
  saveStudioState,
  activeGenerationAttempt,
  beginGeneratedImageEdit,
  activeVideoJobsFromAttempts,
  effectiveThreadDraft,
  effectiveThreadModelId,
  exportAssetToDownloads,
  optionOverridesFromDefaults,
  type NativeManagedAsset,
  type GenerationDraftState,
  type GenerationAttempt,
  type GenerationThread,
  type SessionAsset,
  type StudioSession,
} from "@/studio";
import { NATIVE_MENU_COMMAND_IDS, commandForKeyboardEvent, type AppCommandId } from "@/shortcuts";
import {
  VIDEO_POLL_INTERVAL_MS,
  createResilientPollScheduler,
  hasVideoPollingTimedOut,
  isVideoPollDue,
  videoPollRetryDelayMs,
} from "@/videoPolling";

const AssemblyDialog = lazy(() => import("@/components/AssemblyDialog").then((module) => ({ default: module.AssemblyDialog })));
const DecisionWorkspace = lazy(() => import("@/components/DecisionWorkspace").then((module) => ({ default: module.DecisionWorkspace })));
const SettingsDialog = lazy(() => import("@/components/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error:\s*/, "").slice(0, 800);
}

function FruitTruckMark() {
  return <img src="/fruit-truck-icon.png" alt="" aria-hidden="true" />;
}

function providerLabel(model: GenerationModel | null) {
  return model?.name.split(":", 1)[0] ?? "OpenRouter";
}

function PromptMentionHighlight({
  value,
  mentions,
}: {
  value: string;
  mentions: ReturnType<typeof findInputMentions>;
}) {
  const content = [];
  let cursor = 0;
  for (const mention of mentions) {
    content.push(value.slice(cursor, mention.start));
    content.push(<mark key={`${mention.start}:${mention.slot}`}>{value.slice(mention.start, mention.end)}</mark>);
    cursor = mention.end;
  }
  content.push(value.slice(cursor));
  if (value.endsWith("\n")) content.push(" ");
  return <>{content}</>;
}

function summarizeBatchAttempts(attempts: GenerationAttempt[]): BatchSummary {
  const estimatedCosts = attempts.flatMap((attempt) => attempt.estimatedCostUsd == null ? [] : [attempt.estimatedCostUsd]);
  const actualCosts = attempts.flatMap((attempt) => attempt.actualCostUsd == null ? [] : [attempt.actualCostUsd]);
  return {
    total: attempts.length,
    queued: attempts.filter((attempt) => ["queued", "enhancing", "awaiting_host"].includes(attempt.status)).length,
    running: attempts.filter((attempt) => ["submitting", "in_progress"].includes(attempt.status)).length,
    completed: attempts.filter((attempt) => attempt.status === "completed").length,
    failed: attempts.filter((attempt) => attempt.status === "failed").length,
    uncertain: attempts.filter((attempt) => attempt.status === "uncertain").length,
    canceled: attempts.filter((attempt) => attempt.status === "canceled").length,
    estimatedCostUsd: estimatedCosts.length ? estimatedCosts.reduce((sum, cost) => sum + cost, 0) : undefined,
    actualCostUsd: actualCosts.length ? actualCosts.reduce((sum, cost) => sum + cost, 0) : undefined,
  };
}

const SESSION_SIDEBAR_OPEN_KEY = "fruit-truck.session-sidebar.open";
const SESSION_SIDEBAR_WIDTH_KEY = "fruit-truck.session-sidebar.width";
const RIGHT_PANEL_OPEN_KEY = "fruit-truck.right-panel.open";
const ONBOARDING_COMPLETE_KEY = "fruit-truck.onboarding.complete.v1";
const DEFAULT_SESSION_SIDEBAR_WIDTH = 256;

function hasRunnableInstructions(mode: GenerationMode, draft: GenerationDraftState) {
  return hasGenerationInstructions({
    prompt: draft.prompt,
    hasMask: mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0,
    maskInstructions: draft.maskInstructions,
  });
}

function enhancementOriginalIntent(mode: GenerationMode, draft: GenerationDraftState) {
  const hasMask = mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0;
  return [draft.prompt.trim(), hasMask ? draft.maskInstructions.trim() : ""].filter(Boolean).join("\n");
}

export default function App() {
  const { language, t } = useI18n();
  const [studio, setStudio] = useState(loadStudioState);
  const [catalogs, setCatalogs] = useState<Record<GenerationMode, GenerationModel[]>>({ image: [], video: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [imageEndpoints, setImageEndpoints] = useState<Record<string, ImageModelEndpoint[]>>({});
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [executingThreadIds, setExecutingThreadIds] = useState<Set<string>>(new Set());
  const [enhancingThreadIds, setEnhancingThreadIds] = useState<Set<string>>(new Set());
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [resultQueue, setResultQueue] = useState<GenerationResultNotice[]>([]);
  const [resultDialogOpen, setResultDialogOpen] = useState(false);
  const [resultHandingOff, setResultHandingOff] = useState(false);
  const [resultQueuePaused, setResultQueuePaused] = useState(false);
  const [otherDialogOpen, setOtherDialogOpen] = useState(false);
  const [highlightedAssetIds, setHighlightedAssetIds] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<"agent" | "assets">("assets");
  const [rightPanelOpen, setRightPanelOpen] = useState(() =>
    typeof localStorage === "undefined" || localStorage.getItem(RIGHT_PANEL_OPEN_KEY) !== "false",
  );
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [assemblyOpen, setAssemblyOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(() =>
    typeof localStorage === "undefined" || localStorage.getItem(SESSION_SIDEBAR_OPEN_KEY) !== "false",
  );
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(() => {
    if (typeof localStorage === "undefined") return DEFAULT_SESSION_SIDEBAR_WIDTH;
    const stored = Number(localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= 210 && stored <= 420 ? stored : DEFAULT_SESSION_SIDEBAR_WIDTH;
  });
  const composerViewportRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHighlightRef = useRef<HTMLDivElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const nativeMenuRef = useRef<NativeAppMenu | null>(null);
  const nativeMenuStateRef = useRef<NativeMenuState>({ enabled: {}, checked: {} });
  const nativeMenuBuildQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dispatchCommandRef = useRef<(id: AppCommandId) => boolean>(() => false);
  const createNewSessionRef = useRef<() => void>(() => {});
  const duplicateThreadRef = useRef<(id: string) => void>(() => {});
  const restoreThreadRef = useRef<(id: string) => void>(() => {});
  const switchModeRef = useRef<(mode: GenerationMode) => void>(() => {});
  const pickFilesRef = useRef<() => Promise<SessionAsset[]>>(async () => []);
  const runGenerationRef = useRef<() => void>(() => {});
  const dismissGenerationResultRef = useRef<() => void>(() => {});
  const polling = useRef(false);
  const videoPollNotBefore = useRef(new Map<string, number>());
  const catalogHydrationRevision = useRef(0);
  const attemptStatuses = useRef<Map<string, GenerationAttempt["status"]> | null>(null);
  const resultHandoffTimer = useRef<number | undefined>(undefined);
  const resultCooldownTimer = useRef<number | undefined>(undefined);
  const assetHighlightTimer = useRef<number | undefined>(undefined);
  const studioRef = useRef(studio);
  studioRef.current = studio;
  const migratingAssetIds = useRef(new Set<string>());
  const bridgeRevisions = useRef(new Map<string, number>());
  const bridgeSnapshots = useRef(new Map<string, AgentBridgeSession>());
  const bridgeSyncing = useRef(new Set<string>());
  const bridgeDirtyVersions = useRef(new Map<string, number>());
  const bridgeRetryAttempts = useRef(new Map<string, number>());
  const bridgeRetryAt = useRef(new Map<string, number>());
  const [bridgeSyncTick, setBridgeSyncTick] = useState(0);
  const quitConfirmationPending = useRef(false);
  const confirmationRef = useRef<Confirmation | null>(null);

  const session = studio.sessions.find((item) => item.id === studio.activeSessionId) ?? studio.sessions[0];
  const pendingUiDecision = session.agent.decisions.find((decision) =>
    decision.status === "pending" && decision.channel === "fruit_truck_ui"
  );
  const mode = session.mode;
  const modeThreads = session.threads[mode].filter((item) => !item.archivedAt);
  const thread = modeThreads.find((item) => item.id === session.activeThreadIds[mode]) ?? modeThreads[0];
  const draft = effectiveThreadDraft(session, thread);
  const models = catalogs[mode];
  const selectedId = effectiveThreadModelId(session, thread);
  const selectedModel = models.find((model) => model.id === selectedId) ?? null;
  const approvedVideoCount = session.agent.artifacts.filter((artifact) =>
    artifact.approval === "approved"
      && session.assets.find((asset) => asset.id === artifact.assetId)?.kind === "video"
  ).length;
  const roles = allowedAssetRoles(mode, selectedModel);
  const referenceLimit = mode === "image"
    ? imageReferenceLimit(selectedModel as ImageModel | null)
    : Math.max(
      roles.length,
      videoReferenceLimit(selectedModel as VideoModel | null)
      + ((selectedModel as VideoModel | null)?.supported_frame_images?.length ?? 0),
    );
  const assetMap = useMemo(() => new Map(session.assets.map((asset) => [asset.id, asset])), [session.assets]);
  const sessionVideoJobs = activeVideoJobsFromAttempts(session);
  const persistedBatchSummary = useMemo<BatchSummary | null>(() => {
    const attempts = [...session.threads.image, ...session.threads.video].flatMap((item) => item.attempts);
    const requestKey = attempts.filter((attempt) => attempt.requestKey).toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.requestKey;
    if (!requestKey) return null;
    const batch = attempts.filter((attempt) => attempt.requestKey === requestKey);
    return summarizeBatchAttempts(batch);
  }, [session.threads]);
  const activeAttempt = activeGenerationAttempt(thread);
  const hasActiveAttempt = Boolean(activeAttempt);
  const generating = executingThreadIds.has(thread.id) || Boolean(activeAttempt && activeAttempt.status !== "enhancing");
  const enhancing = enhancingThreadIds.has(thread.id) || activeAttempt?.status === "enhancing";

  useEffect(() => {
    const previous = attemptStatuses.current;
    const next = new Map<string, GenerationAttempt["status"]>();
    const completed: GenerationResultNotice[] = [];
    const failed: Array<{ sessionId: string; sessionName: string; threadName: string; message: string }> = [];

    for (const candidateSession of studio.sessions) {
      for (const candidateThread of [...candidateSession.threads.image, ...candidateSession.threads.video]) {
        for (const attempt of candidateThread.attempts) {
          const key = `${candidateSession.id}:${candidateThread.id}:${attempt.id}`;
          next.set(key, attempt.status);
          const previousStatus = previous?.get(key);
          if (previousStatus === attempt.status) continue;
          if (attempt.status === "completed" && attempt.assetIds.length) {
            completed.push({
              sessionId: candidateSession.id,
              sessionName: candidateSession.name,
              threadId: candidateThread.id,
              threadName: candidateThread.name,
              attemptId: attempt.id,
              assetIds: [...attempt.assetIds],
              completedAt: attempt.completedAt ?? attempt.updatedAt,
            });
          } else if (attempt.status === "failed" || attempt.status === "uncertain") {
            failed.push({
              sessionId: candidateSession.id,
              sessionName: candidateSession.name,
              threadName: candidateThread.name,
              message: attempt.error ?? t("generationFailed"),
            });
          }
        }
      }
    }

    attemptStatuses.current = next;
    if (!previous) return;

    const activeResults = completed
      .filter((notice) => notice.sessionId === studio.activeSessionId)
      .toSorted((left, right) => left.completedAt.localeCompare(right.completedAt));
    if (activeResults.length) {
      setResultQueue((current) => {
        const known = new Set(current.map((notice) => `${notice.sessionId}:${notice.attemptId}`));
        return [...current, ...activeResults.filter((notice) => !known.has(`${notice.sessionId}:${notice.attemptId}`))];
      });
    }
    for (const notice of completed.filter((item) => item.sessionId !== studio.activeSessionId)) {
      toast.info(t("backgroundResultSaved", { session: notice.sessionName, count: notice.assetIds.length }));
    }
    for (const failure of failed) {
      toast.error(failure.sessionId === studio.activeSessionId
        ? `${failure.threadName}: ${failure.message}`
        : t("backgroundGenerationFailed", { session: failure.sessionName, thread: failure.threadName }));
    }
  }, [studio, t]);

  useEffect(() => {
    if (resultQueue.length && !resultDialogOpen && !resultHandingOff && !resultQueuePaused && !otherDialogOpen) setResultDialogOpen(true);
  }, [otherDialogOpen, resultDialogOpen, resultHandingOff, resultQueue.length, resultQueuePaused]);

  useEffect(() => {
    if (!resultQueue.length) {
      if (resultQueuePaused) setResultQueuePaused(false);
      if (resultDialogOpen) setResultDialogOpen(false);
    }
  }, [resultDialogOpen, resultQueue.length, resultQueuePaused]);

  useEffect(() => {
    setResultQueue((current) => current.filter((notice) => notice.sessionId === studio.activeSessionId));
  }, [studio.activeSessionId]);

  useEffect(() => {
    const sync = () => setOtherDialogOpen(Boolean(document.querySelector(
      '[role="dialog"]:not(.generation-result-dialog), [role="alertdialog"]',
    )));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (resultHandoffTimer.current) window.clearTimeout(resultHandoffTimer.current);
    if (resultCooldownTimer.current) window.clearTimeout(resultCooldownTimer.current);
    if (assetHighlightTimer.current) window.clearTimeout(assetHighlightTimer.current);
  }, []);

  useEffect(() => {
    composerViewportRef.current?.scrollTo({ top: 0, left: 0 });
  }, [mode, selectedId, studio.activeSessionId, thread.id]);

  const patchSession = useCallback((id: string, update: (current: StudioSession) => StudioSession) => {
    setStudio((current) => ({
      ...current,
      sessions: current.sessions.map((item) => {
        if (item.id !== id) return item;
        const createdAt = new Date().toISOString();
        const next = update(item);
        if (next.agentBridge) {
          bridgeDirtyVersions.current.set(
            item.id,
            (bridgeDirtyVersions.current.get(item.id) ?? 0) + 1,
          );
        }
        const agent = next.agentBridge && next.agent.revision <= item.agent.revision
          ? { ...next.agent, revision: item.agent.revision + 1, updatedAt: createdAt }
          : next.agent;
        return { ...next, agent, updatedAt: createdAt };
      }),
    }));
  }, []);

  const patchActive = useCallback((update: (current: StudioSession) => StudioSession) => {
    patchSession(studio.activeSessionId, update);
  }, [patchSession, studio.activeSessionId]);

  const patchDraft = useCallback((patch: Partial<GenerationDraftState>) => {
    patchActive((current) => {
      const currentMode = current.mode;
      const targetId = current.activeThreadIds[currentMode];
      return {
        ...current,
        threads: {
          ...current.threads,
          [currentMode]: current.threads[currentMode].map((item) => {
            if (item.id !== targetId) return item;
            const defaults = current.generationDefaults.options[item.mode];
            const optionOverrides = patch.options ? optionOverridesFromDefaults(defaults, patch.options) : item.optionOverrides;
            const providerJsonOverride = patch.providerJson !== undefined
              ? patch.providerJson === current.generationDefaults.providerJson[item.mode] ? undefined : patch.providerJson
              : item.providerJsonOverride;
            const { options: _options, providerJson: _providerJson, ...draftPatch } = patch;
            const normalizedDraftPatch = draftPatch.enhancedPrompt === ""
              ? { ...draftPatch, enhancedVisualCount: 0 }
              : draftPatch;
            return {
              ...item,
              optionOverrides,
              providerJsonOverride,
              draft: { ...item.draft, ...normalizedDraftPatch },
              revision: item.revision + 1,
              updatedAt: new Date().toISOString(),
            };
          }),
        },
      };
    });
  }, [patchActive]);

  const patchAgent = useCallback((update: StudioSession["agent"] | ((current: StudioSession["agent"]) => StudioSession["agent"])) => {
    patchActive((current) => {
      const agent = typeof update === "function" ? update(current.agent) : update;
      return {
        ...current,
        agent,
        agentBridge: current.agentBridge || agent.controlMode === "agent" || agent.plan.length > 0,
      };
    });
  }, [patchActive]);

  const recordGenerationCost = useCallback((
    sessionId: string,
    mode: GenerationMode,
    threadId: string | undefined,
    attemptId: string | undefined,
    actualCostUsd: number,
  ) => {
    if (!threadId || !attemptId) return;
    const recordedAt = new Date().toISOString();
    patchSession(sessionId, (current) => ({
      ...current,
      threads: {
        ...current.threads,
        [mode]: current.threads[mode].map((item) => item.id === threadId ? {
          ...item,
          attempts: item.attempts.map((attempt) => attempt.id === attemptId ? {
            ...attempt,
            actualCostUsd,
            costRecordedAt: recordedAt,
          } : attempt),
        } : item),
      },
      agent: recordActualCost(current.agent, {
        id: `generation:${attemptId}`,
        category: "generation",
        actualCostUsd,
        recordedAt,
      }),
    }));
  }, [patchSession]);

  const confirmAction = useCallback((title: string, description: string, confirmLabel?: string) =>
    new Promise<boolean>((resolve) => {
      if (confirmationRef.current) {
        resolve(false);
        return;
      }
      const next = { title, description, confirmLabel, resolve };
      confirmationRef.current = next;
      setConfirmation(next);
    }), []);

  const closeConfirmation = useCallback(() => {
    confirmationRef.current = null;
    setConfirmation(null);
  }, []);

  useEffect(() => {
    if (studio.sessions.some((item) => item.assets.some((asset) => asset.externalUrl?.startsWith("data:")))) {
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        saveStudioState(studio);
      } catch (error) {
        toast.error(`Could not save the studio state: ${errorMessage(error)}`);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [studio]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const candidate = studio.sessions.flatMap((candidateSession) =>
      candidateSession.assets
        .filter((asset) =>
          !asset.localPath
          && (asset.blobKey || asset.externalUrl?.startsWith("data:"))
          && !migratingAssetIds.current.has(asset.id)
        )
        .map((asset) => ({ sessionId: candidateSession.id, asset }))
    )[0];
    if (!candidate) return;
    migratingAssetIds.current.add(candidate.asset.id);
    void migrateLegacyAsset(candidate.asset).then((migrated) => {
      patchSession(candidate.sessionId, (current) => ({
        ...current,
        assets: current.assets.map((asset) => asset.id === migrated.id ? migrated : asset),
      }));
    }).catch((error) => {
      migratingAssetIds.current.delete(candidate.asset.id);
      console.warn("Legacy asset migration failed; retaining IndexedDB fallback", error);
    });
  }, [patchSession, studio]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const timer = window.setTimeout(() => {
      for (const item of studio.sessions.filter((candidate) => candidate.agentBridge)) {
        const dirtyVersion = bridgeDirtyVersions.current.get(item.id);
        if (dirtyVersion == null || bridgeSyncing.current.has(item.id)) continue;
        if ((bridgeRetryAt.current.get(item.id) ?? 0) > Date.now()) continue;
        const expectedRevision = bridgeRevisions.current.get(item.id);
        const base = bridgeSnapshots.current.get(item.id);
        bridgeSyncing.current.add(item.id);
        let serialized: AgentBridgeSession | undefined;
        void serializeAgentSessionForBridge(item).then(async (value) => {
          serialized = value;
          let saved: AgentBridgeSession;
          if (expectedRevision == null) {
            const envelope = await writeSerializedAgentBridgeSession(serialized, 0);
            saved = envelope.sessions.find((candidate) => candidate.id === item.id)
              ?? await readAgentBridgeSession(item.id);
          } else {
            if (!base) throw new Error(`Core base snapshot for ${item.id} is unavailable.`);
            const patches = diffAgentBridgeSession(base, serialized);
            if (!patches.length) {
              if (bridgeDirtyVersions.current.get(item.id) === dirtyVersion) {
                bridgeDirtyVersions.current.delete(item.id);
              }
              setStudio((current) => ({
                ...current,
                sessions: current.sessions.map((candidate) => candidate.id === item.id
                  ? { ...candidate, agent: { ...candidate.agent, revision: expectedRevision } }
                  : candidate),
              }));
              return;
            }
            const committed = await commitAgentOperations(
              item.id,
              expectedRevision,
              `desktop-projection:${item.id}:${expectedRevision}:${serialized.agent.revision}`,
              [{ type: "apply_projection_patch", patches }],
            );
            saved = committed.session;
          }
          bridgeRevisions.current.set(item.id, saved.agent.revision);
          bridgeSnapshots.current.set(item.id, saved);
          bridgeRetryAttempts.current.delete(item.id);
          bridgeRetryAt.current.delete(item.id);
          const unchangedSinceStart = bridgeDirtyVersions.current.get(item.id) === dirtyVersion;
          if (unchangedSinceStart) bridgeDirtyVersions.current.delete(item.id);
          if (!unchangedSinceStart) return;
          const incoming = materializeAgentSession(saved);
          setStudio((current) => ({
            ...current,
            sessions: current.sessions.map((candidate) => candidate.id === item.id ? {
              ...candidate,
              ...incoming,
              assets: preserveLocalAssetMetadata(incoming.assets, candidate.assets),
            } : candidate),
          }));
        }).catch(async (error) => {
          if (errorMessage(error).includes("AGENT_SESSION_CONFLICT") && serialized) {
            try {
              const remote = await readAgentBridgeSession(item.id);
              const merged = mergeBridgeSession(base ?? remote, serialized, remote);
              bridgeRevisions.current.set(item.id, remote.agent.revision);
              bridgeSnapshots.current.set(item.id, remote);
              bridgeDirtyVersions.current.set(item.id, (bridgeDirtyVersions.current.get(item.id) ?? 0) + 1);
              bridgeRetryAttempts.current.delete(item.id);
              bridgeRetryAt.current.delete(item.id);
              const incoming = materializeAgentSession(merged);
              setStudio((current) => ({
                ...current,
                sessions: current.sessions.map((candidate) => candidate.id === item.id ? {
                  ...candidate,
                  ...incoming,
                  assets: preserveLocalAssetMetadata(incoming.assets, candidate.assets),
                } : candidate),
              }));
              toast.info("The shared session changed first; local edits were rebased onto the latest Core state.");
              return;
            } catch (reloadError) {
              error = reloadError;
            }
          }
          const attempts = (bridgeRetryAttempts.current.get(item.id) ?? 0) + 1;
          bridgeRetryAttempts.current.set(item.id, attempts);
          if (attempts === 1) toast.error(`Could not sync the shared session: ${errorMessage(error)}`);
          const delay = Math.min(30_000, 500 * 2 ** Math.min(6, attempts - 1));
          bridgeRetryAt.current.set(item.id, Date.now() + delay);
          window.setTimeout(() => setBridgeSyncTick((current) => current + 1), delay);
        }).finally(() => {
          bridgeSyncing.current.delete(item.id);
          if (bridgeDirtyVersions.current.has(item.id) && !bridgeRetryAttempts.current.has(item.id)) {
            setBridgeSyncTick((current) => current + 1);
          }
        });
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [bridgeSyncTick, studio]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    const applyEnvelope = (envelope: Awaited<ReturnType<typeof readAgentBridge>>) => {
      if (!active || !envelope.sessions.length) return;
      const projectionStarted = performance.now();
      const discovered = envelope.sessions.filter((external) =>
        !studioRef.current.sessions.some((item) => item.id === external.id)
      );
      if (discovered.length) {
        toast.info(`${discovered.length} new agent session${discovered.length === 1 ? "" : "s"} available in Sessions.`);
      }
      setStudio((current) => {
        let changed = false;
        const sessions = [...current.sessions];
        for (const external of envelope.sessions) {
          const index = sessions.findIndex((item) => item.id === external.id);
          const locallyDirty = bridgeDirtyVersions.current.has(external.id)
            || bridgeSyncing.current.has(external.id);
          if (locallyDirty) continue;
          const confirmedRevision = bridgeRevisions.current.get(external.id) ?? -1;
          bridgeRevisions.current.set(external.id, external.agent.revision);
          bridgeSnapshots.current.set(external.id, external);
          if (index < 0) {
            sessions.push(materializeAgentSession(external));
            changed = true;
          } else if (external.agent.revision > confirmedRevision) {
            const incoming = materializeAgentSession(external);
            sessions[index] = {
              ...sessions[index],
              ...incoming,
              assets: preserveLocalAssetMetadata(incoming.assets, sessions[index].assets),
            };
            changed = true;
          }
        }
        return changed
          ? { ...current, sessions }
          : current;
      });
      window.requestAnimationFrame(() => recordAgentTelemetry(
        "desktop.projection_paint",
        (performance.now() - projectionStarted) * 1_000,
        { sessionCount: envelope.sessions.length },
      ));
    };
    const syncLoop = async () => {
      try {
        let envelope = await readAgentBridge();
        let recoveredUnpublished = false;
        for (const local of studioRef.current.sessions.filter((item) => item.agentBridge)) {
          if (envelope.sessions.some((external) => external.id === local.id)) continue;
          if (!bridgeDirtyVersions.current.has(local.id)) {
            bridgeDirtyVersions.current.set(local.id, 1);
            recoveredUnpublished = true;
          }
        }
        if (recoveredUnpublished) setBridgeSyncTick((current) => current + 1);
        let eventCursor = envelope.revision;
        while (active) {
          applyEnvelope(envelope);
          const batch = await waitForAgentBridgeEvents(eventCursor, 20_000);
          eventCursor = batch.cursor;
          if (batch.resetRequired) {
            envelope = await readAgentBridge();
            eventCursor = envelope.revision;
            continue;
          }
          const sessionIds = [...new Set(batch.events.map((event) => event.sessionId))];
          const sessions = [];
          for (const sessionId of sessionIds) sessions.push(await readAgentBridgeSession(sessionId));
          envelope = { schemaVersion: 4, revision: eventCursor, sessions };
        }
      } catch (error) {
        if (active) console.warn("Agent bridge sync failed", error);
        if (active) window.setTimeout(() => void syncLoop(), 1_000);
      }
    };
    void syncLoop();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    localStorage.setItem(SESSION_SIDEBAR_OPEN_KEY, String(sessionSidebarOpen));
    localStorage.setItem(SESSION_SIDEBAR_WIDTH_KEY, String(Math.round(sessionSidebarWidth)));
  }, [sessionSidebarOpen, sessionSidebarWidth]);

  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_OPEN_KEY, String(rightPanelOpen));
  }, [rightPanelOpen]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const report = () => void invoke("report_desktop_runtime", {
      activeSessionId: studioRef.current.activeSessionId,
    }).catch((error) => console.warn("Could not report Fruit Truck runtime presence", error));
    report();
    const timer = window.setInterval(report, 3_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void getCredentialStatus().then((status) => {
      setCredential(status);
      const completed = localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
      if (status.configured && !completed) localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
      setOnboardingOpen(!status.configured && !completed);
    }).catch((error) => {
      setOnboardingOpen(false);
      toast.error(errorMessage(error));
    });
  }, []);

  const refreshCatalog = useCallback(async () => {
    if (!credential?.configured) return;
    const hydrationRevision = ++catalogHydrationRevision.current;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const [images, videos] = await Promise.all([loadModels("image"), loadModels("video")]);
      setCatalogs({ image: images, video: videos });
      setImageEndpoints({});
      setStudio((current) => ({
        ...current,
        sessions: current.sessions.map((item) => {
          const imageId = images.some((model) => model.id === item.generationDefaults.modelIds.image)
            ? item.generationDefaults.modelIds.image : images[0]?.id ?? "";
          const videoId = videos.some((model) => model.id === item.generationDefaults.modelIds.video)
            ? item.generationDefaults.modelIds.video : videos[0]?.id ?? "";
          const repairThreadModel = (thread: GenerationThread, candidates: GenerationModel[], defaultId: string) => {
            const compatible = new Set(candidates.map((model) => model.id));
            const effectiveId = thread.modelOverrideId ?? defaultId;
            if (compatible.has(effectiveId)) return thread;
            return {
              ...thread,
              modelOverrideId: compatible.has(defaultId) ? undefined : candidates[0]?.id,
              updatedAt: new Date().toISOString(),
              revision: thread.revision + 1,
            };
          };
          return {
            ...item,
            generationDefaults: {
              ...item.generationDefaults,
              modelIds: { image: imageId, video: videoId },
              options: {
                image: Object.keys(item.generationDefaults.options.image).length ? item.generationDefaults.options.image : defaultOptions("image", images[0] ?? null),
                video: Object.keys(item.generationDefaults.options.video).length ? item.generationDefaults.options.video : defaultOptions("video", videos[0] ?? null),
              },
            },
            threads: {
              image: item.threads.image.map((thread) => repairThreadModel(thread, images, imageId)),
              video: item.threads.video.map((thread) => repairThreadModel(thread, videos, videoId)),
            },
          };
        }),
      }));
      void hydrateImageModelPricing(images, (hydrated, endpoints) => {
        if (catalogHydrationRevision.current !== hydrationRevision) return;
        setCatalogs((current) => ({
          ...current,
          image: current.image.map((model) => model.id === hydrated.id ? hydrated : model),
        }));
        setImageEndpoints((current) => ({ ...current, [hydrated.id]: endpoints }));
      });
    } catch (error) {
      setCatalogError(errorMessage(error));
    } finally {
      setCatalogLoading(false);
    }
  }, [credential?.configured]);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  useEffect(() => {
    if (!credential?.configured) catalogHydrationRevision.current += 1;
  }, [credential?.configured]);

  useEffect(() => {
    if (mode !== "image" || !selectedId || imageEndpoints[selectedId] || !credential?.configured) return;
    let active = true;
    void loadImageModelEndpoints(selectedId).then((endpoints) => {
      if (active) setImageEndpoints((current) => ({ ...current, [selectedId]: endpoints }));
    }).catch((error) => {
      if (active) {
        setImageEndpoints((current) => ({ ...current, [selectedId]: [] }));
        toast.error(t("endpointCheckFailed", { error: errorMessage(error) }));
      }
    });
    return () => { active = false; };
  }, [credential?.configured, imageEndpoints, mode, selectedId, t]);

  const activeVideoJobIds = studio.sessions.flatMap((item) =>
    isTauriRuntime() && item.agentBridge ? [] : activeVideoJobsFromAttempts(item)
      .filter((job) => job.status === "pending" || job.status === "in_progress")
      .map((job) => `${item.id}:${job.jobId}`),
  ).sort().join("|");

  useEffect(() => {
    if (!credential?.configured) return;
    const activeJobKeys = new Set(activeVideoJobIds.split("|"));
    for (const key of videoPollNotBefore.current.keys()) {
      if (!activeJobKeys.has(key)) videoPollNotBefore.current.delete(key);
    }
    if (!activeVideoJobIds) return;
    const pollActiveJobs = async () => {
      if (polling.current) return;
      const nowMs = Date.now();
      const activeJobs = studioRef.current.sessions.flatMap((item) =>
        isTauriRuntime() && item.agentBridge ? [] : activeVideoJobsFromAttempts(item)
          .filter((job) => job.status === "pending" || job.status === "in_progress")
          .filter((job) => hasVideoPollingTimedOut(job.submittedAt, nowMs) || (
            (videoPollNotBefore.current.get(`${item.id}:${job.jobId}`) ?? 0) <= nowMs
            && isVideoPollDue(job.nextPollAt, nowMs)
          ))
          .map((job) => ({ sessionId: item.id, job })),
      );
      if (!activeJobs.length) return;
      polling.current = true;
      let outcomes: PromiseSettledResult<void>[] = [];
      try {
        outcomes = await Promise.allSettled(activeJobs.map(async ({ sessionId, job }) => {
        try {
          const result = await pollVideo(job.jobId, (actualCostUsd) => {
            recordGenerationCost(sessionId, "video", job.threadId, job.attemptId, actualCostUsd);
          });
          const pollKey = `${sessionId}:${job.jobId}`;
          if (result.status === "completed") {
            videoPollNotBefore.current.set(pollKey, Number.POSITIVE_INFINITY);
            const polledAt = new Date().toISOString();
            const latestSession = studioRef.current.sessions.find((item) => item.id === sessionId);
            const existing = latestSession?.assets.find((item) => item.jobId === job.jobId);
            if (existing) {
              patchSession(sessionId, (current) => {
                return {
                  ...current,
                  threads: job.threadId && job.attemptId ? {
                    ...current.threads,
                    video: current.threads.video.map((item) => item.id === job.threadId ? {
                      ...item,
                      attempts: item.attempts.map((attempt) => attempt.id === job.attemptId ? { ...attempt, status: "completed", assetIds: [existing.id], progress: 100, error: undefined, actualCostUsd: result.actualCostUsd ?? attempt.actualCostUsd, costRecordedAt: result.actualCostUsd != null ? attempt.costRecordedAt ?? polledAt : attempt.costRecordedAt, pollAttempts: (attempt.pollAttempts ?? 0) + 1, lastPolledAt: polledAt, nextPollAt: undefined, completedAt: polledAt, updatedAt: polledAt } : attempt),
                    } : item),
                  } : current.threads,
                  agent: {
                    ...current.agent,
                    execution: {
                      ...current.agent.execution,
                      currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                    },
                  },
                };
              });
              return;
            }
            const source = await cacheVideo(job.jobId);
            const asset = await importGeneratedVideo(
              source,
              `video-${job.jobId}.mp4`,
              "generated",
              job.jobId,
              typeof job.request.duration === "number" ? job.request.duration : undefined,
            );
            patchSession(sessionId, (current) => {
              const existing = current.assets.find((item) => item.jobId === job.jobId);
              const resolvedAsset = existing ?? asset;
              return {
                ...current,
                assets: existing ? current.assets : [...current.assets, asset],
                threads: job.threadId && job.attemptId ? {
                  ...current.threads,
                  video: current.threads.video.map((item) => item.id === job.threadId ? {
                    ...item,
                    attempts: item.attempts.map((attempt) => attempt.id === job.attemptId ? { ...attempt, status: "completed", assetIds: [resolvedAsset.id], progress: 100, error: undefined, actualCostUsd: result.actualCostUsd ?? attempt.actualCostUsd, costRecordedAt: result.actualCostUsd != null ? attempt.costRecordedAt ?? polledAt : attempt.costRecordedAt, pollAttempts: (attempt.pollAttempts ?? 0) + 1, lastPolledAt: polledAt, nextPollAt: undefined, completedAt: polledAt, updatedAt: polledAt } : attempt),
                  } : item),
                } : current.threads,
                agent: existing ? {
                  ...current.agent,
                  execution: {
                    ...current.agent.execution,
                    currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                  },
                } : recordAgentActivity({
                  ...current.agent,
                  execution: {
                    ...current.agent.execution,
                    currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                  },
                  artifacts: [...current.agent.artifacts, {
                    assetId: resolvedAsset.id,
                    role: current.threads.video.find((item) => item.id === job.threadId)?.outputRole ?? "video_shot",
                    parentAssetIds: job.inputAssetIds ?? [],
                    prompt: typeof job.request.prompt === "string" ? job.request.prompt : undefined,
                    modelId: job.model,
                    threadId: job.threadId,
                    attemptId: job.attemptId,
                    approval: "unreviewed",
                  }],
                }, {
                  actor: "runtime",
                  kind: "generation",
                  title: "Video generation completed",
                  modelId: job.model,
                  assetIds: [resolvedAsset.id],
                }),
              };
            });
          } else if (result.status === "failed" || result.status === "cancelled" || result.status === "expired") {
            videoPollNotBefore.current.set(pollKey, Number.POSITIVE_INFINITY);
            const polledAt = new Date().toISOString();
            const canceled = result.status === "cancelled";
            const message = result.error ?? (canceled
              ? t("videoGenerationCanceled")
              : result.status === "expired" ? t("videoGenerationExpired") : t("videoGenerationFailed"));
            patchSession(sessionId, (current) => ({
              ...current,
              threads: job.threadId && job.attemptId ? {
                ...current.threads,
                video: current.threads.video.map((item) => item.id === job.threadId ? {
                  ...item,
                  attempts: item.attempts.map((attempt) => attempt.id === job.attemptId ? { ...attempt, status: canceled ? "canceled" : "failed", error: message, pollAttempts: (attempt.pollAttempts ?? 0) + 1, lastPolledAt: polledAt, nextPollAt: undefined, completedAt: polledAt, updatedAt: polledAt } : attempt),
                } : item),
              } : current.threads,
              agent: {
                ...current.agent,
                runStatus: current.agent.controlMode === "agent" ? "failed" : current.agent.runStatus,
                execution: {
                  ...current.agent.execution,
                  currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                  lastError: message,
                },
              },
            }));
          } else if (hasVideoPollingTimedOut(job.submittedAt)) {
            videoPollNotBefore.current.set(pollKey, Number.POSITIVE_INFINITY);
            const completedAt = new Date().toISOString();
            const message = t("videoPollingTimedOut");
            patchSession(sessionId, (current) => ({
              ...current,
              threads: job.threadId && job.attemptId ? {
                ...current.threads,
                video: current.threads.video.map((item) => item.id === job.threadId ? {
                  ...item,
                  attempts: item.attempts.map((attempt) => attempt.id === job.attemptId ? { ...attempt, status: "failed", error: message, pollAttempts: (attempt.pollAttempts ?? 0) + 1, lastPolledAt: completedAt, nextPollAt: undefined, completedAt, updatedAt: completedAt } : attempt),
                } : item),
              } : current.threads,
              agent: {
                ...current.agent,
                runStatus: current.agent.controlMode === "agent" && current.agent.runStatus === "working" ? "failed" : current.agent.runStatus,
                execution: {
                  ...current.agent.execution,
                  currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                  lastError: message,
                },
              },
            }));
          } else {
            const polledAt = new Date().toISOString();
            const nextPollAtMs = Date.now() + VIDEO_POLL_INTERVAL_MS;
            videoPollNotBefore.current.set(pollKey, nextPollAtMs);
            patchSession(sessionId, (current) => ({
              ...current,
              threads: job.threadId && job.attemptId ? {
                ...current.threads,
                video: current.threads.video.map((item) => item.id === job.threadId ? {
                  ...item,
                  attempts: item.attempts.map((attempt) => attempt.id === job.attemptId ? { ...attempt, status: "in_progress", progress: result.progress, error: result.error, pollAttempts: (attempt.pollAttempts ?? 0) + 1, lastPolledAt: polledAt, nextPollAt: new Date(nextPollAtMs).toISOString(), updatedAt: polledAt } : attempt),
                } : item),
              } : current.threads,
            }));
          }
        } catch (error) {
          const polledAt = new Date().toISOString();
          const timedOut = hasVideoPollingTimedOut(job.submittedAt, Date.parse(polledAt));
          const message = timedOut ? t("videoPollingTimedOut") : errorMessage(error);
          const pollKey = `${sessionId}:${job.jobId}`;
          const retryAtMs = timedOut ? undefined : Date.now() + videoPollRetryDelayMs(job.pollAttempts ?? 0);
          if (retryAtMs == null) videoPollNotBefore.current.set(pollKey, Number.POSITIVE_INFINITY);
          else videoPollNotBefore.current.set(pollKey, retryAtMs);
          patchSession(sessionId, (current) => ({
            ...current,
            threads: job.threadId && job.attemptId ? {
              ...current.threads,
              video: current.threads.video.map((item) => item.id === job.threadId ? {
                ...item,
                attempts: item.attempts.map((attempt) => attempt.id === job.attemptId ? {
                  ...attempt,
                  status: timedOut ? "failed" : "in_progress",
                  error: message,
                  pollAttempts: (attempt.pollAttempts ?? 0) + 1,
                  lastPolledAt: polledAt,
                  nextPollAt: retryAtMs == null ? undefined : new Date(retryAtMs).toISOString(),
                  completedAt: timedOut ? polledAt : attempt.completedAt,
                  updatedAt: polledAt,
                } : attempt),
              } : item),
            } : current.threads,
            agent: timedOut ? {
              ...current.agent,
              runStatus: current.agent.controlMode === "agent" && current.agent.runStatus === "working" ? "failed" : current.agent.runStatus,
              execution: {
                ...current.agent.execution,
                currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                lastError: message,
              },
            } : current.agent,
          }));
        }
        }));
      } finally {
        polling.current = false;
      }
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") console.error("Video polling state update failed", outcome.reason);
      }
    };
    const scheduler = createResilientPollScheduler({
      run: pollActiveJobs,
      onError: (error) => console.error("Video polling scheduler failed", error),
    });
    const wake = () => scheduler.wake();
    const wakeWhenVisible = () => { if (document.visibilityState === "visible") wake(); };
    scheduler.start();
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wakeWhenVisible);
    return () => {
      scheduler.stop();
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wakeWhenVisible);
    };
  }, [activeVideoJobIds, credential?.configured, patchSession, recordGenerationCost, t]);

  const commitImportedAssets = useCallback((candidates: SessionAsset[]): SessionAsset[] => {
    const imported: SessionAsset[] = [];
    const resolved: SessionAsset[] = [];
    const currentSession = studioRef.current.sessions.find((item) => item.id === studioRef.current.activeSessionId)
      ?? studioRef.current.sessions[0];
    for (const candidate of candidates) {
      const duplicate = currentSession.assets.find((asset) =>
        candidate.fingerprint && asset.fingerprint === candidate.fingerprint
      );
      if (duplicate) {
        resolved.push(duplicate);
        toast.info(t("alreadyInSession", { name: candidate.name }));
        continue;
      }
      imported.push(candidate);
      resolved.push(candidate);
    }
    if (imported.length) {
      patchSession(currentSession.id, (current) => ({
        ...current,
        assets: [...current.assets, ...imported],
        agent: recordAgentActivity({
          ...current.agent,
          artifacts: [
            ...current.agent.artifacts,
            ...imported.map((asset) => ({
              assetId: asset.id,
              role: "uploaded_reference",
              parentAssetIds: [],
              approval: "unreviewed" as const,
            })),
          ],
        }, {
          actor: "user",
          kind: "generation",
          title: `Imported ${imported.length} reference asset${imported.length === 1 ? "" : "s"}`,
          assetIds: imported.map((asset) => asset.id),
        }),
      }));
      toast.success(t("assetsImported", { count: imported.length }));
    }
    return resolved;
  }, [patchSession, t]);

  const importFiles = async (files: FileList | File[]): Promise<SessionAsset[]> => {
    const imported: SessionAsset[] = [];
    for (const file of Array.from(files)) {
      try {
        imported.push(await importFileAsset(file));
      } catch (error) {
        toast.error(errorMessage(error));
      }
    }
    return commitImportedAssets(imported);
  };

  const pickFiles = async (): Promise<SessionAsset[]> => {
    if (!isTauriRuntime()) {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*,video/*";
        input.multiple = true;
        input.onchange = () => void importFiles(input.files ?? []).then(resolve);
        input.oncancel = () => resolve([]);
        input.click();
      });
    }
    try {
      return commitImportedAssets(await pickManagedAssets());
    } catch (error) {
      toast.error(errorMessage(error));
      return [];
    }
  };

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlistenAssets = await listen<NativeManagedAsset[]>("managed-assets-imported", (event) => {
        if (!disposed) commitImportedAssets(managedDroppedAssets(event.payload));
      });
      const unlistenFailure = await listen<string>("managed-assets-import-failed", (event) => {
        if (!disposed) toast.error(event.payload);
      });
      if (disposed) {
        unlistenAssets();
        unlistenFailure();
      } else {
        unlisteners.push(unlistenAssets, unlistenFailure);
      }
    }).catch((error) => toast.error(errorMessage(error)));
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [commitImportedAssets]);

  const addAssetAsReference = (assetId: string, notice?: GenerationResultNotice) => {
    const targetSession = notice
      ? studioRef.current.sessions.find((item) => item.id === notice.sessionId)
      : session;
    const targetThread = notice
      ? targetSession && [...targetSession.threads.image, ...targetSession.threads.video].find((item) => item.id === notice.threadId)
      : thread;
    if (!targetSession || !targetThread) return;
    const targetAsset = targetSession.assets.find((item) => item.id === assetId);
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    const targetModelId = effectiveThreadModelId(targetSession, targetThread);
    const targetModel = catalogs[targetThread.mode].find((item) => item.id === targetModelId) ?? null;
    const targetRoles = allowedAssetRoles(targetThread.mode, targetModel);
    const targetReferenceLimit = targetThread.mode === "image"
      ? imageReferenceLimit(targetModel as ImageModel | null)
      : Math.max(
        targetRoles.length,
        videoReferenceLimit(targetModel as VideoModel | null)
        + ((targetModel as VideoModel | null)?.supported_frame_images?.length ?? 0),
      );
    if (!targetAsset || targetDraft.references.some((reference) => reference.assetId === assetId)) return;
    if (targetDraft.references.length >= targetReferenceLimit) {
      toast.error(t("tooManyInputs", { count: targetReferenceLimit }));
      return;
    }
    const validRole = targetAsset.kind === "video"
      ? null
      : targetRoles.includes("reference") ? "reference" : targetRoles[0] ?? null;
    if (!validRole) {
      toast.error(t("unsupportedAssetInput"));
      return;
    }
    if (!notice) {
      patchDraft({ references: [...targetDraft.references, { assetId, role: validRole, slot: nextReferenceSlot(targetDraft.references) }], enhancedPrompt: "", enhancedPromptDirty: false });
      return;
    }
    patchSession(notice.sessionId, (current) => ({
      ...current,
      mode: targetThread.mode,
      activeThreadIds: { ...current.activeThreadIds, [targetThread.mode]: targetThread.id },
      threads: {
        ...current.threads,
        [targetThread.mode]: current.threads[targetThread.mode].map((item) => item.id === targetThread.id ? {
          ...item,
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
          draft: {
            ...item.draft,
            references: [...item.draft.references, { assetId, role: validRole, slot: nextReferenceSlot(item.draft.references) }],
            enhancedPrompt: "",
            enhancedPromptDirty: false,
          },
        } : item),
      },
    }));
    setStudio((current) => ({ ...current, activeSessionId: notice.sessionId }));
  };

  const editImageAsset = (assetId: string, notice?: GenerationResultNotice) => {
    const patchTarget = notice
      ? (update: (current: StudioSession) => StudioSession) => patchSession(notice.sessionId, update)
      : patchActive;
    patchTarget((current) => {
      const targetId = notice?.threadId ?? current.activeThreadIds.image;
      const imageThread = current.threads.image.find((item) => item.id === targetId) ?? current.threads.image[0];
      const imageDraft = imageThread.draft;
      if (notice) {
        return {
          ...current,
          mode: "image",
          activeThreadIds: { ...current.activeThreadIds, image: imageThread.id },
          threads: {
            ...current.threads,
            image: current.threads.image.map((item) => item.id === imageThread.id ? {
              ...item,
              revision: item.revision + 1,
              updatedAt: new Date().toISOString(),
              draft: beginGeneratedImageEdit(imageDraft, assetId),
            } : item),
          },
        };
      }
      const existing = imageDraft.references.find((reference) => reference.assetId === assetId);
      const previousTarget = imageDraft.references.find((reference) => `@${reference.slot}` === imageDraft.imageEditTarget);
      const slot = existing?.slot ?? nextReferenceSlot(imageDraft.references);
      return {
        ...current,
        mode: "image",
        activeThreadIds: { ...current.activeThreadIds, image: imageThread.id },
        threads: {
          ...current.threads,
          image: current.threads.image.map((item) => item.id === imageThread.id ? {
            ...item,
            revision: item.revision + 1,
            updatedAt: new Date().toISOString(),
            draft: {
              ...imageDraft,
              imageEditMode: true,
              imageEditTarget: `@${slot}`,
              maskStrokes: previousTarget?.assetId === assetId ? imageDraft.maskStrokes : [],
              maskInstructions: previousTarget?.assetId === assetId ? imageDraft.maskInstructions : "",
              enhancedPrompt: "",
              enhancedPromptDirty: false,
              references: existing ? imageDraft.references : [...imageDraft.references, { assetId, slot, role: "reference" }],
            },
          } : item),
        },
      };
    });
    if (notice) setStudio((current) => ({ ...current, activeSessionId: notice.sessionId }));
  };

  const setEditTargetAsset = (assetId: string, incomingAsset?: SessionAsset) => {
    const asset = assetMap.get(assetId) ?? incomingAsset;
    if (!asset || asset.kind !== "image") {
      toast.error(t("editImageRequired"));
      return;
    }
    patchActive((current) => {
      const targetId = current.activeThreadIds.image;
      const targetThread = current.threads.image.find((item) => item.id === targetId) ?? current.threads.image[0];
      const currentDraft = targetThread.draft;
      const role = "reference" as const;
      const previousTarget = currentDraft.references.find((reference) => `@${reference.slot}` === currentDraft.imageEditTarget);
      const existing = currentDraft.references.find((reference) => reference.assetId === assetId);
      const slot = existing?.slot ?? nextReferenceSlot(currentDraft.references);
      const references = currentDraft.references
        .map((reference) => reference.assetId === assetId ? { ...reference, role } : reference);
      if (!references.some((reference) => reference.assetId === assetId)) references.push({ assetId, slot, role });
      return {
        ...current,
        threads: {
          ...current.threads,
          image: current.threads.image.map((item) => item.id === targetThread.id ? {
            ...item,
            revision: item.revision + 1,
            updatedAt: new Date().toISOString(),
            draft: {
              ...currentDraft,
              imageEditTarget: `@${slot}`,
              references,
              maskStrokes: previousTarget?.assetId === assetId ? currentDraft.maskStrokes : [],
              maskInstructions: previousTarget?.assetId === assetId ? currentDraft.maskInstructions : "",
              enhancedPrompt: "",
              enhancedPromptDirty: false,
            },
          } : item),
        },
      };
    });
  };

  const applyImportedEditTarget = (assets: SessionAsset[]) => {
    const target = assets.find((asset) => asset.kind === "image");
    if (target) setEditTargetAsset(target.id, target);
    else toast.error(t("editImageRequired"));
  };
  const importEditTarget = async (files: FileList | File[]) => applyImportedEditTarget(await importFiles(files));
  const pickEditTarget = async () => applyImportedEditTarget(await pickFiles());

  const routeImageToVideo = (assetId: string, notice?: GenerationResultNotice) => {
    const targetSession = notice
      ? studioRef.current.sessions.find((item) => item.id === notice.sessionId)
      : session;
    if (!targetSession) return;
    const targetThread = targetSession.threads.video.find((item) => item.id === targetSession.activeThreadIds.video) ?? targetSession.threads.video[0];
    const videoId = effectiveThreadModelId(targetSession, targetThread);
    const videoModel = catalogs.video.find((model) => model.id === videoId) ?? null;
    const videoRoles = allowedAssetRoles("video", videoModel);
    const role = videoRoles.includes("reference")
      ? "reference"
      : videoRoles.includes("first_frame") ? "first_frame" : null;
    if (!role) {
      toast.error(t("chooseVideoImageInput"));
      if (notice) {
        patchSession(notice.sessionId, (current) => ({ ...current, mode: "video" }));
        setStudio((current) => ({ ...current, activeSessionId: notice.sessionId }));
      } else {
        switchMode("video");
      }
      return;
    }
    const patchTarget = notice
      ? (update: (current: StudioSession) => StudioSession) => patchSession(notice.sessionId, update)
      : patchActive;
    patchTarget((current) => {
      const targetId = current.activeThreadIds.video;
      const videoThread = current.threads.video.find((item) => item.id === targetId) ?? current.threads.video[0];
      const videoDraft = videoThread.draft;
      const exists = videoDraft.references.some((reference) => reference.assetId === assetId);
      return {
        ...current,
        mode: "video",
        threads: {
          ...current.threads,
          video: current.threads.video.map((item) => item.id === videoThread.id ? {
            ...videoThread,
            revision: item.revision + 1,
            updatedAt: new Date().toISOString(),
            draft: {
              ...videoDraft,
              references: exists ? videoDraft.references : [...videoDraft.references, {
                assetId,
                slot: nextReferenceSlot(videoDraft.references),
                role,
              }],
              enhancedPrompt: "",
              enhancedPromptDirty: false,
            },
          } : item),
        },
      };
    });
    if (notice) setStudio((current) => ({ ...current, activeSessionId: notice.sessionId }));
  };

  const selectStageModel = (targetMode: GenerationMode, id: string) => {
    const model = catalogs[targetMode].find((item) => item.id === id) ?? null;
    patchActive((current) => {
      const targetId = current.activeThreadIds[targetMode];
      const createdAt = new Date().toISOString();
      const agent = recordAgentActivity({
        ...current.agent,
        modelSelections: {
          ...current.agent.modelSelections,
          [targetMode]: {
            status: "selected" as const,
            modelId: id,
            selectedBy: "user" as const,
            selectedAt: createdAt,
          },
        },
      }, {
        actor: "user",
        kind: "decision",
        title: `Selected ${targetMode} model`,
        detail: model?.name ?? id,
        modelId: id,
      });
      return {
        ...current,
        agent,
        threads: {
          ...current.threads,
          [targetMode]: current.threads[targetMode].map((item) => item.id === targetId ? {
            ...item,
            modelOverrideId: id,
            optionOverrides: defaultOptions(targetMode, model),
            revision: item.revision + 1,
            updatedAt: createdAt,
          } : item),
        },
      };
    });
  };
  const selectModel = (id: string) => selectStageModel(mode, id);

  const switchMode = (next: GenerationMode) => {
    patchActive((current) => ({ ...current, mode: next }));
  };

  const providerError = useMemo(() => {
    if (!draft.providerJson.trim()) return null;
    try {
      const value = JSON.parse(draft.providerJson) as unknown;
      return !value || Array.isArray(value) || typeof value !== "object" ? t("jsonObjectRequired") : null;
    } catch {
      return t("invalidJson");
    }
  }, [draft.providerJson, t]);

  const previewReferences = useMemo<ReferenceAsset[]>(() => draft.references.flatMap((reference) => {
    const asset = assetMap.get(reference.assetId);
    const masked = mode === "image"
      && draft.imageEditMode
      && `@${reference.slot}` === draft.imageEditTarget.trim()
      && draft.maskStrokes.length > 0;
    return asset ? [{
      id: asset.id,
      name: masked ? `${asset.name} (transparent edit mask)` : asset.name,
      mediaType: masked ? "image/png" : asset.mimeType,
      dataUrl: `local-asset://#${reference.slot}/${asset.name}`,
      role: reference.role,
      slot: reference.slot,
    }] : [];
  }), [assetMap, draft.imageEditMode, draft.imageEditTarget, draft.maskStrokes.length, draft.references, mode]);

  const effectivePrompt = draft.enhancePrompt && draft.enhancedPrompt.trim()
    ? draft.enhancedPrompt
    : draft.prompt;
  const prepareGenerationPrompt = (prompt: string) => {
    if (mode !== "image" || !draft.imageEditMode) return prompt.trim();
    return composeEditPrompt({
      prompt,
      target: draft.imageEditTarget.trim(),
      hasMask: draft.maskStrokes.length > 0,
      maskInstructions: draft.maskInstructions,
    });
  };
  const preparedPrompt = prepareGenerationPrompt(effectivePrompt);
  const requestPayload = useMemo(() => {
    try {
      return buildRequest({
        mode,
        model: selectedId,
        prompt: preparedPrompt,
        assets: previewReferences,
        options: draft.options,
        providerJson: draft.providerJson,
      }, selectedModel);
    } catch {
      return {};
    }
  }, [draft.options, draft.providerJson, mode, preparedPrompt, previewReferences, selectedId, selectedModel]);

  const editTargetError = useMemo(() => {
    if (mode !== "image" || !draft.imageEditMode) return null;
    if (!draft.imageEditTarget.trim()) return t("chooseEditTarget");
    const match = draft.imageEditTarget.trim().match(/^@(\d+)$/);
    if (!match) return t("editTargetFormat");
    const reference = draft.references.find((item) => item.slot === Number(match[1]));
    const asset = reference ? assetMap.get(reference.assetId) : null;
    return !asset || asset.kind !== "image" ? t("targetNotAttached", { target: draft.imageEditTarget || t("thatTarget") }) : null;
  }, [assetMap, draft.imageEditMode, draft.imageEditTarget, draft.references, mode, t]);
  const imageEditReference = mode === "image" && draft.imageEditMode
    ? draft.references.find((reference) => `@${reference.slot}` === draft.imageEditTarget.trim())
    : undefined;
  const editReference = imageEditReference;
  const editTargetAsset = editReference ? assetMap.get(editReference.assetId) ?? null : null;

  const inputValidationError = useMemo(() => {
    const unsupported = draft.references.find((reference) => {
      const asset = assetMap.get(reference.assetId);
      if (!asset) return true;
      if (asset.kind === "video") return true;
      return !roles.includes(reference.role);
    });
    if (unsupported) return t("unsupportedReference", { slot: unsupported.slot });
    if (draft.references.length > referenceLimit) return t("tooManyInputs", { count: referenceLimit });
    if (mode === "video") {
      const hasReference = draft.references.some((reference) => reference.role === "reference");
      const hasFrame = draft.references.some((reference) => reference.role === "first_frame" || reference.role === "last_frame");
      if (hasReference && hasFrame) return t("mixedInputStyles");
    }
    return null;
  }, [assetMap, draft.references, mode, referenceLimit, roles, t]);

  const maskReferenceError = useMemo(() => {
    if (mode !== "image" || !draft.imageEditMode || !draft.maskStrokes.length) return null;
    const slots = new Set(draft.references.map((reference) => reference.slot));
    const mentioned = [...draft.maskInstructions.matchAll(/@(\d+)/g)].map((match) => Number(match[1]));
    const missing = mentioned.find((slot) => !slots.has(slot));
    return missing ? t("missingMention", { slot: missing }) : null;
  }, [draft.imageEditMode, draft.maskInstructions, draft.maskStrokes.length, draft.references, mode, t]);

  const generationValidationError = editTargetError
    ?? maskReferenceError;

  const hydratePromptEnhancementVisuals = async (
    targetSession: StudioSession,
    targetThread: GenerationThread,
    targetDraft: GenerationDraftState,
  ): Promise<PromptEnhancementVisual[]> => {
    const targetAssetMap = new Map(targetSession.assets.map((asset) => [asset.id, asset]));
    const visuals: PromptEnhancementVisual[] = [];
    for (const reference of targetDraft.references.toSorted((left, right) => left.slot - right.slot)) {
      const asset = targetAssetMap.get(reference.assetId);
      if (!asset) throw new Error(t("missingReference", { slot: reference.slot }));
      if (asset.kind === "video") continue;

      const isEditTarget = targetThread.mode === "image"
        && targetDraft.imageEditMode
        && `@${reference.slot}` === targetDraft.imageEditTarget.trim();
      visuals.push({
        id: asset.id,
        kind: isEditTarget ? "edit_target" : "reference",
        source: await assetRequestUrl(asset),
        slot: reference.slot,
        name: asset.name,
        role: reference.role,
      });
      if (isEditTarget && targetDraft.maskStrokes.length > 0) {
        const maskSource = await resolveAssetMaskSource(asset);
        if (!maskSource) throw new Error("The edit image could not be loaded for mask analysis.");
        try {
          visuals.push({
            id: `${asset.id}:mask-guide`,
            kind: "mask_guide",
            source: await renderMaskGuide(maskSource, targetDraft.maskStrokes),
            slot: reference.slot,
            name: `${asset.name} mask guide`,
            role: reference.role,
          });
        } finally {
          if (maskSource.startsWith("blob:")) URL.revokeObjectURL(maskSource);
        }
      }
    }
    return visuals;
  };

  const enhanceThreadPrompt = async (
    targetSession: StudioSession,
    targetThread: GenerationThread,
    costEntryId = `prompt-enhancement:${crypto.randomUUID()}`,
  ) => {
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    if (!hasRunnableInstructions(targetThread.mode, targetDraft)) {
      throw new Error(targetThread.mode === "image" && targetDraft.imageEditMode && targetDraft.maskStrokes.length
        ? t("enterPromptOrMaskInstructions")
        : t("enterPromptFirst"));
    }
    setEnhancingThreadIds((current) => new Set(current).add(targetThread.id));
    try {
      const targetAssetMap = new Map(targetSession.assets.map((asset) => [asset.id, asset]));
      const hasMask = targetThread.mode === "image" && targetDraft.imageEditMode && targetDraft.maskStrokes.length > 0;
      const visuals = await hydratePromptEnhancementVisuals(targetSession, targetThread, targetDraft);
      const text = await enhancePrompt({
        promptModel: studioRef.current.promptModel,
        mode: targetThread.mode,
        editMode: targetDraft.imageEditMode,
        editTarget: targetDraft.imageEditTarget,
        prompt: targetDraft.prompt,
        maskInstructions: targetDraft.maskInstructions,
        hasMask,
        references: targetDraft.references.flatMap((reference) => {
          const asset = targetAssetMap.get(reference.assetId);
          return asset ? [{ slot: reference.slot, name: asset.name, mediaType: asset.mimeType, role: reference.role }] : [];
        }),
        visuals,
      }, (actualCostUsd) => {
        patchSession(targetSession.id, (current) => ({
          ...current,
          agent: recordActualCost(current.agent, {
            id: costEntryId,
            category: "prompt_enhancement",
            actualCostUsd,
          }),
        }));
      });
      patchSession(targetSession.id, (current) => ({
        ...current,
        threads: {
          ...current.threads,
          [targetThread.mode]: current.threads[targetThread.mode].map((item) => item.id === targetThread.id && item.revision === targetThread.revision ? {
            ...item,
            draft: { ...item.draft, enhancedPrompt: text, enhancedPromptDirty: false, enhancedVisualCount: visuals.length },
            updatedAt: new Date().toISOString(),
          } : item),
        },
      }));
      return text;
    } finally {
      setEnhancingThreadIds((current) => {
        const next = new Set(current);
        next.delete(targetThread.id);
        return next;
      });
    }
  };

  const runEnhancement = () => enhanceThreadPrompt(session, thread);

  const hydrateThreadReferences = async (targetSession: StudioSession, targetThread: GenerationThread, targetDraft: GenerationDraftState): Promise<ReferenceAsset[]> => Promise.all(targetDraft.references.map(async (reference) => {
    const targetAssetMap = new Map(targetSession.assets.map((asset) => [asset.id, asset]));
    const asset = targetAssetMap.get(reference.assetId);
    if (!asset) throw new Error(t("missingReference", { slot: reference.slot }));
    const masked = targetThread.mode === "image"
      && targetDraft.imageEditMode
      && `@${reference.slot}` === targetDraft.imageEditTarget.trim()
      && targetDraft.maskStrokes.length > 0;
    let source = await assetRequestUrl(asset);
    if (masked) {
      const maskSource = await resolveAssetMaskSource(asset);
      if (!maskSource) throw new Error("The edit image could not be loaded for masking.");
      try {
        source = await materializeRequestBlob(
          await applyAlphaMaskBlob(maskSource, targetDraft.maskStrokes),
          `mask-${asset.id}.png`,
        );
      } finally {
        if (maskSource.startsWith("blob:")) URL.revokeObjectURL(maskSource);
      }
    }
    return {
      id: asset.id,
      name: masked ? `${asset.name} (transparent edit mask)` : asset.name,
      mediaType: masked ? "image/png" : asset.mimeType,
      dataUrl: source,
      role: reference.role,
      slot: reference.slot,
    };
  }));

  const validateThreadForRun = (targetSession: StudioSession, targetThread: GenerationThread) => {
    if (activeGenerationAttempt(targetThread)) return "This thread already has an active generation.";
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    const modelId = effectiveThreadModelId(targetSession, targetThread);
    const available = catalogs[targetThread.mode];
    const model = available.find((item) => item.id === modelId) ?? null;
    if (!model) return "Choose a compatible model.";
    if (!hasRunnableInstructions(targetThread.mode, targetDraft)) {
      return targetThread.mode === "image" && targetDraft.imageEditMode && targetDraft.maskStrokes.length
        ? t("enterPromptOrMaskInstructions")
        : t("enterPromptFirst");
    }
    if (targetDraft.providerJson.trim()) {
      try {
        const value = JSON.parse(targetDraft.providerJson) as unknown;
        if (!value || Array.isArray(value) || typeof value !== "object") return t("jsonObjectRequired");
      } catch { return t("invalidJson"); }
    }
    const targetRoles = allowedAssetRoles(targetThread.mode, model);
    const targetAssets = new Map(targetSession.assets.map((asset) => [asset.id, asset]));
    const unsupported = targetDraft.references.find((reference) => {
      const asset = targetAssets.get(reference.assetId);
      if (!asset) return true;
      return asset.kind === "video" || !targetRoles.includes(reference.role);
    });
    if (unsupported) return t("unsupportedReference", { slot: unsupported.slot });
    if (targetThread.mode === "video") {
      const hasReference = targetDraft.references.some((reference) => reference.role === "reference");
      const hasFrame = targetDraft.references.some((reference) => reference.role === "first_frame" || reference.role === "last_frame");
      if (hasReference && hasFrame) return t("mixedInputStyles");
    }
    return null;
  };

  const patchAttempt = (sessionId: string, mode: GenerationMode, threadId: string, attemptId: string, patch: Partial<GenerationAttempt>) => {
    patchSession(sessionId, (current) => ({
      ...current,
      threads: {
        ...current.threads,
        [mode]: current.threads[mode].map((item) => item.id === threadId ? {
          ...item,
          attempts: item.attempts.map((attempt) => attempt.id === attemptId
            ? attempt.status === "canceled" && patch.status !== "canceled"
              ? attempt
              : { ...attempt, ...patch, updatedAt: new Date().toISOString() }
            : attempt),
          updatedAt: new Date().toISOString(),
        } : item),
      },
    }));
  };

  const runGenerationThread = async (threadId: string, requestKey?: string) => {
    const targetSession = studioRef.current.sessions.find((item) => item.id === studioRef.current.activeSessionId) ?? studioRef.current.sessions[0];
    const targetThread = [...targetSession.threads.image, ...targetSession.threads.video].find((item) => item.id === threadId);
    if (!targetThread) return;
    if (targetSession.agent.controlMode === "agent") {
      toast.info("The agent has control. Switch to Human control to run this request yourself.");
      return;
    }
    if (!credential?.configured) { setSettingsOpen(true); return; }
    const validationError = validateThreadForRun(targetSession, targetThread);
    if (validationError) throw new Error(validationError);
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    const targetModelId = effectiveThreadModelId(targetSession, targetThread);
    const targetModel = catalogs[targetThread.mode].find((item) => item.id === targetModelId) ?? null;
    if (!targetModel) throw new Error("Choose a compatible model.");
    const attemptId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const shouldEnhancePrompt = targetDraft.enhancePrompt && hasRunnableInstructions(targetThread.mode, targetDraft);
    const attempt: GenerationAttempt = {
      id: attemptId,
      requestKey,
      status: shouldEnhancePrompt ? "enhancing" : "submitting",
      backend: "openrouter",
      draftRevision: targetThread.revision,
      requestedBy: "human",
      createdAt,
      updatedAt: createdAt,
      modelId: targetModelId,
      estimatedCostUsd: estimateGenerationCost(targetThread.mode, targetModel, targetDraft.options, {
        imageInputCount: targetDraft.references.filter((reference) =>
          targetSession.assets.find((asset) => asset.id === reference.assetId)?.kind === "image"
        ).length,
      }),
      snapshot: {
        mode: targetThread.mode,
        modelId: targetModelId,
        outputRole: targetThread.outputRole,
        prompt: targetDraft.prompt,
        enhancePrompt: targetDraft.enhancePrompt,
        enhancedPrompt: targetDraft.enhancedPrompt,
        options: structuredClone(targetDraft.options),
        providerJson: targetDraft.providerJson,
        assetBindings: targetDraft.references.map((reference) => ({ ...reference })),
        imageEditMode: targetDraft.imageEditMode,
        imageEditTarget: targetDraft.imageEditTarget,
        maskInstructions: targetDraft.maskInstructions,
        maskStrokes: structuredClone(targetDraft.maskStrokes),
      },
      inputAssetIds: targetDraft.references.map((reference) => reference.assetId),
      assetIds: [],
    };
    patchSession(targetSession.id, (current) => ({
      ...current,
      threads: {
        ...current.threads,
        [targetThread.mode]: current.threads[targetThread.mode].map((item) => item.id === targetThread.id ? { ...item, attempts: [...item.attempts, attempt], updatedAt: createdAt } : item),
      },
    }));
    setExecutingThreadIds((current) => new Set(current).add(targetThread.id));
    try {
      let prompt = targetDraft.prompt.trim();
      if (shouldEnhancePrompt) {
        if (targetDraft.enhancedPromptDirty && targetDraft.enhancedPrompt.trim()) {
          prompt = targetDraft.enhancedPrompt.trim();
          const enhancedError = validateEnhancedPrompt(
            enhancementOriginalIntent(targetThread.mode, targetDraft),
            prompt,
            targetDraft.imageEditMode ? targetDraft.imageEditTarget : undefined,
            targetDraft.references.map((reference) => reference.slot),
          );
          if (enhancedError) throw new Error(enhancedError);
        } else {
          try {
            prompt = targetDraft.enhancedPrompt.trim() || await enhanceThreadPrompt(
              targetSession,
              targetThread,
              `prompt-enhancement:${attemptId}`,
            );
          } catch (error) {
            const continueWithOriginal = await confirmAction(
              t("enhancementFailed"),
              t("enhancementFailedHint", { error: errorMessage(error) }),
              t("useOriginal"),
            );
            if (!continueWithOriginal) throw error;
          }
        }
      }
      prompt = targetThread.mode === "image" && targetDraft.imageEditMode
        ? composeEditPrompt({ prompt, target: targetDraft.imageEditTarget.trim(), hasMask: targetDraft.maskStrokes.length > 0, maskInstructions: targetDraft.maskInstructions })
        : prompt;
      const currentAttemptStatus = studioRef.current.sessions
        .find((item) => item.id === targetSession.id)?.threads[targetThread.mode]
        .find((item) => item.id === targetThread.id)?.attempts
        .find((item) => item.id === attemptId)?.status;
      if (currentAttemptStatus === "canceled") return;
      patchAttempt(targetSession.id, targetThread.mode, targetThread.id, attemptId, { status: "submitting" });
      const payload = buildRequest({
        mode: targetThread.mode,
        model: targetModelId,
        prompt,
        assets: await hydrateThreadReferences(targetSession, targetThread, targetDraft),
        options: targetDraft.options,
        providerJson: targetDraft.providerJson,
      }, targetModel);
      patchAttempt(targetSession.id, targetThread.mode, targetThread.id, attemptId, { request: JSON.parse(prettyRequest(payload)) as Record<string, unknown>, submittedAt: new Date().toISOString() });
      if (targetThread.mode === "image") {
        const result = await generateImage(payload, (actualCostUsd) => {
          recordGenerationCost(targetSession.id, "image", targetThread.id, attemptId, actualCostUsd);
        });
        const generated = await Promise.all(result.urls.map((url, index) =>
          importGeneratedImage(
            url,
            `image-${new Date().toISOString().replaceAll(":", "-")}-${index + 1}.png`,
            targetDraft.imageEditMode ? "edited" : "generated",
            {
              resolution: typeof targetDraft.options.resolution === "string" || typeof targetDraft.options.resolution === "number"
                ? String(targetDraft.options.resolution) : undefined,
              aspectRatio: typeof targetDraft.options.aspect_ratio === "string" ? targetDraft.options.aspect_ratio : undefined,
            },
          ),
        ));
        patchSession(targetSession.id, (current) => {
          const parentAssetIds = targetDraft.references.map((reference) => reference.assetId);
          return {
            ...current,
            assets: [...current.assets, ...generated],
            threads: {
              ...current.threads,
              image: current.threads.image.map((item) => item.id === targetThread.id ? {
                ...item,
                attempts: item.attempts.map((entry) => entry.id === attemptId ? {
                  ...entry,
                  status: "completed",
                  assetIds: generated.map((asset) => asset.id),
                  actualCostUsd: result.actualCostUsd,
                  costRecordedAt: result.actualCostUsd != null ? new Date().toISOString() : entry.costRecordedAt,
                  completedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                } : entry),
              } : item),
            },
            agent: recordAgentActivity({
              ...current.agent,
              execution: {
                ...current.agent.execution,
                generationCount: current.agent.execution.generationCount + 1,
              },
              artifacts: [
                ...current.agent.artifacts,
                ...generated.map((asset) => ({
                  assetId: asset.id,
                  role: targetThread.outputRole,
                  parentAssetIds,
                  prompt,
                  modelId: targetModelId,
                  threadId: targetThread.id,
                  attemptId,
                  approval: "unreviewed" as const,
                })),
              ],
            }, {
              actor: current.agent.controlMode === "agent" ? "agent" : "user",
              kind: "generation",
              title: `Generated ${generated.length} image candidate${generated.length === 1 ? "" : "s"}`,
              prompt,
              modelId: targetModelId,
              assetIds: generated.map((asset) => asset.id),
            }),
          };
        });
      } else {
        const result = await submitVideo(payload, (actualCostUsd) => {
          recordGenerationCost(targetSession.id, "video", targetThread.id, attemptId, actualCostUsd);
        });
        patchSession(targetSession.id, (current) => ({
          ...current,
          threads: {
            ...current.threads,
            video: current.threads.video.map((item) => item.id === targetThread.id ? {
              ...item,
              attempts: item.attempts.map((entry) => entry.id === attemptId ? {
                ...entry,
                status: "in_progress",
                jobId: result.jobId,
                progress: result.progress,
                actualCostUsd: result.actualCostUsd,
                costRecordedAt: result.actualCostUsd != null ? new Date().toISOString() : entry.costRecordedAt,
                request: JSON.parse(prettyRequest(payload)) as Record<string, unknown>,
                submittedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              } : entry),
            } : item),
          },
          agent: recordAgentActivity({
            ...current.agent,
            execution: {
              ...current.agent.execution,
              generationCount: current.agent.execution.generationCount + 1,
              currentJobIds: [...current.agent.execution.currentJobIds, result.jobId],
            },
          }, {
            actor: current.agent.controlMode === "agent" ? "agent" : "user",
            kind: "generation",
            title: `Submitted ${targetThread.name}`,
            prompt,
            modelId: targetModelId,
            assetIds: targetDraft.references.map((reference) => reference.assetId),
          }),
        }));
      }
    } catch (error) {
      patchAttempt(targetSession.id, targetThread.mode, targetThread.id, attemptId, { status: "failed", error: errorMessage(error), completedAt: new Date().toISOString() });
      patchSession(targetSession.id, (current) => ({
        ...current,
        agent: { ...current.agent, execution: { ...current.agent.execution, lastError: errorMessage(error) } },
      }));
    } finally {
      setExecutingThreadIds((current) => {
        const next = new Set(current);
        next.delete(targetThread.id);
        return next;
      });
    }
  };

  const runGeneration = () => runGenerationThread(thread.id);

  const activateThread = (id: string) => {
    patchActive((current) => ({ ...current, activeThreadIds: { ...current.activeThreadIds, [current.mode]: id } }));
  };

  const createThread = useCallback(() => {
    patchActive((current) => {
      if (current.agent.controlMode === "agent") return current;
      const active = current.threads[current.mode].find((item) => item.id === current.activeThreadIds[current.mode]);
      if (!active) return current;
      const next = createSiblingGenerationThread(active, current.threads[current.mode].length + 1);
      return {
        ...current,
        threads: { ...current.threads, [current.mode]: [...current.threads[current.mode], next] },
        activeThreadIds: { ...current.activeThreadIds, [current.mode]: next.id },
      };
    });
  }, [patchActive]);

  const duplicateThread = (id: string) => {
    patchActive((current) => {
      const source = current.threads[current.mode].find((item) => item.id === id);
      if (!source) return current;
      const createdAt = new Date().toISOString();
      const copy: GenerationThread = {
        ...structuredClone(source),
        id: crypto.randomUUID(),
        name: `${source.name} copy`,
        createdAt,
        updatedAt: createdAt,
        archivedAt: undefined,
        revision: 0,
        attempts: [],
      };
      return {
        ...current,
        threads: { ...current.threads, [current.mode]: [...current.threads[current.mode], copy] },
        activeThreadIds: { ...current.activeThreadIds, [current.mode]: copy.id },
      };
    });
  };

  const renameThread = (id: string, name: string) => {
    const current = modeThreads.find((item) => item.id === id);
    if (!current) return;
    const normalized = name.trim().slice(0, 100);
    if (!normalized || normalized === current.name) return;
    patchActive((session) => ({
      ...session,
      threads: {
        ...session.threads,
        [session.mode]: session.threads[session.mode].map((item) => item.id === id ? {
          ...item,
          name: normalized,
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
        } : item),
      },
    }));
  };

  const archiveThread = useCallback((id: string) => {
    patchActive((current) => {
      if (current.agent.controlMode === "agent") return current;
      const visible = current.threads[current.mode].filter((item) => !item.archivedAt);
      if (visible.length <= 1) return current;
      const target = visible.find((item) => item.id === id);
      if (!target || activeGenerationAttempt(target)) return current;
      const remaining = visible.filter((item) => item.id !== id);
      const targetIndex = visible.findIndex((item) => item.id === id);
      const nextActive = remaining[Math.min(targetIndex, remaining.length - 1)];
      return {
        ...current,
        threads: {
          ...current.threads,
          [current.mode]: current.threads[current.mode].map((item) => item.id === id ? { ...item, archivedAt: new Date().toISOString() } : item),
        },
        activeThreadIds: current.activeThreadIds[current.mode] === id
          ? { ...current.activeThreadIds, [current.mode]: nextActive.id }
          : current.activeThreadIds,
      };
    });
  }, [patchActive]);

  const requestAppQuit = useCallback(() => void (async () => {
    if (quitConfirmationPending.current || confirmationRef.current) return;
    quitConfirmationPending.current = true;
    try {
      const activeJobCount = studioRef.current.sessions.reduce(
        (count, current) => count + activeVideoJobsFromAttempts(current).length,
        0,
      );
      const confirmed = await confirmAction(
        t("quitAppTitle"),
        activeJobCount
          ? `${t("quitAppHint")}\n\n${t("quitAppWithVideoJobsHint", { count: activeJobCount })}`
          : t("quitAppHint"),
        t("quitApp"),
      );
      if (confirmed && isTauriRuntime()) {
        saveStudioState(studioRef.current);
        await invoke("quit_app");
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      quitConfirmationPending.current = false;
    }
  })(), [confirmAction, t]);

  const restoreThread = (id: string) => {
    patchActive((current) => {
      const restored = current.threads[current.mode].find((item) => item.id === id);
      if (!restored) return current;
      return {
        ...current,
        threads: {
          ...current.threads,
          [current.mode]: current.threads[current.mode].map((item) => item.id === id ? { ...item, archivedAt: undefined, updatedAt: new Date().toISOString() } : item),
        },
        activeThreadIds: { ...current.activeThreadIds, [current.mode]: id },
      };
    });
  };

  const cancelQueuedAttempts = (current: StudioSession) => ({
    ...current,
    threads: {
      image: current.threads.image.map((item) => ({
        ...item,
        attempts: item.attempts.map((attempt) => ["queued", "enhancing", "awaiting_host"].includes(attempt.status)
          ? { ...attempt, status: "canceled" as const, cancelRequestedAt: new Date().toISOString(), completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
          : attempt),
      })),
      video: current.threads.video.map((item) => ({
        ...item,
        attempts: item.attempts.map((attempt) => ["queued", "enhancing", "awaiting_host"].includes(attempt.status)
          ? { ...attempt, status: "canceled" as const, cancelRequestedAt: new Date().toISOString(), completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
          : attempt),
      })),
    },
  });

  const useModeDefaults = () => patchActive((current) => ({
    ...current,
    threads: {
      ...current.threads,
      [current.mode]: current.threads[current.mode].map((item) => item.id === current.activeThreadIds[current.mode] ? {
        ...item,
        modelOverrideId: undefined,
        optionOverrides: {},
        providerJsonOverride: undefined,
        revision: item.revision + 1,
        updatedAt: new Date().toISOString(),
      } : item),
    },
  }));

  const setCurrentAsModeDefault = () => patchActive((current) => {
    const target = current.threads[current.mode].find((item) => item.id === current.activeThreadIds[current.mode]) ?? current.threads[current.mode][0];
    const resolved = effectiveThreadDraft(current, target);
    const key = target.mode;
    const modelId = effectiveThreadModelId(current, target);
    return {
      ...current,
      generationDefaults: {
        ...current.generationDefaults,
        modelIds: { ...current.generationDefaults.modelIds, [current.mode]: modelId },
        options: { ...current.generationDefaults.options, [key]: resolved.options },
        providerJson: { ...current.generationDefaults.providerJson, [key]: resolved.providerJson },
      },
      threads: {
        ...current.threads,
        [current.mode]: current.threads[current.mode].map((item) => item.id === target.id ? { ...item, modelOverrideId: undefined, optionOverrides: {}, providerJsonOverride: undefined } : item),
      },
    };
  });

  const deleteAssets = async (ids: string[]) => {
    const deleting = session.assets.filter((asset) => ids.includes(asset.id));
    const inUse = [...session.threads.image, ...session.threads.video].some((item) =>
      item.draft.references.some((reference) => ids.includes(reference.assetId)),
    );
    if (!deleting.length || !await confirmAction(
      inUse ? t("deleteAttachedAssets") : t("deleteAssetsTitle"),
      inUse ? t("deleteAttachedAssetsHint") : t("deleteAssetsHint"),
      t("deleteAssets"),
    )) return;
    try {
      await Promise.all(deleting.map(deleteManagedAsset));
    } catch (error) {
      toast.error(`Could not delete every local asset file: ${errorMessage(error)}`);
      return;
    }
    patchActive((current) => ({
      ...current,
      assets: current.assets.filter((asset) => !ids.includes(asset.id)),
      threads: {
        image: current.threads.image.map((item) => ({
          ...item,
          draft: { ...item.draft, references: item.draft.references.filter((reference) => !ids.includes(reference.assetId)) },
          attempts: item.attempts.map((attempt) => ({ ...attempt, inputAssetIds: attempt.inputAssetIds.filter((id) => !ids.includes(id)), assetIds: attempt.assetIds.filter((id) => !ids.includes(id)), snapshot: attempt.snapshot ? { ...attempt.snapshot, assetBindings: attempt.snapshot.assetBindings.filter((binding) => !ids.includes(binding.assetId)) } : undefined })),
        })),
        video: current.threads.video.map((item) => ({
          ...item,
          draft: { ...item.draft, references: item.draft.references.filter((reference) => !ids.includes(reference.assetId)) },
          attempts: item.attempts.map((attempt) => ({ ...attempt, inputAssetIds: attempt.inputAssetIds.filter((id) => !ids.includes(id)), assetIds: attempt.assetIds.filter((id) => !ids.includes(id)), snapshot: attempt.snapshot ? { ...attempt.snapshot, assetBindings: attempt.snapshot.assetBindings.filter((binding) => !ids.includes(binding.assetId)) } : undefined })),
        })),
      },
      agent: {
        ...current.agent,
        artifacts: current.agent.artifacts
          .filter((artifact) => !ids.includes(artifact.assetId))
          .map((artifact) => ({
            ...artifact,
            parentAssetIds: artifact.parentAssetIds.filter((id) => !ids.includes(id)),
          })),
        decisions: current.agent.decisions.map((decision) => ({
          ...decision,
          relatedAssetIds: decision.relatedAssetIds.filter((id) => !ids.includes(id)),
        })),
        assembly: {
          ...current.agent.assembly,
          clips: current.agent.assembly.clips.filter((clip) => !ids.includes(clip.assetId)),
          outputAssetId: current.agent.assembly.outputAssetId && ids.includes(current.agent.assembly.outputAssetId)
            ? undefined
            : current.agent.assembly.outputAssetId,
          status: current.agent.assembly.clips.some((clip) => ids.includes(clip.assetId))
            ? "draft"
            : current.agent.assembly.status,
        },
      },
    }));
    setSelectedAssetIds(new Set());
  };

  const mentionMatch = draft.prompt.match(/(?:^|\s)@(\d*)$/);
  const mentionSuggestions = mentionMatch
    ? draft.references.filter((reference) => String(reference.slot).startsWith(mentionMatch[1]))
    : [];
  const validPromptMentions = useMemo(
    () => findInputMentions(draft.prompt, draft.references.map((reference) => reference.slot)),
    [draft.prompt, draft.references],
  );
  const mentionedSlots = useMemo(
    () => mentionedInputSlots(draft.prompt, draft.references.map((reference) => reference.slot)),
    [draft.prompt, draft.references],
  );
  const agentModelConfirmed = session.agent.controlMode === "human"
    || (session.agent.modelSelections[mode].status === "selected" && session.agent.modelSelections[mode].modelId === selectedId);
  const hasMask = mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0;
  const canGenerate = Boolean(selectedModel && hasRunnableInstructions(mode, draft) && !providerError && !generationValidationError && credential?.configured && !generating && !enhancing && !activeAttempt && agentModelConfirmed && session.agent.controlMode === "human");
  const currentResult = resultQueue[0] ?? null;
  const currentResultSession = currentResult
    ? studio.sessions.find((item) => item.id === currentResult.sessionId) ?? null
    : null;
  const dismissGenerationResult = (action?: () => void) => {
    if (!currentResult || resultHandingOff) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const exitDelay = reduceMotion ? 0 : 280;
    if (action) setResultQueuePaused(true);
    setResultHandingOff(true);
    setResultDialogOpen(false);
    if (resultHandoffTimer.current) window.clearTimeout(resultHandoffTimer.current);
    if (resultCooldownTimer.current) window.clearTimeout(resultCooldownTimer.current);
    resultHandoffTimer.current = window.setTimeout(() => {
      if (action) {
        action();
      } else {
        setRightPanelTab("assets");
        setHighlightedAssetIds(new Set(currentResult.assetIds));
        if (assetHighlightTimer.current) window.clearTimeout(assetHighlightTimer.current);
        assetHighlightTimer.current = window.setTimeout(() => setHighlightedAssetIds(new Set()), reduceMotion ? 20 : 1_400);
      }
      setResultQueue((current) => current.slice(1));
    }, exitDelay);
    resultCooldownTimer.current = window.setTimeout(() => setResultHandingOff(false), exitDelay + (reduceMotion ? 20 : 420));
  };
  const selectSession = (id: string) => {
    setStudio((current) => ({ ...current, activeSessionId: id }));
    setSelectedAssetIds(new Set());
    setFocusedAssetId(null);
    setPreviewAssetId(null);
    setDecisionOpen(false);
  };
  const createNewSession = () => {
    setStudio((current) => {
      const created = initializeSessionCatalogDefaults(
        createSession(nextAvailableSessionName(
          current.sessions,
          (count) => t("newSessionName", { count }),
        )),
        catalogs,
      );
      return { ...current, activeSessionId: created.id, sessions: [...current.sessions, created] };
    });
  };
  const deleteStudioSession = (id: string) => void (async () => {
    const deleting = studio.sessions.find((item) => item.id === id);
    if (!deleting || studio.sessions.length === 1) return;
    if (!await confirmAction(
      t("deleteSessionTitle", { name: deleting.name }),
      t("deleteSessionHint"),
      t("deleteSession"),
    )) return;
    void deleteSessionBlobs(deleting);
    setStudio((current) => {
      const sessions = current.sessions.filter((item) => item.id !== id);
      return { ...current, sessions, activeSessionId: current.activeSessionId === id ? sessions[0].id : current.activeSessionId };
    });
  })();

  const toggleControlMode = () => {
    const currentDraft = thread.draft;
    if (
      session.agent.controlMode === "human"
      && session.agent.connection.status === "disconnected"
      && !currentDraft.prompt.trim()
    ) {
      toast.error(t("enterIntentBeforeAgent"));
      return;
    }
    patchActive((current) => {
      if (current.agent.controlMode === "agent") return { ...current, agent: setControlMode(current.agent, "human") };
      const currentMode = current.mode;
      const currentThread = current.threads[currentMode].find((item) => item.id === current.activeThreadIds[currentMode]) ?? current.threads[currentMode][0];
      const currentDraft = currentThread.draft;
      const seeded = current.agent.connection.status === "disconnected"
        ? exposeAgentSession(current.agent, currentDraft.prompt)
        : setControlMode(current.agent, "agent");
      return { ...current, agent: seeded, agentBridge: true };
    });
  };

  createNewSessionRef.current = createNewSession;
  duplicateThreadRef.current = duplicateThread;
  restoreThreadRef.current = restoreThread;
  switchModeRef.current = switchMode;
  pickFilesRef.current = pickFiles;
  runGenerationRef.current = runGeneration;
  dismissGenerationResultRef.current = () => dismissGenerationResult();

  const modalOpen = onboardingOpen !== false || otherDialogOpen || resultDialogOpen || Boolean(confirmation)
    || settingsOpen || shortcutHelpOpen || assemblyOpen || decisionOpen;
  const previewAsset = session.assets.find((asset) => asset.id === previewAssetId);
  const focusedAsset = previewAsset ?? session.assets.find((asset) => asset.id === focusedAssetId)
    ?? (selectedAssetIds.size === 1 ? session.assets.find((asset) => selectedAssetIds.has(asset.id)) : undefined);

  const focusPrompt = useCallback(() => {
    window.requestAnimationFrame(() => {
      promptRef.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      promptRef.current?.focus();
    });
  }, []);

  const closeTopmostDialog = useCallback(() => {
    if (confirmation) {
      confirmation.resolve(false);
      closeConfirmation();
      return true;
    }
    if (shortcutHelpOpen) { setShortcutHelpOpen(false); return true; }
    if (resultDialogOpen) { dismissGenerationResultRef.current(); return true; }
    if (decisionOpen) { setDecisionOpen(false); return true; }
    if (assemblyOpen) { setAssemblyOpen(false); return true; }
    if (settingsOpen) { setSettingsOpen(false); return true; }
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')];
    const dialog = dialogs.at(-1);
    if (!dialog) return false;
    const close = dialog.querySelector<HTMLElement>('[data-base-ui-dialog-close], [data-base-ui-alert-dialog-close], button[aria-label*="Close"], button[aria-label*="닫기"]');
    if (close) close.click();
    else dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  }, [assemblyOpen, closeConfirmation, confirmation, decisionOpen, resultDialogOpen, settingsOpen, shortcutHelpOpen]);

  const cycleThread = useCallback((direction: -1 | 1) => {
    patchActive((current) => {
      const visible = current.threads[current.mode].filter((candidate) => !candidate.archivedAt);
      if (visible.length < 2) return current;
      const index = visible.findIndex((candidate) => candidate.id === current.activeThreadIds[current.mode]);
      const next = visible[(Math.max(0, index) + direction + visible.length) % visible.length];
      return { ...current, activeThreadIds: { ...current.activeThreadIds, [current.mode]: next.id } };
    });
  }, [patchActive]);

  const dispatchAppCommand = useCallback((id: AppCommandId): boolean => {
    if (id === "quit") {
      requestAppQuit();
      return true;
    }
    if (id === "archiveThread" && modalOpen) return closeTopmostDialog();
    if (confirmation) return false;
    if (id === "generate" && (decisionOpen || assemblyOpen)) {
      const target = document.querySelector<HTMLElement>(decisionOpen ? ".decision-workspace" : ".assembly-dialog");
      target?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: navigator.platform.toLowerCase().includes("mac"),
        ctrlKey: !navigator.platform.toLowerCase().includes("mac"),
        bubbles: true,
        cancelable: true,
      }));
      return Boolean(target);
    }
    if (modalOpen && id !== "settings" && id !== "shortcutHelp" && !(id === "exportAsset" && previewAsset)) return false;
    switch (id) {
      case "newSession":
        createNewSessionRef.current();
        focusPrompt();
        return true;
      case "newThread":
        if (session.agent.controlMode === "agent") return false;
        createThread();
        focusPrompt();
        return true;
      case "duplicateThread":
        if (session.agent.controlMode === "agent") return false;
        duplicateThreadRef.current(thread.id);
        focusPrompt();
        return true;
      case "archiveThread":
        if (session.agent.controlMode === "agent" || hasActiveAttempt || modeThreads.length <= 1) return true;
        archiveThread(thread.id);
        return true;
      case "restoreThread": {
        const latest = session.threads[mode]
          .filter((candidate) => candidate.archivedAt)
          .toSorted((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""))[0];
        if (!latest || session.agent.controlMode === "agent") return false;
        restoreThreadRef.current(latest.id);
        return true;
      }
      case "nextThread": cycleThread(1); return true;
      case "previousThread": cycleThread(-1); return true;
      case "findSessions":
        setSessionSidebarOpen(true);
        window.requestAnimationFrame(() => sessionSearchRef.current?.focus());
        return true;
      case "importAssets": void pickFilesRef.current(); return true;
      case "exportAsset": {
        const hasAssetPanelContext = rightPanelOpen && rightPanelTab === "assets";
        if (!focusedAsset || (!previewAsset && !hasAssetPanelContext)) return false;
        void exportAssetToDownloads(focusedAsset)
          .then((path) => toast.success(t("downloadComplete", { name: focusedAsset.name, path })))
          .catch((error) => toast.error(errorMessage(error)));
        return true;
      }
      case "imageMode": switchModeRef.current("image"); return true;
      case "videoMode": switchModeRef.current("video"); return true;
      case "toggleSessionSidebar": setSessionSidebarOpen((open) => !open); return true;
      case "toggleInspector": setRightPanelOpen((open) => !open); return true;
      case "showAgent": setRightPanelOpen(true); setRightPanelTab("agent"); return true;
      case "showAssets": setRightPanelOpen(true); setRightPanelTab("assets"); return true;
      case "focusPrompt": focusPrompt(); return true;
      case "generate":
        if (!canGenerate) return false;
        runGenerationRef.current();
        return true;
      case "settings":
        if (modalOpen && !settingsOpen) return false;
        setSettingsOpen(true);
        return true;
      case "shortcutHelp":
        if (modalOpen && !shortcutHelpOpen) return false;
        setShortcutHelpOpen(true);
        return true;
      default: return false;
    }
  }, [archiveThread, assemblyOpen, canGenerate, closeTopmostDialog, confirmation, createThread, cycleThread, decisionOpen, focusPrompt, focusedAsset, hasActiveAttempt, modalOpen, mode, modeThreads.length, previewAsset, requestAppQuit, rightPanelOpen, rightPanelTab, session.agent.controlMode, session.threads, settingsOpen, shortcutHelpOpen, t, thread.id]);
  dispatchCommandRef.current = dispatchAppCommand;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen("app-quit-requested", () => dispatchCommandRef.current("quit"));
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => toast.error(errorMessage(error)));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      const command = commandForKeyboardEvent(event);
      if (!command) return;
      if (command.id === "generate" && (decisionOpen || assemblyOpen)) return;
      if (nativeMenuRef.current && NATIVE_MENU_COMMAND_IDS.has(command.id)) return;
      if (!dispatchCommandRef.current(command.id)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [assemblyOpen, decisionOpen]);

  const hasArchivedThread = session.threads[mode].some((candidate) => candidate.archivedAt);
  const nativeMenuState = useMemo<NativeMenuState>(() => ({
    enabled: {
      newSession: !modalOpen,
      newThread: !modalOpen && session.agent.controlMode === "human",
      duplicateThread: !modalOpen && session.agent.controlMode === "human",
      archiveThread: modalOpen || (session.agent.controlMode === "human" && !hasActiveAttempt && modeThreads.length > 1),
      restoreThread: !modalOpen && session.agent.controlMode === "human" && hasArchivedThread,
      nextThread: !modalOpen && modeThreads.length > 1,
      previousThread: !modalOpen && modeThreads.length > 1,
      findSessions: !modalOpen,
      importAssets: !modalOpen,
      exportAsset: !confirmation && (Boolean(previewAsset) || (!modalOpen && rightPanelOpen && rightPanelTab === "assets" && Boolean(focusedAsset))),
      imageMode: !modalOpen,
      videoMode: !modalOpen,
      toggleSessionSidebar: !modalOpen,
      toggleInspector: !modalOpen,
      showAgent: !modalOpen,
      showAssets: !modalOpen,
      generate: !confirmation && ((!modalOpen && canGenerate) || decisionOpen || assemblyOpen),
      settings: !modalOpen || settingsOpen,
      shortcutHelp: !modalOpen || shortcutHelpOpen,
      quit: true,
    },
    checked: {
      toggleSessionSidebar: sessionSidebarOpen,
      toggleInspector: rightPanelOpen,
      imageMode: mode === "image",
      videoMode: mode === "video",
      showAgent: rightPanelOpen && rightPanelTab === "agent",
      showAssets: rightPanelOpen && rightPanelTab === "assets",
    },
  }), [assemblyOpen, canGenerate, confirmation, decisionOpen, focusedAsset, hasActiveAttempt, hasArchivedThread, modalOpen, mode, modeThreads.length, previewAsset, rightPanelOpen, rightPanelTab, session.agent.controlMode, sessionSidebarOpen, settingsOpen, shortcutHelpOpen]);
  nativeMenuStateRef.current = nativeMenuState;

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      const build = nativeMenuBuildQueueRef.current.catch(() => undefined).then(async () => {
        if (disposed) return;
        const menu = await createNativeAppMenu(t, (id) => { dispatchCommandRef.current(id); });
        nativeMenuRef.current = menu;
        await menu.update(nativeMenuStateRef.current);
      });
      nativeMenuBuildQueueRef.current = build;
      void build.catch((error) => toast.error(errorMessage(error)));
    }, 0);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [language, t]);

  useEffect(() => {
    void nativeMenuRef.current?.update(nativeMenuState).catch((error) => console.warn("Could not update app menu", error));
  }, [nativeMenuState]);

  const resolveUiDecision = async (
    selectedOptionIds: string[],
    selectedAssetIdsForDecision: string[],
    note?: string,
  ) => {
    const currentSession = studioRef.current.sessions.find((item) => item.id === studioRef.current.activeSessionId);
    const decision = currentSession?.agent.decisions.find((item) => item.id === pendingUiDecision?.id);
    if (!currentSession || !decision) throw new Error("This checkpoint is no longer pending.");
    if (!isTauriRuntime()) {
      const resolved = resolveAgentDecisionFromDesktop(
        currentSession.agent,
        decision.id,
        selectedOptionIds,
        selectedAssetIdsForDecision,
        note,
      );
      const selectedModel = selectedOptionIds[0];
      patchSession(currentSession.id, (current) => {
        const selectedMode = decision.semanticKey === "model_selection_image" ? "image" : decision.semanticKey === "model_selection_video" ? "video" : undefined;
        const related = decision.relatedThreadIds ?? [];
        return {
          ...current,
          generationDefaults: selectedMode && selectedModel && !related.length ? {
            ...current.generationDefaults,
            modelIds: { ...current.generationDefaults.modelIds, [selectedMode]: selectedModel },
          } : current.generationDefaults,
          threads: selectedMode && selectedModel && related.length ? {
            ...current.threads,
            [selectedMode]: current.threads[selectedMode].map((item) => related.includes(item.id) ? { ...item, modelOverrideId: selectedModel } : item),
          } : current.threads,
          agent: resolved,
        };
      });
      return;
    }
    const confirmedRevision = bridgeRevisions.current.get(currentSession.id);
    if (confirmedRevision == null) throw new Error("This session is still being published to Core. Try again in a moment.");
    const base = bridgeSnapshots.current.get(currentSession.id);
    const localBeforeDecision = bridgeDirtyVersions.current.has(currentSession.id)
      ? await serializeAgentSessionForBridge(currentSession)
      : undefined;
    const committed = await commitAgentOperationsWithConflictRetry(
      currentSession.id,
      confirmedRevision,
      `desktop-decision:${decision.id}`,
      [{
        type: "resolve_ui_decision",
        decisionId: decision.id,
        selectedOptionIds,
        selectedAssetIds: selectedAssetIdsForDecision,
        note,
      }],
    );
    bridgeRevisions.current.set(currentSession.id, committed.receipt.revision);
    bridgeSnapshots.current.set(currentSession.id, committed.session);
    const resolvedSession = localBeforeDecision && base
      ? mergeBridgeSession(base, localBeforeDecision, committed.session)
      : committed.session;
    if (localBeforeDecision) {
      bridgeDirtyVersions.current.set(
        currentSession.id,
        (bridgeDirtyVersions.current.get(currentSession.id) ?? 0) + 1,
      );
    }
    const incoming = materializeAgentSession(resolvedSession);
    setStudio((current) => ({
      ...current,
      sessions: current.sessions.map((candidate) => candidate.id === currentSession.id ? {
        ...candidate,
        ...incoming,
        assets: preserveLocalAssetMetadata(incoming.assets, candidate.assets),
      } : candidate),
    }));
  };

  const assembleVideo = async (clips: VideoAssemblyClip[]) => {
    try {
      if (!isTauriRuntime()) throw new Error("Final rendering requires the Tauri desktop app.");
      const assemblyDecision = session.agent.decisions.find((decision) =>
        decision.status === "pending"
        && decision.channel === "fruit_truck_ui"
        && decision.presentation === "assembly_review"
      );
      if (session.agent.controlMode !== "human" && !assemblyDecision) {
        throw new Error("Switch to Human control before starting a desktop render.");
      }
      const unapproved = clips.find((clip) =>
        session.agent.artifacts.find((artifact) => artifact.assetId === clip.assetId)?.approval !== "approved",
      );
      if (unapproved) throw new Error("Approve every source clip before rendering.");
      const duration = assemblyDurationSeconds(clips);
      const durationError = validateAssemblyDuration(session.agent, duration);
      if (durationError) throw new Error(durationError);
      patchAgent((current) => ({
        ...current,
        assembly: { ...current.assembly, clips, status: "rendering", error: undefined },
        runStatus: "paused",
      }));
      const hydrated = await Promise.all(clips.map(async (clip) => {
        const asset = assetMap.get(clip.assetId);
        if (!asset) throw new Error(`Assembly asset ${clip.assetId} is missing.`);
        if (!asset.localPath) throw new Error(`${asset.name} must be migrated into managed storage before assembly.`);
        return {
          source: asset.localPath,
          name: asset.name,
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
        };
      }));
      const result = await invoke<{ path: string; duration: number }>("assemble_video", {
        clips: hydrated,
        expectedDuration: expectedVideoDurationSeconds(session.agent),
      });
      const finalAsset: SessionAsset = {
        id: crypto.randomUUID(),
        name: `final-${new Date().toISOString().replaceAll(":", "-")}.mp4`,
        kind: "video",
        mimeType: "video/mp4",
        origin: "edited",
        createdAt: new Date().toISOString(),
        localPath: result.path,
        duration: result.duration,
      };
      patchActive((current) => {
        const withFinalArtifact: AgentSessionState = {
          ...current.agent,
          runStatus: "waiting",
          assembly: { ...current.agent.assembly, clips, outputAssetId: finalAsset.id, status: "completed", error: undefined },
          artifacts: [...current.agent.artifacts, {
            assetId: finalAsset.id,
            role: "final_video",
            parentAssetIds: clips.map((clip) => clip.assetId),
            approval: "unreviewed",
          }],
        };
        const afterAssemblyDecision = assemblyDecision
          ? resolveAgentDecisionFromDesktop(withFinalArtifact, assemblyDecision.id, ["rendered"], [], "Rendered in Fruit Truck")
          : withFinalArtifact;
        return {
          ...current,
          assets: [...current.assets, finalAsset],
          agent: recordAgentActivity({
          ...afterAssemblyDecision,
          runStatus: "waiting",
          decisions: [...afterAssemblyDecision.decisions, {
            id: crypto.randomUUID(),
            semanticKey: "final_approval",
            title: "Final video approval",
            prompt: "Review the assembled result. Approve it as final or leave revision feedback.",
            kind: "approval",
            channel: "fruit_truck_ui",
            presentation: "media_grid",
            selectionMode: "single",
            minSelections: 1,
            maxSelections: 1,
            allowNote: true,
            status: "pending",
            blocking: true,
            relatedAssetIds: [finalAsset.id],
            options: [
              { id: "approve", label: "Approve final", recommended: true },
              { id: "revise", label: "Request revision" },
            ],
            createdAt: new Date().toISOString(),
          }],
        }, {
          actor: "runtime",
          kind: "assembly",
          title: "Rendered final video",
          detail: `${clips.length} clips · ${result.duration.toFixed(1)} seconds`,
          assetIds: [finalAsset.id],
        }),
        };
      });
    } catch (error) {
      const message = errorMessage(error);
      patchAgent((current) => ({
        ...current,
        runStatus: "failed",
        assembly: { ...current.assembly, status: "failed", error: message },
      }));
      throw new Error(message);
    }
  };

  return (
    <Tooltip.Provider>
    <div className="app-shell" aria-hidden={onboardingOpen !== false} inert={onboardingOpen !== false ? true : undefined}>
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><span className="brand-mark"><FruitTruckMark /></span><strong>Fruit Truck</strong><button type="button" className={`brand-badge ${session.agent.controlMode}`} onClick={() => {
          setRightPanelOpen(true);
          setRightPanelTab("agent");
        }}>{session.agent.controlMode === "agent" ? t("agent") : t("humanDriven")}</button></div>
        <ModelSelector mode={mode} models={models} selectedId={selectedId} loading={catalogLoading} disabled={session.agent.controlMode === "agent"} onSelect={selectModel} inherited={!thread.modelOverrideId} onUseDefault={useModeDefaults} onSetDefault={setCurrentAsModeDefault} />
        <ToggleGroup className="mode-switcher" aria-label={t("generationMode")} value={[mode]} onValueChange={(value) => {
          const next = value[0];
          if (next === "image" || next === "video") switchMode(next);
        }}>
          <Toggle value="image" aria-label={t("image")} aria-keyshortcuts="Meta+1"><ImageIcon /> {t("image")}</Toggle>
          <Toggle value="video" aria-label={t("video")} aria-keyshortcuts="Meta+2"><Video /> {t("video")}</Toggle>
        </ToggleGroup>
        <div className="topbar-actions">
          <div
            className="session-spend"
            role="status"
            aria-live="polite"
            aria-label={`${t("sessionSpend")}: ${formatUsd(session.agent.execution.spentUsd)}`}
            data-tauri-drag-region
          >
            <small>{t("sessionSpend")}</small>
            <strong>{formatUsd(session.agent.execution.spentUsd)}</strong>
          </div>
          <div className="connection-pill" role="status"><i className={credential?.configured ? "online" : ""} />{credential?.configured ? credential.maskedKey : t("addApiKey")}</div>
          <Button type="button" variant="ghost" size="icon" aria-label={t("settings")} aria-keyshortcuts="Meta+," onClick={() => setSettingsOpen(true)}><Settings /></Button>
        </div>
      </header>

      <main
        className={`workspace ${sessionSidebarOpen ? "session-sidebar-open" : "session-sidebar-closed"} ${rightPanelOpen ? "right-panel-open" : "right-panel-closed"}`}
        style={{ "--sessions-width": `${sessionSidebarWidth}px` } as CSSProperties}
      >
        {!sessionSidebarOpen ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="session-sidebar-reopen"
            aria-label={t("openSessionSidebar")}
            aria-keyshortcuts="Control+Meta+S"
            onClick={() => setSessionSidebarOpen(true)}
          ><PanelLeftOpen /></Button>
        ) : null}
        {sessionSidebarOpen ? (
          <SessionSidebar
            sessions={studio.sessions}
            activeId={studio.activeSessionId}
            width={sessionSidebarWidth}
            onWidthChange={setSessionSidebarWidth}
            onClose={() => setSessionSidebarOpen(false)}
            onSelect={selectSession}
            onCreate={createNewSession}
            onRename={(id, name) => patchSession(id, (current) => ({ ...current, name }))}
            onDelete={deleteStudioSession}
            searchInputRef={sessionSearchRef}
          />
        ) : null}
        {!rightPanelOpen ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="right-panel-reopen"
            aria-label={t("commandToggleInspector")}
            aria-keyshortcuts="Meta+Alt+I"
            onClick={() => setRightPanelOpen(true)}
          ><PanelRightOpen /></Button>
        ) : null}
        <section className="composer">
          <GenerationThreadRail
            threads={session.threads[mode]}
            activeId={thread.id}
            disabled={session.agent.controlMode === "agent"}
            onActivate={activateThread}
            onCreate={createThread}
            onDuplicate={duplicateThread}
            onRename={renameThread}
            onArchive={archiveThread}
            onRestore={restoreThread}
          />
          <ScrollArea className="composer-scroll" viewportRef={composerViewportRef}>
          {catalogError ? <div className="catalog-error"><CircleAlert /><span><strong>{t("catalogLoadFailed")}</strong><small>{catalogError}</small></span><Button variant="outline" size="sm" onClick={() => void refreshCatalog()}><RefreshCw /> {t("retry")}</Button></div> : null}
          <header className="composer-header">
            <div>
              <p>{mode === "image" ? draft.imageEditMode ? t("imageEdit") : t("imageGeneration") : t("videoGeneration")}</p>
              <h1>{selectedModel?.name ?? (catalogLoading ? t("loadingModels") : t("chooseModel"))}</h1>
            </div>
            <div className="composer-header-meta">
              {selectedModel ? <div className="model-meta"><span>{providerLabel(selectedModel)}</span>{mode === "image" && imageEndpoints[selectedId] ? <span>{t("endpointsVerified", { count: imageEndpoints[selectedId].length })}</span> : null}</div> : null}
              <div className="composer-header-utilities">
                {resultQueuePaused && resultQueue.length ? <Button type="button" className="pending-results-trigger" variant="outline" size="xs" onClick={() => setResultQueuePaused(false)}><ImageIcon /> {t("pendingResults", { count: resultQueue.length })}</Button> : null}
                <AttemptHistoryPopover attempts={thread.attempts} />
              </div>
            </div>
          </header>
          <div className="composer-form">
            {mode === "image" ? (
              <Field.Root className="edit-mode-row">
                <Field.Label className="edit-mode-label" nativeLabel={false} render={<div />}><span><strong>{t("editMode")}</strong><small>{t("editModeHint")}</small></span></Field.Label>
                <Switch checked={draft.imageEditMode} onCheckedChange={(value) => patchDraft({ imageEditMode: value })} />
              </Field.Root>
            ) : null}
            {mode === "image" && draft.imageEditMode ? (
              <>
                <ImageEditPanel
                  asset={editTargetAsset}
                  targetLabel={editReference ? `@${editReference.slot}` : ""}
                  maskStrokes={draft.maskStrokes}
                  maskInstructions={draft.maskInstructions}
                  maskError={maskReferenceError}
                  onMaskStrokesChange={(maskStrokes) => patchDraft({
                    maskStrokes,
                    maskInstructions: maskStrokes.length ? draft.maskInstructions : "",
                    enhancedPrompt: "",
                    enhancedPromptDirty: false,
                  })}
                  onMaskInstructionsChange={(maskInstructions) => patchDraft({ maskInstructions, enhancedPrompt: "", enhancedPromptDirty: false })}
                  onDropAsset={setEditTargetAsset}
                  onImport={importEditTarget}
                  onPick={pickEditTarget}
                />
                {editTargetError ? <div className="field-error edit-canvas-error">{editTargetError}</div> : null}
              </>
            ) : null}
            <InputTray references={draft.references} assets={session.assets} roles={roles} limit={referenceLimit} error={inputValidationError} onChange={(references) => {
              const targetStillAttached = references.some((reference) => `@${reference.slot}` === draft.imageEditTarget);
              patchDraft({
                references,
                imageEditTarget: mode === "image" && draft.imageEditMode && !targetStillAttached ? "" : draft.imageEditTarget,
                maskStrokes: mode === "image" && draft.imageEditMode && !targetStillAttached ? [] : draft.maskStrokes,
                maskInstructions: mode === "image" && draft.imageEditMode && !targetStillAttached ? "" : draft.maskInstructions,
                enhancedPrompt: "",
                enhancedPromptDirty: false,
              });
            }} onImport={importFiles} onPick={pickFiles} />
            <Field.Root className="prompt-field">
              <Field.Label className="section-label-row"><span className="section-label">{t("prompt")}{hasMask ? <> <em>{t("optional")}</em></> : null}</span><small>{t("characters", { count: draft.prompt.length.toLocaleString(language === "ko" ? "ko-KR" : "en-US") })}</small></Field.Label>
              <div className={`prompt-input-wrap ${draft.prompt ? "has-value" : ""}`}>
                <div ref={promptHighlightRef} className="prompt-highlight" aria-hidden="true">
                  <PromptMentionHighlight value={draft.prompt} mentions={validPromptMentions} />
                </div>
                <Textarea
                  ref={promptRef}
                  autoFocus
                  aria-keyshortcuts="Meta+Enter Shift+Escape"
                  rows={7}
                  value={draft.prompt}
                  placeholder={mode === "image" ? t("imagePromptPlaceholder") : t("videoPromptPlaceholder")}
                  onChange={(event) => patchDraft({
                    prompt: event.target.value,
                    enhancedPrompt: "",
                    enhancedPromptDirty: false,
                  })}
                  onScroll={(event) => {
                    if (!promptHighlightRef.current) return;
                    promptHighlightRef.current.scrollTop = event.currentTarget.scrollTop;
                    promptHighlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
                  }}
                />
                {mentionSuggestions.length ? (
                  <div className="mention-menu" role="listbox" aria-label={t("numberedInputs")}>
                    {mentionSuggestions.map((reference) => {
                      const asset = assetMap.get(reference.assetId);
                      return <Button type="button" variant="ghost" key={reference.assetId} onClick={() => patchDraft({ prompt: draft.prompt.replace(/@\d*$/, `@${reference.slot} `) })}><b>@{reference.slot}</b>{asset?.name}</Button>;
                    })}
                  </div>
                ) : null}
              </div>
              <div className="prompt-reference-meta">
                <small>{t("mentionInputsHint")}</small>
                {mentionedSlots.length ? <div className="prompt-references">{mentionedSlots.map((slot) => {
                  const reference = draft.references.find((item) => item.slot === slot);
                  const asset = reference ? assetMap.get(reference.assetId) : undefined;
                  return asset ? (
                    <Tooltip.Root key={slot}>
                      <Tooltip.Trigger render={<span className="prompt-reference-chip" />}>@{slot} {t("mentioned")}</Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Positioner sideOffset={6}>
                          <Tooltip.Popup className="token-tooltip"><AssetPreview asset={asset} /><span>{asset.name}</span></Tooltip.Popup>
                        </Tooltip.Positioner>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  ) : null;
                })}</div> : null}
              </div>
            </Field.Root>

            <Field.Root className="enhance-row">
              <Field.Label className="enhance-label" nativeLabel={false} render={<div />}><span><Sparkles /><span><strong>{t("promptEnhancement")}</strong><small>{studio.promptModel.endsWith("luna") ? "GPT-5.6 Luna · xhigh" : "GPT-5.6 Terra · high"}{draft.enhancedPrompt && draft.enhancedVisualCount > 0 ? ` · ${t("visualContextIncluded")}` : ""}</small></span></span></Field.Label>
              <div><Button size="xs" variant="ghost" disabled={enhancing || !hasRunnableInstructions(mode, draft)} onClick={() => void runEnhancement().catch((error) => toast.error(errorMessage(error)))}>{enhancing ? <LoaderCircle className="spin" /> : <RefreshCw />} {draft.enhancedPrompt ? t("reEnhance") : t("preview")}</Button><Switch checked={draft.enhancePrompt && hasRunnableInstructions(mode, draft)} disabled={!hasRunnableInstructions(mode, draft)} onCheckedChange={(value) => patchDraft({ enhancePrompt: value })} /></div>
            </Field.Root>
            {draft.enhancedPrompt ? (
              <Collapsible.Root className="enhanced-prompt">
                <Collapsible.Trigger>{t("enhancedPrompt")} <ChevronRight /></Collapsible.Trigger>
                <Collapsible.Panel>
                  <Textarea value={draft.enhancedPrompt} rows={6} onChange={(event) => patchDraft({ enhancedPrompt: event.target.value, enhancedPromptDirty: true })} />
                  <small>{t("enhancedPromptHint")}</small>
                </Collapsible.Panel>
              </Collapsible.Root>
            ) : null}

            <OptionsFields key={`${mode}:${selectedModel?.id ?? ""}`} mode={mode} model={selectedModel} options={draft.options} providerJson={draft.providerJson} providerError={providerError} onOptionsChange={(options) => patchDraft({ options })} onProviderJsonChange={(providerJson) => patchDraft({ providerJson })} />
            {selectedModel ? <div className="thread-default-controls">
              <Button type="button" size="xs" variant="ghost" disabled={session.agent.controlMode === "agent" || !thread.modelOverrideId && !Object.keys(thread.optionOverrides).length && thread.providerJsonOverride == null} onClick={useModeDefaults}>{t("useModeDefault")}</Button>
              <Button type="button" size="xs" variant="ghost" disabled={session.agent.controlMode === "agent"} onClick={setCurrentAsModeDefault}>{t("setModeDefault")}</Button>
            </div> : null}
          </div>
          <footer className="generate-bar">
            <div className="generate-meta">
              <div><span>{selectedModel ? t("requestFields", { count: Object.keys(requestPayload).length }) : t("noModelSelected")}</span><small>{mode === "video" ? t("backgroundJobs", { count: sessionVideoJobs.length }) : t("commandGenerate")}</small></div>
              <RequestPreviewDialog mode={mode} request={prettyRequest(requestPayload)} references={previewReferences} />
            </div>
            <Button size="lg" className="generate-button" aria-keyshortcuts="Meta+Enter" disabled={!canGenerate} onClick={() => void runGeneration()}>
              {generating || enhancing ? <LoaderCircle className="spin" /> : mode === "image" ? <Sparkles /> : <Play />}
              {generating || enhancing
                ? t("preparing")
                : mode === "image"
                  ? draft.imageEditMode ? t("editImage") : t("generateMode", { mode: t("image") })
                  : t("generateMode", { mode: t("video") })}
              {!generating && !enhancing ? <ChevronRight /> : null}
            </Button>
          </footer>
          </ScrollArea>
        </section>

        {rightPanelOpen ? <RightPanel
          tab={rightPanelTab}
          onTabChange={setRightPanelTab}
          agent={(
            <AgentPanel
              state={session.agent}
              threads={session.threads}
              currentMode={mode}
              batchSummary={persistedBatchSummary}
              onOpenThread={(targetMode, threadId) => {
                patchActive((current) => ({ ...current, mode: targetMode, activeThreadIds: { ...current.activeThreadIds, [targetMode]: threadId } }));
              }}
              onToggleControl={toggleControlMode}
              onPauseResume={() => patchActive((current) => {
                const next = current.agent.runStatus === "paused" ? current : cancelQueuedAttempts(current);
                return { ...next, agent: {
                  ...next.agent,
                  runStatus: next.agent.runStatus === "paused" ? "working" : "paused",
                  pausedReason: next.agent.runStatus === "paused" ? undefined : "Paused by user.",
                } };
              })}
              onStop={() => patchActive((current) => {
                const next = cancelQueuedAttempts(current);
                return { ...next, agent: { ...next.agent, runStatus: "idle", pausedReason: "Stopped by user." } };
              })}
              onOpenDecision={() => setDecisionOpen(true)}
            />
          )}
          assets={(
            <AssetLibrary assets={session.assets} jobs={sessionVideoJobs} artifacts={session.agent.artifacts} approvedVideoCount={approvedVideoCount} onOpenAssembly={() => setAssemblyOpen(true)} selectedIds={selectedAssetIds} onSelectedIdsChange={setSelectedAssetIds} highlightedIds={highlightedAssetIds} onFocusedAssetChange={setFocusedAssetId} onPreviewAssetChange={setPreviewAssetId} onImport={async (files) => { await importFiles(files); }} onPick={async () => { await pickFiles(); }} onUse={addAssetAsReference} onDelete={(ids) => void deleteAssets(ids)} />
          )}
        /> : null}
      </main>

      <GenerationResultDialog
        notice={currentResult}
        assets={currentResultSession?.assets ?? []}
        open={resultDialogOpen && Boolean(currentResultSession)}
        handingOff={resultHandingOff}
        onDismiss={() => dismissGenerationResult()}
        onEditImage={(assetId) => currentResult && dismissGenerationResult(() => editImageAsset(assetId, currentResult))}
        onUseInVideo={(assetId) => currentResult && dismissGenerationResult(() => routeImageToVideo(assetId, currentResult))}
        onUseAsInput={(assetId) => currentResult && dismissGenerationResult(() => addAssetAsReference(assetId, currentResult))}
      />

      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />

      <Suspense fallback={null}>
      <SettingsDialog
        open={settingsOpen}
        status={credential}
        promptModel={studio.promptModel}
        activeCustomSkillNames={session.agent.appliedSkills
          .filter((skill) => skill.source === "custom")
          .map((skill) => skill.name)}
        onPromptModelChange={(promptModel) => setStudio((current) => ({ ...current, promptModel }))}
        onClose={() => setSettingsOpen(false)}
        onSave={async (apiKey) => { const status = await saveApiKey(apiKey); setCredential(status); toast.success(t("keySaved")); }}
        onRemove={async () => { const status = await removeApiKey(); setCredential(status); setCatalogs({ image: [], video: [] }); toast.success(t("keyRemoved")); }}
      />
      <AssemblyDialog
        open={assemblyOpen}
        state={session.agent}
        assets={session.assets}
        onClose={() => setAssemblyOpen(false)}
        onRender={assembleVideo}
      />
      <DecisionWorkspace
        open={decisionOpen && Boolean(pendingUiDecision)}
        decision={pendingUiDecision}
        assets={session.assets}
        onClose={() => setDecisionOpen(false)}
        onPick={pickFiles}
        onOpenAssembly={() => setAssemblyOpen(true)}
        onResolve={resolveUiDecision}
      />
      </Suspense>
      <ConfirmDialog confirmation={confirmation} onClose={closeConfirmation} />
      <UpdatePrompt />
    </div>
    {onboardingOpen !== false ? (
      <Onboarding
        ready={onboardingOpen === true}
        onSave={async (apiKey) => {
          const status = await saveApiKey(apiKey);
          if (!status.configured) throw new Error(t("onboardingKeySaveFailed"));
          setCredential(status);
          localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
          toast.success(t("keySaved"));
        }}
        onComplete={() => setOnboardingOpen(false)}
      />
    ) : null}
    </Tooltip.Provider>
  );
}
