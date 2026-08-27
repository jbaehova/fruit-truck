import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { Field } from "@base-ui/react/field";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  Braces,
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
import { AttemptHistoryPopover } from "@/components/AttemptHistoryPopover";
import { AssetLibrary } from "@/components/AssetLibrary";
import { AssetPreview } from "@/components/AssetPreview";
import { ConfirmDialog, type Confirmation } from "@/components/ConfirmDialog";
import { ExternalLink } from "@/components/ExternalLink";
import { GenerationThreadRail } from "@/components/GenerationThreadRail";
import { GenerationPresetBar } from "@/components/GenerationPresetBar";
import type { GenerationResultNotice } from "@/components/GenerationResultDialog";
import { InputTray } from "@/components/InputTray";
import { ModelSelector } from "@/components/ModelSelector";
import { Onboarding } from "@/components/Onboarding";
import { OptionsFields } from "@/components/OptionsFields";
import { RightPanel } from "@/components/RightPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ShortcutHelpDialog } from "@/components/ShortcutHelpDialog";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import { WorkspaceRecoveryDialog } from "@/components/WorkspaceRecoveryDialog";
import { WorkflowGuide } from "@/components/WorkflowGuide";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast-manager";
import { useI18n, type MessageKey } from "@/i18n";
import { findInputMentions, mentionedInputSlots } from "@/inputMentions";
import { createNativeAppMenu, type NativeAppMenu, type NativeMenuState } from "@/appMenu";
import { applyAlphaMaskBlob, composeEditPrompt, hasGenerationInstructions, renderMaskGuide } from "@/mask";
import {
  assessInputConstraints,
  explainGenerationError,
  modelPolicyNotices,
  validateInputConstraints,
  type InputConstraint,
} from "@/modelPolicies";
import { invoke } from "@tauri-apps/api/core";
import {
  allowedAssetRoles,
  allowedAssetRolesForKind,
  applyImageModelEndpoints,
  cacheVideo,
  cancelOpenRouterRequest,
  catalogFingerprint,
  defaultOptions,
  enhancePrompt,
  formatUsd,
  generateImage,
  generationActualCost,
  generationRecoveryPath,
  getCredentialStatus,
  imageReferenceLimit,
  imageReferenceMinimum,
  hydrateImageModelPricing,
  isTauriRuntime,
  loadModels,
  loadImageModelEndpoints,
  modelPriceLabel,
  pollVideo,
  prettyRequest,
  prepareRequest as prepareOpenRouterRequest,
  preparedRequestPayload,
  referenceCoverageReport,
  resolveEligibleRoute,
  removeApiKey,
  saveApiKey,
  submitVideo,
  validateEnhancedPrompt,
  validateApiKeyCandidate,
  validateCredential,
  validateProviderConfiguration,
  validateReferenceCoverage,
  videoReferenceLimit,
  type CredentialStatus,
  type CredentialValidationStatus,
  type GenerationMode,
  type GenerationModel,
  type ImageModel,
  type ImageModelEndpoint,
  type PromptEnhancementVisual,
  type PreparedRequest,
  type ReferenceAsset,
  type VideoModel,
} from "@/openrouter";
import {
  PROMPT_PLANNER_VERSION,
  defaultReferencePurpose,
  promptProfileForModel,
  promptEnhancementSignature,
  resolvePromptWorkflow,
  type PromptEnhancementArtifact,
  type PromptReferenceInput,
  type PromptTarget,
} from "@/prompting";
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
  loadStudioStateWithRecovery,
  managedDroppedAssets,
  materializeRequestBlob,
  migrateLegacyAsset,
  nextReferenceSlot,
  nextAvailableSessionName,
  pickManagedAssets,
  resolveAssetMaskSource,
  resolveAssetSource,
  saveStudioState,
  activeGenerationAttempt,
  beginGeneratedImageEdit,
  markReferenceAsEditTarget,
  restoreReferenceAfterEditTarget,
  activeVideoJobsFromAttempts,
  effectiveThreadDraft,
  effectiveThreadModelId,
  exportAssetToDownloads,
  optionOverridesFromDefaults,
  preferredCatalogModel,
  applyDefaultEnhancePrompt,
  recordSessionCost,
  reconcileManagedAssetIndex,
  type NativeManagedAsset,
  type GenerationDraftState,
  type GenerationAttempt,
  type GenerationThread,
  type GenerationPreset,
  type SessionAsset,
  type StudioSession,
  type StudioState,
  type StudioStorage,
  STUDIO_LAST_KNOWN_GOOD_KEY,
  STUDIO_STORAGE_KEY,
} from "@/studio";
import { NATIVE_MENU_COMMAND_IDS, commandForKeyboardEvent, type AppCommandId } from "@/shortcuts";
import { activeDurableOperationCount, reconcilePersistedAttempts, sessionDeletionDecision } from "@/attemptRecovery";
import { localizedAttemptAction, localizedAttemptMessage } from "@/attemptPresentation";
import { buildSupportBundle, localDiagnosticLog, serializeSupportBundle } from "@/diagnostics";
import {
  VIDEO_POLL_INTERVAL_MS,
  createResilientPollScheduler,
  hasVideoPollingTimedOut,
  isVideoPollDue,
  videoPollRetryDelayMs,
} from "@/videoPolling";

const SettingsDialog = lazy(() => import("@/components/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const ImageEditPanel = lazy(() => import("@/components/EditMediaPanel").then((module) => ({ default: module.ImageEditPanel })));
const RequestPreviewDialog = lazy(() => import("@/components/RequestPreviewDialog").then((module) => ({ default: module.RequestPreviewDialog })));
const GenerationResultDialog = lazy(() => import("@/components/GenerationResultDialog").then((module) => ({ default: module.GenerationResultDialog })));

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error:\s*/, "").slice(0, 800);
}

function mayHaveReachedPaidEndpoint(error: unknown) {
  const message = errorMessage(error);
  return /(?:timeout|timed out|network|fetch|connection|socket|reset|closed|eof|local (?:request|response) tracking stopped|paid request may|OpenRouter\s+(?:429|5\d\d))/i.test(message);
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

const SESSION_SIDEBAR_OPEN_KEY = "fruit-truck.session-sidebar.open";
const SESSION_SIDEBAR_WIDTH_KEY = "fruit-truck.session-sidebar.width";
const RIGHT_PANEL_OPEN_KEY = "fruit-truck.right-panel.open";
const ONBOARDING_COMPLETE_KEY = "fruit-truck.onboarding.complete.v1";
const DEFAULT_SESSION_SIDEBAR_WIDTH = 256;
const SESSION_BUDGET_KEY = "fruit-truck.session-budget-usd.v1";
const DIAGNOSTIC_LOG = localDiagnosticLog();

type NativeLoadedWorkspace = {
  payload: unknown;
  source: string;
  schemaVersion: number;
  checksum: string;
  recovered: boolean;
};

function memoryStudioStorage(payload?: unknown): StudioStorage {
  const values = new Map<string, string>();
  if (payload !== undefined) values.set(STUDIO_STORAGE_KEY, JSON.stringify(payload));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
  };
}

function persistedStudioPayload(state: StudioState): unknown {
  const storage = memoryStudioStorage();
  saveStudioState(state, { storage });
  const serialized = storage.getItem(STUDIO_STORAGE_KEY);
  if (!serialized) throw new Error("The workspace state could not be serialized.");
  return JSON.parse(serialized) as unknown;
}

type PreparedGenerationRequest = {
  key: string;
  threadId: string;
  artifact: PreparedRequest;
  request: string;
  coverage: ReturnType<typeof referenceCoverageReport>;
  enhancementArtifact?: PromptEnhancementArtifact;
  prompt: string;
  preparedAt: string;
  costLabel: string;
  routeLabel: string;
  privacyLabel: string;
};

function preparationKeyFor(
  session: StudioSession,
  thread: GenerationThread,
  draft: GenerationDraftState,
  model: GenerationModel | null,
) {
  return JSON.stringify({
    sessionId: session.id,
    threadId: thread.id,
    revision: thread.revision,
    model,
    prompt: draft.prompt,
    enhancePrompt: draft.enhancePrompt,
    enhancedPrompt: draft.enhancedPrompt,
    enhancedPromptDirty: draft.enhancedPromptDirty,
    enhancementSignature: draft.enhancementArtifact?.signature,
    enhancementNegativePrompt: draft.enhancementArtifact?.negativePrompt,
    options: draft.options,
    providerJson: draft.providerJson,
    references: draft.references.map((reference) => ({
      ...reference,
      asset: session.assets.find((asset) => asset.id === reference.assetId)
        ? (({ id, fingerprint, byteSize, mimeType, localPath, createdAt }) => ({ id, fingerprint, byteSize, mimeType, localPath, createdAt }))(session.assets.find((asset) => asset.id === reference.assetId)!)
        : null,
    })),
    imageEditMode: draft.imageEditMode,
    imageEditTarget: draft.imageEditTarget,
    maskInstructions: draft.maskInstructions,
    maskStrokes: draft.maskStrokes,
  });
}

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

function promptReferenceInputs(session: StudioSession, draft: GenerationDraftState): PromptReferenceInput[] {
  const assets = new Map(session.assets.map((asset) => [asset.id, asset]));
  return draft.references.flatMap((reference) => {
    const asset = assets.get(reference.assetId);
    return asset ? [{
      slot: reference.slot,
      name: asset.name,
      mediaType: asset.mimeType,
      role: reference.role,
      purpose: reference.purpose,
      fingerprint: asset.fingerprint,
      durationSeconds: asset.duration,
    }] : [];
  });
}

function waitForMediaEvent(media: HTMLMediaElement, event: "loadedmetadata" | "loadeddata" | "seeked", timeoutMs = 12_000) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error(`Timed out waiting for video ${event}.`)), timeoutMs);
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      media.removeEventListener(event, onReady);
      media.removeEventListener("error", onError);
      if (error) reject(error); else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error("The video reference could not be decoded for storyboard analysis."));
    media.addEventListener(event, onReady, { once: true });
    media.addEventListener("error", onError, { once: true });
  });
}

async function sampleVideoStoryboard(source: string): Promise<string[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  const ready = Promise.all([
    waitForMediaEvent(video, "loadedmetadata"),
    waitForMediaEvent(video, "loadeddata"),
  ]);
  video.src = source;
  video.load();
  try {
    await ready;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) return [];
    const width = Math.min(768, video.videoWidth);
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return [];
    const frames: string[] = [];
    for (const ratio of [0.1, 0.5, 0.9]) {
      const seeked = waitForMediaEvent(video, "seeked");
      video.currentTime = Math.min(Math.max(0, video.duration * ratio), Math.max(0, video.duration - 0.01));
      await seeked;
      context.drawImage(video, 0, 0, width, height);
      frames.push(canvas.toDataURL("image/jpeg", 0.82));
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

function enhancementContext(
  session: StudioSession,
  thread: GenerationThread,
  draft: GenerationDraftState,
  targetModel: GenerationModel,
  plannerModel: string,
) {
  const target: PromptTarget = {
    id: targetModel.id,
    name: targetModel.name,
    options: draft.options,
    providerJson: draft.providerJson,
    capabilities: thread.mode === "image"
      ? {
        inputModalities: targetModel.architecture?.input_modalities,
        supportedParameters: (targetModel as ImageModel).supported_parameters,
      }
      : {
        inputModalities: targetModel.architecture?.input_modalities,
        referenceTypes: (targetModel as VideoModel).input_reference_types,
        maxInputReferences: (targetModel as VideoModel).max_input_references,
        frameImages: (targetModel as VideoModel).supported_frame_images,
        durations: (targetModel as VideoModel).supported_durations,
        resolutions: (targetModel as VideoModel).supported_resolutions,
        aspectRatios: (targetModel as VideoModel).supported_aspect_ratios,
        generateAudio: (targetModel as VideoModel).generate_audio,
      },
  };
  const profile = promptProfileForModel(thread.mode, targetModel.id);
  const references = promptReferenceInputs(session, draft);
  const hasMask = thread.mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0;
  const workflow = resolvePromptWorkflow({
    mode: thread.mode,
    editMode: draft.imageEditMode,
    hasMask,
    references,
  });
  const signature = promptEnhancementSignature({
    plannerModel,
    promptVersion: PROMPT_PLANNER_VERSION,
    promptProfile: { id: profile.id, version: profile.version },
    target,
    workflow,
    prompt: draft.prompt,
    maskInstructions: hasMask ? draft.maskInstructions : undefined,
    editTarget: draft.imageEditMode ? draft.imageEditTarget : undefined,
    maskState: hasMask ? draft.maskStrokes : undefined,
    references,
  });
  return { references, hasMask, workflow, signature, target };
}

export default function App() {
  const { language, t } = useI18n();
  const [studio, setStudio] = useState(() => reconcilePersistedAttempts(loadStudioState()).state);
  const [nativeWorkspaceReady, setNativeWorkspaceReady] = useState(() => !isTauriRuntime());
  const [catalogs, setCatalogs] = useState<Record<GenerationMode, GenerationModel[]>>({ image: [], video: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogErrors, setCatalogErrors] = useState<Partial<Record<GenerationMode, string>>>({});
  const [imageEndpoints, setImageEndpoints] = useState<Record<string, ImageModelEndpoint[]>>({});
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [connectionState, setConnectionState] = useState<CredentialValidationStatus | "validating" | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [workflowGuideOpen, setWorkflowGuideOpen] = useState(false);
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
  const [preparedRequest, setPreparedRequest] = useState<PreparedGenerationRequest | null>(null);
  const [preparingRequest, setPreparingRequest] = useState(false);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [sessionBudgetUsd, setSessionBudgetUsd] = useState<number | null>(() => {
    const value = Number(localStorage.getItem(SESSION_BUDGET_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  });
  const [rightPanelOpen, setRightPanelOpen] = useState(() =>
    typeof localStorage === "undefined" || localStorage.getItem(RIGHT_PANEL_OPEN_KEY) !== "false",
  );
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
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
  const quitConfirmationPending = useRef(false);
  const confirmationRef = useRef<Confirmation | null>(null);
  const nativeSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nativeSavePendingRef = useRef(0);
  const nativeSaveErrorRef = useRef<unknown>(undefined);
  const nativeSnapshotSourceRef = useRef<"current" | "bak1" | "bak2">("current");
  const managedReconciliationRanRef = useRef(false);

  const session = studio.sessions.find((item) => item.id === studio.activeSessionId) ?? studio.sessions[0];
  const mode = session.mode;
  const modeThreads = session.threads[mode].filter((item) => !item.archivedAt);
  const thread = modeThreads.find((item) => item.id === session.activeThreadIds[mode]) ?? modeThreads[0];
  const draft = effectiveThreadDraft(session, thread);
  const syncPromptHighlightScroll = useCallback(() => {
    const textarea = promptRef.current;
    const highlight = promptHighlightRef.current;
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);

  useLayoutEffect(() => {
    syncPromptHighlightScroll();
    const frame = requestAnimationFrame(syncPromptHighlightScroll);
    return () => cancelAnimationFrame(frame);
  }, [draft.prompt, syncPromptHighlightScroll]);

  const models = catalogs[mode];
  const selectedId = effectiveThreadModelId(session, thread);
  const selectedModel = models.find((model) => model.id === selectedId) ?? null;
  const roleOptions = useMemo(() => ({
    image: allowedAssetRolesForKind(mode, selectedModel, "image"),
    video: allowedAssetRolesForKind(mode, selectedModel, "video"),
    audio: allowedAssetRolesForKind(mode, selectedModel, "audio"),
  }), [mode, selectedModel]);
  const roles = useMemo(() => [...new Set(Object.values(roleOptions).flat())], [roleOptions]);
  const referenceLimit = mode === "image"
    ? imageReferenceLimit(selectedModel as ImageModel | null)
    : 0;
  const assetMap = useMemo(() => new Map(session.assets.map((asset) => [asset.id, asset])), [session.assets]);
  const currentEnhancementContext = useMemo(() => selectedModel
    ? enhancementContext(session, thread, draft, selectedModel, studio.promptModel)
    : null, [draft, selectedModel, session, studio.promptModel, thread]);
  const policyNotices = useMemo(() => modelPolicyNotices(mode, selectedModel), [mode, selectedModel]);
  const sessionVideoJobs = activeVideoJobsFromAttempts(session);
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
        : `${t("backgroundGenerationFailed", { session: failure.sessionName, thread: failure.threadName })}: ${failure.message}`);
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
    const next = {
      ...studioRef.current,
      sessions: studioRef.current.sessions.map((item) => {
        if (item.id !== id) return item;
        const updated = update(item);
        return { ...updated, updatedAt: new Date().toISOString() };
      }),
    };
    studioRef.current = next;
    setStudio(next);
  }, []);

  const commitStudioNow = useCallback((update: (current: StudioState) => StudioState) => {
    const next = update(studioRef.current);
    studioRef.current = next;
    setStudio(next);
    return next;
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
              ? { ...draftPatch, enhancedVisualCount: 0, enhancementArtifact: undefined }
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

  const recordGenerationCost = useCallback((
    sessionId: string,
    mode: GenerationMode,
    threadId: string | undefined,
    attemptId: string | undefined,
    actualCostUsd: number,
  ) => {
    if (!threadId || !attemptId) return;
    const recordedAt = new Date().toISOString();
    commitStudioNow((current) => ({
      ...current,
      sessions: current.sessions.map((session) => session.id === sessionId ? {
        ...session,
        threads: {
          ...session.threads,
          [mode]: session.threads[mode].map((item) => item.id === threadId ? {
            ...item,
            attempts: item.attempts.map((attempt) => attempt.id === attemptId ? {
              ...attempt,
              actualCostUsd,
              costRecordedAt: recordedAt,
            } : attempt),
          } : item),
        },
        costLedger: recordSessionCost(session, {
          id: `generation:${attemptId}`,
          category: "generation",
          actualCostUsd,
          recordedAt,
        }).costLedger,
      } : session),
    }));
  }, [commitStudioNow]);

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

  const persistWorkspace = useCallback(async (state: StudioState) => {
    if (!isTauriRuntime()) {
      saveStudioState(state);
      nativeSaveErrorRef.current = undefined;
      return;
    }
    if (!nativeWorkspaceReady) throw new Error("The native workspace is still loading.");
    const payload = persistedStudioPayload(state);
    nativeSavePendingRef.current += 1;
    const queued = nativeSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => { await invoke("save_workspace_state", { payload }); });
    const tracked = queued.then(() => {
      nativeSaveErrorRef.current = undefined;
    }, (error) => {
      nativeSaveErrorRef.current = error;
      throw error;
    }).finally(() => {
      nativeSavePendingRef.current = Math.max(0, nativeSavePendingRef.current - 1);
    });
    nativeSaveQueueRef.current = tracked;
    await tracked;
  }, [nativeWorkspaceReady]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void invoke<NativeLoadedWorkspace | null>("load_workspace_state").then((loaded) => {
      if (cancelled) return;
      if (loaded) {
        nativeSnapshotSourceRef.current = loaded.source.endsWith(".bak1")
          ? "bak1"
          : loaded.source.endsWith(".bak2") ? "bak2" : "current";
        const result = loadStudioStateWithRecovery({ storage: memoryStudioStorage(loaded.payload) });
        const reconciled = reconcilePersistedAttempts(result.state).state;
        setStudio(loaded.recovered ? {
          ...reconciled,
          recovery: {
            ...result.recovery,
            kind: "recovered_last_known_good",
            status: "recovered_last_known_good",
            rawStateAvailable: true,
            requiresUserAction: true,
            reason: `The native workspace store recovered from ${loaded.source}. Review it before replacing the primary snapshot.`,
          },
        } : reconciled);
      }
      setNativeWorkspaceReady(true);
    }).catch((error) => {
      if (cancelled) return;
      setStudio((current) => ({
        ...current,
        recovery: {
          kind: "corrupt",
          status: "corrupt",
          targetSchemaVersion: 6,
          rawStateAvailable: true,
          requiresUserAction: true,
          reason: "The native workspace could not be loaded. Its files were retained and automatic saving is paused.",
          error: errorMessage(error),
          attempts: [],
        },
      }));
      setNativeWorkspaceReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || !nativeWorkspaceReady || studio.recovery?.requiresUserAction || managedReconciliationRanRef.current) return;
    managedReconciliationRanRef.current = true;
    void invoke<NativeManagedAsset[]>("scan_managed_assets").then(async (records) => {
      const scanned = await managedDroppedAssets(records);
      const reconciliation = reconcileManagedAssetIndex(studioRef.current, scanned);
      const changed = reconciliation.missingCount + reconciliation.relinkedCount + reconciliation.recoveredCount > 0;
      if (changed) {
        studioRef.current = reconciliation.state;
        setStudio(reconciliation.state);
        await persistWorkspace(reconciliation.state);
        toast.info(t("managedMediaReconciled", {
          missing: reconciliation.missingCount,
          relinked: reconciliation.relinkedCount,
          recovered: reconciliation.recoveredCount,
        }));
      }
      const cleanup = await Promise.allSettled(reconciliation.duplicateFiles.map(deleteManagedAsset));
      for (const outcome of cleanup) {
        if (outcome.status === "rejected") console.warn("Could not clean a duplicate managed file", outcome.reason);
      }
    }).catch((error) => {
      DIAGNOSTIC_LOG.append({ level: "error", event: "managed-media.reconcile", details: { error: errorMessage(error) } });
      toast.error(errorMessage(error));
    });
  }, [nativeWorkspaceReady, persistWorkspace, studio.recovery?.requiresUserAction, t]);

  useEffect(() => {
    if (!nativeWorkspaceReady) return;
    if (studio.recovery?.requiresUserAction) return;
    if (studio.sessions.some((item) => item.assets.some((asset) => asset.externalUrl?.startsWith("data:")))) {
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        void persistWorkspace(studio).catch((error) => {
          toast.error(`Could not save the studio state: ${errorMessage(error)}`);
        });
      } catch (error) {
        toast.error(`Could not save the studio state: ${errorMessage(error)}`);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [nativeWorkspaceReady, persistWorkspace, studio]);

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
    localStorage.setItem(SESSION_SIDEBAR_OPEN_KEY, String(sessionSidebarOpen));
    localStorage.setItem(SESSION_SIDEBAR_WIDTH_KEY, String(Math.round(sessionSidebarWidth)));
  }, [sessionSidebarOpen, sessionSidebarWidth]);

  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_OPEN_KEY, String(rightPanelOpen));
  }, [rightPanelOpen]);

  useEffect(() => {
    if (sessionBudgetUsd == null) localStorage.removeItem(SESSION_BUDGET_KEY);
    else localStorage.setItem(SESSION_BUDGET_KEY, String(sessionBudgetUsd));
  }, [sessionBudgetUsd]);

  const validateSavedCredential = useCallback(async () => {
    setConnectionState("validating");
    const result = await validateCredential();
    setConnectionState(result.status);
    DIAGNOSTIC_LOG.append({
      level: result.status === "connected" ? "info" : result.status === "stored" || result.status === "missing" ? "warn" : "error",
      event: "credential.validation",
      details: { status: result.status, httpStatus: result.httpStatus, retryAfter: result.retryAfter },
    });
    return result;
  }, []);

  const saveAndValidateApiKey = useCallback(async (apiKey: string) => {
    const candidate = await validateApiKeyCandidate(apiKey);
    if (!candidate.valid) {
      DIAGNOSTIC_LOG.append({ level: "warn", event: "credential.candidate_rejected", details: { state: candidate.state, statusCode: candidate.statusCode } });
      throw new Error(candidate.message ?? `OpenRouter API key validation failed (${candidate.state}).`);
    }
    const status = await saveApiKey(apiKey);
    setCredential(status);
    const validation = await validateSavedCredential();
    if (validation.status !== "connected") throw new Error(validation.error ?? validation.status);
    return status;
  }, [validateSavedCredential]);

  useEffect(() => {
    void getCredentialStatus().then(async (status) => {
      setCredential(status);
      setOnboardingOpen(localStorage.getItem(ONBOARDING_COMPLETE_KEY) !== "true" || !status.configured);
      if (status.configured) await validateSavedCredential();
      else setConnectionState("missing");
    }).catch((error) => {
      setOnboardingOpen(false);
      toast.error(errorMessage(error));
    });
  }, [validateSavedCredential]);

  const refreshCatalog = useCallback(async () => {
    if (connectionState !== "connected") return;
    const hydrationRevision = ++catalogHydrationRevision.current;
    setCatalogLoading(true);
    setCatalogError(null);
    setCatalogErrors({});
    setImageEndpoints({});
    const applyCatalog = (catalogMode: GenerationMode, candidates: GenerationModel[]) => {
      const preferred = preferredCatalogModel(catalogMode, candidates);
      setCatalogs((current) => ({ ...current, [catalogMode]: candidates }));
      setStudio((current) => ({
        ...current,
        sessions: current.sessions.map((item) => {
          const existingId = item.generationDefaults.modelIds[catalogMode];
          if (existingId) return item;
          return {
            ...item,
            generationDefaults: {
              ...item.generationDefaults,
              modelIds: { ...item.generationDefaults.modelIds, [catalogMode]: preferred?.id ?? "" },
              options: {
                ...item.generationDefaults.options,
                [catalogMode]: Object.keys(item.generationDefaults.options[catalogMode]).length
                  ? item.generationDefaults.options[catalogMode]
                  : defaultOptions(catalogMode, preferred),
              },
            },
          };
        }),
      }));
      if (catalogMode === "image") {
        void hydrateImageModelPricing(candidates as ImageModel[], (hydrated, endpoints) => {
          if (catalogHydrationRevision.current !== hydrationRevision) return;
          setCatalogs((current) => ({
            ...current,
            image: current.image.map((model) => model.id === hydrated.id ? hydrated : model),
          }));
          setImageEndpoints((current) => ({ ...current, [hydrated.id]: endpoints }));
        });
      }
    };
    const loadMode = async (catalogMode: GenerationMode) => {
      try {
        const candidates: GenerationModel[] = catalogMode === "image"
          ? await loadModels("image")
          : await loadModels("video");
        applyCatalog(catalogMode, candidates);
        setCatalogErrors((current) => {
          const next = { ...current };
          delete next[catalogMode];
          return next;
        });
      } catch (error) {
        const message = errorMessage(error);
        DIAGNOSTIC_LOG.append({ level: "error", event: "catalog.load_failed", details: { mode: catalogMode, error: message } });
        setCatalogErrors((current) => ({ ...current, [catalogMode]: message }));
        throw new Error(`${catalogMode}: ${message}`);
      }
    };
    const outcomes = await Promise.allSettled([loadMode("image"), loadMode("video")]);
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [errorMessage(outcome.reason)] : []);
    setCatalogError(failures.length === outcomes.length ? failures.join(" · ") : null);
    setCatalogLoading(false);
  }, [connectionState]);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  useEffect(() => {
    if (connectionState !== "connected") catalogHydrationRevision.current += 1;
  }, [connectionState]);

  useEffect(() => {
    if (mode !== "image" || !selectedId || imageEndpoints[selectedId] || connectionState !== "connected") return;
    let active = true;
    void loadImageModelEndpoints(selectedId).then((endpoints) => {
      if (active) {
        setImageEndpoints((current) => ({ ...current, [selectedId]: endpoints }));
        setCatalogs((current) => ({
          ...current,
          image: current.image.map((model) => model.id === selectedId
            ? applyImageModelEndpoints(model as ImageModel, endpoints)
            : model),
        }));
      }
    }).catch((error) => {
      if (active) {
        setImageEndpoints((current) => ({ ...current, [selectedId]: [] }));
        toast.error(t("endpointCheckFailed", { error: errorMessage(error) }));
      }
    });
    return () => { active = false; };
  }, [connectionState, imageEndpoints, mode, selectedId, t]);

  const activeVideoJobIds = studio.sessions.flatMap((item) =>
    activeVideoJobsFromAttempts(item)
      .filter((job) => job.status === "pending" || job.status === "in_progress")
      .map((job) => `${item.id}:${job.jobId}`),
  ).sort().join("|");

  useEffect(() => {
    if (connectionState !== "connected") return;
    const activeJobKeys = new Set(activeVideoJobIds.split("|"));
    for (const key of videoPollNotBefore.current.keys()) {
      if (!activeJobKeys.has(key)) videoPollNotBefore.current.delete(key);
    }
    if (!activeVideoJobIds) return;
    const pollActiveJobs = async () => {
      if (polling.current) return;
      const nowMs = Date.now();
      const activeJobs = studioRef.current.sessions.flatMap((item) =>
        activeVideoJobsFromAttempts(item)
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
      const persistPollState = async (sessionId: string, jobId: string) => {
        try {
          await persistWorkspace(studioRef.current);
        } catch (error) {
          DIAGNOSTIC_LOG.append({
            level: "error",
            event: "video.poll_persist_failed",
            details: { sessionId, jobId, error: errorMessage(error) },
          });
        }
      };
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
                };
              });
              await persistPollState(sessionId, job.jobId);
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
              };
            });
          } else if (result.status === "failed" || result.status === "cancelled" || result.status === "expired") {
            videoPollNotBefore.current.set(pollKey, Number.POSITIVE_INFINITY);
            const polledAt = new Date().toISOString();
            const canceled = result.status === "cancelled";
            const rawMessage = result.error ?? (canceled
              ? t("videoGenerationCanceled")
              : result.status === "expired" ? t("videoGenerationExpired") : t("videoGenerationFailed"));
            const explained = canceled ? null : explainGenerationError(rawMessage, { modelId: job.model, language });
            const message = explained?.message ?? rawMessage;
            patchSession(sessionId, (current) => ({
              ...current,
              threads: job.threadId && job.attemptId ? {
                ...current.threads,
                video: current.threads.video.map((item) => item.id === job.threadId ? {
                  ...item,
                  attempts: item.attempts.map((attempt) => attempt.id === job.attemptId ? {
                    ...attempt,
                    status: canceled ? "canceled" : "failed",
                    error: message,
                    errorCode: explained?.code,
                    errorAction: explained?.action,
                    errorDetails: explained?.technical,
                    pollAttempts: (attempt.pollAttempts ?? 0) + 1,
                    lastPolledAt: polledAt,
                    nextPollAt: undefined,
                    completedAt: polledAt,
                    updatedAt: polledAt,
                  } : attempt),
                } : item),
              } : current.threads,
            }));
          } else if (hasVideoPollingTimedOut(job.submittedAt)) {
            videoPollNotBefore.current.set(pollKey, Number.POSITIVE_INFINITY);
            const completedAt = new Date().toISOString();
            const explained = explainGenerationError(t("videoPollingTimedOut"), { modelId: job.model, language });
            const message = explained.message;
            patchSession(sessionId, (current) => ({
              ...current,
              threads: job.threadId && job.attemptId ? {
                ...current.threads,
                video: current.threads.video.map((item) => item.id === job.threadId ? {
                  ...item,
                      attempts: item.attempts.map((attempt) => attempt.id === job.attemptId ? { ...attempt, status: "uncertain", error: message, errorCode: "polling_timeout_recoverable", errorAction: "requery_remote", errorDetails: explained.technical, pollAttempts: (attempt.pollAttempts ?? 0) + 1, lastPolledAt: completedAt, nextPollAt: undefined, completedAt, updatedAt: completedAt } : attempt),
                } : item),
              } : current.threads,
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
          await persistPollState(sessionId, job.jobId);
        } catch (error) {
          const polledAt = new Date().toISOString();
          const timedOut = hasVideoPollingTimedOut(job.submittedAt, Date.parse(polledAt));
          const explained = explainGenerationError(timedOut ? t("videoPollingTimedOut") : error, { modelId: job.model, language });
          const message = explained.message;
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
                  status: timedOut ? "uncertain" : "in_progress",
                  error: message,
                  errorCode: timedOut ? "polling_timeout_recoverable" : explained.code,
                  errorAction: timedOut ? "requery_remote" : explained.action,
                  errorDetails: explained.technical,
                  pollAttempts: (attempt.pollAttempts ?? 0) + 1,
                  lastPolledAt: polledAt,
                  nextPollAt: retryAtMs == null ? undefined : new Date(retryAtMs).toISOString(),
                  completedAt: timedOut ? polledAt : attempt.completedAt,
                  updatedAt: polledAt,
                } : attempt),
              } : item),
            } : current.threads,
          }));
          await persistPollState(sessionId, job.jobId);
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
  }, [activeVideoJobIds, connectionState, language, patchSession, persistWorkspace, recordGenerationCost, t]);

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
        void deleteManagedAsset(candidate).catch((error) => console.warn("Could not clean duplicate managed import", error));
        continue;
      }
      imported.push(candidate);
      resolved.push(candidate);
    }
    if (imported.length) {
      patchSession(currentSession.id, (current) => ({
        ...current,
        assets: [...current.assets, ...imported],
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
        input.accept = "image/*,video/*,audio/*";
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

  const reimportAsset = async (assetId: string) => {
    const targetSessionId = studioRef.current.activeSessionId;
    const currentAsset = studioRef.current.sessions.find((candidate) => candidate.id === targetSessionId)?.assets.find((asset) => asset.id === assetId);
    if (!currentAsset) return;
    let candidates: SessionAsset[] = [];
    if (isTauriRuntime()) {
      candidates = await pickManagedAssets();
    } else {
      candidates = await new Promise<SessionAsset[]>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = `${currentAsset.kind}/*`;
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) resolve([]);
          else void importFileAsset(file).then((asset) => resolve([asset]), (error) => {
            toast.error(errorMessage(error));
            resolve([]);
          });
        };
        input.oncancel = () => resolve([]);
        input.click();
      });
    }
    const compatible = candidates.find((candidate) => candidate.kind === currentAsset.kind);
    const unused = candidates.filter((candidate) => candidate !== compatible);
    await Promise.allSettled(unused.map(deleteManagedAsset));
    if (!compatible) {
      if (candidates.length) toast.error(t("reimportKindMismatch", { kind: t(currentAsset.kind) }));
      return;
    }
    patchSession(targetSessionId, (current) => ({
      ...current,
      assets: current.assets.map((asset) => asset.id === assetId ? {
        ...compatible,
        id: asset.id,
        origin: asset.origin,
        createdAt: asset.createdAt,
        jobId: asset.jobId,
        sourceUrl: asset.sourceUrl,
        sourcePageUrl: asset.sourcePageUrl,
        license: asset.license,
        derivation: asset.derivation,
        storageAvailability: "available",
      } : asset),
    }));
    await persistWorkspace(studioRef.current);
    toast.success(t("reimportAssetComplete", { name: currentAsset.name }));
  };

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlistenAssets = await listen<NativeManagedAsset[]>("managed-assets-imported", (event) => {
        if (!disposed) void managedDroppedAssets(event.payload).then(commitImportedAssets).catch((error) => toast.error(errorMessage(error)));
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
      : studioRef.current.sessions.find((item) => item.id === studioRef.current.activeSessionId) ?? studioRef.current.sessions[0];
    const targetThread = notice
      ? targetSession && [...targetSession.threads.image, ...targetSession.threads.video].find((item) => item.id === notice.threadId)
      : targetSession && targetSession.threads[targetSession.mode].find((item) => item.id === targetSession.activeThreadIds[targetSession.mode]);
    if (!targetSession || !targetThread) return;
    const targetAsset = targetSession.assets.find((item) => item.id === assetId);
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    const targetModelId = effectiveThreadModelId(targetSession, targetThread);
    const targetModel = catalogs[targetThread.mode].find((item) => item.id === targetModelId) ?? null;
    const targetReferenceLimit = targetThread.mode === "image"
      ? imageReferenceLimit(targetModel as ImageModel | null)
      : 0;
    if (!targetAsset) return;
    if (targetDraft.references.some((reference) => reference.assetId === assetId)) {
      toast.info(t("alreadyInput", { name: targetAsset.name }));
      return;
    }
    if (targetDraft.references.length >= targetReferenceLimit) {
      toast.error(t("tooManyInputs", { count: targetReferenceLimit }));
      return;
    }
    const validRoles = allowedAssetRolesForKind(targetThread.mode, targetModel, targetAsset.kind);
    const validRole = validRoles.includes("reference") ? "reference" : validRoles[0] ?? null;
    if (!validRole) {
      toast.error(t("unsupportedAssetInput"));
      return;
    }
    if (!notice) {
      patchDraft({
        references: [...targetDraft.references, {
          assetId,
          role: validRole,
          purpose: defaultReferencePurpose(targetAsset.kind, validRole),
          slot: nextReferenceSlot(targetDraft.references),
        }],
        enhancedPrompt: "",
        enhancedPromptDirty: false,
      });
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
            references: [...item.draft.references, {
              assetId,
              role: validRole,
              purpose: defaultReferencePurpose(targetAsset.kind, validRole),
              slot: nextReferenceSlot(item.draft.references),
            }],
            enhancedPrompt: "",
            enhancedPromptDirty: false,
            enhancedVisualCount: 0,
            enhancementArtifact: undefined,
          },
        } : item),
      },
    }));
    setStudio((current) => ({ ...current, activeSessionId: notice.sessionId }));
  };

  const loadGuideSample = () => void (async () => {
    const existing = session.assets.find((asset) => asset.name === "fruit-truck-workflow-sample.png");
    const sample = existing ?? await importGeneratedImage(
      new URL("/fruit-truck-icon.png", window.location.href).href,
      "fruit-truck-workflow-sample.png",
      "upload",
    );
    if (!existing) commitImportedAssets([sample]);
    addAssetAsReference(sample.id);
    setRightPanelOpen(true);
    focusPrompt();
    toast.success(t("guideSampleLoaded"));
  })().catch((error) => toast.error(errorMessage(error)));

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
              enhancedVisualCount: 0,
              enhancementArtifact: undefined,
              references: existing
                ? imageDraft.references.map((reference) => reference.assetId === assetId
                  ? markReferenceAsEditTarget(reference)
                  : reference.purpose === "edit_target"
                    ? restoreReferenceAfterEditTarget(reference, "image")
                    : reference)
                : [
                  ...imageDraft.references.map((reference) => reference.purpose === "edit_target"
                    ? restoreReferenceAfterEditTarget(reference, "image")
                    : reference),
                  markReferenceAsEditTarget({ assetId, slot, role: "reference", purpose: defaultReferencePurpose("image", "reference") }),
                ],
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
      const currentAssets = new Map(current.assets.map((candidate) => [candidate.id, candidate]));
      const references = currentDraft.references.map((reference) => {
        if (reference.assetId === assetId) return markReferenceAsEditTarget({ ...reference, role });
        if (reference.purpose !== "edit_target") return reference;
        return restoreReferenceAfterEditTarget(reference, currentAssets.get(reference.assetId)?.kind ?? "image");
      });
      if (!references.some((reference) => reference.assetId === assetId)) {
        references.push(markReferenceAsEditTarget({ assetId, slot, role, purpose: defaultReferencePurpose("image", role) }));
      }
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
              enhancedVisualCount: 0,
              enhancementArtifact: undefined,
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

  const routeImageToVideo = (_assetId: string, notice?: GenerationResultNotice) => {
    toast.error(t("videoReferencesUnavailable"));
    if (notice) {
      patchSession(notice.sessionId, (current) => ({ ...current, mode: "video" }));
      setStudio((current) => ({ ...current, activeSessionId: notice.sessionId }));
    } else {
      switchMode("video");
    }
  };

  const selectStageModel = async (targetMode: GenerationMode, id: string) => {
    const model = catalogs[targetMode].find((item) => item.id === id) ?? null;
    if (!model) return;
    const targetThread = session.threads[targetMode].find((item) => item.id === session.activeThreadIds[targetMode])
      ?? session.threads[targetMode][0];
    const priorModelId = effectiveThreadModelId(session, targetThread);
    if (priorModelId === id) return;
    const priorModel = catalogs[targetMode].find((item) => item.id === priorModelId) ?? null;
    const priorDraft = effectiveThreadDraft(session, targetThread);
    const nextDefaults = defaultOptions(targetMode, model);
    const addedDefaults = Object.keys(nextDefaults).filter((key) => priorDraft.options[key] === undefined);
    const accepted = await confirmAction(
      t("changeModelTitle"),
      t("changeModelHint", {
        from: (priorModel?.name ?? priorModelId) || t("unavailableModel"),
        to: model.name,
        price: modelPriceLabel(targetMode, model),
        options: addedDefaults.length ? addedDefaults.join(", ") : t("none"),
      }),
      t("changeModel"),
    );
    if (!accepted) return;
    patchActive((current) => {
      const targetId = current.activeThreadIds[targetMode];
      const createdAt = new Date().toISOString();
      return {
        ...current,
        threads: {
          ...current.threads,
          [targetMode]: current.threads[targetMode].map((item) => item.id === targetId ? {
            ...item,
            modelOverrideId: id,
            optionOverrides: optionOverridesFromDefaults(
              current.generationDefaults.options[targetMode],
              { ...nextDefaults, ...effectiveThreadDraft(current, item).options },
            ),
            revision: item.revision + 1,
            updatedAt: createdAt,
          } : item),
        },
      };
    });
    if (targetMode === mode && model) {
      const incompatibilities: string[] = [];
      if (draft.providerJson.trim()) {
        try { validateProviderConfiguration(draft.providerJson, model); }
        catch (error) { incompatibilities.push(errorMessage(error)); }
      }
      const incompatibleReference = draft.references.find((reference) => {
        const asset = assetMap.get(reference.assetId);
        return !asset || !allowedAssetRolesForKind(targetMode, model, asset.kind).includes(reference.role);
      });
      if (incompatibleReference) incompatibilities.push(t("unsupportedReference", { slot: incompatibleReference.slot }));
      if (incompatibilities.length) {
        toast.error(`Model changed; retained inputs need review. ${incompatibilities.join(" · ")}`);
      }
    }
  };
  const selectModel = (id: string) => { void selectStageModel(mode, id); };

  const switchMode = (next: GenerationMode) => {
    patchActive((current) => ({ ...current, mode: next }));
  };

  const providerError = useMemo(() => {
    if (!draft.providerJson.trim()) return null;
    let value: unknown;
    try {
      value = JSON.parse(draft.providerJson) as unknown;
    } catch {
      return t("invalidJson");
    }
    if (!value || Array.isArray(value) || typeof value !== "object") return t("jsonObjectRequired");
    if (selectedModel) {
      try {
        validateProviderConfiguration(draft.providerJson, selectedModel);
      } catch (error) {
        return errorMessage(error);
      }
    }
    return null;
  }, [draft.providerJson, selectedModel, t]);

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
      byteSize: asset.byteSize,
      role: reference.role,
      purpose: reference.purpose,
      slot: reference.slot,
    }] : [];
  }), [assetMap, draft.imageEditMode, draft.imageEditTarget, draft.maskStrokes.length, draft.references, mode]);

  const hasCurrentEnhancement = Boolean(
    currentEnhancementContext
    && draft.enhancementArtifact?.signature === currentEnhancementContext.signature,
  );
  const displayedEnhancedPrompt = hasCurrentEnhancement ? draft.enhancedPrompt : "";
  const effectivePrompt = draft.enhancePrompt && hasCurrentEnhancement && draft.enhancedPrompt.trim()
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
  const currentPreparationKey = useMemo(
    () => preparationKeyFor(session, thread, draft, selectedModel),
    [draft, selectedModel, session, thread],
  );
  const currentCatalogFingerprint = catalogFingerprint(catalogs[mode]);
  const currentPreparedRequest = preparedRequest?.threadId === thread.id
    && preparedRequest.key === currentPreparationKey
    && preparedRequest.artifact.source.catalogFingerprint === currentCatalogFingerprint
    ? preparedRequest
    : null;
  const previewGenerationDraft = useMemo(() => ({
    mode,
    model: selectedId,
    prompt: preparedPrompt,
    assets: previewReferences,
    options: draft.options,
    providerJson: draft.providerJson,
    editTargetSlot: draft.imageEditMode
      ? Number(draft.imageEditTarget.match(/^@(\d+)$/)?.[1] ?? 0) || undefined
      : undefined,
    negativePrompt: hasCurrentEnhancement ? draft.enhancementArtifact?.negativePrompt : undefined,
  }), [draft.enhancementArtifact?.negativePrompt, draft.imageEditMode, draft.imageEditTarget, draft.options, draft.providerJson, hasCurrentEnhancement, mode, preparedPrompt, previewReferences, selectedId]);
  const draftPreparedRequest = useMemo(() => prepareOpenRouterRequest(previewGenerationDraft, selectedModel, {
    final: false,
    catalogFingerprint: currentCatalogFingerprint,
    sourceSignature: currentPreparationKey,
    planner: {
      requested: draft.enhancePrompt,
      modelId: draft.enhancePrompt ? studio.promptModel : undefined,
      costUsd: hasCurrentEnhancement ? draft.enhancementArtifact?.actualCostUsd : undefined,
    },
  }), [currentCatalogFingerprint, currentPreparationKey, draft.enhancePrompt, draft.enhancementArtifact?.actualCostUsd, hasCurrentEnhancement, previewGenerationDraft, selectedModel, studio.promptModel]);
  const requestPayload = draftPreparedRequest.sanitizedPayload;
  const requestBuildError = null;
  const previewReferencePriorities = hasCurrentEnhancement
    ? draft.enhancementArtifact?.referencePriorities
    : undefined;
  const previewCoverage = useMemo(() => referenceCoverageReport({
    mode,
    model: selectedId,
    prompt: preparedPrompt,
    assets: previewReferences,
    options: draft.options,
    providerJson: draft.providerJson,
    editTargetSlot: draft.imageEditMode
      ? Number(draft.imageEditTarget.match(/^@(\d+)$/)?.[1] ?? 0) || undefined
      : undefined,
    negativePrompt: hasCurrentEnhancement ? draft.enhancementArtifact?.negativePrompt : undefined,
  }, selectedModel, requestPayload, previewReferencePriorities), [draft.enhancementArtifact?.negativePrompt, draft.imageEditMode, draft.imageEditTarget, draft.options, draft.providerJson, hasCurrentEnhancement, mode, preparedPrompt, previewReferencePriorities, previewReferences, requestPayload, selectedId, selectedModel]);

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

  const inputConstraintMessage = useCallback((constraint: InputConstraint | null) => {
    if (!constraint) return null;
    switch (constraint.code) {
      case "unsupported_reference": return t("unsupportedReference", { slot: constraint.slot ?? "?" });
      case "too_many_inputs": return t("tooManyInputs", { count: constraint.limit ?? 0 });
      case "mixed_input_styles": return t("mixedInputStyles");
      case "frame_inputs_ignored": return t("frameInputsIgnored");
      case "duplicate_first_frame": return t("duplicateFirstFrame");
      case "duplicate_last_frame": return t("duplicateLastFrame");
      case "frame_requires_image": return t("frameRequiresImage", { slot: constraint.slot ?? "?" });
      case "audio_requires_visual": return t("audioRequiresVisual");
      case "audio_requires_image": return t("audioRequiresImage");
      case "media_too_large": return t("mediaTooLarge", { slot: constraint.slot ?? "?", size: Math.round((constraint.limit ?? 0) / 1024 / 1024) });
      case "unsupported_media_format": return t("unsupportedMediaFormat", { slot: constraint.slot ?? "?", format: constraint.value ?? "" });
      case "unsupported_media_codec": return t("unsupportedMediaCodec", { slot: constraint.slot ?? "?", codec: constraint.value ?? "" });
      case "dimensions_too_small": return t("dimensionsTooSmall", { slot: constraint.slot ?? "?" });
      case "dimensions_too_large": return t("dimensionsTooLarge", { slot: constraint.slot ?? "?" });
      case "aspect_ratio_unsupported": return t("aspectRatioUnsupported", { slot: constraint.slot ?? "?" });
      case "duration_too_short": return t("durationTooShort", { slot: constraint.slot ?? "?", seconds: constraint.limit ?? 0 });
      case "duration_too_long": return t("durationTooLong", { slot: constraint.slot ?? "?", seconds: constraint.limit ?? 0 });
      case "combined_duration_too_long": return t("combinedDurationTooLong", { seconds: constraint.limit ?? 0 });
      case "fps_too_high": return t("fpsTooHigh", { slot: constraint.slot ?? "?", fps: constraint.limit ?? 0 });
      case "resolution_with_references": return t("resolutionWithReferences", { resolution: constraint.value ?? "720p" });
      case "frames_will_crop": return t("framesWillCrop", { slot: constraint.slot ?? "?" });
      case "real_person_blocked": return t("realPersonBlocked", { slot: constraint.slot ?? "?" });
      case "face_check_unavailable": return t("faceCheckUnavailable");
    }
  }, [t]);

  const inputIssues = useMemo(() => {
    const unsupported = draft.references.find((reference) => {
      const asset = assetMap.get(reference.assetId);
      return !asset || !allowedAssetRolesForKind(mode, selectedModel, asset.kind).includes(reference.role);
    });
    return [
      ...(unsupported ? [{ code: "unsupported_reference" as const, severity: "error" as const, slot: unsupported.slot }] : []),
      ...assessInputConstraints({
      references: draft.references.map((reference) => {
        const asset = assetMap.get(reference.assetId);
        return {
          ...reference,
          kind: asset?.kind ?? "image",
          byteSize: asset?.byteSize,
          width: asset?.width,
          height: asset?.height,
          duration: asset?.duration,
          fps: asset?.fps,
          mimeType: asset?.mimeType,
          codec: asset?.codec,
          facePresence: asset?.facePresence,
        };
      }),
      allowedRoles: roles,
      limit: referenceLimit,
      referenceLimit: mode === "video" ? videoReferenceLimit(selectedModel as VideoModel | null) : referenceLimit,
      mode,
      modelId: selectedModel?.id,
      options: draft.options,
      }),
    ];
  }, [assetMap, draft.options, draft.references, mode, referenceLimit, roles, selectedModel]);
  const inputValidationError = inputConstraintMessage(inputIssues.find((issue) => issue.severity === "error") ?? null);
  const inputWarnings = inputIssues.filter((issue) => issue.severity === "warning").map(inputConstraintMessage).filter(Boolean) as string[];

  const maskReferenceError = useMemo(() => {
    if (mode !== "image" || !draft.imageEditMode || !draft.maskStrokes.length) return null;
    const slots = new Set(draft.references.map((reference) => reference.slot));
    const mentioned = [...draft.maskInstructions.matchAll(/@(\d+)/g)].map((match) => Number(match[1]));
    const missing = mentioned.find((slot) => !slots.has(slot));
    return missing ? t("missingMention", { slot: missing }) : null;
  }, [draft.imageEditMode, draft.maskInstructions, draft.maskStrokes.length, draft.references, mode, t]);

  const generationValidationError = editTargetError
    ?? maskReferenceError
    ?? (mode === "video" && draft.references.length ? t("videoReferencesUnavailable") : null);

  const sessionSpendUsd = session.costLedger.reduce((total, entry) => total + entry.actualCostUsd, 0);
  const transferBytes = draft.references.reduce((total, reference) => total + (assetMap.get(reference.assetId)?.byteSize ?? 0), 0);
  const generationCost = selectedModel ? draftPreparedRequest.cost : undefined;
  const generationEstimate = generationCost?.totalMaxUsd;
  const budgetError = sessionBudgetUsd != null && generationEstimate != null && sessionSpendUsd + generationEstimate > sessionBudgetUsd
    ? t("budgetExceeded", { budget: formatUsd(sessionBudgetUsd), spent: formatUsd(sessionSpendUsd), estimate: formatUsd(generationEstimate) })
    : null;

  const requestPreflightErrors = [
    connectionState !== "connected" ? t(connectionState === "validating" ? "keyValidating" : connectionState === "unauthorized" ? "keyUnauthorized" : connectionState === "rate_limited" ? "keyRateLimited" : connectionState === "offline" || connectionState === "server_error" ? "keyOffline" : connectionState === "missing" ? "apiKeyMissingHint" : "keyStored") : null,
    !selectedModel && selectedId ? t("modelUnavailable") : !selectedModel ? t("chooseModel") : null,
    !hasRunnableInstructions(mode, draft)
      ? mode === "image" && draft.imageEditMode && draft.maskStrokes.length ? t("enterPromptOrMaskInstructions") : t("enterPromptFirst")
      : null,
    providerError,
    requestBuildError,
    ...draftPreparedRequest.issues.map((issue) => issue.message),
    inputValidationError,
    generationValidationError,
    budgetError,
  ].filter((value): value is string => Boolean(value));

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
      if (asset.kind === "video") {
        const videoSource = await resolveAssetSource(asset);
        try {
          const storyboard = await sampleVideoStoryboard(videoSource);
          if (!storyboard.length) throw new Error(`No decodable frames were found in ${asset.name}.`);
          storyboard.forEach((source, index) => visuals.push({
            id: `${asset.id}:storyboard:${index + 1}`,
            kind: "video_frame",
            source,
            slot: reference.slot,
            name: `${asset.name} storyboard ${index + 1}/${storyboard.length}`,
            role: reference.role,
          }));
        } catch (error) {
          throw new Error(`Video @${reference.slot} was not analyzed for prompt enhancement: ${errorMessage(error)}`);
        } finally {
          if (videoSource.startsWith("blob:")) URL.revokeObjectURL(videoSource);
        }
        continue;
      }
      if (asset.kind !== "image") continue;

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
  ): Promise<PromptEnhancementArtifact> => {
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    if (!hasRunnableInstructions(targetThread.mode, targetDraft)) {
      throw new Error(targetThread.mode === "image" && targetDraft.imageEditMode && targetDraft.maskStrokes.length
        ? t("enterPromptOrMaskInstructions")
        : t("enterPromptFirst"));
    }
    if (targetThread.mode === "video" && targetDraft.references.length) throw new Error(t("videoReferencesUnavailable"));
    if (targetThread.enhancementAttempts?.at(-1)?.status === "uncertain" && !await confirmAction(
      t("uncertainEnhancementTitle"),
      t("uncertainEnhancementHint"),
      t("retryPaidEnhancement"),
    )) {
      throw new Error(t("uncertainEnhancementHint"));
    }
    setEnhancingThreadIds((current) => new Set(current).add(targetThread.id));
    let enhancementAttemptId: string | undefined;
    let reportedCostUsd = 0;
    try {
      const targetModelId = effectiveThreadModelId(targetSession, targetThread);
      const targetModel = catalogs[targetThread.mode].find((candidate) => candidate.id === targetModelId) ?? null;
      if (!targetModel) throw new Error("Choose a compatible model before enhancing the prompt.");
      const plannerModel = studioRef.current.promptModel;
      const context = enhancementContext(targetSession, targetThread, targetDraft, targetModel, plannerModel);
      const targetRoute = resolveEligibleRoute({
        mode: targetThread.mode,
        model: targetModel,
        options: targetDraft.options,
        providerJson: targetDraft.providerJson,
      }).selected;
      const visuals = await hydratePromptEnhancementVisuals(targetSession, targetThread, targetDraft);
      enhancementAttemptId = costEntryId.replace(/^prompt-enhancement:/, "") || crypto.randomUUID();
      const startedAt = new Date().toISOString();
      const enhancementState = commitStudioNow((current) => ({
        ...current,
        sessions: current.sessions.map((candidateSession) => candidateSession.id === targetSession.id ? {
          ...candidateSession,
          updatedAt: startedAt,
          threads: {
            ...candidateSession.threads,
            [targetThread.mode]: candidateSession.threads[targetThread.mode].map((item) => item.id === targetThread.id ? {
              ...item,
              enhancementAttempts: [...(item.enhancementAttempts ?? []), {
                id: enhancementAttemptId!,
                requestKey: context.signature,
                status: "in_progress",
                threadRevision: targetThread.revision,
                originalPrompt: targetDraft.prompt,
                createdAt: startedAt,
                updatedAt: startedAt,
              }],
            } : item),
          },
        } : candidateSession),
      }));
      await persistWorkspace(enhancementState);
      const artifact = await enhancePrompt({
        promptModel: plannerModel,
        mode: targetThread.mode,
        target: context.target,
        targetRoute,
        workflow: context.workflow,
        signature: context.signature,
        editMode: targetDraft.imageEditMode,
        editTarget: targetDraft.imageEditTarget,
        prompt: targetDraft.prompt,
        maskInstructions: targetDraft.maskInstructions,
        hasMask: context.hasMask,
        references: context.references,
        visuals,
      }, (actualCostUsd) => { reportedCostUsd = actualCostUsd; });
      const completedAt = new Date().toISOString();
      const actualCostUsd = artifact.actualCostUsd ?? reportedCostUsd;
      const completedState = commitStudioNow((current) => ({
        ...current,
        sessions: current.sessions.map((candidateSession) => {
          if (candidateSession.id !== targetSession.id) return candidateSession;
          const withCost = actualCostUsd > 0 ? recordSessionCost(candidateSession, {
            id: costEntryId,
            category: "prompt_enhancement",
            actualCostUsd,
            recordedAt: completedAt,
          }) : candidateSession;
          return {
            ...withCost,
            updatedAt: completedAt,
            threads: {
              ...withCost.threads,
              [targetThread.mode]: withCost.threads[targetThread.mode].map((item) => item.id === targetThread.id ? {
                ...item,
                draft: item.revision === targetThread.revision ? {
                  ...item.draft,
                  enhancedPrompt: artifact.prompt,
                  enhancedPromptDirty: false,
                  enhancedVisualCount: visuals.length,
                  enhancementArtifact: artifact,
                } : item.draft,
                enhancementAttempts: (item.enhancementAttempts ?? []).map((entry) => entry.id === enhancementAttemptId ? {
                  ...entry,
                  status: "completed",
                  enhancedPrompt: artifact.prompt,
                  actualCostUsd: actualCostUsd || undefined,
                  costRecordedAt: actualCostUsd > 0 ? completedAt : undefined,
                  updatedAt: completedAt,
                } : entry),
                updatedAt: completedAt,
              } : item),
            },
          };
        }),
      }));
      await persistWorkspace(completedState);
      return artifact;
    } catch (error) {
      if (enhancementAttemptId) {
        const failedAt = new Date().toISOString();
        const uncertain = mayHaveReachedPaidEndpoint(error);
        const failedState = commitStudioNow((current) => ({
          ...current,
          sessions: current.sessions.map((candidateSession) => {
            if (candidateSession.id !== targetSession.id) return candidateSession;
            const withCost = reportedCostUsd > 0 ? recordSessionCost(candidateSession, {
              id: costEntryId,
              category: "prompt_enhancement",
              actualCostUsd: reportedCostUsd,
              recordedAt: failedAt,
            }) : candidateSession;
            return {
              ...withCost,
              updatedAt: failedAt,
              threads: {
                ...withCost.threads,
                [targetThread.mode]: withCost.threads[targetThread.mode].map((item) => item.id === targetThread.id ? {
                  ...item,
                  enhancementAttempts: (item.enhancementAttempts ?? []).map((entry) => entry.id === enhancementAttemptId ? {
                    ...entry,
                    status: uncertain ? "uncertain" : "failed",
                    error: errorMessage(error),
                    errorCode: uncertain ? "delivery_uncertain" : "enhancement_failed",
                    errorAction: uncertain ? "Review account activity before retrying." : "Retry from the saved prompt.",
                    actualCostUsd: reportedCostUsd || undefined,
                    costRecordedAt: reportedCostUsd > 0 ? failedAt : undefined,
                    updatedAt: failedAt,
                  } : entry),
                } : item),
              },
            };
          }),
        }));
        await persistWorkspace(failedState).catch(() => undefined);
      }
      throw error;
    } finally {
      setEnhancingThreadIds((current) => {
        const next = new Set(current);
        next.delete(targetThread.id);
        return next;
      });
    }
  };

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
      byteSize: masked ? undefined : asset.byteSize,
      role: reference.role,
      purpose: reference.purpose,
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
    if (targetThread.mode === "video" && targetDraft.references.length) return t("videoReferencesUnavailable");
    if (targetDraft.providerJson.trim()) {
      try {
        const value = JSON.parse(targetDraft.providerJson) as unknown;
        if (!value || Array.isArray(value) || typeof value !== "object") return t("jsonObjectRequired");
        validateProviderConfiguration(targetDraft.providerJson, model);
      } catch (error) {
        try { JSON.parse(targetDraft.providerJson); } catch { return t("invalidJson"); }
        return errorMessage(error);
      }
    }
    const targetRoles = allowedAssetRoles(targetThread.mode, model);
    const targetAssets = new Map(targetSession.assets.map((asset) => [asset.id, asset]));
    const unsupported = targetDraft.references.find((reference) => {
      const asset = targetAssets.get(reference.assetId);
      if (!asset) return true;
      return !allowedAssetRolesForKind(targetThread.mode, model, asset.kind).includes(reference.role);
    });
    if (unsupported) return t("unsupportedReference", { slot: unsupported.slot });
    if (targetThread.mode === "image") {
      const minimum = imageReferenceMinimum(model as ImageModel);
      const imageCount = targetDraft.references.filter((reference) => targetAssets.get(reference.assetId)?.kind === "image").length;
      if (imageCount < minimum) return `This model requires at least ${minimum} image reference${minimum === 1 ? "" : "s"}.`;
    }
    const routeResolution = resolveEligibleRoute({
      mode: targetThread.mode,
      model,
      options: targetDraft.options,
      providerJson: targetDraft.providerJson,
    });
    if (routeResolution.errors.length) return routeResolution.errors[0].message;
    if (!routeResolution.selected) return routeResolution.warnings[0] ?? "No eligible provider endpoint is available.";
    const preflightPrompt = targetThread.mode === "image" && targetDraft.imageEditMode
      ? composeEditPrompt({
        prompt: targetDraft.prompt,
        target: targetDraft.imageEditTarget.trim(),
        hasMask: targetDraft.maskStrokes.length > 0,
        maskInstructions: targetDraft.maskInstructions,
      })
      : targetDraft.prompt.trim();
    const strictPreflight = prepareOpenRouterRequest({
      mode: targetThread.mode,
      model: modelId,
      prompt: preflightPrompt,
      assets: targetDraft.references.flatMap((reference) => {
        const asset = targetAssets.get(reference.assetId);
        return asset ? [{
          id: asset.id,
          name: asset.name,
          mediaType: asset.mimeType,
          dataUrl: `local-asset://#${reference.slot}/${asset.name}`,
          byteSize: asset.byteSize,
          role: reference.role,
          purpose: reference.purpose,
          slot: reference.slot,
        }] : [];
      }),
      options: targetDraft.options,
      providerJson: targetDraft.providerJson,
      editTargetSlot: targetDraft.imageEditMode
        ? Number(targetDraft.imageEditTarget.match(/^@(\d+)$/)?.[1] ?? 0) || undefined
        : undefined,
      negativePrompt: targetDraft.enhancementArtifact?.negativePrompt,
    }, model, {
      final: false,
      route: routeResolution.selected,
      catalogFingerprint: catalogFingerprint(catalogs[targetThread.mode]),
    });
    if (strictPreflight.status !== "ready") return strictPreflight.issues[0]?.message ?? "The request cannot be prepared.";
    const targetLimit = targetThread.mode === "image"
      ? imageReferenceLimit(model as ImageModel)
      : 0;
    return inputConstraintMessage(validateInputConstraints({
      references: targetDraft.references.map((reference) => {
        const asset = targetAssets.get(reference.assetId);
        return { ...reference, kind: asset?.kind ?? "image", byteSize: asset?.byteSize, width: asset?.width, height: asset?.height, duration: asset?.duration, fps: asset?.fps, mimeType: asset?.mimeType, codec: asset?.codec, facePresence: asset?.facePresence };
      }),
      allowedRoles: targetRoles,
      limit: targetLimit,
      referenceLimit: targetThread.mode === "video" ? videoReferenceLimit(model as VideoModel) : targetLimit,
      mode: targetThread.mode,
      modelId: model.id,
      options: targetDraft.options,
    }));
  };

  const prepareRequestForReview = async () => {
    if (preparingRequest) return;
    const targetSession = studioRef.current.sessions.find((item) => item.id === studioRef.current.activeSessionId) ?? studioRef.current.sessions[0];
    const targetThread = [...targetSession.threads.image, ...targetSession.threads.video].find((item) => item.id === thread.id);
    if (!targetThread) return;
    const validationError = validateThreadForRun(targetSession, targetThread);
    if (validationError) {
      toast.error(validationError);
      return;
    }
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    const targetModelId = effectiveThreadModelId(targetSession, targetThread);
    const targetModel = catalogs[targetThread.mode].find((item) => item.id === targetModelId) ?? null;
    if (!targetModel) {
      toast.error(t("modelUnavailable"));
      return;
    }
    setPreparingRequest(true);
    try {
      const targetEnhancementContext = enhancementContext(targetSession, targetThread, targetDraft, targetModel, studioRef.current.promptModel);
      let artifact = targetDraft.enhancementArtifact?.signature === targetEnhancementContext.signature
        ? targetDraft.enhancementArtifact
        : undefined;
      let prompt = targetDraft.prompt.trim();
      if (targetDraft.enhancePrompt) {
        artifact ??= await enhanceThreadPrompt(targetSession, targetThread);
        prompt = targetDraft.enhancedPromptDirty && artifact === targetDraft.enhancementArtifact
          ? targetDraft.enhancedPrompt.trim()
          : artifact.prompt;
        const enhancedError = validateEnhancedPrompt(
          enhancementOriginalIntent(targetThread.mode, targetDraft),
          prompt,
          targetDraft.imageEditMode ? targetDraft.imageEditTarget : undefined,
          targetDraft.references.map((reference) => reference.slot),
          targetDraft.references.map((reference) => reference.slot),
        );
        if (enhancedError) throw new Error(enhancedError);
      }
      const finalPrompt = targetThread.mode === "image" && targetDraft.imageEditMode
        ? composeEditPrompt({ prompt, target: targetDraft.imageEditTarget.trim(), hasMask: targetDraft.maskStrokes.length > 0, maskInstructions: targetDraft.maskInstructions })
        : prompt;
      const hydratedReferences = await hydrateThreadReferences(targetSession, targetThread, targetDraft);
      const generationDraft = {
        mode: targetThread.mode,
        model: targetModelId,
        prompt: finalPrompt,
        assets: hydratedReferences,
        options: targetDraft.options,
        providerJson: targetDraft.providerJson,
        editTargetSlot: targetDraft.imageEditMode
          ? Number(targetDraft.imageEditTarget.match(/^@(\d+)$/)?.[1] ?? 0) || undefined
          : undefined,
        negativePrompt: artifact?.negativePrompt,
      };
      const finalRoute = resolveEligibleRoute({
        mode: targetThread.mode,
        model: targetModel,
        options: targetDraft.options,
        providerJson: targetDraft.providerJson,
      }).selected;
      const finalRequest = prepareOpenRouterRequest(generationDraft, targetModel, {
        final: true,
        route: finalRoute,
        catalogFingerprint: catalogFingerprint(catalogs[targetThread.mode]),
        sourceSignature: preparationKeyFor(targetSession, targetThread, targetDraft, targetModel),
        planner: {
          requested: targetDraft.enhancePrompt,
          modelId: targetDraft.enhancePrompt ? studioRef.current.promptModel : undefined,
          costUsd: artifact?.actualCostUsd,
          // The prompt planner is a separate OpenRouter request and has no
          // hydrated endpoint/privacy contract in this flow.
          inheritsConstraints: !targetDraft.enhancePrompt,
        },
      });
      if (finalRequest.status !== "ready") {
        throw new Error(finalRequest.issues.map((issue) => issue.message).join(" · "));
      }
      const payload = preparedRequestPayload(finalRequest);
      const coverage = referenceCoverageReport(generationDraft, targetModel, payload, artifact?.referencePriorities);
      const coverageError = validateReferenceCoverage(coverage);
      if (coverageError) throw new Error(coverageError);
      const preparedDraft: GenerationDraftState = artifact && artifact !== targetDraft.enhancementArtifact ? {
        ...targetDraft,
        enhancedPrompt: prompt,
        enhancedPromptDirty: false,
        enhancementArtifact: artifact,
      } : targetDraft;
      setPreparedRequest({
        key: preparationKeyFor(targetSession, targetThread, preparedDraft, targetModel),
        threadId: targetThread.id,
        artifact: finalRequest,
        request: prettyRequest(payload),
        coverage,
        enhancementArtifact: artifact,
        prompt: finalPrompt,
        preparedAt: new Date().toISOString(),
        costLabel: finalRequest.cost.label,
        routeLabel: finalRequest.route?.providerName ?? finalRequest.route?.providerSlug ?? targetModel.name,
        privacyLabel: `ZDR: ${finalRequest.privacy.zdr} · data collection: ${finalRequest.privacy.dataCollection}${finalRequest.privacy.plannerSeparate ? " · planner route separate" : ""}${finalRequest.privacy.warning ? ` · ${finalRequest.privacy.warning}` : ""}`,
      });
      toast.success(t("requestFinal"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPreparingRequest(false);
    }
  };

  const runEnhancement = async () => {
    const validationError = validateThreadForRun(session, thread);
    if (validationError) throw new Error(validationError);
    return enhanceThreadPrompt(session, thread);
  };

  const patchAttempt = (sessionId: string, mode: GenerationMode, threadId: string, attemptId: string, patch: Partial<GenerationAttempt>) => {
    if (patch.status || patch.errorCode || patch.error) {
      DIAGNOSTIC_LOG.append({
        level: patch.status === "completed" ? "info" : patch.status === "failed" || patch.status === "uncertain" ? "error" : "debug",
        event: "generation.attempt_transition",
        details: { sessionId, threadId, attemptId, mode, status: patch.status, errorCode: patch.errorCode, errorPresent: Boolean(patch.error) },
      });
    }
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

  const runGenerationThread = async (threadId: string) => {
    const targetSession = studioRef.current.sessions.find((item) => item.id === studioRef.current.activeSessionId) ?? studioRef.current.sessions[0];
    const targetThread = [...targetSession.threads.image, ...targetSession.threads.video].find((item) => item.id === threadId);
    if (!targetThread) return;
    if (connectionState !== "connected") { setSettingsOpen(true); return; }
    const validationError = validateThreadForRun(targetSession, targetThread);
    if (validationError) throw new Error(validationError);
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    const targetModelId = effectiveThreadModelId(targetSession, targetThread);
    const targetModel = catalogs[targetThread.mode].find((item) => item.id === targetModelId) ?? null;
    if (!targetModel) throw new Error("Choose a compatible model.");
    const targetPreparationKey = preparationKeyFor(targetSession, targetThread, targetDraft, targetModel);
    const reviewedRequest = preparedRequest?.threadId === targetThread.id && preparedRequest.key === targetPreparationKey
      && preparedRequest.artifact.source.catalogFingerprint === catalogFingerprint(catalogs[targetThread.mode])
      ? preparedRequest
      : null;
    if (!reviewedRequest) {
      setPreparedRequest(null);
      toast.error(t("requestNeedsPreparation"));
      return;
    }
    const reviewedEstimate = reviewedRequest.artifact.cost.totalMaxUsd;
    if (reviewedEstimate != null && reviewedEstimate >= 1 && !await confirmAction(
      t("highCostTitle"),
      t("highCostHint", { cost: formatUsd(reviewedEstimate) }),
      t("confirmGeneration"),
    )) return;
    const attemptId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const attempt: GenerationAttempt = {
      id: attemptId,
      status: "submitting",
      draftRevision: targetThread.revision,
      createdAt,
      updatedAt: createdAt,
      modelId: targetModelId,
      estimatedCostUsd: reviewedRequest.artifact.cost.totalMaxUsd ?? undefined,
      snapshot: {
        mode: targetThread.mode,
        modelId: targetModelId,
        prompt: targetDraft.prompt,
        enhancePrompt: targetDraft.enhancePrompt,
        enhancedPrompt: reviewedRequest.enhancementArtifact ? targetDraft.enhancedPrompt : "",
        enhancementArtifact: reviewedRequest.enhancementArtifact,
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
      request: JSON.parse(reviewedRequest.request) as Record<string, unknown>,
    };
    const submissionStudio: StudioState = {
      ...studioRef.current,
      sessions: studioRef.current.sessions.map((current) => current.id === targetSession.id ? {
        ...current,
        updatedAt: createdAt,
        threads: {
          ...current.threads,
          [targetThread.mode]: current.threads[targetThread.mode].map((item) => item.id === targetThread.id ? { ...item, attempts: [...item.attempts, attempt], updatedAt: createdAt } : item),
        },
      } : current),
    };
    studioRef.current = submissionStudio;
    setStudio(submissionStudio);
    setPreparedRequest(null);
    setExecutingThreadIds((current) => new Set(current).add(targetThread.id));
    try {
      // A paid POST is never dispatched until its exact snapshot and attempt
      // identity have reached both local and native durable storage.
      await persistWorkspace(submissionStudio);
      const currentAttemptStatus = studioRef.current.sessions
        .find((item) => item.id === targetSession.id)?.threads[targetThread.mode]
        .find((item) => item.id === targetThread.id)?.attempts
        .find((item) => item.id === attemptId)?.status;
      if (currentAttemptStatus === "canceled") return;
      const payload = preparedRequestPayload(reviewedRequest.artifact);
      const referenceCoverage = reviewedRequest.coverage;
      patchAttempt(targetSession.id, targetThread.mode, targetThread.id, attemptId, {
        request: JSON.parse(reviewedRequest.request) as Record<string, unknown>,
        submittedAt: new Date().toISOString(),
        snapshot: attempt.snapshot ? {
          ...attempt.snapshot,
          enhancedPrompt: reviewedRequest.enhancementArtifact ? targetDraft.enhancedPrompt : "",
          enhancementArtifact: reviewedRequest.enhancementArtifact,
          referenceCoverage,
        } : undefined,
      });
      if (targetThread.mode === "image") {
        const result = await generateImage(payload, (actualCostUsd) => {
          recordGenerationCost(targetSession.id, "image", targetThread.id, attemptId, actualCostUsd);
        }, {
          requestId: attemptId,
          onProgress: (progress) => {
            const percentage = progress.stage === "completed"
              ? 95
              : progress.stage === "partial_image"
                ? Math.min(90, 25 + (progress.partialImageIndex ?? 0) * 10)
                : 10;
            patchAttempt(targetSession.id, "image", targetThread.id, attemptId, {
              status: "in_progress",
              progress: percentage,
            });
          },
        });
        const responseCapturedAt = new Date().toISOString();
        const paidResponseState = commitStudioNow((current) => ({
          ...current,
          sessions: current.sessions.map((candidateSession) => candidateSession.id === targetSession.id ? {
            ...candidateSession,
            updatedAt: responseCapturedAt,
            threads: {
              ...candidateSession.threads,
              image: candidateSession.threads.image.map((candidateThread) => candidateThread.id === targetThread.id ? {
                ...candidateThread,
                updatedAt: responseCapturedAt,
                attempts: candidateThread.attempts.map((entry) => entry.id === attemptId ? {
                  ...entry,
                  resultSources: [...result.urls],
                  recoveryPath: result.recoveryPath,
                  actualCostUsd: result.actualCostUsd ?? entry.actualCostUsd,
                  updatedAt: responseCapturedAt,
                } : entry),
              } : candidateThread),
            },
          } : candidateSession),
        }));
        await persistWorkspace(paidResponseState);
        const materialized = await Promise.allSettled(result.urls.map((url, index) =>
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
        const generated = materialized.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
        const materializationErrors = [
          ...result.materializationErrors,
          ...materialized.flatMap((outcome) => outcome.status === "rejected" ? [errorMessage(outcome.reason)] : []),
          ...(result.recoveryPath ? [`Recovery payload retained at ${result.recoveryPath}.`] : []),
        ];
        if (!generated.length) {
          throw new Error(`The provider returned ${result.urls.length} paid result(s), but none could be materialized. ${materializationErrors.join(" · ")}`);
        }
        patchSession(targetSession.id, (current) => {
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
                  progress: 100,
                  assetIds: generated.map((asset) => asset.id),
                  error: materializationErrors.length
                    ? `${generated.length}/${result.urls.length} results were preserved. ${materializationErrors.join(" · ")}`
                    : undefined,
                  errorCode: materializationErrors.length ? "partial_result" : undefined,
                  actualCostUsd: result.actualCostUsd,
                  costRecordedAt: result.actualCostUsd != null ? new Date().toISOString() : entry.costRecordedAt,
                  completedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                } : entry),
              } : item),
            },
          };
        });
        // The paid result, imported assets, terminal status, and cost ledger
        // must all be durable before this generation task is released.
        try {
          await persistWorkspace(studioRef.current);
        } catch (persistenceError) {
          DIAGNOSTIC_LOG.append({
            level: "error",
            event: "generation.completion_persist_failed",
            details: { sessionId: targetSession.id, threadId: targetThread.id, attemptId, mode: targetThread.mode, error: errorMessage(persistenceError) },
          });
          toast.error(`The result was preserved, but its completed state could not be saved: ${errorMessage(persistenceError)}`);
        }
      } else {
        const result = await submitVideo(payload, (actualCostUsd) => {
          recordGenerationCost(targetSession.id, "video", targetThread.id, attemptId, actualCostUsd);
        });
        const remoteTerminal = result.status === "failed" || result.status === "expired" || result.status === "cancelled";
        const jobCapturedAt = new Date().toISOString();
        const jobState = commitStudioNow((current) => ({
          ...current,
          sessions: current.sessions.map((candidateSession) => candidateSession.id === targetSession.id ? {
            ...candidateSession,
            updatedAt: jobCapturedAt,
            threads: {
              ...candidateSession.threads,
              video: candidateSession.threads.video.map((candidateThread) => candidateThread.id === targetThread.id ? {
                ...candidateThread,
                updatedAt: jobCapturedAt,
                attempts: candidateThread.attempts.map((entry) => entry.id === attemptId ? {
                  ...entry,
                  status: result.status === "cancelled" ? "canceled" : remoteTerminal ? "failed" : "in_progress",
                  jobId: result.jobId,
                  progress: result.progress,
                  actualCostUsd: result.actualCostUsd,
                  costRecordedAt: result.actualCostUsd != null ? jobCapturedAt : entry.costRecordedAt,
                  request: JSON.parse(prettyRequest(payload)) as Record<string, unknown>,
                  submittedAt: jobCapturedAt,
                  ...(remoteTerminal ? { completedAt: jobCapturedAt, error: result.error ?? `Video generation ${result.status}.` } : {}),
                  updatedAt: jobCapturedAt,
                } : entry),
              } : candidateThread),
            },
          } : candidateSession),
        }));
        await persistWorkspace(jobState);
        if (remoteTerminal) throw new Error(result.error ?? `Video generation ${result.status}.`);
      }
    } catch (error) {
      const currentAttempt = studioRef.current.sessions
        .find((item) => item.id === targetSession.id)?.threads[targetThread.mode]
        .find((item) => item.id === targetThread.id)?.attempts
        .find((item) => item.id === attemptId);
      if (currentAttempt?.errorCode === "local_transfer_stopped") {
        await persistWorkspace(studioRef.current).catch((persistenceError) => {
          toast.error(`Could not durably save the stopped request: ${errorMessage(persistenceError)}`);
        });
        return;
      }
      const explained = explainGenerationError(error, { modelId: targetModelId, language });
      const recoveryPath = generationRecoveryPath(error);
      const errorActualCostUsd = generationActualCost(error);
      // A retained native response proves the paid endpoint answered, but its
      // usage field may not yet be readable. Preserve that as billing-uncertain
      // unless parsing already attached a definitive provider cost.
      const uncertain = mayHaveReachedPaidEndpoint(error)
        || Boolean(recoveryPath && errorActualCostUsd == null);
      patchAttempt(targetSession.id, targetThread.mode, targetThread.id, attemptId, {
        status: uncertain ? "uncertain" : "failed",
        error: explained.message,
        errorCode: explained.code,
        errorAction: explained.action,
        errorDetails: explained.technical,
        ...(recoveryPath ? { recoveryPath } : {}),
        ...(errorActualCostUsd != null ? {
          actualCostUsd: errorActualCostUsd,
          costRecordedAt: new Date().toISOString(),
        } : {}),
        completedAt: new Date().toISOString(),
      });
      try {
        await persistWorkspace(studioRef.current);
      } catch (persistenceError) {
        DIAGNOSTIC_LOG.append({
          level: "error",
          event: "generation.attempt_persist_failed",
          details: { sessionId: targetSession.id, threadId: targetThread.id, attemptId, mode: targetThread.mode, error: errorMessage(persistenceError) },
        });
        toast.error(`Could not durably save the failed generation attempt: ${errorMessage(persistenceError)}`);
      }
    } finally {
      setExecutingThreadIds((current) => {
        const next = new Set(current);
        next.delete(targetThread.id);
        return next;
      });
    }
  };

  const runGeneration = () => runGenerationThread(thread.id);

  const cancelAttemptTracking = (attempt: GenerationAttempt) => void (async () => {
    const canceledAt = new Date().toISOString();
    if (!attempt.jobId && thread.mode === "image" && ["submitting", "in_progress"].includes(attempt.status)) {
      const stopped = await cancelOpenRouterRequest(attempt.id).catch((error) => {
        toast.error(errorMessage(error));
        return false;
      });
      if (!stopped) return;
      patchAttempt(session.id, thread.mode, thread.id, attempt.id, {
        status: "uncertain",
        error: t("localPaidTrackingStopped"),
        errorCode: "local_transfer_stopped",
        errorAction: "avoid_duplicate_retry",
        cancelRequestedAt: canceledAt,
        completedAt: canceledAt,
      });
      await persistWorkspace(studioRef.current).catch((error) => toast.error(errorMessage(error)));
      return;
    }
    patchAttempt(session.id, thread.mode, thread.id, attempt.id, {
      status: "canceled",
      error: attempt.jobId
        ? t("localTrackingStopped")
        : t("localOperationReleased"),
      errorCode: "local_cancelled",
      errorAction: attempt.jobId ? "requery_remote_status" : undefined,
      cancelRequestedAt: canceledAt,
      completedAt: canceledAt,
    });
    await persistWorkspace(studioRef.current).catch((error) => toast.error(errorMessage(error)));
  })();

  const restoreAttemptSnapshot = (attempt: GenerationAttempt) => {
    const snapshot = attempt.snapshot;
    if (!snapshot) return;
    patchActive((current) => ({
      ...current,
      mode: snapshot.mode,
      activeThreadIds: { ...current.activeThreadIds, [snapshot.mode]: thread.id },
      threads: {
        ...current.threads,
        [snapshot.mode]: current.threads[snapshot.mode].map((item) => item.id === thread.id ? {
          ...item,
          modelOverrideId: snapshot.modelId,
          optionOverrides: optionOverridesFromDefaults(current.generationDefaults.options[snapshot.mode], snapshot.options),
          providerJsonOverride: snapshot.providerJson,
          draft: {
            ...item.draft,
            prompt: snapshot.prompt,
            enhancePrompt: snapshot.enhancePrompt,
            enhancedPrompt: snapshot.enhancedPrompt,
            enhancedPromptDirty: false,
            enhancementArtifact: snapshot.enhancementArtifact,
            references: snapshot.assetBindings.map((binding) => ({ ...binding })),
            imageEditMode: snapshot.imageEditMode,
            imageEditTarget: snapshot.imageEditTarget,
            maskInstructions: snapshot.maskInstructions,
            maskStrokes: structuredClone(snapshot.maskStrokes),
          },
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
        } : item),
      },
    }));
    setPreparedRequest(null);
    toast.success(t("restoreAttempt"));
  };

  const duplicateAttemptSnapshot = (attempt: GenerationAttempt) => {
    const snapshot = attempt.snapshot;
    if (!snapshot) return;
    patchActive((current) => {
      const source = current.threads[snapshot.mode].find((item) => item.id === thread.id);
      if (!source) return current;
      const createdAt = new Date().toISOString();
      const copy: GenerationThread = {
        ...structuredClone(source),
        id: crypto.randomUUID(),
        name: `${source.name} · ${t("attemptCopySuffix")}`,
        mode: snapshot.mode,
        createdAt,
        updatedAt: createdAt,
        archivedAt: undefined,
        revision: 0,
        attempts: [],
        modelOverrideId: snapshot.modelId,
        optionOverrides: optionOverridesFromDefaults(current.generationDefaults.options[snapshot.mode], snapshot.options),
        providerJsonOverride: snapshot.providerJson,
        draft: {
          ...source.draft,
          prompt: snapshot.prompt,
          enhancePrompt: snapshot.enhancePrompt,
          enhancedPrompt: snapshot.enhancedPrompt,
          enhancedPromptDirty: false,
          enhancementArtifact: snapshot.enhancementArtifact,
          references: snapshot.assetBindings.map((binding) => ({ ...binding })),
          imageEditMode: snapshot.imageEditMode,
          imageEditTarget: snapshot.imageEditTarget,
          maskInstructions: snapshot.maskInstructions,
          maskStrokes: structuredClone(snapshot.maskStrokes),
        },
      };
      return {
        ...current,
        mode: snapshot.mode,
        threads: { ...current.threads, [snapshot.mode]: [...current.threads[snapshot.mode], copy] },
        activeThreadIds: { ...current.activeThreadIds, [snapshot.mode]: copy.id },
      };
    });
    setPreparedRequest(null);
    toast.success(t("attemptDuplicated"));
  };

  const recheckAttemptStatus = (attempt: GenerationAttempt) => {
    if (!attempt.jobId) return;
    videoPollNotBefore.current.set(`${session.id}:${attempt.jobId}`, 0);
    patchAttempt(session.id, "video", thread.id, attempt.id, {
      status: "in_progress",
      nextPollAt: new Date(0).toISOString(),
      completedAt: undefined,
    });
    window.dispatchEvent(new Event("online"));
  };

  const repairAttemptInputs = (attempt: GenerationAttempt) => {
    restoreAttemptSnapshot(attempt);
    setRightPanelOpen(true);
    toast.info(t("repairMissingInputsHint"));
  };

  const recoverAttemptResults = async (attempt: GenerationAttempt) => {
    if (attempt.jobId) {
      recheckAttemptStatus(attempt);
      return;
    }
    const sources = attempt.resultSources ?? [];
    if (!sources.length) {
      toast.error(t("noRecoverableResultSource"));
      return;
    }
    const recovered = await Promise.allSettled(sources.map((source, index) => importGeneratedImage(
      source,
      `recovered-${attempt.id}-${index + 1}.png`,
      "generated",
    )));
    const assets = recovered.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!assets.length) {
      toast.error(t("resultRecoveryFailed"));
      return;
    }
    patchActive((current) => ({
      ...current,
      assets: [...current.assets, ...assets],
      threads: {
        ...current.threads,
        [thread.mode]: current.threads[thread.mode].map((candidate) => candidate.id === thread.id ? {
          ...candidate,
          attempts: candidate.attempts.map((entry) => entry.id === attempt.id ? {
            ...entry,
            status: "completed",
            assetIds: assets.map((asset) => asset.id),
            completedAt: new Date().toISOString(),
          } : entry),
        } : candidate),
      },
    }));
    await persistWorkspace(studioRef.current);
    toast.success(t("resultRecovered", { count: assets.length }));
  };

  const activateThread = (id: string) => {
    patchActive((current) => ({ ...current, activeThreadIds: { ...current.activeThreadIds, [current.mode]: id } }));
  };

  const createThread = useCallback(() => {
    patchActive((current) => {
      const active = current.threads[current.mode].find((item) => item.id === current.activeThreadIds[current.mode]);
      if (!active) return current;
      const next = createSiblingGenerationThread(active, current.threads[current.mode].length + 1, studioRef.current.defaultEnhancePrompt);
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
        draft: { ...source.draft, enhancePrompt: studioRef.current.defaultEnhancePrompt },
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
        await persistWorkspace(studioRef.current);
        await invoke("quit_app");
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      quitConfirmationPending.current = false;
    }
  })(), [confirmAction, persistWorkspace, t]);

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

  const saveGenerationPreset = (name: string): string => {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const preset: GenerationPreset = {
      id,
      name,
      mode,
      modelId: selectedId,
      options: structuredClone(draft.options),
      providerJson: draft.providerJson,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const next = commitStudioNow((current) => ({
      ...current,
      generationPresets: [...(current.generationPresets ?? []), preset],
    }));
    void persistWorkspace(next).catch((error) => toast.error(errorMessage(error)));
    toast.success(t("presetSaved", { name }));
    return id;
  };

  const applyGenerationPreset = (preset: GenerationPreset) => void (async () => {
    const presetModel = catalogs[preset.mode].find((model) => model.id === preset.modelId);
    if (!presetModel) {
      toast.error(t("presetModelUnavailable", { model: preset.modelId }));
      return;
    }
    if (preset.modelId !== selectedId && !await confirmAction(
      t("applyPresetModelTitle"),
      t("applyPresetModelHint", { current: selectedModel?.name ?? selectedId, next: presetModel.name, price: modelPriceLabel(preset.mode, presetModel) }),
      t("applyPreset"),
    )) return;
    patchActive((current) => ({
      ...current,
      threads: {
        ...current.threads,
        [preset.mode]: current.threads[preset.mode].map((item) => item.id === current.activeThreadIds[preset.mode] ? {
          ...item,
          modelOverrideId: preset.modelId === current.generationDefaults.modelIds[preset.mode] ? undefined : preset.modelId,
          optionOverrides: optionOverridesFromDefaults(current.generationDefaults.options[preset.mode], preset.options),
          providerJsonOverride: preset.providerJson === current.generationDefaults.providerJson[preset.mode] ? undefined : preset.providerJson,
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
        } : item),
      },
    }));
    await persistWorkspace(studioRef.current).catch((error) => toast.error(errorMessage(error)));
    toast.success(t("presetApplied", { name: preset.name }));
  })();

  const deleteGenerationPreset = (id: string) => {
    const next = commitStudioNow((current) => ({
      ...current,
      generationPresets: (current.generationPresets ?? []).filter((preset) => preset.id !== id),
    }));
    void persistWorkspace(next).catch((error) => toast.error(errorMessage(error)));
  };

  const deleteAssets = async (ids: string[]) => {
    const deleting = session.assets.filter((asset) => ids.includes(asset.id));
    const inUse = [...session.threads.image, ...session.threads.video].some((item) =>
      item.draft.references.some((reference) => ids.includes(reference.assetId)),
    );
    if (!deleting.length || !await confirmAction(
      inUse ? t("deleteAttachedAssets") : t("deleteAssetsTitle"),
      `${inUse ? t("deleteAttachedAssetsHint") : t("deleteAssetsHint")}\n\n${deleting.length}: ${deleting.map((asset) => `${asset.name} (${asset.kind})`).join(", ")}`,
      t("deleteAssets"),
    )) return;
    const outcomes = await Promise.allSettled(deleting.map(deleteManagedAsset));
    const deletedIds = outcomes.flatMap((outcome, index) => outcome.status === "fulfilled" ? [deleting[index].id] : []);
    const failures = outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [`${deleting[index].name}: ${errorMessage(outcome.reason)}`] : []);
    if (!deletedIds.length) {
      toast.error(t("deleteLocalAssetsFailed", { error: failures.join(" · ") }));
      return;
    }
    patchActive((current) => ({
      ...current,
      assets: current.assets.filter((asset) => !deletedIds.includes(asset.id)),
      threads: {
        image: current.threads.image.map((item) => ({
          ...item,
          draft: { ...item.draft, references: item.draft.references.filter((reference) => !deletedIds.includes(reference.assetId)) },
        })),
        video: current.threads.video.map((item) => ({
          ...item,
          draft: { ...item.draft, references: item.draft.references.filter((reference) => !deletedIds.includes(reference.assetId)) },
        })),
      },
    }));
    await persistWorkspace(studioRef.current).catch((error) => toast.error(errorMessage(error)));
    setSelectedAssetIds(new Set());
    if (failures.length) toast.error(t("someAssetDeletesFailed", { error: failures.join(" · ") }));
  };

  const mentionMatch = draft.prompt.match(/(?:^|\s)@(\d*)$/);
  const mentionSuggestions = mentionMenuOpen && mentionMatch
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
  const hasMask = mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0;
  const canPrepareRequest = Boolean(selectedModel && draftPreparedRequest.status === "ready" && hasRunnableInstructions(mode, draft) && !providerError && !requestBuildError && !inputValidationError && !generationValidationError && !budgetError && connectionState === "connected" && !generating && !enhancing && !activeAttempt);
  const canGenerate = Boolean(canPrepareRequest && currentPreparedRequest && !preparingRequest);
  const generationBlocker = requestPreflightErrors[0]
    ?? (activeAttempt ? (activeAttempt.error ?? t("activeGenerations", { count: 1 })) : null)
    ?? (preparingRequest ? t("preparingRequest") : null)
    ?? (!currentPreparedRequest ? (preparedRequest ? t("requestOutdated") : t("requestNeedsPreparation")) : null);
  const revealProviderOptions = () => {
    const toggle = document.querySelector<HTMLElement>(".advanced-toggle");
    if (toggle && !toggle.classList.contains("open")) toggle.click();
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".provider-options-field textarea")?.focus());
  };
  const generationRecoveryAction = canPrepareRequest && !currentPreparedRequest
    ? { label: t("prepareRequest"), run: () => void prepareRequestForReview(), icon: <Braces /> }
    : connectionState !== "connected"
      ? { label: t("settings"), run: () => setSettingsOpen(true), icon: <Settings /> }
      : !selectedModel
        ? { label: t("chooseModel"), run: () => document.querySelector<HTMLElement>(".model-selector-trigger")?.click(), icon: <ImageIcon /> }
        : !hasRunnableInstructions(mode, draft)
          ? { label: t("prompt"), run: () => focusPrompt(), icon: <Sparkles /> }
          : providerError || requestBuildError
            ? { label: t("reviewProviderOptions"), run: revealProviderOptions, icon: <Settings /> }
            : inputValidationError || generationValidationError
              ? { label: t("reviewInputs"), run: () => setRightPanelOpen(true), icon: <ImageIcon /> }
              : budgetError
                ? { label: t("adjustBudget"), run: () => setSettingsOpen(true), icon: <Settings /> }
                : draftPreparedRequest.issues.length
                  ? { label: t("chooseModel"), run: () => document.querySelector<HTMLElement>(".model-selector-trigger")?.click(), icon: <ImageIcon /> }
          : activeAttempt
            ? { label: t("attemptHistory"), run: () => document.querySelector<HTMLElement>(".attempt-history-trigger")?.click(), icon: <RefreshCw /> }
            : null;
  const latestAttempt = thread.attempts.at(-1);
  const latestGenerationFailure = latestAttempt && (latestAttempt.status === "failed" || latestAttempt.status === "uncertain") && latestAttempt.error
    ? latestAttempt
    : null;
  const policyTitle = (code: (typeof policyNotices)[number]["code"]) => t(({
    seedance_real_person: "seedancePersonPolicyTitle",
    veo_person_generation: "veoPersonPolicyTitle",
    sora_person_policy: "soraPersonPolicyTitle",
    sora_deprecation: "soraDeprecationTitle",
    runway_moderation: "runwayModerationTitle",
    video_retention: "videoRetentionTitle",
  } satisfies Record<(typeof policyNotices)[number]["code"], MessageKey>)[code]);
  const policyMessage = (code: (typeof policyNotices)[number]["code"]) => t(({
    seedance_real_person: "seedancePersonPolicyMessage",
    veo_person_generation: "veoPersonPolicyMessage",
    sora_person_policy: "soraPersonPolicyMessage",
    sora_deprecation: "soraDeprecationMessage",
    runway_moderation: "runwayModerationMessage",
    video_retention: "videoRetentionMessage",
  } satisfies Record<(typeof policyNotices)[number]["code"], MessageKey>)[code]);
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
  };
  const createNewSession = () => {
    setStudio((current) => {
      const created = initializeSessionCatalogDefaults(
        createSession(nextAvailableSessionName(
          current.sessions,
          (count) => t("newSessionName", { count }),
        ), current.defaultEnhancePrompt),
        catalogs,
      );
      return { ...current, activeSessionId: created.id, sessions: [...current.sessions, created] };
    });
  };
  const deleteStudioSession = (id: string) => void (async () => {
    const deleting = studio.sessions.find((item) => item.id === id);
    if (!deleting || studio.sessions.length === 1) return;
    const deletionDecision = sessionDeletionDecision(deleting);
    if (!deletionDecision.allowed) {
      toast.error(t("activeSessionDeleteBlocked", { count: deletionDecision.blockingJobs.length }));
      return;
    }
    if (!await confirmAction(
      t("deleteSessionTitle", { name: deleting.name }),
      t("deleteSessionHint"),
      t("deleteSession"),
    )) return;
    const deletion = await deleteSessionBlobs(deleting);
    if (deletion.failures.length) {
      const deleted = new Set(deletion.deletedIds);
      patchSession(id, (current) => ({
        ...current,
        assets: current.assets.filter((asset) => !deleted.has(asset.id)),
        threads: {
          image: current.threads.image.map((item) => ({
            ...item,
            draft: { ...item.draft, references: item.draft.references.filter((reference) => !deleted.has(reference.assetId)) },
          })),
          video: current.threads.video.map((item) => ({
            ...item,
            draft: { ...item.draft, references: item.draft.references.filter((reference) => !deleted.has(reference.assetId)) },
          })),
        },
      }));
      await persistWorkspace(studioRef.current).catch((error) => toast.error(errorMessage(error)));
      toast.error(t("partialSessionDeleteFailed", {
        count: deletion.failures.length,
        error: deletion.failures.map((failure) => `${failure.name}: ${errorMessage(failure.error)}`).join(" · "),
      }));
      return;
    }
    const next = commitStudioNow((current) => {
      const sessions = current.sessions.filter((item) => item.id !== id);
      return { ...current, sessions, activeSessionId: current.activeSessionId === id ? sessions[0].id : current.activeSessionId };
    });
    await persistWorkspace(next).catch((error) => toast.error(errorMessage(error)));
  })();

  const exportRecoveryBackup = () => void (async () => {
    if (isTauriRuntime()) {
      try {
        const path = await invoke<string>("export_workspace_snapshot", {
          source: nativeSnapshotSourceRef.current,
          name: `fruit-truck-workspace-backup-${new Date().toISOString().replaceAll(":", "-")}.json`,
        });
        toast.success(`Workspace snapshot exported to ${path}.`);
      } catch (error) {
        toast.error(errorMessage(error));
      }
      return;
    }
    const recovery = studio.recovery;
    if (!recovery) return;
    const key = recovery.backupKey ?? recovery.sourceKey ?? STUDIO_STORAGE_KEY;
    const raw = localStorage.getItem(key);
    if (!raw) {
      toast.error(`No recovery payload was found at ${key}.`);
      return;
    }
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `fruit-truck-workspace-backup-${new Date().toISOString().replaceAll(":", "-")}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  })();

  const restoreLastKnownGood = () => void (async () => {
    if (isTauriRuntime()) {
      const preferred = nativeSnapshotSourceRef.current === "current" ? ["bak1", "bak2"] : [nativeSnapshotSourceRef.current];
      let lastError: unknown;
      for (const source of preferred) {
        try {
          await invoke("restore_workspace_backup", { source });
          window.location.reload();
          return;
        } catch (error) {
          lastError = error;
        }
      }
      toast.error(errorMessage(lastError ?? "No native backup is available."));
      return;
    }
    const raw = localStorage.getItem(studio.recovery?.lastKnownGoodKey ?? STUDIO_LAST_KNOWN_GOOD_KEY);
    if (!raw) {
      toast.error("No last-known-good workspace is available.");
      return;
    }
    localStorage.setItem(STUDIO_STORAGE_KEY, raw);
    window.location.reload();
  })();

  const reindexManagedMedia = () => void invoke<NativeManagedAsset[]>("scan_managed_assets").then(async (records) => {
    const recovered = await managedDroppedAssets(records);
    patchActive((current) => {
      const known = new Set(current.assets.flatMap((asset) => [asset.localPath, asset.fingerprint].filter(Boolean)));
      const additions = recovered.filter((asset) => !known.has(asset.localPath) && !known.has(asset.fingerprint));
      return { ...current, assets: [...current.assets, ...additions] };
    });
    toast.success(t("assetsImported", { count: recovered.length }));
  }).catch((error) => toast.error(errorMessage(error)));

  const exportWorkspace = () => void (async () => {
    const payload = persistedStudioPayload(studioRef.current);
    if (isTauriRuntime()) {
      const path = await invoke<string>("export_workspace_state", {
        payload,
        name: `fruit-truck-workspace-${new Date().toISOString().slice(0, 10)}.json`,
      });
      toast.success(`Workspace exported to ${path}.`);
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `fruit-truck-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  })().catch((error) => toast.error(errorMessage(error)));

  const importWorkspace = () => void (async () => {
    if (!isTauriRuntime()) throw new Error("Workspace import is available in the desktop app.");
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: false, filters: [{ name: "Fruit Truck workspace", extensions: ["json"] }] });
    if (typeof selected !== "string") return;
    const loaded = await invoke<NativeLoadedWorkspace>("import_workspace_state", { path: selected });
    const result = loadStudioStateWithRecovery({ storage: memoryStudioStorage(loaded.payload) });
    if (result.recovery.requiresUserAction) throw new Error(result.recovery.error ?? result.recovery.reason ?? "The workspace could not be imported safely.");
    setPreparedRequest(null);
    setSelectedAssetIds(new Set());
    setStudio(reconcilePersistedAttempts(result.state).state);
    toast.success(t("workspaceImported"));
  })().catch((error) => toast.error(errorMessage(error)));

  const exportSupportBundle = () => void (async () => {
    const storageHealth = isTauriRuntime()
      ? await invoke<unknown>("workspace_storage_health").catch((error) => ({ diagnostic: errorMessage(error) }))
      : { backend: "browser-local-storage" };
    const attempts = studio.sessions.flatMap((candidateSession) => [...candidateSession.threads.image, ...candidateSession.threads.video].flatMap((candidateThread) => candidateThread.attempts.map((attempt) => ({
      sessionId: candidateSession.id,
      threadId: candidateThread.id,
      attemptId: attempt.id,
      mode: candidateThread.mode,
      status: attempt.status,
      modelId: attempt.modelId ?? attempt.snapshot?.modelId,
      jobId: attempt.jobId,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
      errorCode: attempt.errorCode,
      error: attempt.error,
      estimatedCostUsd: attempt.estimatedCostUsd,
      actualCostUsd: attempt.actualCostUsd,
    }))));
    const activeStages = attempts
      .filter((attempt) => ["enhancing", "submitting", "in_progress"].includes(attempt.status))
      .map((attempt) => `${attempt.mode}:${attempt.status}`);
    const bundle = buildSupportBundle({
      appVersion: __APP_VERSION__,
      platform: navigator.platform,
      os: navigator.userAgent,
      attemptStage: activeStages.length ? activeStages.join(",") : "idle",
      attempts,
      logs: DIAGNOSTIC_LOG.entries(),
      state: {
        schemaVersion: studio.schemaVersion,
        sessionCount: studio.sessions.length,
        assetCount: studio.sessions.reduce((count, candidate) => count + candidate.assets.length, 0),
        recovery: studio.recovery,
      },
      context: { language, connectionState, catalogErrors, storageHealth },
    });
    const url = URL.createObjectURL(new Blob([serializeSupportBundle(bundle)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `fruit-truck-diagnostics-${bundle.diagnosticId}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    toast.success(t("diagnosticsExported"));
  })().catch((error) => toast.error(errorMessage(error)));

  createNewSessionRef.current = createNewSession;
  duplicateThreadRef.current = duplicateThread;
  restoreThreadRef.current = restoreThread;
  switchModeRef.current = switchMode;
  pickFilesRef.current = pickFiles;
  runGenerationRef.current = runGeneration;
  dismissGenerationResultRef.current = () => dismissGenerationResult();

  const modalOpen = onboardingOpen !== false || Boolean(studio.recovery?.requiresUserAction) || otherDialogOpen || resultDialogOpen || Boolean(confirmation)
    || settingsOpen || shortcutHelpOpen;
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
    if (settingsOpen) { setSettingsOpen(false); return true; }
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')];
    const dialog = dialogs.at(-1);
    if (!dialog) return false;
    const close = dialog.querySelector<HTMLElement>('[data-base-ui-dialog-close], [data-base-ui-alert-dialog-close], button[aria-label*="Close"], button[aria-label*="닫기"]');
    if (close) close.click();
    else dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return true;
  }, [closeConfirmation, confirmation, resultDialogOpen, settingsOpen, shortcutHelpOpen]);

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
    if (modalOpen && id !== "settings" && id !== "shortcutHelp" && !(id === "exportAsset" && previewAsset)) return false;
    switch (id) {
      case "newSession":
        createNewSessionRef.current();
        focusPrompt();
        return true;
      case "newThread":
        createThread();
        focusPrompt();
        return true;
      case "duplicateThread":
        duplicateThreadRef.current(thread.id);
        focusPrompt();
        return true;
      case "archiveThread":
        if (hasActiveAttempt || modeThreads.length <= 1) return true;
        archiveThread(thread.id);
        return true;
      case "restoreThread": {
        const latest = session.threads[mode]
          .filter((candidate) => candidate.archivedAt)
          .toSorted((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""))[0];
        if (!latest) return false;
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
        const hasAssetPanelContext = rightPanelOpen;
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
      case "showAssets": setRightPanelOpen(true); return true;
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
  }, [archiveThread, canGenerate, closeTopmostDialog, confirmation, createThread, cycleThread, focusPrompt, focusedAsset, hasActiveAttempt, modalOpen, mode, modeThreads.length, previewAsset, requestAppQuit, rightPanelOpen, session.threads, settingsOpen, shortcutHelpOpen, t, thread.id]);
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
      if (nativeMenuRef.current && NATIVE_MENU_COMMAND_IDS.has(command.id)) return;
      if (!dispatchCommandRef.current(command.id)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, []);

  const hasArchivedThread = session.threads[mode].some((candidate) => candidate.archivedAt);
  const nativeMenuState = useMemo<NativeMenuState>(() => ({
    enabled: {
      newSession: !modalOpen,
      newThread: !modalOpen,
      duplicateThread: !modalOpen,
      archiveThread: modalOpen || (!hasActiveAttempt && modeThreads.length > 1),
      restoreThread: !modalOpen && hasArchivedThread,
      nextThread: !modalOpen && modeThreads.length > 1,
      previousThread: !modalOpen && modeThreads.length > 1,
      findSessions: !modalOpen,
      importAssets: !modalOpen,
      exportAsset: !confirmation && (Boolean(previewAsset) || (!modalOpen && rightPanelOpen && Boolean(focusedAsset))),
      imageMode: !modalOpen,
      videoMode: !modalOpen,
      toggleSessionSidebar: !modalOpen,
      toggleInspector: !modalOpen,
      showAssets: !modalOpen,
      generate: !confirmation && !modalOpen && canGenerate,
      settings: !modalOpen || settingsOpen,
      shortcutHelp: !modalOpen || shortcutHelpOpen,
      quit: true,
    },
    checked: {
      toggleSessionSidebar: sessionSidebarOpen,
      toggleInspector: rightPanelOpen,
      imageMode: mode === "image",
      videoMode: mode === "video",
      showAssets: rightPanelOpen,
    },
  }), [canGenerate, confirmation, focusedAsset, hasActiveAttempt, hasArchivedThread, modalOpen, mode, modeThreads.length, previewAsset, rightPanelOpen, sessionSidebarOpen, settingsOpen, shortcutHelpOpen]);
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

  return (
    <Tooltip.Provider>
    <div className="app-shell" aria-hidden={onboardingOpen !== false} inert={onboardingOpen !== false ? true : undefined}>
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><span className="brand-mark"><FruitTruckMark /></span><strong>Fruit Truck</strong></div>
        <ModelSelector mode={mode} models={models} selectedId={selectedId} loading={catalogLoading} onSelect={selectModel} inherited={!thread.modelOverrideId} onUseDefault={useModeDefaults} onSetDefault={setCurrentAsModeDefault} />
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
            aria-label={`${t("sessionSpend")}: ${formatUsd(sessionSpendUsd)}`}
            data-tauri-drag-region
          >
            <small>{t("sessionSpend")}</small>
            <strong>{formatUsd(sessionSpendUsd)}</strong>
          </div>
          <div className="connection-pill" role="status" data-status={connectionState ?? "loading"}><i className={connectionState === "connected" ? "online" : ""} />{connectionState === "connected" ? `${t("keyConnected")} · ${credential?.maskedKey ?? ""}` : connectionState === "validating" ? t("keyValidating") : connectionState === "unauthorized" ? t("keyUnauthorized") : connectionState === "rate_limited" ? t("keyRateLimited") : connectionState === "offline" || connectionState === "server_error" ? t("keyOffline") : credential?.configured ? t("keyStored") : t("addApiKey")}</div>
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
            onActivate={activateThread}
            onCreate={createThread}
            onDuplicate={duplicateThread}
            onRename={renameThread}
            onArchive={archiveThread}
            onRestore={restoreThread}
          />
          <ScrollArea className="composer-scroll" viewportRef={composerViewportRef}>
          {catalogError || catalogErrors[mode] ? <div className="catalog-error"><CircleAlert /><span><strong>{t("catalogLoadFailed")}</strong><small>{catalogErrors[mode] ? t("catalogModeError", { mode: t(mode), error: catalogErrors[mode]! }) : catalogError}</small></span><Button variant="outline" size="sm" onClick={() => void refreshCatalog()}><RefreshCw /> {t("retry")}</Button></div> : null}
          {!selectedModel && selectedId && !catalogLoading && !catalogErrors[mode] ? <div className="catalog-error" role="alert"><CircleAlert /><span><strong>{t("modelUnavailable")}</strong><small>{selectedId}</small></span></div> : null}
          <header className="composer-header">
            <div>
              <p>{mode === "image" ? draft.imageEditMode ? t("imageEdit") : t("imageGeneration") : t("videoGeneration")}</p>
              <h1>{selectedModel?.name ?? (catalogLoading ? t("loadingModels") : t("chooseModel"))}</h1>
            </div>
            <div className="composer-header-meta">
              {selectedModel ? <div className="model-meta"><span>{providerLabel(selectedModel)}</span>{mode === "image" && imageEndpoints[selectedId]?.length ? <span>{t("endpointsVerified", { count: imageEndpoints[selectedId].length })}</span> : null}</div> : null}
              <div className="composer-header-utilities">
                {resultQueuePaused && resultQueue.length ? <Button type="button" className="pending-results-trigger" variant="outline" size="xs" onClick={() => setResultQueuePaused(false)}><ImageIcon /> {t("pendingResults", { count: resultQueue.length })}</Button> : null}
                <AttemptHistoryPopover attempts={thread.attempts} availableAssetIds={new Set(session.assets.map((asset) => asset.id))} onCancel={cancelAttemptTracking} onDuplicate={duplicateAttemptSnapshot} onRestore={restoreAttemptSnapshot} onRecheck={recheckAttemptStatus} onRepairInputs={repairAttemptInputs} onRecoverResults={(attempt) => void recoverAttemptResults(attempt)} />
              </div>
            </div>
          </header>
          {policyNotices.length || latestGenerationFailure ? <div className="generation-guidance-stack">
            {policyNotices.map((notice) => (
              <section className="model-policy-notice" data-policy={notice.code} key={notice.code} aria-label={t("modelPolicyNotice")}>
                <CircleAlert />
                <div>
                  <strong>{policyTitle(notice.code)}</strong>
                  <p>{policyMessage(notice.code)}</p>
                  <small>{notice.sources.map((source, index) => <span key={source.url}>{index ? " · " : ""}<ExternalLink href={source.url}>{source.label}</ExternalLink> · {t("reviewedDate", { date: source.reviewedAt })}</span>)}</small>
                </div>
              </section>
            ))}
            {latestGenerationFailure ? (
              <section className="generation-failure-guidance" role="alert" data-error-code={latestGenerationFailure.errorCode}>
                <CircleAlert />
                <div>
                  <strong>{t("generationNeedsAttention")}</strong>
                  <p>{localizedAttemptMessage(latestGenerationFailure, t)}</p>
                  {latestGenerationFailure.errorAction ? <b>{t("recoveryActionLabel")}: {localizedAttemptAction(latestGenerationFailure.errorAction, t)}</b> : null}
                  {latestGenerationFailure.errorDetails && latestGenerationFailure.errorDetails !== latestGenerationFailure.error ? (
                    <details>
                      <summary>{t("technicalDetails")}</summary>
                      <code>{latestGenerationFailure.errorDetails}</code>
                    </details>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div> : null}
          <div className="composer-form">
            {mode === "image" ? (
              <Field.Root className="edit-mode-row">
                <Field.Label className="edit-mode-label" nativeLabel={false} render={<div />}><span><strong>{t("editMode")}</strong><small>{t("editModeHint")}</small></span></Field.Label>
                <Switch checked={draft.imageEditMode} onCheckedChange={(value) => {
                  const references = draft.references.map((reference) => {
                    const isTarget = value && `@${reference.slot}` === draft.imageEditTarget;
                    if (isTarget) return markReferenceAsEditTarget(reference);
                    if (reference.purpose !== "edit_target") return reference;
                    return restoreReferenceAfterEditTarget(reference, assetMap.get(reference.assetId)?.kind ?? "image");
                  });
                  patchDraft({
                    imageEditMode: value,
                    references,
                    enhancedPrompt: "",
                    enhancedPromptDirty: false,
                  });
                }} />
              </Field.Root>
            ) : null}
            {mode === "image" && draft.imageEditMode ? (
              <>
                <Suspense fallback={null}>
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
                </Suspense>
                {editTargetError ? <div className="field-error edit-canvas-error">{editTargetError}</div> : null}
              </>
            ) : null}
            <InputTray
              references={draft.references}
              assets={session.assets}
              roles={roles}
              roleOptions={roleOptions}
              lockedPurposes={mode === "image" && draft.imageEditMode
                ? Object.fromEntries(draft.references
                  .filter((reference) => `@${reference.slot}` === draft.imageEditTarget)
                  .map((reference) => [reference.slot, "edit_target" as const]))
                : undefined}
              limit={referenceLimit}
              error={inputValidationError}
              onChange={(references) => {
              const normalizedReferences = mode === "image" && draft.imageEditMode
                ? references.map((reference) => `@${reference.slot}` === draft.imageEditTarget
                  ? markReferenceAsEditTarget(reference)
                  : reference)
                : references;
              const targetStillAttached = normalizedReferences.some((reference) => `@${reference.slot}` === draft.imageEditTarget);
              patchDraft({
                references: normalizedReferences,
                imageEditTarget: mode === "image" && draft.imageEditMode && !targetStillAttached ? "" : draft.imageEditTarget,
                maskStrokes: mode === "image" && draft.imageEditMode && !targetStillAttached ? [] : draft.maskStrokes,
                maskInstructions: mode === "image" && draft.imageEditMode && !targetStillAttached ? "" : draft.maskInstructions,
                enhancedPrompt: "",
                enhancedPromptDirty: false,
              });
            }} onImport={importFiles} onPick={pickFiles} />
            {inputWarnings.length ? <div className="input-advisories" role="status">
              {inputWarnings.map((message) => <p key={message}><CircleAlert />{message}</p>)}
            </div> : null}
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
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={mentionSuggestions.length > 0}
                  aria-controls={mentionSuggestions.length ? "input-mention-listbox" : undefined}
                  aria-activedescendant={mentionSuggestions[mentionIndex] ? `input-mention-${mentionSuggestions[mentionIndex].slot}` : undefined}
                  rows={7}
                  value={draft.prompt}
                  placeholder={mode === "image" ? t("imagePromptPlaceholder") : t("videoPromptPlaceholder")}
                  onChange={(event) => {
                    patchDraft({
                      prompt: event.target.value,
                      enhancedPrompt: "",
                      enhancedPromptDirty: false,
                    });
                    setMentionMenuOpen(/(?:^|\s)@\d*$/.test(event.target.value));
                    setMentionIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (!mentionSuggestions.length) return;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setMentionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + mentionSuggestions.length) % mentionSuggestions.length);
                    } else if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      const selected = mentionSuggestions[mentionIndex] ?? mentionSuggestions[0];
                      patchDraft({ prompt: draft.prompt.replace(/@\d*$/, `@${selected.slot} `), enhancedPrompt: "", enhancedPromptDirty: false });
                      setMentionMenuOpen(false);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setMentionMenuOpen(false);
                    }
                  }}
                  onScroll={syncPromptHighlightScroll}
                />
                {mentionSuggestions.length ? (
                  <div className="mention-menu" id="input-mention-listbox" role="listbox" aria-label={t("numberedInputs")}>
                    {mentionSuggestions.map((reference, index) => {
                      const asset = assetMap.get(reference.assetId);
                      return <Button type="button" variant="ghost" role="option" id={`input-mention-${reference.slot}`} aria-selected={index === mentionIndex} key={reference.assetId} onMouseEnter={() => setMentionIndex(index)} onClick={() => { patchDraft({ prompt: draft.prompt.replace(/@\d*$/, `@${reference.slot} `) }); setMentionMenuOpen(false); }}><b>@{reference.slot}</b>{asset?.name}</Button>;
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
              <Field.Label className="enhance-label" nativeLabel={false} render={<div />}><span><Sparkles /><span><strong>{t("promptEnhancement")}</strong><small>{studio.promptModel.endsWith("luna") ? "GPT-5.6 Luna · xhigh" : "GPT-5.6 Terra · high"}{displayedEnhancedPrompt && draft.enhancedVisualCount > 0 ? ` · ${t("visualContextIncluded")}` : ""}</small></span></span></Field.Label>
              <div><Button size="xs" variant="ghost" disabled={enhancing || !hasRunnableInstructions(mode, draft)} onClick={() => void runEnhancement().catch((error) => toast.error(errorMessage(error)))}>{enhancing ? <LoaderCircle className="spin" /> : <RefreshCw />} {displayedEnhancedPrompt ? t("reEnhance") : t("preview")}</Button><Switch checked={draft.enhancePrompt && hasRunnableInstructions(mode, draft)} disabled={!hasRunnableInstructions(mode, draft)} onCheckedChange={(value) => patchDraft({ enhancePrompt: value })} /></div>
            </Field.Root>
            {displayedEnhancedPrompt ? (
              <Collapsible.Root className="enhanced-prompt">
                <Collapsible.Trigger>{t("enhancedPrompt")} <ChevronRight /></Collapsible.Trigger>
                <Collapsible.Panel>
                  <Textarea value={displayedEnhancedPrompt} rows={6} onChange={(event) => patchDraft({ enhancedPrompt: event.target.value, enhancedPromptDirty: true })} />
                  <small>{t("enhancedPromptHint")}</small>
                  {draft.enhancementArtifact?.negativePrompt != null ? (
                    <Field.Root className="enhanced-negative-prompt">
                      <Field.Label>{t("enhancedNegativePrompt")}</Field.Label>
                      <Textarea
                        value={draft.enhancementArtifact.negativePrompt}
                        rows={3}
                        onChange={(event) => patchDraft({
                          enhancementArtifact: draft.enhancementArtifact
                            ? { ...draft.enhancementArtifact, negativePrompt: event.target.value }
                            : undefined,
                          enhancedPromptDirty: true,
                        })}
                      />
                      <small>{t("enhancedNegativePromptHint")}</small>
                    </Field.Root>
                  ) : null}
                </Collapsible.Panel>
              </Collapsible.Root>
            ) : null}

            <OptionsFields key={`${mode}:${selectedModel?.id ?? ""}`} mode={mode} model={selectedModel} options={draft.options} providerJson={draft.providerJson} providerError={providerError} onOptionsChange={(options) => patchDraft({ options })} onProviderJsonChange={(providerJson) => patchDraft({ providerJson })} />
            <GenerationPresetBar mode={mode} modelId={selectedId} options={draft.options} providerJson={draft.providerJson} presets={studio.generationPresets ?? []} onSave={saveGenerationPreset} onApply={applyGenerationPreset} onDelete={deleteGenerationPreset} />
            {requestBuildError && !providerError ? <div className="field-error request-build-error">{requestBuildError}</div> : null}
            {selectedModel ? <div className="thread-default-controls">
              <Button type="button" size="xs" variant="ghost" disabled={!thread.modelOverrideId && !Object.keys(thread.optionOverrides).length && thread.providerJsonOverride == null} onClick={useModeDefaults}>{t("useModeDefault")}</Button>
              <Button type="button" size="xs" variant="ghost" onClick={setCurrentAsModeDefault}>{t("setModeDefault")}</Button>
            </div> : null}
          </div>
          <footer className="generate-bar">
            <div className="generate-meta">
              <div><span>{selectedModel ? t("requestFields", { count: Object.keys(requestPayload).length }) : t("noModelSelected")}</span><small>{mode === "video" ? t("backgroundJobs", { count: sessionVideoJobs.length }) : t("commandGenerate")}</small></div>
              <Suspense fallback={null}>
              <RequestPreviewDialog
                mode={mode}
                request={currentPreparedRequest?.request ?? prettyRequest(requestPayload)}
                references={previewReferences}
                coverage={currentPreparedRequest?.coverage ?? previewCoverage}
                error={requestBuildError}
                preflightErrors={requestPreflightErrors}
                status={preparingRequest ? "preparing" : currentPreparedRequest ? "final" : "draft"}
                estimatedCost={currentPreparedRequest?.costLabel ?? generationCost?.label}
                plannerModel={draft.enhancePrompt ? studio.promptModel : undefined}
                plannerCost={currentPreparedRequest?.enhancementArtifact?.actualCostUsd != null ? formatUsd(currentPreparedRequest.enhancementArtifact.actualCostUsd) : undefined}
                routeSummary={currentPreparedRequest?.routeLabel ?? draftPreparedRequest.route?.providerName ?? draftPreparedRequest.route?.providerSlug}
                routeDefinitive={currentPreparedRequest?.artifact.routeResolution.definitive ?? draftPreparedRequest.routeResolution.definitive}
                privacySummary={currentPreparedRequest?.privacyLabel ?? `ZDR: ${draftPreparedRequest.privacy.zdr} · data collection: ${draftPreparedRequest.privacy.dataCollection}${draftPreparedRequest.privacy.warning ? ` · ${draftPreparedRequest.privacy.warning}` : ""}`}
                transferredBytes={transferBytes}
                plannerEnabled={draft.enhancePrompt}
                onPrepare={() => void prepareRequestForReview()}
              />
              </Suspense>
            </div>
            {generationBlocker ? <div className="generation-blocker" id="generation-blocker" role="status"><span><strong>{t("generationBlocker")}</strong><small>{generationBlocker}</small></span>{generationRecoveryAction ? <Button type="button" size="xs" variant="outline" disabled={preparingRequest} onClick={generationRecoveryAction.run}>{preparingRequest ? <LoaderCircle className="spin" /> : generationRecoveryAction.icon} {generationRecoveryAction.label}</Button> : null}</div> : null}
            <Button size="lg" className="generate-button" aria-keyshortcuts="Meta+Enter" aria-describedby={generationBlocker ? "generation-blocker" : undefined} disabled={!canGenerate} onClick={() => void runGeneration()}>
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

        {rightPanelOpen ? <RightPanel onClose={() => setRightPanelOpen(false)} assets={(
          <AssetLibrary assets={session.assets} jobs={sessionVideoJobs} selectedIds={selectedAssetIds} onSelectedIdsChange={setSelectedAssetIds} highlightedIds={highlightedAssetIds} onFocusedAssetChange={setFocusedAssetId} onPreviewAssetChange={setPreviewAssetId} onImport={async (files) => { await importFiles(files); }} onPick={async () => { await pickFiles(); }} onUse={addAssetAsReference} onEdit={(assetId) => editImageAsset(assetId)} onDelete={(ids) => void deleteAssets(ids)} onReimport={(assetId) => void reimportAsset(assetId)} />
        )} /> : null}
      </main>

      <Suspense fallback={null}>
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
      </Suspense>

      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />

      <Suspense fallback={null}>
      <SettingsDialog
        open={settingsOpen}
        status={credential}
        connectionState={connectionState}
        promptModel={studio.promptModel}
        defaultEnhancePrompt={studio.defaultEnhancePrompt}
        onPromptModelChange={(promptModel) => setStudio((current) => ({ ...current, promptModel }))}
        onDefaultEnhancePromptChange={(enabled) => setStudio((current) => applyDefaultEnhancePrompt(current, enabled))}
        onExportSupport={exportSupportBundle}
        onExportWorkspace={exportWorkspace}
        onImportWorkspace={importWorkspace}
        onStartGuide={() => { setSettingsOpen(false); setWorkflowGuideOpen(true); }}
        sessionBudgetUsd={sessionBudgetUsd}
        onSessionBudgetChange={setSessionBudgetUsd}
        onClose={() => setSettingsOpen(false)}
        onSave={async (apiKey) => { await saveAndValidateApiKey(apiKey); toast.success(t("keySaved")); }}
        onRemove={async () => { const status = await removeApiKey(); setCredential(status); setConnectionState("missing"); setCatalogs({ image: [], video: [] }); toast.success(t("keyRemoved")); }}
      />
      </Suspense>
      <ConfirmDialog confirmation={confirmation} onClose={closeConfirmation} />
      {onboardingOpen === false && !studio.recovery?.requiresUserAction ? <UpdatePrompt
        getActiveAttemptCount={() => activeDurableOperationCount(studioRef.current)}
        isDurableSavePending={() => nativeSavePendingRef.current > 0}
        getDurableSaveError={() => nativeSaveErrorRef.current}
        onBeforeInstall={() => persistWorkspace(studioRef.current)}
      /> : null}
      <WorkflowGuide
        open={workflowGuideOpen}
        hasAsset={session.assets.length > 0}
        hasMention={mentionedSlots.length > 0}
        hasFinalRequest={Boolean(currentPreparedRequest)}
        hasResult={thread.attempts.some((attempt) => attempt.status === "completed" && attempt.assetIds.length > 0)}
        onImport={() => void pickFiles()}
        onLoadSample={loadGuideSample}
        onFocusPrompt={focusPrompt}
        onOpenRequest={() => document.querySelector<HTMLElement>(".generate-bar .request-dialog-trigger")?.click()}
        onClose={() => setWorkflowGuideOpen(false)}
      />
      {studio.recovery?.requiresUserAction ? <WorkspaceRecoveryDialog
        recovery={studio.recovery}
        onExport={exportRecoveryBackup}
        onRestoreLastKnownGood={restoreLastKnownGood}
        onReindex={reindexManagedMedia}
        onOpenSafeWorkspace={() => setStudio((current) => current.recovery ? { ...current, recovery: { ...current.recovery, kind: "fresh", status: "fresh", requiresUserAction: false } } : current)}
      /> : null}
    </div>
    {onboardingOpen !== false && !studio.recovery?.requiresUserAction ? (
      <Onboarding
        ready={onboardingOpen === true}
        onSave={async (apiKey) => {
          const status = await saveAndValidateApiKey(apiKey);
          if (!status.configured) throw new Error(t("onboardingKeySaveFailed"));
          setCredential(status);
          toast.success(t("keySaved"));
        }}
        onComplete={() => {
          localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
          setOnboardingOpen(false);
        }}
      />
    ) : null}
    </Tooltip.Provider>
  );
}
