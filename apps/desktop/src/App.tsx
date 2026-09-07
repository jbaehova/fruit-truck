import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import { PromptEnhancementToolbar } from "@/components/PromptEnhancementToolbar";
import { AssetLibrary } from "@/components/AssetLibrary";
import { AssetPreview } from "@/components/AssetPreview";
import { ConfirmDialog, type Confirmation } from "@/components/ConfirmDialog";
import { ExternalLink } from "@/components/ExternalLink";
import { GenerationThreadRail } from "@/components/GenerationThreadRail";
import type { GenerationResultNotice } from "@/components/GenerationResultDialog";
import { availableInputRoles, modelForInputControls, optionsForInputReferences, resolveInputCapabilities, videoImageReferences } from "@/inputCapabilities";
import { simplifyVideoDraft } from "@/videoDraft";
import { InputTray } from "@/components/InputTray";
import { ModelSelector } from "@/components/ModelSelector";
import { Onboarding } from "@/components/Onboarding";
import { OptionsFields } from "@/components/OptionsFields";
import { RightPanel } from "@/components/RightPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { ShortcutHelpDialog } from "@/components/ShortcutHelpDialog";
import { UpdatePrompt, type UpdateInstallPhase, type UpdatePreparationContext } from "@/components/UpdatePrompt";
import { UpdateRecoveryDialog } from "@/components/UpdateRecoveryDialog";
import { WorkspaceRecoveryDialog } from "@/components/WorkspaceRecoveryDialog";
import { loadLegacyWorkspace } from "@/workspaceBoot";
import { captureWorkspacePreferences, PREFERENCES_CHANGED, saveWorkspacePreference } from "@/workspacePreferences";
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
  hydrateImageModelPricing,
  isTauriRuntime,
  loadModels,
  loadPromptModelAvailability,
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
  validateApiKeyCandidate,
  validateCredential,
  validateProviderConfiguration,
  validateReferenceCoverage,
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
  exportStudioStateJson,
  optionOverridesFromDefaults,
  preferredCatalogModel,
  recordSessionCost,
  reconcileManagedAssetIndex,
  reconcileVerifiedUpdateAssetIndex,
  type NativeManagedAsset,
  type GenerationDraftState,
  type GenerationAttempt,
  type GenerationThread,
  type SessionAsset,
  type StudioSession,
  type StudioState,
  type StudioStorage,
  STUDIO_LAST_KNOWN_GOOD_KEY,
  STUDIO_STORAGE_KEY,
} from "@/studio";
import {
  beginPromptEnhancement,
  canEnhancePrompt,
  completePromptEnhancement,
  currentPromptEnhancementArtifact,
  currentPromptCheckpoint,
  editPromptHistory,
  failPromptEnhancement,
  invalidatePromptEnhancement,
  promptHistoryCanRedo,
  promptHistoryCanUndo,
  redoPromptEnhancement,
  undoPromptEnhancement,
} from "@/promptHistory";
import { PROMPT_MODELS, promptModelDefinition, type PromptModel } from "@/promptModels";
import { NATIVE_MENU_COMMAND_IDS, commandForKeyboardEvent, type AppCommandId } from "@/shortcuts";
import { reconcilePersistedAttempts, sessionDeletionDecision } from "@/attemptRecovery";
import { localizedAttemptAction, localizedAttemptMessage } from "@/attemptPresentation";
import { localDiagnosticLog } from "@/diagnostics";
import {
  VIDEO_POLL_INTERVAL_MS,
  createResilientPollScheduler,
  hasVideoPollingTimedOut,
  isVideoPollDue,
  videoPollRetryDelayMs,
} from "@/videoPolling";
import {
  assertWorkspaceInvariants,
  assertWorkspaceMutable,
  inspectActiveUpdateOperations,
  migrateStudioForUpdate,
  type MutationLock,
  type UpdateMigrationStep,
  type WorkspaceInvariantReport,
} from "@/updateMigration";

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
const PROMPT_ENHANCEMENT_NOTICE_KEY = "fruit-truck.prompt-enhancement-notice.v1";
const DEFAULT_SESSION_SIDEBAR_WIDTH = 256;
const DIAGNOSTIC_LOG = localDiagnosticLog();

type PlannerAvailabilityStatus = "checking" | "available" | "unavailable" | "unknown";

function plannerAvailabilityRecord(status: PlannerAvailabilityStatus): Record<PromptModel, PlannerAvailabilityStatus> {
  return Object.fromEntries(PROMPT_MODELS.map((model) => [model.id, status])) as Record<PromptModel, PlannerAvailabilityStatus>;
}

type NativeLoadedWorkspace = {
  payload: unknown;
  source: string;
  schemaVersion: number;
  checksum: string;
  recovered: boolean;
};

type WorkspaceBootState = "loading" | "migrating" | "verifying" | "ready" | "recovery_required";

type UpdateTransactionPhase =
  | "preparing"
  | "snapshot_ready"
  | "downloading"
  | "installing"
  | "awaiting_restart"
  | "verifying"
  | "complete"
  | "recovery_required";

type NativeUpdateTransaction = {
  schemaVersion: 1;
  id: string;
  fromAppVersion: string;
  toAppVersion: string;
  fromStudioSchema: number;
  targetStudioSchema: number;
  phase: UpdateTransactionPhase;
  createdAt: string;
  updatedAt: string;
  snapshotPath: string;
  snapshotChecksum: string;
  assetManifestPath: string;
  assetManifestChecksum: string;
  migratedWorkspace?: { studioSchema: number; payloadChecksum: string };
  failure?: { code: string; message: string };
};

type NativeAssetVerificationReport = {
  schemaVersion: 1;
  transactionId: string;
  valid: boolean;
  totalEntries: number;
  verifiedEntries: number;
  missingEntries: number;
  changedEntries: number;
  issues: Array<{ assetId: string; relativePath: string; code: string; message: string }>;
};

type NativeUpdatePreparationProgress = {
  schemaVersion: 1;
  transactionId: string;
  stage: "hashing_assets";
  assetId?: string;
  relativePath?: string;
  assetIndex: number;
  assetCount: number;
  assetBytesHashed: number;
  assetByteSize: number;
  totalBytesHashed: number;
  totalByteSize: number;
};

type UpdateRecoveryState = {
  transaction: NativeUpdateTransaction;
  code: string;
  message: string;
  invariants?: WorkspaceInvariantReport;
  assetReport?: NativeAssetVerificationReport;
  migrationSteps?: UpdateMigrationStep[];
};

type PendingUpdateCompletion = {
  transaction: NativeUpdateTransaction;
  invariants: WorkspaceInvariantReport;
  assetReport: NativeAssetVerificationReport;
  migrationSteps: UpdateMigrationStep[];
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

function losslessStudioPayload(state: StudioState): unknown {
  return JSON.parse(exportStudioStateJson(state)) as unknown;
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
    promptHistory: draft.promptHistory,
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
    directorPlan: draft.directorPlan,
  });
}

function previewAssetTransportUrl(asset: SessionAsset, slot: number): string {
  const external = asset.externalUrl?.trim().toLowerCase();
  if (external?.startsWith("https://")) return `https://fruit-truck.invalid/reference-${slot}`;
  if (external?.startsWith("http://")) return `http://fruit-truck.invalid/reference-${slot}`;
  return `data:${asset.mimeType};base64,AA==`;
}

function hasRunnableInstructions(mode: GenerationMode, draft: GenerationDraftState) {
  return hasGenerationInstructions({
    prompt: draft.prompt,
    hasMask: mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0,
    maskInstructions: draft.maskInstructions,
  });
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
  prompt = draft.prompt,
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
    prompt,
    maskInstructions: hasMask ? draft.maskInstructions : undefined,
    editTarget: draft.imageEditMode ? draft.imageEditTarget : undefined,
    maskState: hasMask ? draft.maskStrokes : undefined,
    references,
  });
  return { references, hasMask, workflow, signature, target };
}

export default function App() {
  const { language, t } = useI18n();
  const [studio, setStudio] = useState(() => reconcilePersistedAttempts(loadStudioState(
    isTauriRuntime() ? { storage: memoryStudioStorage() } : {},
  )).state);
  const [nativeWorkspaceReady, setNativeWorkspaceReady] = useState(() => !isTauriRuntime());
  const [workspaceBootState, setWorkspaceBootState] = useState<WorkspaceBootState>(() => isTauriRuntime() ? "loading" : "ready");
  const [updateMutationLock, setUpdateMutationLock] = useState<MutationLock>({ active: false });
  const [updateRecovery, setUpdateRecovery] = useState<UpdateRecoveryState | null>(null);
  const [pendingUpdateCompletion, setPendingUpdateCompletion] = useState<PendingUpdateCompletion | null>(null);
  const [managedReconciliationRetry, setManagedReconciliationRetry] = useState(0);
  const [updateRetentionCleanupEligible, setUpdateRetentionCleanupEligible] = useState(false);
  const [updateRetentionCleanupRetry, setUpdateRetentionCleanupRetry] = useState(0);
  const [catalogs, setCatalogs] = useState<Record<GenerationMode, GenerationModel[]>>({ image: [], video: [] });
  const [promptModelAvailability, setPromptModelAvailability] = useState<Record<PromptModel, PlannerAvailabilityStatus>>(
    () => plannerAvailabilityRecord("unknown"),
  );
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogErrors, setCatalogErrors] = useState<Partial<Record<GenerationMode, string>>>({});
  const [imageEndpoints, setImageEndpoints] = useState<Record<string, ImageModelEndpoint[]>>({});
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [connectionState, setConnectionState] = useState<CredentialValidationStatus | "validating" | null>(null);
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
  const [preparedRequest, setPreparedRequest] = useState<PreparedGenerationRequest | null>(null);
  const [preparingRequest, setPreparingRequest] = useState(false);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionCaret, setMentionCaret] = useState(0);
  const pendingMentionSelection = useRef<{ prompt: string; caret: number } | null>(null);
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
  const managedReconciliationRetryTimer = useRef<number | undefined>(undefined);
  const updateRetentionCleanupRetryTimer = useRef<number | undefined>(undefined);
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
  const managedReconciliationPendingRef = useRef(0);
  const updateRetentionCleanupRanRef = useRef(false);
  const pendingWorkspaceMutationRef = useRef(0);
  const updateMutationLockRef = useRef<MutationLock>(updateMutationLock);
  const pendingUpdateTransactionRef = useRef<NativeUpdateTransaction | null>(null);
  const completingUpdateTransactionRef = useRef<string | null>(null);
  const updatePreparationPromiseRef = useRef<Promise<void> | null>(null);
  updateMutationLockRef.current = updateMutationLock;

  const replaceUpdateMutationLock = useCallback((lock: MutationLock) => {
    updateMutationLockRef.current = lock;
    setUpdateMutationLock(lock);
  }, []);

  const assertMutable = useCallback(() => {
    assertWorkspaceMutable(updateMutationLockRef.current);
  }, []);

  const withPendingWorkspaceMutation = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    assertWorkspaceMutable(updateMutationLockRef.current);
    pendingWorkspaceMutationRef.current += 1;
    try {
      return await operation();
    } finally {
      pendingWorkspaceMutationRef.current = Math.max(0, pendingWorkspaceMutationRef.current - 1);
    }
  }, []);

  const scheduleManagedReconciliationRetry = useCallback(() => {
    if (managedReconciliationRetryTimer.current !== undefined) return;
    managedReconciliationRetryTimer.current = window.setTimeout(() => {
      managedReconciliationRetryTimer.current = undefined;
      setManagedReconciliationRetry((current) => current + 1);
    }, 1_500);
  }, []);

  const scheduleUpdateRetentionCleanupRetry = useCallback(() => {
    if (updateRetentionCleanupRetryTimer.current !== undefined) return;
    updateRetentionCleanupRetryTimer.current = window.setTimeout(() => {
      updateRetentionCleanupRetryTimer.current = undefined;
      setUpdateRetentionCleanupRetry((current) => current + 1);
    }, 5_000);
  }, []);

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
  const inputSupport = useMemo(() => resolveInputCapabilities(mode, selectedModel, draft.options, draft.providerJson),
    [mode, selectedModel, draft.options, draft.providerJson]);
  const controlsModel = useMemo(() => modelForInputControls(inputSupport, draft.references), [inputSupport, draft.references]);
  const roleOptions = inputSupport.roles;
  const roles = useMemo(() => [...new Set(Object.values(roleOptions).flat())], [roleOptions]);
  const referenceLimit = inputSupport.limit;
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
  const selectedPromptModel = promptModelDefinition(studio.promptModel);
  const selectedPromptModelAvailability = promptModelAvailability[studio.promptModel];
  const promptEnhancementCanUndo = !enhancing && promptHistoryCanUndo(draft.promptHistory, draft.prompt);
  const promptEnhancementCanRedo = !enhancing && promptHistoryCanRedo(draft.promptHistory, draft.prompt);
  const promptEnhancementResultReady = !draft.promptHistory.enhancementLocked
    && draft.promptHistory.entries[draft.promptHistory.cursor + 1]?.kind === "enhancement_result";
  const promptEnhancementEnabled = canEnhancePrompt({
    prompt: draft.prompt,
    history: draft.promptHistory,
    enhancing,
    plannerAvailable: selectedPromptModelAvailability === "available",
    generationModelAvailable: Boolean(selectedModel),
  });

  useEffect(() => {
    if (workspaceBootState !== "ready") {
      attemptStatuses.current = null;
      return;
    }
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
  }, [studio, t, workspaceBootState]);

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
    if (managedReconciliationRetryTimer.current) window.clearTimeout(managedReconciliationRetryTimer.current);
    if (updateRetentionCleanupRetryTimer.current) window.clearTimeout(updateRetentionCleanupRetryTimer.current);
  }, []);

  useEffect(() => {
    composerViewportRef.current?.scrollTo({ top: 0, left: 0 });
  }, [mode, selectedId, studio.activeSessionId, thread.id]);

  const patchSession = useCallback((id: string, update: (current: StudioSession) => StudioSession) => {
    assertWorkspaceMutable(updateMutationLockRef.current);
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
    assertWorkspaceMutable(updateMutationLockRef.current);
    const next = update(studioRef.current);
    studioRef.current = next;
    setStudio(next);
    return next;
  }, []);

  const patchActive = useCallback((update: (current: StudioSession) => StudioSession) => {
    patchSession(studio.activeSessionId, update);
  }, [patchSession, studio.activeSessionId]);

  const patchDraft = useCallback((patch: Partial<GenerationDraftState>) => {
    assertWorkspaceMutable(updateMutationLockRef.current);
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
            const contextChanged = [
              "references",
              "options",
              "providerJson",
              "imageEditMode",
              "imageEditTarget",
              "maskInstructions",
              "maskStrokes",
              "directorPlan",
            ].some((key) => key in patch);
            const promptChanged = draftPatch.prompt !== undefined && draftPatch.prompt !== item.draft.prompt;
            const promptHistory = draftPatch.promptHistory
              ?? (promptChanged
                ? editPromptHistory(item.draft.promptHistory, item.draft.prompt)
                : contextChanged
                  ? invalidatePromptEnhancement(item.draft.promptHistory)
                  : item.draft.promptHistory);
            return {
              ...item,
              optionOverrides,
              providerJsonOverride,
              draft: { ...(item.mode === "video" ? simplifyVideoDraft(item.draft) : item.draft), ...draftPatch, promptHistory },
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
    const payload = losslessStudioPayload(state);
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

  const requireUpdateRecovery = useCallback(async (
    transaction: NativeUpdateTransaction,
    code: string,
    error: unknown,
    details: Pick<UpdateRecoveryState, "invariants" | "assetReport" | "migrationSteps"> = {},
  ) => {
    replaceUpdateMutationLock({ active: true, reason: "update", transactionId: transaction.id });
    const message = errorMessage(error);
    let failedTransaction = transaction;
    try {
      failedTransaction = await invoke<NativeUpdateTransaction>("fail_update_transaction", {
        transactionId: transaction.id,
        code,
        message,
      });
    } catch (failureWriteError) {
      DIAGNOSTIC_LOG.append({
        level: "error",
        event: "update.failure_marker_write_failed",
        details: { transactionId: transaction.id, code, error: errorMessage(failureWriteError) },
      });
    }
    pendingUpdateTransactionRef.current = failedTransaction;
    setUpdateRecovery({ transaction: failedTransaction, code, message, ...details });
    setNativeWorkspaceReady(false);
    setWorkspaceBootState("recovery_required");
  }, [replaceUpdateMutationLock]);

  const verifyPendingNativeUpdate = useCallback(async (transaction: NativeUpdateTransaction) => {
    let invariants: WorkspaceInvariantReport | undefined;
    let assetReport: NativeAssetVerificationReport | undefined;
    let migrationSteps: UpdateMigrationStep[] | undefined;
    try {
      pendingUpdateTransactionRef.current = transaction;
      replaceUpdateMutationLock({ active: true, reason: "update", transactionId: transaction.id });
      setPendingUpdateCompletion(null);
      setUpdateRetentionCleanupEligible(false);
      setUpdateRecovery(null);
      setNativeWorkspaceReady(false);
      setWorkspaceBootState("migrating");
      const snapshot = await invoke<NativeLoadedWorkspace>("load_pre_update_snapshot", {
        transactionId: transaction.id,
      });
      const snapshotMigration = migrateStudioForUpdate(snapshot.payload);
      if (snapshotMigration.state.schemaVersion !== transaction.targetStudioSchema) {
        throw new Error("The migrated workspace does not match the update target schema.");
      }
      invariants = snapshotMigration.invariants;
      migrationSteps = snapshotMigration.migration.steps;
      setWorkspaceBootState("verifying");
      assetReport = await invoke<NativeAssetVerificationReport>("verify_update_assets", {
        transactionId: transaction.id,
      });
      if (!assetReport.valid) {
        const firstIssue = assetReport.issues[0];
        throw new Error(firstIssue?.message ?? "Managed asset verification failed.");
      }

      invariants = assertWorkspaceInvariants(snapshot.payload, snapshotMigration.state);
      await invoke("save_verified_update_workspace", {
        transactionId: transaction.id,
        payload: losslessStudioPayload(snapshotMigration.state),
      });

      const nativeAssetRecords = await invoke<NativeManagedAsset[]>("scan_managed_assets");
      const verifiedAssetIndex = reconcileVerifiedUpdateAssetIndex(
        snapshotMigration.state,
        nativeAssetRecords,
      );
      if (verifiedAssetIndex.missingCount > 0) {
        throw new Error(`Managed asset presence scan is missing ${verifiedAssetIndex.missingCount} verified file(s).`);
      }
      managedReconciliationRanRef.current = true;

      const recoveredAttempts = reconcilePersistedAttempts(snapshotMigration.state, transaction.createdAt).state;
      invariants = assertWorkspaceInvariants(snapshot.payload, recoveredAttempts);
      studioRef.current = recoveredAttempts;
      setStudio(recoveredAttempts);
      setUpdateRecovery(null);
      setNativeWorkspaceReady(true);
      setWorkspaceBootState("ready");
      setPendingUpdateCompletion({ transaction, invariants, assetReport, migrationSteps });
    } catch (error) {
      setPendingUpdateCompletion(null);
      await requireUpdateRecovery(
        transaction,
        assetReport && !assetReport.valid
          ? "asset_verification_failed"
          : "post_update_verification_failed",
        error,
        { invariants, assetReport, migrationSteps },
      );
    }
  }, [replaceUpdateMutationLock, requireUpdateRecovery]);

  useEffect(() => {
    const completion = pendingUpdateCompletion;
    if (!completion || completingUpdateTransactionRef.current === completion.transaction.id) return;
    completingUpdateTransactionRef.current = completion.transaction.id;
    void invoke("complete_update_transaction", { transactionId: completion.transaction.id }).then(() => {
      DIAGNOSTIC_LOG.append({
        level: "info",
        event: "update.verification_complete",
        details: {
          transactionId: completion.transaction.id,
          fromAppVersion: completion.transaction.fromAppVersion,
          toAppVersion: completion.transaction.toAppVersion,
          fromStudioSchema: completion.transaction.fromStudioSchema,
          targetStudioSchema: completion.transaction.targetStudioSchema,
          finalPhase: "complete",
          snapshotChecksum: completion.transaction.snapshotChecksum,
          assetManifestChecksum: completion.transaction.assetManifestChecksum,
          invariants: completion.invariants,
          assetVerification: {
            totalEntries: completion.assetReport.totalEntries,
            verifiedEntries: completion.assetReport.verifiedEntries,
            missingEntries: completion.assetReport.missingEntries,
            changedEntries: completion.assetReport.changedEntries,
            errorCount: completion.assetReport.issues.length,
          },
          migrationSteps: completion.migrationSteps,
        },
      });
      pendingUpdateTransactionRef.current = null;
      setPendingUpdateCompletion(null);
      setUpdateRecovery(null);
      setUpdateRetentionCleanupEligible(true);
      replaceUpdateMutationLock({ active: false });
    }).catch(async (error) => {
      setPendingUpdateCompletion(null);
      DIAGNOSTIC_LOG.append({
        level: "error",
        event: "update.completion_marker_failed",
        details: { transactionId: completion.transaction.id, error: errorMessage(error) },
      });
      await requireUpdateRecovery(
        completion.transaction,
        "completion_marker_failed",
        error,
        {
          invariants: completion.invariants,
          assetReport: completion.assetReport,
          migrationSteps: completion.migrationSteps,
        },
      );
    }).finally(() => {
      if (completingUpdateTransactionRef.current === completion.transaction.id) {
        completingUpdateTransactionRef.current = null;
      }
    });
  }, [pendingUpdateCompletion, replaceUpdateMutationLock, requireUpdateRecovery]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const loadRegularWorkspace = async () => {
      const loaded = await invoke<NativeLoadedWorkspace | null>("load_workspace_state");
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
      } else {
        const records = await invoke<NativeManagedAsset[]>("scan_managed_assets");
        if (cancelled) return;
        const legacy = loadLegacyWorkspace(localStorage, records.length > 0);
        setStudio(reconcilePersistedAttempts(legacy.state).state);
      }
      setNativeWorkspaceReady(true);
      setWorkspaceBootState("ready");
    };
    void (async () => {
      const pending = await invoke<NativeUpdateTransaction | null>("load_pending_update_transaction");
      if (cancelled) return;
      if (pending) {
        pendingUpdateTransactionRef.current = pending;
        replaceUpdateMutationLock({ active: true, reason: "update", transactionId: pending.id });
        const { getVersion } = await import("@tauri-apps/api/app");
        const runningVersion = await getVersion();
        if (runningVersion === pending.toAppVersion) {
          await verifyPendingNativeUpdate(pending);
          return;
        }
        if (runningVersion === pending.fromAppVersion && ["preparing", "snapshot_ready", "downloading"].includes(pending.phase)) {
          await invoke("abort_update_transaction", { transactionId: pending.id });
          pendingUpdateTransactionRef.current = null;
          replaceUpdateMutationLock({ active: false });
        } else if (runningVersion === pending.fromAppVersion && ["installing", "awaiting_restart", "recovery_required"].includes(pending.phase)) {
          try {
            await invoke<NativeUpdateTransaction>("abandon_update_transaction_after_source_relaunch", {
              transactionId: pending.id,
            });
            pendingUpdateTransactionRef.current = null;
            replaceUpdateMutationLock({ active: false });
          } catch (error) {
            await requireUpdateRecovery(pending, "source_relaunch_abandon_failed", error);
            return;
          }
        } else {
          await requireUpdateRecovery(
            pending,
            "app_version_mismatch",
            new Error(`Expected app version ${pending.toAppVersion} after the update, but found ${runningVersion}.`),
          );
          return;
        }
      }
      await loadRegularWorkspace();
    })().catch((error) => {
      if (cancelled) return;
      const pending = pendingUpdateTransactionRef.current;
      if (pending) {
        void requireUpdateRecovery(pending, "update_boot_failed", error);
        return;
      }
      setStudio((current) => ({
        ...current,
        recovery: {
          kind: "corrupt",
          status: "corrupt",
          targetSchemaVersion: 8,
          rawStateAvailable: true,
          requiresUserAction: true,
          reason: "The native workspace could not be loaded. Its files were retained and automatic saving is paused.",
          error: errorMessage(error),
          attempts: [],
        },
      }));
      setNativeWorkspaceReady(true);
      setWorkspaceBootState("ready");
    });
    return () => { cancelled = true; };
  }, [replaceUpdateMutationLock, requireUpdateRecovery, verifyPendingNativeUpdate]);

  useEffect(() => {
    if (!isTauriRuntime()
      || !nativeWorkspaceReady
      || workspaceBootState !== "ready"
      || updateMutationLock.active
      || updateRecovery
      || !updateRetentionCleanupEligible
      || pendingUpdateTransactionRef.current
      || studio.recovery?.requiresUserAction
      || updateRetentionCleanupRanRef.current) return;
    updateRetentionCleanupRanRef.current = true;
    void invoke<number>("cleanup_completed_update_snapshots").catch((error) => {
      updateRetentionCleanupRanRef.current = false;
      scheduleUpdateRetentionCleanupRetry();
      DIAGNOSTIC_LOG.append({
        level: "warn",
        event: "update.retention_cleanup_failed",
        details: { error: errorMessage(error) },
      });
    });
  }, [
    nativeWorkspaceReady,
    scheduleUpdateRetentionCleanupRetry,
    studio.recovery?.requiresUserAction,
    updateMutationLock.active,
    updateRecovery,
    updateRetentionCleanupEligible,
    updateRetentionCleanupRetry,
    workspaceBootState,
  ]);

  useEffect(() => {
    if (!isTauriRuntime()
      || !nativeWorkspaceReady
      || workspaceBootState !== "ready"
      || updateMutationLock.active
      || studio.recovery?.requiresUserAction
      || managedReconciliationRanRef.current) return;
    managedReconciliationRanRef.current = true;
    managedReconciliationPendingRef.current += 1;
    void invoke<NativeManagedAsset[]>("scan_managed_assets").then(async (records) => {
      const scanned = await managedDroppedAssets(records);
      const reconciliation = reconcileManagedAssetIndex(studioRef.current, scanned);
      const changed = reconciliation.missingCount + reconciliation.relinkedCount + reconciliation.recoveredCount > 0;
      if (updateMutationLockRef.current.active) {
        throw new Error("Managed media reconciliation paused while the workspace is locked.");
      }
      if (changed) {
        await persistWorkspace(reconciliation.state);
        studioRef.current = reconciliation.state;
        setStudio(reconciliation.state);
        toast.info(t("managedMediaReconciled", {
          missing: reconciliation.missingCount,
          relinked: reconciliation.relinkedCount,
          recovered: reconciliation.recoveredCount,
        }));
      }
      const cleanup = await Promise.allSettled(reconciliation.duplicateFiles.map(deleteManagedAsset));
      for (const outcome of cleanup) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
    }).catch((error) => {
      managedReconciliationRanRef.current = false;
      scheduleManagedReconciliationRetry();
      DIAGNOSTIC_LOG.append({ level: "error", event: "managed-media.reconcile", details: { error: errorMessage(error) } });
      toast.error(errorMessage(error));
    }).finally(() => {
      managedReconciliationPendingRef.current = Math.max(0, managedReconciliationPendingRef.current - 1);
    });
  }, [managedReconciliationRetry, nativeWorkspaceReady, persistWorkspace, scheduleManagedReconciliationRetry, studio.recovery?.requiresUserAction, t, updateMutationLock.active, workspaceBootState]);

  useEffect(() => {
    if (!nativeWorkspaceReady || workspaceBootState !== "ready" || updateMutationLock.active || studio.recovery?.requiresUserAction) return;
    const sync = () => setStudio((current) => {
      const preferences = captureWorkspacePreferences(localStorage);
      return JSON.stringify(current.preferences) === JSON.stringify(preferences)
        ? current : { ...current, preferences };
    });
    sync();
    window.addEventListener(PREFERENCES_CHANGED, sync);
    return () => window.removeEventListener(PREFERENCES_CHANGED, sync);
  }, [nativeWorkspaceReady, workspaceBootState, updateMutationLock.active, studio.recovery?.requiresUserAction]);

  useEffect(() => {
    if (!nativeWorkspaceReady || workspaceBootState !== "ready" || updateMutationLock.active) return;
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
  }, [nativeWorkspaceReady, persistWorkspace, studio, updateMutationLock.active, workspaceBootState]);

  useEffect(() => {
    if (!isTauriRuntime() || workspaceBootState !== "ready" || updateMutationLock.active) return;
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
      console.warn("Legacy asset migration failed; retaining IndexedDB fallback", error);
    }).finally(() => {
      migratingAssetIds.current.delete(candidate.asset.id);
    });
  }, [patchSession, studio, updateMutationLock.active, workspaceBootState]);

  useEffect(() => {
    saveWorkspacePreference(SESSION_SIDEBAR_OPEN_KEY, String(sessionSidebarOpen));
    saveWorkspacePreference(SESSION_SIDEBAR_WIDTH_KEY, String(Math.round(sessionSidebarWidth)));
  }, [sessionSidebarOpen, sessionSidebarWidth]);

  useEffect(() => {
    saveWorkspacePreference(RIGHT_PANEL_OPEN_KEY, String(rightPanelOpen));
  }, [rightPanelOpen]);

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
    if (connectionState !== "connected" || workspaceBootState !== "ready" || updateMutationLockRef.current.active) return;
    const hydrationRevision = ++catalogHydrationRevision.current;
    setCatalogLoading(true);
    setCatalogError(null);
    setCatalogErrors({});
    setImageEndpoints({});
    setPromptModelAvailability(plannerAvailabilityRecord("checking"));
    const applyCatalog = (catalogMode: GenerationMode, candidates: GenerationModel[]) => {
      const preferred = preferredCatalogModel(catalogMode, candidates);
      setCatalogs((current) => ({ ...current, [catalogMode]: candidates }));
      if (!updateMutationLockRef.current.active) setStudio((current) => ({
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
    const [imageOutcome, videoOutcome, plannerOutcome] = await Promise.allSettled([
      loadMode("image"),
      loadMode("video"),
      loadPromptModelAvailability(),
    ]);
    const outcomes = [imageOutcome, videoOutcome];
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [errorMessage(outcome.reason)] : []);
    setCatalogError(failures.length === outcomes.length ? failures.join(" · ") : null);
    if (plannerOutcome.status === "fulfilled") {
      setPromptModelAvailability(Object.fromEntries(PROMPT_MODELS.map((model) => [
        model.id,
        plannerOutcome.value[model.id] ? "available" : "unavailable",
      ])) as Record<PromptModel, PlannerAvailabilityStatus>);
    } else {
      DIAGNOSTIC_LOG.append({ level: "error", event: "planner_catalog.load_failed", details: { error: errorMessage(plannerOutcome.reason) } });
      setPromptModelAvailability(plannerAvailabilityRecord("unknown"));
    }
    setCatalogLoading(false);
  }, [connectionState, workspaceBootState]);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  useEffect(() => {
    if (connectionState !== "connected") {
      catalogHydrationRevision.current += 1;
      setPromptModelAvailability(plannerAvailabilityRecord("unknown"));
    }
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
    if (connectionState !== "connected" || workspaceBootState !== "ready" || updateMutationLock.active) return;
    const activeJobKeys = new Set(activeVideoJobIds.split("|"));
    for (const key of videoPollNotBefore.current.keys()) {
      if (!activeJobKeys.has(key)) videoPollNotBefore.current.delete(key);
    }
    if (!activeVideoJobIds) return;
    const pollActiveJobs = async () => {
      if (polling.current || updateMutationLockRef.current.active) return;
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
      if (!activeJobs.length || updateMutationLockRef.current.active) return;
      polling.current = true;
      let outcomes: PromiseSettledResult<void>[] = [];
      const persistPollState = async (sessionId: string, jobId: string) => {
        if (updateMutationLockRef.current.active) return;
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
            if (!updateMutationLockRef.current.active) {
              recordGenerationCost(sessionId, "video", job.threadId, job.attemptId, actualCostUsd);
            }
          });
          if (updateMutationLockRef.current.active) return;
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
            if (updateMutationLockRef.current.active) return;
            const asset = await importGeneratedVideo(
              source,
              `video-${job.jobId}.mp4`,
              "generated",
              job.jobId,
              typeof job.request.duration === "number" ? job.request.duration : undefined,
            );
            if (updateMutationLockRef.current.active) return;
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
          if (updateMutationLockRef.current.active) return;
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
  }, [activeVideoJobIds, connectionState, language, patchSession, persistWorkspace, recordGenerationCost, t, updateMutationLock.active, workspaceBootState]);

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

  const importFiles = async (files: FileList | File[]): Promise<SessionAsset[]> => withPendingWorkspaceMutation(async () => {
      const imported: SessionAsset[] = [];
      for (const file of Array.from(files)) {
        try {
          imported.push(await importFileAsset(file));
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }
      assertMutable();
      return commitImportedAssets(imported);
    });

  const pickFiles = async (kinds: SessionAsset["kind"][] = ["image", "video", "audio"]): Promise<SessionAsset[]> => {
    if (!isTauriRuntime()) {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = kinds.map((kind) => `${kind}/*`).join(",");
        input.multiple = true;
        input.onchange = () => void importFiles(input.files ?? []).then(resolve, () => resolve([]));
        input.oncancel = () => resolve([]);
        input.click();
      });
    }
    try {
      return await withPendingWorkspaceMutation(async () => {
        const imported = await pickManagedAssets(kinds);
        assertMutable();
        return commitImportedAssets(imported);
      });
    } catch (error) {
      toast.error(errorMessage(error));
      return [];
    }
  };

  const reimportAsset = async (assetId: string) => {
    assertMutable();
    pendingWorkspaceMutationRef.current += 1;
    try {
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
    assertMutable();
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
    } finally {
      pendingWorkspaceMutationRef.current = Math.max(0, pendingWorkspaceMutationRef.current - 1);
    }
  };

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlistenAssets = await listen<NativeManagedAsset[]>("managed-assets-imported", (event) => {
        if (!disposed && workspaceBootState === "ready" && !updateMutationLockRef.current.active) {
          void withPendingWorkspaceMutation(async () => commitImportedAssets(await managedDroppedAssets(event.payload)))
            .catch((error) => toast.error(errorMessage(error)));
        }
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
  }, [commitImportedAssets, withPendingWorkspaceMutation, workspaceBootState]);

  const addAssetAsReference = (assetId: string, notice?: GenerationResultNotice) => {
    assertMutable();
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
    const targetSupport = resolveInputCapabilities(targetThread.mode, targetModel, targetDraft.options, targetDraft.providerJson);
    if (!targetAsset) return;
    if (targetDraft.references.some((reference) => reference.assetId === assetId)) {
      toast.info(t("alreadyInput", { name: targetAsset.name }));
      return;
    }
    const validRole = availableInputRoles(targetSupport, targetDraft.references, targetSession.assets, targetAsset)[0];
    if (!validRole) {
      toast.error(t("unsupportedAssetInput"));
      return;
    }
    const references = [...targetDraft.references, {
      assetId,
      role: validRole,
      purpose: defaultReferencePurpose(targetAsset.kind, validRole),
      slot: nextReferenceSlot(targetDraft.references),
    }];
    const options = optionsForInputReferences(targetSupport, references, targetDraft.options);
    if (!notice) {
      patchDraft({ references, options });
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
          optionOverrides: optionOverridesFromDefaults(current.generationDefaults.options[targetThread.mode], options),
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
          draft: {
            ...item.draft,
            references,
            promptHistory: invalidatePromptEnhancement(item.draft.promptHistory),
          },
        } : item),
      },
    }));
    setStudio((current) => ({ ...current, activeSessionId: notice.sessionId }));
  };

  const editImageAsset = (assetId: string, notice?: GenerationResultNotice) => {
    assertMutable();
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
              promptHistory: invalidatePromptEnhancement(imageDraft.promptHistory),
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
    assertMutable();
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
              promptHistory: invalidatePromptEnhancement(currentDraft.promptHistory),
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

  const videoImageDestination = (assetId: string, notice?: GenerationResultNotice) => {
    const targetSession = studioRef.current.sessions.find((item) => item.id === (notice?.sessionId ?? studioRef.current.activeSessionId));
    const targetThread = targetSession?.threads.video.find((item) => item.id === targetSession.activeThreadIds.video);
    const asset = targetSession?.assets.find((item) => item.id === assetId);
    if (!targetSession || !targetThread || !asset) return;
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    const targetModel = catalogs.video.find((item) => item.id === effectiveThreadModelId(targetSession, targetThread)) ?? null;
    const support = resolveInputCapabilities("video", targetModel, targetDraft.options, targetDraft.providerJson);
    const references = videoImageReferences(support, targetDraft.references, targetSession.assets, asset);
    return references ? { targetSession, references, options: optionsForInputReferences(support, references, targetDraft.options) } : undefined;
  };

  const canUseResultInput = (assetId: string, notice: GenerationResultNotice) => {
    const targetSession = studioRef.current.sessions.find((item) => item.id === notice.sessionId);
    const targetThread = targetSession && [...targetSession.threads.image, ...targetSession.threads.video].find((item) => item.id === notice.threadId);
    const asset = targetSession?.assets.find((item) => item.id === assetId);
    if (!targetSession || !targetThread || !asset) return false;
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    if (targetDraft.references.some((reference) => reference.assetId === assetId)) return false;
    const targetModel = catalogs[targetThread.mode].find((item) => item.id === effectiveThreadModelId(targetSession, targetThread)) ?? null;
    return availableInputRoles(resolveInputCapabilities(targetThread.mode, targetModel, targetDraft.options, targetDraft.providerJson), targetDraft.references, targetSession.assets, asset).length > 0;
  };

  const routeImageToVideo = (assetId: string, notice?: GenerationResultNotice) => {
    assertMutable();
    const destination = videoImageDestination(assetId, notice);
    if (!destination) { toast.error(t("unsupportedAssetInput")); return; }
    const { targetSession, references, options } = destination;
    const patchTarget = (update: (current: StudioSession) => StudioSession) => patchSession(targetSession.id, update);
    patchTarget((current) => {
      const asset = current.assets.find((candidate) => candidate.id === assetId);
      if (!asset || asset.kind !== "image") return current;
      const targetId = current.activeThreadIds.video;
      return {
        ...current,
        mode: "video",
        threads: {
          ...current.threads,
          video: current.threads.video.map((candidate) => {
            if (candidate.id !== targetId) return candidate;
            const videoDraft = simplifyVideoDraft(candidate.draft);
            return {
              ...candidate,
              optionOverrides: optionOverridesFromDefaults(current.generationDefaults.options.video, options),
              draft: {
                ...videoDraft,
                references,
                promptHistory: invalidatePromptEnhancement(candidate.draft.promptHistory),
              },
              revision: candidate.revision + 1,
              updatedAt: new Date().toISOString(),
            };
          }),
        },
      };
    });
    if (notice) setStudio((current) => ({ ...current, activeSessionId: notice.sessionId }));
  };

  const selectStageModel = async (targetMode: GenerationMode, id: string) => {
    assertMutable();
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
    assertMutable();
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
            draft: { ...item.draft, promptHistory: invalidatePromptEnhancement(item.draft.promptHistory) },
            optionOverrides: optionOverridesFromDefaults(
              current.generationDefaults.options[targetMode],
              optionsForInputReferences(
                resolveInputCapabilities(targetMode, model, {}, effectiveThreadDraft(current, item).providerJson),
                effectiveThreadDraft(current, item).references,
                { ...nextDefaults, ...effectiveThreadDraft(current, item).options },
              ),
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
    assertMutable();
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

  const previewReferences = useMemo<ReferenceAsset[]>(() => {
    const references: ReferenceAsset[] = draft.references.flatMap((reference) => {
      const asset = assetMap.get(reference.assetId);
      const masked = mode === "image"
        && draft.imageEditMode
        && `@${reference.slot}` === draft.imageEditTarget.trim()
        && draft.maskStrokes.length > 0;
      return asset ? [{
        id: asset.id,
        name: masked ? `${asset.name} (transparent edit mask)` : asset.name,
        mediaType: masked ? "image/png" : asset.mimeType,
        dataUrl: previewAssetTransportUrl(asset, reference.slot),
        byteSize: asset.byteSize,
        role: reference.role,
        purpose: reference.purpose,
        slot: reference.slot,
      }] : [];
    });
    return references;
  }, [assetMap, draft.imageEditMode, draft.imageEditTarget, draft.maskStrokes.length, draft.references, mode]);

  const currentCheckpoint = currentPromptCheckpoint(draft.prompt, draft.promptHistory);
  const currentEnhancementArtifact = currentPromptEnhancementArtifact(
    draft.prompt,
    draft.promptHistory,
    currentEnhancementContext?.signature,
  );
  const prepareGenerationPrompt = (prompt: string) => {
    if (mode !== "image" || !draft.imageEditMode) return prompt.trim();
    return composeEditPrompt({
      prompt,
      target: draft.imageEditTarget.trim(),
      hasMask: draft.maskStrokes.length > 0,
      maskInstructions: draft.maskInstructions,
    });
  };
  const preparedPrompt = prepareGenerationPrompt(draft.prompt);
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
    negativePrompt: currentEnhancementArtifact?.negativePrompt,
  }), [currentEnhancementArtifact?.negativePrompt, draft.imageEditMode, draft.imageEditTarget, draft.options, draft.providerJson, mode, preparedPrompt, previewReferences, selectedId]);
  const draftPreparedRequest = useMemo(() => prepareOpenRouterRequest(previewGenerationDraft, selectedModel, {
    final: false,
    catalogFingerprint: currentCatalogFingerprint,
    sourceSignature: currentPreparationKey,
    planner: {
      requested: Boolean(currentEnhancementArtifact),
      modelId: currentEnhancementArtifact ? currentCheckpoint?.plannerModel ?? currentEnhancementArtifact.plannerModel : undefined,
      costUsd: currentEnhancementArtifact?.actualCostUsd,
    },
  }), [currentCatalogFingerprint, currentCheckpoint?.plannerModel, currentEnhancementArtifact, currentPreparationKey, previewGenerationDraft, selectedModel]);
  const requestPayload = draftPreparedRequest.sanitizedPayload;
  const requestBuildError = null;
  const previewReferencePriorities = currentEnhancementArtifact?.referencePriorities;
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
    negativePrompt: currentEnhancementArtifact?.negativePrompt,
  }, selectedModel, requestPayload, previewReferencePriorities, inputSupport.route), [inputSupport.route, currentEnhancementArtifact?.negativePrompt, draft.imageEditMode, draft.imageEditTarget, draft.options, draft.providerJson, mode, preparedPrompt, previewReferencePriorities, previewReferences, requestPayload, selectedId, selectedModel]);

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
      case "last_frame_requires_first_frame": return t("lastFrameRequiresFirst");
      case "reference_duration_unsupported": return t("referenceDurationUnsupported");
      case "reference_aspect_ratio_unsupported": return t("referenceAspectRatioUnsupported");
      case "reference_resolution_unsupported": return t("referenceResolutionUnsupported");
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
      return !asset || !roleOptions[asset.kind].includes(reference.role);
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
      referenceLimit: inputSupport.referenceLimits.image,
      totalReferenceLimit: inputSupport.referenceLimit,
      endpoint: inputSupport.endpoint,
      mode,
      modelId: selectedModel?.id,
      options: draft.options,
      }),
    ];
  }, [assetMap, draft.options, draft.references, inputSupport, mode, referenceLimit, roleOptions, roles, selectedModel]);
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
    ?? null;

  const sessionSpendUsd = session.costLedger.reduce((total, entry) => total + entry.actualCostUsd, 0);
  const transferBytes = previewReferences.reduce((total, reference) => total + (reference.byteSize ?? 0), 0);
  const generationCost = selectedModel ? draftPreparedRequest.cost : undefined;

  const requestPreflightErrors = [
    connectionState !== "connected" ? t(connectionState === "validating" ? "keyValidating" : connectionState === "unauthorized" ? "keyUnauthorized" : connectionState === "rate_limited" ? "keyRateLimited" : connectionState === "offline" || connectionState === "server_error" ? "keyOffline" : connectionState === "missing" ? "apiKeyMissingHint" : "keyStored") : null,
    !selectedModel && selectedId ? t("modelUnavailable") : !selectedModel ? t("chooseModel") : null,
    !hasRunnableInstructions(mode, draft)
      ? mode === "image" && draft.imageEditMode && draft.maskStrokes.length ? t("enterPromptOrMaskInstructions") : t("enterPromptFirst")
      : null,
    providerError,
    requestBuildError,
    ...draftPreparedRequest.issues.map((issue) => issue.message.includes("no provider slug") ? t("providerRouteUnavailable") : issue.message),
    inputValidationError,
    generationValidationError,
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
    assertMutable();
    const targetDraft = effectiveThreadDraft(targetSession, targetThread);
    if (!targetDraft.prompt.trim()) throw new Error(t("enterPromptFirst"));
    if (promptModelAvailability[studioRef.current.promptModel] !== "available") throw new Error(t("promptModelAvailabilityUnavailable"));
    if (targetThread.enhancementAttempts?.at(-1)?.status === "uncertain" && !await confirmAction(
      t("uncertainEnhancementTitle"),
      t("uncertainEnhancementHint"),
      t("retryPaidEnhancement"),
    )) {
      throw new Error(t("uncertainEnhancementHint"));
    }
    assertMutable();
    pendingWorkspaceMutationRef.current += 1;
    setEnhancingThreadIds((current) => new Set(current).add(targetThread.id));
    let enhancementAttemptId: string | undefined;
    let reportedCostUsd = 0;
    let resultReady = false;
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
      const dispatchSnapshot = {
        threadRevision: targetThread.revision,
        editRevision: targetDraft.promptHistory.editRevision,
        prompt: targetDraft.prompt,
        contextSignature: context.signature,
      };
      const enhancementState = commitStudioNow((current) => ({
        ...current,
        sessions: current.sessions.map((candidateSession) => candidateSession.id === targetSession.id ? {
          ...candidateSession,
          updatedAt: startedAt,
          threads: {
            ...candidateSession.threads,
            [targetThread.mode]: candidateSession.threads[targetThread.mode].map((item) => item.id === targetThread.id ? {
              ...item,
              draft: {
                ...item.draft,
                promptHistory: beginPromptEnhancement(item.draft.promptHistory, targetDraft.prompt, {
                  attemptId: enhancementAttemptId!,
                  plannerModel,
                  inputHash: context.signature,
                  createdAt: startedAt,
                }),
              },
              enhancementAttempts: [...(item.enhancementAttempts ?? []), {
                id: enhancementAttemptId!,
                requestKey: context.signature,
                status: "in_progress",
                threadRevision: dispatchSnapshot.threadRevision,
                editRevision: dispatchSnapshot.editRevision,
                contextSignature: dispatchSnapshot.contextSignature,
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
      const completedArtifact = actualCostUsd > 0 && artifact.actualCostUsd == null
        ? { ...artifact, actualCostUsd }
        : artifact;
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
              [targetThread.mode]: withCost.threads[targetThread.mode].map((item) => {
                if (item.id !== targetThread.id) return item;
                const currentDraft = effectiveThreadDraft(withCost, item);
                const currentModelId = effectiveThreadModelId(withCost, item);
                const currentModel = catalogs[item.mode].find((candidate) => candidate.id === currentModelId) ?? null;
                const currentContext = currentModel
                  ? enhancementContext(withCost, item, currentDraft, currentModel, current.promptModel)
                  : null;
                const autoApply = item.revision === dispatchSnapshot.threadRevision
                  && currentDraft.promptHistory.editRevision === dispatchSnapshot.editRevision
                  && currentDraft.prompt === dispatchSnapshot.prompt
                  && currentContext?.signature === dispatchSnapshot.contextSignature;
                const completed = completePromptEnhancement(
                  item.draft.promptHistory,
                  item.draft.prompt,
                  completedArtifact,
                  {
                    attemptId: enhancementAttemptId!,
                    plannerModel,
                    autoApply,
                    outputHash: enhancementContext(
                      targetSession,
                      targetThread,
                      targetDraft,
                      targetModel,
                      plannerModel,
                      completedArtifact.prompt,
                    ).signature,
                    createdAt: completedAt,
                  },
                );
                if (!autoApply) resultReady = true;
                return {
                  ...item,
                  draft: {
                    ...item.draft,
                    prompt: completed.prompt,
                    promptHistory: completed.history,
                  },
                  enhancementAttempts: (item.enhancementAttempts ?? []).map((entry) => entry.id === enhancementAttemptId ? {
                    ...entry,
                    status: "completed",
                    enhancedPrompt: completedArtifact.prompt,
                    actualCostUsd: actualCostUsd || undefined,
                    costRecordedAt: actualCostUsd > 0 ? completedAt : undefined,
                    updatedAt: completedAt,
                  } : entry),
                  updatedAt: completedAt,
                };
              }),
            },
          };
        }),
      }));
      await persistWorkspace(completedState);
      if (resultReady) toast.info(t("promptEnhancementResultReady"));
      return completedArtifact;
    } catch (error) {
      if (enhancementAttemptId) {
        const failedAt = new Date().toISOString();
        const uncertain = reportedCostUsd > 0 || mayHaveReachedPaidEndpoint(error);
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
                [targetThread.mode]: withCost.threads[targetThread.mode].map((item) => {
                  if (item.id !== targetThread.id) return item;
                  const selectedCheckpoint = item.draft.promptHistory.entries[item.draft.promptHistory.cursor];
                  const resultWasApplied = selectedCheckpoint?.kind === "enhancement_result"
                    && selectedCheckpoint.enhancementAttemptId === enhancementAttemptId
                    && selectedCheckpoint.text === item.draft.prompt;
                  const enhancementAttempt = (item.enhancementAttempts ?? []).find((entry) => entry.id === enhancementAttemptId);
                  return {
                    ...item,
                    draft: {
                      ...item.draft,
                      prompt: resultWasApplied && enhancementAttempt
                        ? enhancementAttempt.originalPrompt
                        : item.draft.prompt,
                      promptHistory: failPromptEnhancement(item.draft.promptHistory, enhancementAttemptId!),
                    },
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
                  };
                }),
              },
            };
          }),
        }));
        try {
          await persistWorkspace(failedState);
        } catch (persistenceError) {
          throw new Error(`${errorMessage(error)} ${errorMessage(persistenceError)}`);
        }
      }
      throw error;
    } finally {
      pendingWorkspaceMutationRef.current = Math.max(0, pendingWorkspaceMutationRef.current - 1);
      setEnhancingThreadIds((current) => {
        const next = new Set(current);
        next.delete(targetThread.id);
        return next;
      });
    }
  };

  const hydrateThreadReferences = async (
    targetSession: StudioSession,
    targetThread: GenerationThread,
    targetDraft: GenerationDraftState,
  ): Promise<ReferenceAsset[]> => {
    const hydrated: ReferenceAsset[] = await Promise.all(targetDraft.references.map(async (reference) => {
    const targetAssetMap = new Map(targetSession.assets.map((asset) => [asset.id, asset]));
    const asset = targetAssetMap.get(reference.assetId);
    if (!asset) throw new Error(t("missingReference", { slot: reference.slot }));
    if (asset.storageAvailability === "missing") throw new Error(`Reference @${reference.slot} is missing from local storage and must be relinked.`);
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
    return hydrated;
  };

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
        validateProviderConfiguration(targetDraft.providerJson, model);
      } catch (error) {
        try { JSON.parse(targetDraft.providerJson); } catch { return t("invalidJson"); }
        return errorMessage(error);
      }
    }
    const targetAssets = new Map(targetSession.assets.map((asset) => [asset.id, asset]));
    const routeResolution = resolveEligibleRoute({
      mode: targetThread.mode,
      model,
      options: targetDraft.options,
      providerJson: targetDraft.providerJson,
    });
    if (routeResolution.errors.length) return routeResolution.errors[0].message;
    if (!routeResolution.selected) return routeResolution.warnings[0] ?? "No eligible provider endpoint is available.";
    const targetReferences = targetDraft.references;
    const targetSupport = resolveInputCapabilities(targetThread.mode, model, targetDraft.options, targetDraft.providerJson);
    const targetRoles = [...new Set(Object.values(targetSupport.roles).flat())];
    const unsupported = targetReferences.find((reference) => {
      const asset = targetAssets.get(reference.assetId);
      if (!asset) return true;
      return !targetSupport.roles[asset.kind].includes(reference.role);
    });
    if (unsupported) return t("unsupportedReference", { slot: unsupported.slot });
    if (targetThread.mode === "image") {
      const minimum = targetSupport.minimum;
      const imageCount = targetReferences.filter((reference) => targetAssets.get(reference.assetId)?.kind === "image").length;
      if (imageCount < minimum) return `This model requires at least ${minimum} image reference${minimum === 1 ? "" : "s"}.`;
    }
    const preflightPrompt = targetThread.mode === "image" && targetDraft.imageEditMode
      ? composeEditPrompt({
        prompt: targetDraft.prompt,
        target: targetDraft.imageEditTarget.trim(),
        hasMask: targetDraft.maskStrokes.length > 0,
        maskInstructions: targetDraft.maskInstructions,
      })
      : targetDraft.prompt.trim();
    const targetPreviewReferences: ReferenceAsset[] = targetReferences.flatMap((reference) => {
      const asset = targetAssets.get(reference.assetId);
      return asset ? [{
        id: asset.id,
        name: asset.name,
        mediaType: asset.mimeType,
        dataUrl: previewAssetTransportUrl(asset, reference.slot),
        byteSize: asset.byteSize,
        role: reference.role,
        purpose: reference.purpose,
        slot: reference.slot,
      }] : [];
    });
    const strictPreflight = prepareOpenRouterRequest({
      mode: targetThread.mode,
      model: modelId,
      prompt: preflightPrompt,
      assets: targetPreviewReferences,
      options: targetDraft.options,
      providerJson: targetDraft.providerJson,
      editTargetSlot: targetDraft.imageEditMode
        ? Number(targetDraft.imageEditTarget.match(/^@(\d+)$/)?.[1] ?? 0) || undefined
        : undefined,
      negativePrompt: (() => {
        const context = enhancementContext(targetSession, targetThread, targetDraft, model, studioRef.current.promptModel);
        return currentPromptEnhancementArtifact(
          targetDraft.prompt,
          targetDraft.promptHistory,
          context.signature,
        )?.negativePrompt;
      })(),
    }, model, {
      final: false,
      route: routeResolution.selected,
      catalogFingerprint: catalogFingerprint(catalogs[targetThread.mode]),
    });
    if (strictPreflight.status !== "ready") return strictPreflight.issues[0]?.message ?? "The request cannot be prepared.";
    return inputConstraintMessage(validateInputConstraints({
      references: targetReferences.map((reference) => {
        const asset = targetAssets.get(reference.assetId);
        return { ...reference, kind: asset?.kind ?? "image", byteSize: asset?.byteSize, width: asset?.width, height: asset?.height, duration: asset?.duration, fps: asset?.fps, mimeType: asset?.mimeType, codec: asset?.codec, facePresence: asset?.facePresence };
      }),
      allowedRoles: targetRoles,
      limit: targetSupport.limit,
      referenceLimit: targetSupport.referenceLimits.image,
      totalReferenceLimit: targetSupport.referenceLimit,
      endpoint: targetSupport.endpoint,
      mode: targetThread.mode,
      modelId: model.id,
      options: targetDraft.options,
    }));
  };

  const prepareRequestForReview = async () => {
    assertMutable();
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
    pendingWorkspaceMutationRef.current += 1;
    setPreparingRequest(true);
    try {
      const targetEnhancementContext = enhancementContext(targetSession, targetThread, targetDraft, targetModel, studioRef.current.promptModel);
      const checkpoint = currentPromptCheckpoint(targetDraft.prompt, targetDraft.promptHistory);
      const artifact = currentPromptEnhancementArtifact(
        targetDraft.prompt,
        targetDraft.promptHistory,
        targetEnhancementContext.signature,
      );
      const prompt = targetDraft.prompt.trim();
      const finalPrompt = targetThread.mode === "image" && targetDraft.imageEditMode
        ? composeEditPrompt({ prompt, target: targetDraft.imageEditTarget.trim(), hasMask: targetDraft.maskStrokes.length > 0, maskInstructions: targetDraft.maskInstructions })
        : prompt;
      const finalRoute = resolveEligibleRoute({
        mode: targetThread.mode,
        model: targetModel,
        options: targetDraft.options,
        providerJson: targetDraft.providerJson,
      }).selected;
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
      const finalRequest = prepareOpenRouterRequest(generationDraft, targetModel, {
        final: true,
        route: finalRoute,
        catalogFingerprint: catalogFingerprint(catalogs[targetThread.mode]),
        sourceSignature: preparationKeyFor(targetSession, targetThread, targetDraft, targetModel),
        planner: {
          requested: Boolean(artifact),
          modelId: artifact ? checkpoint?.plannerModel ?? artifact.plannerModel : undefined,
          costUsd: artifact?.actualCostUsd,
          // The prompt planner is a separate OpenRouter request and has no
          // hydrated endpoint/privacy contract in this flow.
          inheritsConstraints: !artifact,
        },
      });
      if (finalRequest.status !== "ready") {
        throw new Error(finalRequest.issues.map((issue) => issue.message).join(" · "));
      }
      const payload = preparedRequestPayload(finalRequest);
      const coverage = referenceCoverageReport(generationDraft, targetModel, payload, artifact?.referencePriorities, finalRoute);
      const coverageError = validateReferenceCoverage(coverage);
      if (coverageError) throw new Error(coverageError);
      assertMutable();
      setPreparedRequest({
        key: preparationKeyFor(targetSession, targetThread, targetDraft, targetModel),
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
      pendingWorkspaceMutationRef.current = Math.max(0, pendingWorkspaceMutationRef.current - 1);
      setPreparingRequest(false);
    }
  };

  const runEnhancement = async () => {
    assertMutable();
    if (!promptEnhancementEnabled) throw new Error(
      selectedPromptModelAvailability === "available" ? t("enterPromptFirst") : t("promptModelAvailabilityUnavailable"),
    );
    if (localStorage.getItem(PROMPT_ENHANCEMENT_NOTICE_KEY) !== "true") {
      const accepted = await confirmAction(
        t("promptEnhancement"),
        t("promptEnhancementFirstUseNotice"),
        t("enhancePrompt"),
      );
      if (!accepted) return undefined;
      assertMutable();
      saveWorkspacePreference(PROMPT_ENHANCEMENT_NOTICE_KEY, "true");
    }
    return enhanceThreadPrompt(session, thread);
  };

  const navigatePromptEnhancementHistory = (direction: "undo" | "redo") => {
    assertMutable();
    let changed = false;
    const next = commitStudioNow((current) => ({
      ...current,
      sessions: current.sessions.map((candidateSession) => {
        if (candidateSession.id !== session.id) return candidateSession;
        return {
          ...candidateSession,
          threads: {
            ...candidateSession.threads,
            [thread.mode]: candidateSession.threads[thread.mode].map((candidateThread) => {
              if (candidateThread.id !== thread.id) return candidateThread;
              const navigation = direction === "undo"
                ? undoPromptEnhancement(candidateThread.draft.promptHistory, candidateThread.draft.prompt)
                : redoPromptEnhancement(candidateThread.draft.promptHistory);
              if (!navigation) return candidateThread;
              changed = true;
              return {
                ...candidateThread,
                draft: {
                  ...candidateThread.draft,
                  prompt: navigation.prompt,
                  promptHistory: navigation.history,
                },
                revision: candidateThread.revision + 1,
                updatedAt: new Date().toISOString(),
              };
            }),
          },
        };
      }),
    }));
    if (changed) {
      setPreparedRequest(null);
      void persistWorkspace(next).catch((error) => toast.error(errorMessage(error)));
    }
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
    assertMutable();
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
    assertMutable();
    const attemptId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const attemptReferences = targetDraft.references;
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
        promptHistory: structuredClone(targetDraft.promptHistory),
        options: structuredClone(targetDraft.options),
        providerJson: targetDraft.providerJson,
        assetBindings: targetDraft.references.map((reference) => ({ ...reference })),
        imageEditMode: targetDraft.imageEditMode,
        imageEditTarget: targetDraft.imageEditTarget,
        maskInstructions: targetDraft.maskInstructions,
        maskStrokes: structuredClone(targetDraft.maskStrokes),
        directorPlan: targetDraft.directorPlan ? structuredClone(targetDraft.directorPlan) : undefined,
      },
      inputAssetIds: [...new Set(attemptReferences.map((reference) => reference.assetId))],
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
          promptHistory: structuredClone(targetDraft.promptHistory),
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
    assertMutable();
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
            promptHistory: structuredClone(snapshot.promptHistory),
            references: snapshot.assetBindings.map((binding) => ({ ...binding })),
            imageEditMode: snapshot.imageEditMode,
            imageEditTarget: snapshot.imageEditTarget,
            maskInstructions: snapshot.maskInstructions,
            maskStrokes: structuredClone(snapshot.maskStrokes),
            directorPlan: snapshot.directorPlan ? structuredClone(snapshot.directorPlan) : undefined,
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
    assertMutable();
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
          promptHistory: structuredClone(snapshot.promptHistory),
          references: snapshot.assetBindings.map((binding) => ({ ...binding })),
          imageEditMode: snapshot.imageEditMode,
          imageEditTarget: snapshot.imageEditTarget,
          maskInstructions: snapshot.maskInstructions,
          maskStrokes: structuredClone(snapshot.maskStrokes),
          directorPlan: snapshot.directorPlan ? structuredClone(snapshot.directorPlan) : undefined,
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
    assertMutable();
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
    try {
      await withPendingWorkspaceMutation(async () => {
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
        assertMutable();
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
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const activateThread = (id: string) => {
    assertMutable();
    patchActive((current) => ({ ...current, activeThreadIds: { ...current.activeThreadIds, [current.mode]: id } }));
  };

  const createThread = useCallback(() => {
    assertMutable();
    patchActive((current) => {
      const active = current.threads[current.mode].find((item) => item.id === current.activeThreadIds[current.mode]);
      if (!active) return current;
      const next = createSiblingGenerationThread(active, current.threads[current.mode].length + 1);
      return {
        ...current,
        threads: { ...current.threads, [current.mode]: [...current.threads[current.mode], next] },
        activeThreadIds: { ...current.activeThreadIds, [current.mode]: next.id },
      };
    });
  }, [assertMutable, patchActive]);

  const duplicateThread = (id: string) => {
    assertMutable();
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
        draft: structuredClone(source.draft),
      };
      return {
        ...current,
        threads: { ...current.threads, [current.mode]: [...current.threads[current.mode], copy] },
        activeThreadIds: { ...current.activeThreadIds, [current.mode]: copy.id },
      };
    });
  };

  const renameThread = (id: string, name: string) => {
    assertMutable();
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
    assertMutable();
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
  }, [assertMutable, patchActive]);

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
    assertMutable();
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

  const deleteAssets = async (ids: string[]) => {
    assertMutable();
    pendingWorkspaceMutationRef.current += 1;
    try {
    const deleting = session.assets.filter((asset) => ids.includes(asset.id));
    const inUse = [...session.threads.image, ...session.threads.video].some((item) =>
      item.draft.references.some((reference) => ids.includes(reference.assetId)),
    );
    if (!deleting.length || !await confirmAction(
      inUse ? t("deleteAttachedAssets") : t("deleteAssetsTitle"),
      `${inUse ? t("deleteAttachedAssetsHint") : t("deleteAssetsHint")}\n\n${deleting.length}: ${deleting.map((asset) => `${asset.name} (${asset.kind})`).join(", ")}`,
      t("deleteAssets"),
    )) return;
    assertMutable();
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
          draft: {
            ...item.draft,
            references: item.draft.references.filter((reference) => !deletedIds.includes(reference.assetId)),
            promptHistory: item.draft.references.some((reference) => deletedIds.includes(reference.assetId))
              ? invalidatePromptEnhancement(item.draft.promptHistory)
              : item.draft.promptHistory,
          },
        })),
        video: current.threads.video.map((item) => ({
          ...item,
          draft: {
            ...item.draft,
            references: item.draft.references.filter((reference) => !deletedIds.includes(reference.assetId)),
            promptHistory: item.draft.references.some((reference) => deletedIds.includes(reference.assetId))
              ? invalidatePromptEnhancement(item.draft.promptHistory)
              : item.draft.promptHistory,
          },
        })),
      },
    }));
    await persistWorkspace(studioRef.current).catch((error) => toast.error(errorMessage(error)));
    setSelectedAssetIds(new Set());
    if (failures.length) toast.error(t("someAssetDeletesFailed", { error: failures.join(" · ") }));
    } finally {
      pendingWorkspaceMutationRef.current = Math.max(0, pendingWorkspaceMutationRef.current - 1);
    }
  };

  const mentionMatch = draft.prompt.slice(0, mentionCaret).match(/(?:^|\s)@(\d*)$/);
  const mentionSuggestions = mentionMenuOpen && mentionMatch
    ? draft.references.filter((reference) => String(reference.slot).startsWith(mentionMatch[1]))
    : [];
  const insertInputMention = (slot: number, completeSuggestion = false) => {
    assertMutable();
    const input = promptRef.current;
    const start = completeSuggestion && mentionMatch
      ? mentionCaret - mentionMatch[1].length - 1
      : input?.selectionStart ?? draft.prompt.length;
    const end = completeSuggestion ? mentionCaret : input?.selectionEnd ?? start;
    const prefix = start > 0 && !/\s$/.test(draft.prompt.slice(0, start)) ? " " : "";
    const inserted = `${prefix}@${slot} `;
    const nextPrompt = draft.prompt.slice(0, start) + inserted + draft.prompt.slice(end);
    pendingMentionSelection.current = { prompt: nextPrompt, caret: start + inserted.length };
    patchDraft({ prompt: nextPrompt });
    setMentionMenuOpen(false);
  };
  useLayoutEffect(() => {
    const selection = pendingMentionSelection.current;
    pendingMentionSelection.current = null;
    if (!selection || selection.prompt !== draft.prompt) return;
    promptRef.current?.focus({ preventScroll: true });
    promptRef.current?.setSelectionRange(selection.caret, selection.caret);
  }, [draft.prompt]);
  const validPromptMentions = useMemo(
    () => findInputMentions(draft.prompt, draft.references.map((reference) => reference.slot)),
    [draft.prompt, draft.references],
  );
  const mentionedSlots = useMemo(
    () => mentionedInputSlots(draft.prompt, draft.references.map((reference) => reference.slot)),
    [draft.prompt, draft.references],
  );
  const hasMask = mode === "image" && draft.imageEditMode && draft.maskStrokes.length > 0;
  const canPrepareRequest = Boolean(selectedModel && draftPreparedRequest.status === "ready" && hasRunnableInstructions(mode, draft) && !providerError && !requestBuildError && !inputValidationError && !generationValidationError && connectionState === "connected" && !generating && !enhancing && !activeAttempt);
  const canGenerate = Boolean(canPrepareRequest && currentPreparedRequest && !preparingRequest);
  const needsInstructions = connectionState === "connected" && Boolean(selectedModel) && !hasRunnableInstructions(mode, draft);
  const generationIsBlocked = !needsInstructions && requestPreflightErrors.length > 0;
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
              ? { label: t("reviewInputs"), run: () => {
                window.requestAnimationFrame(() => {
                  const field = document.querySelector<HTMLElement>(maskReferenceError
                    ? ".mask-instructions textarea"
                    : editTargetError ? ".edit-media-actions > button:last-child" : ".reference-section");
                  field?.scrollIntoView({ block: "center" });
                  (field?.matches("input, select, textarea, button") ? field : field?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
                });
              }, icon: <ImageIcon /> }
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
      if (action && updateMutationLockRef.current.active) {
        setResultQueuePaused(false);
        return;
      }
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
    assertMutable();
    setStudio((current) => ({ ...current, activeSessionId: id }));
    setSelectedAssetIds(new Set());
    setFocusedAssetId(null);
    setPreviewAssetId(null);
  };
  const createNewSession = () => {
    assertMutable();
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
    assertMutable();
    pendingWorkspaceMutationRef.current += 1;
    try {
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
    assertMutable();
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
    } finally {
      pendingWorkspaceMutationRef.current = Math.max(0, pendingWorkspaceMutationRef.current - 1);
    }
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

  const updateOperationGate = () => inspectActiveUpdateOperations({
    state: studioRef.current,
    pendingMaterializationCount: pendingWorkspaceMutationRef.current
      + managedReconciliationPendingRef.current
      + migratingAssetIds.current.size
      + executingThreadIds.size
      + enhancingThreadIds.size
      + (polling.current ? 1 : 0),
    pendingDurableSaveCount: nativeSavePendingRef.current,
    durableSaveError: nativeSaveErrorRef.current,
  });

  const prepareLosslessUpdate = async ({
    fromVersion,
    toVersion,
    signal,
    onProgress,
  }: UpdatePreparationContext) => {
    if (updateMutationLockRef.current.active) {
      throw new Error("Another update preparation is already active.");
    }
    pendingUpdateTransactionRef.current = null;
    replaceUpdateMutationLock({ active: true, reason: "update" });
    const preparation = (async () => {
      const assertNotCancelled = () => {
        if (signal.aborted) throw new Error("Update preparation was cancelled.");
      };
      assertNotCancelled();
      const initialGate = updateOperationGate();
      const initialBlockers = initialGate.blockers.filter((blocker) => blocker !== "durable_save_pending");
      if (initialBlockers.length > 0) {
        throw new Error(initialGate.activeOperationCount > 0
          ? t("updateBlockedAttempts", { count: initialGate.activeOperationCount })
          : t("updateDurableSaveFailed"));
      }

      onProgress("preparing_workspace", 15);
      await nativeSaveQueueRef.current;
      assertNotCancelled();
      await persistWorkspace(studioRef.current);
      await nativeSaveQueueRef.current;
      assertNotCancelled();
      const settledGate = updateOperationGate();
      if (!settledGate.allowed) {
        throw new Error(settledGate.activeOperationCount > 0
          ? t("updateBlockedAttempts", { count: settledGate.activeOperationCount })
          : t("updateDurableSaveFailed"));
      }

      onProgress("verifying_assets", 55);
      const cancelNativePreparation = () => {
        void invoke<boolean>("cancel_update_snapshot_preparation").catch((error) => {
          DIAGNOSTIC_LOG.append({
            level: "error",
            event: "update.snapshot_cancel_failed",
            details: { error: errorMessage(error) },
          });
        });
      };
      signal.addEventListener("abort", cancelNativePreparation, { once: true });
      let unlistenProgress: (() => void) | undefined;
      let transaction: NativeUpdateTransaction;
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenProgress = await listen<NativeUpdatePreparationProgress>("update-preparation-progress", (event) => {
          if (signal.aborted) return;
          const progress = event.payload.totalByteSize > 0
            ? 55 + Math.round((event.payload.totalBytesHashed / event.payload.totalByteSize) * 44)
            : 99;
          onProgress("verifying_assets", Math.min(99, progress));
        });
        assertNotCancelled();
        transaction = await invoke<NativeUpdateTransaction>("create_pre_update_snapshot", {
          fromVersion,
          toVersion,
        });
      } finally {
        signal.removeEventListener("abort", cancelNativePreparation);
        unlistenProgress?.();
      }
      pendingUpdateTransactionRef.current = transaction;
      replaceUpdateMutationLock({ active: true, reason: "update", transactionId: transaction.id });
      assertNotCancelled();
      const finalGate = updateOperationGate();
      if (!finalGate.allowed) {
        throw new Error("The workspace changed after its update snapshot was created.");
      }
      onProgress("verifying_assets", 100);
    })();
    updatePreparationPromiseRef.current = preparation;
    await preparation;
  };

  const abortLosslessUpdate = async () => {
    await updatePreparationPromiseRef.current?.catch(() => undefined);
    const transaction = pendingUpdateTransactionRef.current;
    if (transaction) {
      if (["installing", "awaiting_restart", "verifying"].includes(transaction.phase)) {
        replaceUpdateMutationLock({ active: true, reason: "update", transactionId: transaction.id });
        await requireUpdateRecovery(
          transaction,
          "update_relaunch_required",
          new Error("The app update reached installation and must be verified or restored before the workspace can reopen."),
        );
        return;
      }
      try {
        await invoke("abort_update_transaction", { transactionId: transaction.id });
      } catch (error) {
        DIAGNOSTIC_LOG.append({
          level: "error",
          event: "update.abort_failed",
          details: { transactionId: transaction.id, error: errorMessage(error) },
        });
        replaceUpdateMutationLock({ active: true, reason: "update", transactionId: transaction.id });
        await requireUpdateRecovery(transaction, "update_relaunch_required", error);
        throw error;
      }
    }
    pendingUpdateTransactionRef.current = null;
    updatePreparationPromiseRef.current = null;
    replaceUpdateMutationLock({ active: false });
  };

  const requireInstalledUpdateRecovery = async (error: unknown) => {
    const transaction = pendingUpdateTransactionRef.current;
    if (!transaction) throw error;
    replaceUpdateMutationLock({ active: true, reason: "update", transactionId: transaction.id });
    await requireUpdateRecovery(transaction, "update_relaunch_required", error);
  };

  const persistUpdateInstallPhase = async (phase: UpdateInstallPhase) => {
    const transaction = pendingUpdateTransactionRef.current;
    if (!transaction) throw new Error("The pre-update snapshot transaction is missing.");
    const nativePhase: UpdateTransactionPhase = phase === "restarting"
      ? "awaiting_restart"
      : phase;
    const updated = await invoke<NativeUpdateTransaction>("set_update_transaction_phase", {
      transactionId: transaction.id,
      phase: nativePhase,
    });
    pendingUpdateTransactionRef.current = updated;
  };

  const retryUpdateVerification = async () => {
    if (!updateRecovery) return;
    const { getVersion } = await import("@tauri-apps/api/app");
    const runningVersion = await getVersion();
    if (runningVersion !== updateRecovery.transaction.toAppVersion) {
      throw new Error(`Update verification requires app version ${updateRecovery.transaction.toAppVersion}, but this is ${runningVersion}.`);
    }
    await verifyPendingNativeUpdate(updateRecovery.transaction);
  };

  const restorePreUpdateWorkspace = async () => {
    if (!updateRecovery) return;
    await invoke("restore_pre_update_snapshot", { transactionId: updateRecovery.transaction.id });
    const { getVersion } = await import("@tauri-apps/api/app");
    const runningVersion = await getVersion();
    if (runningVersion === updateRecovery.transaction.toAppVersion) {
      await verifyPendingNativeUpdate(updateRecovery.transaction);
      return;
    }
    if (runningVersion === updateRecovery.transaction.fromAppVersion) {
      await invoke<NativeUpdateTransaction>("abandon_update_transaction_after_source_relaunch", {
        transactionId: updateRecovery.transaction.id,
      });
      pendingUpdateTransactionRef.current = null;
      replaceUpdateMutationLock({ active: false });
      window.location.reload();
      return;
    }
    throw new Error(`The restored workspace requires app version ${updateRecovery.transaction.fromAppVersion}, but this is ${runningVersion}.`);
  };

  const exportPreUpdateWorkspace = async () => {
    if (!updateRecovery) return;
    const path = await invoke<string>("export_pre_update_snapshot", {
      transactionId: updateRecovery.transaction.id,
    });
    toast.success(`Pre-update workspace exported to ${path}.`);
  };

  const openUpdateAssetFolder = async () => {
    const path = await invoke<string>("update_asset_folder");
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  };

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
    if (updateMutationLockRef.current.active || workspaceBootState !== "ready") return false;
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
  }, [archiveThread, canGenerate, closeTopmostDialog, confirmation, createThread, cycleThread, focusPrompt, focusedAsset, hasActiveAttempt, modalOpen, mode, modeThreads.length, previewAsset, requestAppQuit, rightPanelOpen, session.threads, settingsOpen, shortcutHelpOpen, t, thread.id, workspaceBootState]);
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
      quit: !updateMutationLock.active && workspaceBootState === "ready",
    },
    checked: {
      toggleSessionSidebar: sessionSidebarOpen,
      toggleInspector: rightPanelOpen,
      imageMode: mode === "image",
      videoMode: mode === "video",
      showAssets: rightPanelOpen,
    },
  }), [canGenerate, confirmation, focusedAsset, hasActiveAttempt, hasArchivedThread, modalOpen, mode, modeThreads.length, previewAsset, rightPanelOpen, sessionSidebarOpen, settingsOpen, shortcutHelpOpen, updateMutationLock.active, workspaceBootState]);
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
    <div
      className="app-shell"
      data-workspace-boot-state={workspaceBootState}
      data-update-locked={updateMutationLock.active ? "true" : "false"}
      aria-hidden={onboardingOpen !== false || workspaceBootState !== "ready" || updateMutationLock.active || Boolean(updateRecovery)}
      inert={onboardingOpen !== false || workspaceBootState !== "ready" || updateMutationLock.active || updateRecovery ? true : undefined}
    >
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><span className="brand-mark"><FruitTruckMark /></span><strong>Fruit Truck</strong></div>
        <ModelSelector mode={mode} models={models} selectedId={selectedId} loading={catalogLoading} onSelect={selectModel} />
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
        <section className={`composer ${mode === "image" && draft.imageEditMode ? "edit-active" : ""}`}>
          <GenerationThreadRail
            leadingAction={!sessionSidebarOpen ? (
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
            trailingAction={!rightPanelOpen ? (
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
            {policyNotices.length ? <details className="model-guidance"><summary><CircleAlert />{t("modelPolicyNotice")}<span>{policyNotices.length}</span><ChevronRight /></summary>
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
            </details> : null}
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
                  assertMutable();
                  const references = draft.references.map((reference) => {
                    const isTarget = value && `@${reference.slot}` === draft.imageEditTarget;
                    if (isTarget) return markReferenceAsEditTarget(reference);
                    if (reference.purpose !== "edit_target") return reference;
                    return restoreReferenceAfterEditTarget(reference, assetMap.get(reference.assetId)?.kind ?? "image");
                  });
                  patchDraft({
                    imageEditMode: value,
                    references,
                  });
                }} />
              </Field.Root>
            ) : null}
            {mode === "image" && draft.imageEditMode ? (
              <>
                <Suspense fallback={null}>
                <ImageEditPanel
                  key={`${thread.id}:${editTargetAsset?.id ?? "empty"}`}
                  asset={editTargetAsset}
                  targetLabel={editReference ? `@${editReference.slot}` : ""}
                  maskStrokes={draft.maskStrokes}
                  maskInstructions={draft.maskInstructions}
                  maskError={maskReferenceError}
                  onMaskStrokesChange={(maskStrokes) => {
                    assertMutable();
                    patchDraft({
                      maskStrokes,
                      maskInstructions: draft.maskInstructions,
                    });
                  }}
                  onMaskInstructionsChange={(maskInstructions) => {
                    assertMutable();
                    patchDraft({ maskInstructions });
                  }}
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
              support={inputSupport}
              onMention={(slot) => insertInputMention(slot)}
              lockedPurposes={mode === "image" && draft.imageEditMode
                ? Object.fromEntries(draft.references
                  .filter((reference) => `@${reference.slot}` === draft.imageEditTarget)
                  .map((reference) => [reference.slot, "edit_target" as const]))
                : undefined}
              error={inputValidationError}
              onChange={(references) => {
              assertMutable();
              const normalizedReferences = mode === "image" && draft.imageEditMode
                ? references.map((reference) => `@${reference.slot}` === draft.imageEditTarget
                  ? markReferenceAsEditTarget(reference)
                  : reference)
                : references;
              const targetStillAttached = normalizedReferences.some((reference) => `@${reference.slot}` === draft.imageEditTarget);
              patchDraft({
                references: normalizedReferences,
                options: optionsForInputReferences(inputSupport, normalizedReferences, draft.options),
                imageEditTarget: mode === "image" && draft.imageEditMode && !targetStillAttached ? "" : draft.imageEditTarget,
                maskStrokes: mode === "image" && draft.imageEditMode && !targetStillAttached ? [] : draft.maskStrokes,
                maskInstructions: mode === "image" && draft.imageEditMode && !targetStillAttached ? "" : draft.maskInstructions,
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
                    assertMutable();
                    patchDraft({
                      prompt: event.target.value,
                    });
                    setMentionCaret(event.target.selectionStart);
                    setMentionMenuOpen(/(?:^|\s)@\d*$/.test(event.target.value.slice(0, event.target.selectionStart)));
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
                      insertInputMention(selected.slot, true);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setMentionMenuOpen(false);
                    }
                  }}
                  onSelect={(event) => {
                    const input = event.currentTarget;
                    setMentionCaret(input.selectionStart);
                    setMentionMenuOpen(input.selectionStart === input.selectionEnd && /(?:^|\s)@\d*$/.test(input.value.slice(0, input.selectionStart)));
                  }}
                  onScroll={syncPromptHighlightScroll}
                />
                {mentionSuggestions.length ? (
                  <div className="mention-menu" id="input-mention-listbox" role="listbox" aria-label={t("numberedInputs")}>
                    {mentionSuggestions.map((reference, index) => {
                      const asset = assetMap.get(reference.assetId);
                      return <Button type="button" variant="ghost" role="option" id={`input-mention-${reference.slot}`} aria-selected={index === mentionIndex} key={reference.slot} onMouseEnter={() => setMentionIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => insertInputMention(reference.slot, true)}>{asset ? <AssetPreview asset={asset} /> : null}<b>@{reference.slot}</b><span>{asset?.name}</span>{reference.role !== "reference" ? <small>{t(reference.role === "first_frame" ? "firstFrame" : "lastFrame")}</small> : null}</Button>;
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

            <PromptEnhancementToolbar
              modelLabel={selectedPromptModel.label}
              effortLabel={t("promptReasoningEffortHigh")}
              availability={selectedPromptModelAvailability}
              canEnhance={promptEnhancementEnabled}
              enhancing={enhancing}
              canUndo={promptEnhancementCanUndo}
              canRedo={promptEnhancementCanRedo}
              resultReady={promptEnhancementResultReady}
              onEnhance={() => void runEnhancement().catch((error) => toast.error(errorMessage(error)))}
              onUndo={() => navigatePromptEnhancementHistory("undo")}
              onRedo={() => navigatePromptEnhancementHistory("redo")}
            />

            <OptionsFields key={`${mode}:${selectedModel?.id ?? ""}`} mode={mode} model={controlsModel} options={draft.options} providerJson={draft.providerJson} providerError={providerError} onOptionsChange={(options) => { assertMutable(); patchDraft({ options }); }} onProviderJsonChange={(providerJson) => { assertMutable(); patchDraft({ providerJson }); }} />
            {requestBuildError && !providerError ? <div className="field-error request-build-error">{requestBuildError}</div> : null}
          </div>
          </ScrollArea>
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
                plannerModel={currentEnhancementArtifact ? currentCheckpoint?.plannerModel ?? currentEnhancementArtifact.plannerModel : undefined}
                plannerCost={(currentPreparedRequest?.enhancementArtifact?.actualCostUsd ?? currentEnhancementArtifact?.actualCostUsd) != null
                  ? formatUsd((currentPreparedRequest?.enhancementArtifact?.actualCostUsd ?? currentEnhancementArtifact?.actualCostUsd)!)
                  : undefined}
                routeSummary={currentPreparedRequest?.routeLabel ?? draftPreparedRequest.route?.providerName ?? draftPreparedRequest.route?.providerSlug}
                routeDefinitive={currentPreparedRequest?.artifact.routeResolution.definitive ?? draftPreparedRequest.routeResolution.definitive}
                privacySummary={currentPreparedRequest?.privacyLabel ?? `ZDR: ${draftPreparedRequest.privacy.zdr} · data collection: ${draftPreparedRequest.privacy.dataCollection}${draftPreparedRequest.privacy.warning ? ` · ${draftPreparedRequest.privacy.warning}` : ""}`}
                transferredBytes={transferBytes}
                plannerEnabled={Boolean(currentEnhancementArtifact)}
                onPrepare={() => void prepareRequestForReview()}
              />
              </Suspense>
            </div>

            {generationBlocker && !needsInstructions ? <div className="generation-blocker" data-blocked={generationIsBlocked} id="generation-blocker" role="status"><span><strong>{t(generationIsBlocked ? "generationBlocker" : needsInstructions ? "prompt" : activeAttempt ? "statusInProgress" : "prepareRequest")}</strong><small>{generationBlocker}</small></span>{generationRecoveryAction ? <Button type="button" size="xs" variant="outline" disabled={preparingRequest} onClick={generationRecoveryAction.run}>{preparingRequest ? <LoaderCircle className="spin" /> : generationRecoveryAction.icon} {generationRecoveryAction.label}</Button> : null}</div> : null}
            <Button size="lg" className="generate-button" aria-keyshortcuts="Meta+Enter" aria-describedby={generationBlocker && !needsInstructions ? "generation-blocker" : undefined} disabled={!canGenerate} onClick={() => void runGeneration()}>
              {generating || enhancing ? <LoaderCircle className="spin" /> : mode === "image" ? <Sparkles /> : <Play />}
              {generating || enhancing
                ? t("preparing")
                : mode === "image"
                  ? draft.imageEditMode ? t("editImage") : t("generateMode", { mode: t("image") })
                  : t("generateMode", { mode: t("video") })}
              {!generating && !enhancing ? <ChevronRight /> : null}
            </Button>
          </footer>
        </section>

        {rightPanelOpen ? <RightPanel assets={(
          <AssetLibrary onClose={() => setRightPanelOpen(false)} assets={session.assets} jobs={sessionVideoJobs} selectedIds={selectedAssetIds} onSelectedIdsChange={setSelectedAssetIds} highlightedIds={highlightedAssetIds} onFocusedAssetChange={setFocusedAssetId} onPreviewAssetChange={setPreviewAssetId} onImport={async (files) => { await importFiles(files); }} onPick={async () => { await pickFiles(); }} canUse={(asset) => !draft.references.some((reference) => reference.assetId === asset.id) && availableInputRoles(inputSupport, draft.references, session.assets, asset).length > 0} onUse={addAssetAsReference} onEdit={(assetId) => editImageAsset(assetId)} onDelete={(ids) => void deleteAssets(ids)} onReimport={(assetId) => void reimportAsset(assetId)} />
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
        canUseInVideo={(assetId) => Boolean(currentResult && videoImageDestination(assetId, currentResult))}
        canUseAsInput={(assetId) => Boolean(currentResult && canUseResultInput(assetId, currentResult))}
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
        promptModelAvailability={promptModelAvailability}
        onPromptModelChange={(promptModel) => {
          assertMutable();
          setStudio((current) => ({
          ...current,
          promptModel,
          sessions: current.sessions.map((candidateSession) => ({
            ...candidateSession,
            threads: {
              image: candidateSession.threads.image.map((candidateThread) => ({
                ...candidateThread,
                draft: { ...candidateThread.draft, promptHistory: invalidatePromptEnhancement(candidateThread.draft.promptHistory) },
              })),
              video: candidateSession.threads.video.map((candidateThread) => ({
                ...candidateThread,
                draft: { ...candidateThread.draft, promptHistory: invalidatePromptEnhancement(candidateThread.draft.promptHistory) },
              })),
            },
          })),
          }));
        }}
        onClose={() => setSettingsOpen(false)}
        onSave={async (apiKey) => { await saveAndValidateApiKey(apiKey); toast.success(t("keySaved")); }}
        onRemove={async () => { const status = await removeApiKey(); setCredential(status); setConnectionState("missing"); setCatalogs({ image: [], video: [] }); toast.success(t("keyRemoved")); }}
      />
      </Suspense>
      <ConfirmDialog confirmation={confirmation} onClose={closeConfirmation} />
      {onboardingOpen === false && workspaceBootState === "ready" && !pendingUpdateCompletion && !updateRecovery && !studio.recovery?.requiresUserAction ? <UpdatePrompt
        onPrepareInstall={prepareLosslessUpdate}
        onInstallAborted={abortLosslessUpdate}
        onInstallRecoveryRequired={requireInstalledUpdateRecovery}
        onInstallPhaseChange={persistUpdateInstallPhase}
      /> : null}
      {studio.recovery?.requiresUserAction ? <WorkspaceRecoveryDialog
        recovery={studio.recovery}
        onExport={exportRecoveryBackup}
        onRestoreLastKnownGood={restoreLastKnownGood}
        onReindex={reindexManagedMedia}
        onOpenSafeWorkspace={() => setStudio((current) => current.recovery ? { ...current, recovery: { ...current.recovery, kind: "fresh", status: "fresh", requiresUserAction: false } } : current)}
      /> : null}
    </div>
    {isTauriRuntime() && workspaceBootState !== "ready" && workspaceBootState !== "recovery_required" ? (
      <div className="update-boot-status" role="status" aria-live="polite">
        <FruitTruckMark />
        <LoaderCircle className="spin" />
        <strong>{t(workspaceBootState === "loading" ? "updateLoadingWorkspace" : workspaceBootState === "migrating" ? "updateMigratingWorkspace" : "updateVerifying")}</strong>
        <span>{t("updateReadOnly")}</span>
      </div>
    ) : null}
    {updateRecovery ? <UpdateRecoveryDialog
      fromVersion={updateRecovery.transaction.fromAppVersion}
      toVersion={updateRecovery.transaction.toAppVersion}
      transactionId={updateRecovery.transaction.id}
      failureCode={updateRecovery.code}
      failureMessage={updateRecovery.message}
      onRetryVerification={retryUpdateVerification}
      onRestorePreUpdateWorkspace={restorePreUpdateWorkspace}
      onExportPreUpdateSnapshot={exportPreUpdateWorkspace}
      onOpenAssetFolder={openUpdateAssetFolder}
      onExitWithoutChanges={() => invoke("quit_app")}
    /> : null}
    {workspaceBootState === "ready" && !updateRecovery && onboardingOpen !== false && !studio.recovery?.requiresUserAction ? (
      <Onboarding
        ready={onboardingOpen === true}
        onSave={async (apiKey) => {
          const status = await saveAndValidateApiKey(apiKey);
          if (!status.configured) throw new Error(t("onboardingKeySaveFailed"));
          setCredential(status);
          toast.success(t("keySaved"));
        }}
        onComplete={() => {
          saveWorkspacePreference(ONBOARDING_COMPLETE_KEY, "true");
          setOnboardingOpen(false);
        }}
      />
    ) : null}
    </Tooltip.Provider>
  );
}
