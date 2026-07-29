import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { Field } from "@base-ui/react/field";
import { Progress } from "@base-ui/react/progress";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Film,
  ImageIcon,
  LoaderCircle,
  PanelLeftOpen,
  Play,
  Pencil,
  RefreshCw,
  Settings,
  Sparkles,
  Video,
} from "lucide-react";
import "./App.css";
import {
  assemblyDurationSeconds,
  expectedVideoDurationSeconds,
  recordAgentActivity,
  exposeAgentSession,
  setControlMode,
  validateAssemblyDuration,
  validatePlanStepTransition,
  type VideoAssemblyClip,
} from "@/agent";
import {
  materializeAgentSession,
  readAgentBridge,
  serializeAgentSessionForBridge,
  waitForAgentBridge,
  writeSerializedAgentBridgeSession,
  type AgentBridgeSession,
} from "@/agentBridge";
import { mergeBridgeSession } from "@/bridgeMerge";
import { AgentPanel } from "@/components/AgentPanel";
import { AssetLibrary } from "@/components/AssetLibrary";
import { AssetPreview } from "@/components/AssetPreview";
import { ConfirmDialog, type Confirmation } from "@/components/ConfirmDialog";
import { EditMediaPanel } from "@/components/EditMediaPanel";
import { InputTray } from "@/components/InputTray";
import { ModelSelector } from "@/components/ModelSelector";
import { OptionsFields } from "@/components/OptionsFields";
import { RequestPreviewDialog } from "@/components/RequestPreviewDialog";
import { RightPanel } from "@/components/RightPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast-manager";
import { useI18n, type MessageKey } from "@/i18n";
import { applyAlphaMask, applyAlphaMaskBlob, composeEditPrompt } from "@/mask";
import { invoke } from "@tauri-apps/api/core";
import {
  allowedAssetRoles,
  buildRequest,
  cacheVideo,
  defaultOptions,
  enhancePrompt,
  generateImage,
  getCredentialStatus,
  imageReferenceLimit,
  isTauriRuntime,
  loadModels,
  loadImageModelEndpoints,
  pollVideo,
  prettyRequest,
  removeApiKey,
  saveApiKey,
  submitVideo,
  supportsVideoInput,
  validateEnhancedPrompt,
  videoReferenceLimit,
  type CredentialStatus,
  type GenerationMode,
  type GenerationModel,
  type ImageModel,
  type ImageModelEndpoint,
  type ReferenceAsset,
  type VideoModel,
} from "@/openrouter";
import {
  createSession,
  assetRequestUrl,
  deleteManagedAsset,
  deleteSessionBlobs,
  importFileAsset,
  importGeneratedImage,
  importGeneratedVideo,
  loadStudioState,
  managedDroppedAssets,
  materializeRequestBlob,
  migrateLegacyAsset,
  nextReferenceSlot,
  pickManagedAssets,
  saveStudioState,
  type NativeManagedAsset,
  type GenerationDraftState,
  type SessionAsset,
  type StudioSession,
} from "@/studio";

const AssemblyDialog = lazy(() => import("@/components/AssemblyDialog").then((module) => ({ default: module.AssemblyDialog })));
const SettingsDialog = lazy(() => import("@/components/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error:\s*/, "").slice(0, 800);
}

function OppaGenMark() {
  return <img src="/oppa-gen-icon.png" alt="" aria-hidden="true" />;
}

function draftKey(session: StudioSession) {
  if (session.mode === "image") return "image" as const;
  return session.videoWorkflow === "generate" ? "videoGenerate" as const : "videoEdit" as const;
}

function providerLabel(model: GenerationModel | null) {
  return model?.name.split(":", 1)[0] ?? "OpenRouter";
}

const JOB_STATUS_KEYS: Record<string, MessageKey> = {
  pending: "statusPending",
  in_progress: "statusInProgress",
  failed: "statusFailed",
  completed: "statusCompleted",
};

const SESSION_SIDEBAR_OPEN_KEY = "oppa-gen.session-sidebar.open";
const SESSION_SIDEBAR_WIDTH_KEY = "oppa-gen.session-sidebar.width";

export default function App() {
  const { language, t } = useI18n();
  const [studio, setStudio] = useState(loadStudioState);
  const [catalogs, setCatalogs] = useState<Record<GenerationMode, GenerationModel[]>>({ image: [], video: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [imageEndpoints, setImageEndpoints] = useState<Record<string, ImageModelEndpoint[]>>({});
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<"agent" | "assets">("assets");
  const [assemblyOpen, setAssemblyOpen] = useState(false);
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(() =>
    typeof localStorage === "undefined" || localStorage.getItem(SESSION_SIDEBAR_OPEN_KEY) !== "false",
  );
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(() => {
    if (typeof localStorage === "undefined") return 264;
    const stored = Number(localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= 210 && stored <= 420 ? stored : 264;
  });
  const composerViewportRef = useRef<HTMLDivElement>(null);
  const polling = useRef(false);
  const studioRef = useRef(studio);
  studioRef.current = studio;
  const migratingAssetIds = useRef(new Set<string>());
  const bridgeRevisions = useRef(new Map<string, number>());
  const bridgeSnapshots = useRef(new Map<string, AgentBridgeSession>());

  const session = studio.sessions.find((item) => item.id === studio.activeSessionId) ?? studio.sessions[0];
  const mode = session.mode;
  const workflow = session.videoWorkflow;
  const key = draftKey(session);
  const draft = session.drafts[key];
  const allModels = catalogs[mode];
  const models = mode === "video" && workflow === "edit"
    ? allModels.filter((model) => supportsVideoInput(model as VideoModel))
    : allModels;
  const selectedId = session.selectedModelIds[mode];
  const selectedModel = models.find((model) => model.id === selectedId) ?? null;
  const approvedVideoCount = session.agent.artifacts.filter((artifact) =>
    artifact.approval === "approved"
      && session.assets.find((asset) => asset.id === artifact.assetId)?.kind === "video"
  ).length;
  const roles = allowedAssetRoles(mode, selectedModel, workflow);
  const referenceLimit = mode === "image"
    ? imageReferenceLimit(selectedModel as ImageModel | null)
    : Math.max(
      roles.length,
      videoReferenceLimit(selectedModel as VideoModel | null)
      + ((selectedModel as VideoModel | null)?.supported_frame_images?.length ?? 0),
    );
  const assetMap = useMemo(() => new Map(session.assets.map((asset) => [asset.id, asset])), [session.assets]);
  const lastAssets = session.lastResultAssetIds[mode].flatMap((id) => {
    const asset = assetMap.get(id);
    return asset ? [asset] : [];
  });
  const currentJob = session.activeVideoJobs.at(-1);
  const visibleJob = mode === "video" ? currentJob : undefined;

  useEffect(() => {
    composerViewportRef.current?.scrollTo({ top: 0, left: 0 });
  }, [mode, workflow, selectedId, studio.activeSessionId]);

  const patchSession = useCallback((id: string, update: (current: StudioSession) => StudioSession) => {
    setStudio((current) => ({
      ...current,
      sessions: current.sessions.map((item) => {
        if (item.id !== id) return item;
        const createdAt = new Date().toISOString();
        const next = update(item);
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
      const currentKey = draftKey(current);
      return {
        ...current,
        drafts: {
          ...current.drafts,
          [currentKey]: { ...current.drafts[currentKey], ...patch },
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

  const confirmAction = useCallback((title: string, description: string, confirmLabel?: string) =>
    new Promise<boolean>((resolve) => setConfirmation({ title, description, confirmLabel, resolve })), []);

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
        const expectedRevision = bridgeRevisions.current.get(item.id);
        if (expectedRevision === item.agent.revision) continue;
        void serializeAgentSessionForBridge(item).then(async (serialized) => {
          const savedEnvelope = await writeSerializedAgentBridgeSession(serialized, expectedRevision);
          const saved = savedEnvelope.sessions.find((candidate) => candidate.id === item.id);
          if (!saved) throw new Error("The saved agent session was not returned by the bridge.");
          bridgeRevisions.current.set(item.id, saved.agent.revision);
          bridgeSnapshots.current.set(item.id, saved);
          setStudio((current) => ({
            ...current,
            sessions: current.sessions.map((candidate) =>
              candidate.id === item.id && candidate.agent.revision === serialized.agent.revision
                ? { ...candidate, agent: { ...candidate.agent, revision: saved.agent.revision } }
                : candidate
            ),
          }));
        }).catch(async (error) => {
          if (errorMessage(error).includes("AGENT_SESSION_CONFLICT")) {
            try {
              const envelope = await readAgentBridge();
              const remote = envelope.sessions.find((candidate) => candidate.id === item.id);
              const base = bridgeSnapshots.current.get(item.id);
              if (!remote || !base) throw error;
              const local = await serializeAgentSessionForBridge(item);
              const merged = mergeBridgeSession(base, local, remote);
              const savedEnvelope = await writeSerializedAgentBridgeSession(merged, remote.agent.revision);
              const saved = savedEnvelope.sessions.find((candidate) => candidate.id === item.id);
              if (!saved) throw new Error("The merged agent session was not returned by the bridge.");
              bridgeRevisions.current.set(item.id, saved.agent.revision);
              bridgeSnapshots.current.set(item.id, saved);
              const incoming = materializeAgentSession(saved);
              setStudio((current) => ({
                ...current,
                sessions: current.sessions.map((candidate) => candidate.id === item.id ? {
                  ...candidate,
                  ...incoming,
                  drafts: candidate.drafts,
                  activeVideoJobs: candidate.activeVideoJobs,
                  lastResultAssetIds: candidate.lastResultAssetIds,
                  assets: incoming.assets.map((asset) => {
                    const localAsset = candidate.assets.find((existing) => existing.id === asset.id);
                    return localAsset ? { ...asset, blobKey: localAsset.blobKey, fingerprint: localAsset.fingerprint } : asset;
                  }),
                } : candidate),
              }));
              toast.info("Merged simultaneous desktop and MCP session changes.");
            } catch (mergeError) {
              toast.error(`Shared session changed again. Reload before retrying: ${errorMessage(mergeError)}`);
            }
          } else {
            toast.error(errorMessage(error));
          }
        });
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [studio]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let active = true;
    const applyEnvelope = (envelope: Awaited<ReturnType<typeof readAgentBridge>>) => {
      if (!active || !envelope.sessions.length) return;
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
          bridgeRevisions.current.set(external.id, external.agent.revision);
          bridgeSnapshots.current.set(external.id, external);
          const index = sessions.findIndex((item) => item.id === external.id);
          if (index < 0) {
            sessions.push(materializeAgentSession(external));
            changed = true;
          } else if (external.agent.revision > sessions[index].agent.revision) {
            const incoming = materializeAgentSession(external);
            sessions[index] = {
              ...sessions[index],
              ...incoming,
              drafts: sessions[index].drafts,
              activeVideoJobs: sessions[index].activeVideoJobs,
              lastResultAssetIds: sessions[index].lastResultAssetIds,
              assets: [
                ...sessions[index].assets,
                ...incoming.assets.filter((asset) => !sessions[index].assets.some((existing) => existing.id === asset.id)),
              ],
            };
            changed = true;
          }
        }
        return changed
          ? { ...current, sessions }
          : current;
      });
    };
    const syncLoop = async () => {
      try {
        let envelope = await readAgentBridge();
        while (active) {
          applyEnvelope(envelope);
          envelope = await waitForAgentBridge(envelope.revision, 20_000);
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
    void getCredentialStatus().then((status) => {
      setCredential(status);
    }).catch((error) => {
      toast.error(errorMessage(error));
    });
  }, []);

  const refreshCatalog = useCallback(async () => {
    if (!credential?.configured) return;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const [images, videos] = await Promise.all([loadModels("image"), loadModels("video")]);
      setCatalogs({ image: images, video: videos });
      setStudio((current) => ({
        ...current,
        sessions: current.sessions.map((item) => {
          const videoCandidates = item.videoWorkflow === "edit"
            ? videos.filter((model) => supportsVideoInput(model))
            : videos;
          const imageId = images.some((model) => model.id === item.selectedModelIds.image)
            ? item.selectedModelIds.image : images[0]?.id ?? "";
          const videoId = videoCandidates.some((model) => model.id === item.selectedModelIds.video)
            ? item.selectedModelIds.video : videoCandidates[0]?.id ?? "";
          return {
            ...item,
            selectedModelIds: { image: imageId, video: videoId },
            drafts: {
              ...item.drafts,
              image: Object.keys(item.drafts.image.options).length ? item.drafts.image : { ...item.drafts.image, options: defaultOptions("image", images[0] ?? null) },
              videoGenerate: Object.keys(item.drafts.videoGenerate.options).length ? item.drafts.videoGenerate : { ...item.drafts.videoGenerate, options: defaultOptions("video", videos[0] ?? null) },
              videoEdit: Object.keys(item.drafts.videoEdit.options).length ? item.drafts.videoEdit : { ...item.drafts.videoEdit, options: defaultOptions("video", videoCandidates[0] ?? null) },
            },
          };
        }),
      }));
    } catch (error) {
      setCatalogError(errorMessage(error));
    } finally {
      setCatalogLoading(false);
    }
  }, [credential?.configured]);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

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
    item.activeVideoJobs
      .filter((job) => job.status === "pending" || job.status === "in_progress")
      .map((job) => `${item.id}:${job.jobId}`),
  ).sort().join("|");

  useEffect(() => {
    if (!credential?.configured || !activeVideoJobIds) return;
    let active = true;
    let timer: number | undefined;
    const schedule = () => {
      if (active) timer = window.setTimeout(() => void pollActiveJobs(), 4_000);
    };
    const pollActiveJobs = async () => {
      if (!active) return;
      if (polling.current) {
        schedule();
        return;
      }
      const activeJobs = studioRef.current.sessions.flatMap((item) =>
        item.activeVideoJobs
          .filter((job) => job.status === "pending" || job.status === "in_progress")
          .map((job) => ({ sessionId: item.id, job })),
      );
      if (!activeJobs.length) return;
      polling.current = true;
      await Promise.all(activeJobs.map(async ({ sessionId, job }) => {
        try {
          const result = await pollVideo(job.jobId);
          if (result.status === "completed") {
            const latestSession = studioRef.current.sessions.find((item) => item.id === sessionId);
            const existing = latestSession?.assets.find((item) => item.jobId === job.jobId);
            if (existing) {
              patchSession(sessionId, (current) => ({
                ...current,
                activeVideoJobs: current.activeVideoJobs.filter((item) => item.jobId !== job.jobId),
                lastResultAssetIds: { ...current.lastResultAssetIds, video: [existing.id] },
                agent: {
                  ...current.agent,
                  execution: {
                    ...current.agent.execution,
                    currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                  },
                },
              }));
              return;
            }
            let source = result.url;
            if (isTauriRuntime()) {
              source = await cacheVideo(job.jobId);
            }
            if (!source) throw new Error("The video completed without a readable URL.");
            const asset = isTauriRuntime()
              ? {
                id: crypto.randomUUID(),
                name: `video-${job.jobId}.mp4`,
                kind: "video" as const,
                mimeType: "video/mp4",
                origin: job.workflow === "edit" ? "edited" as const : "generated" as const,
                createdAt: new Date().toISOString(),
                localPath: source,
                jobId: job.jobId,
              }
              : await importGeneratedVideo(
                source,
                `video-${job.jobId}.mp4`,
                job.workflow === "edit" ? "edited" : "generated",
                job.jobId,
              );
            patchSession(sessionId, (current) => {
              const existing = current.assets.find((item) => item.jobId === job.jobId);
              const resolvedAsset = existing ?? asset;
              return {
                ...current,
                assets: existing ? current.assets : [...current.assets, asset],
                activeVideoJobs: current.activeVideoJobs.filter((item) => item.jobId !== job.jobId),
                lastResultAssetIds: { ...current.lastResultAssetIds, video: [resolvedAsset.id] },
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
                    role: "video_shot",
                    parentAssetIds: job.inputAssetIds ?? [],
                    planStepId: current.agent.currentStepId,
                    prompt: typeof job.request.prompt === "string" ? job.request.prompt : undefined,
                    modelId: job.model,
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
          } else if (result.status === "failed") {
            patchSession(sessionId, (current) => ({
              ...current,
              activeVideoJobs: current.activeVideoJobs.filter((item) => item.jobId !== job.jobId),
              agent: {
                ...current.agent,
                runStatus: current.agent.controlMode === "agent" ? "failed" : current.agent.runStatus,
                execution: {
                  ...current.agent.execution,
                  currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                  lastError: result.error ?? "Video generation failed.",
                },
              },
            }));
          } else {
            const polledAt = new Date().toISOString();
            patchSession(sessionId, (current) => ({
              ...current,
              activeVideoJobs: current.activeVideoJobs.map((item) =>
                item.jobId === job.jobId
                  ? { ...item, ...result, pollAttempts: (item.pollAttempts ?? 0) + 1, lastPolledAt: polledAt }
                  : item,
              ),
            }));
          }
        } catch (error) {
          const message = errorMessage(error);
          const expired = Date.now() - new Date(job.submittedAt).getTime() >= 30 * 60_000;
          patchSession(sessionId, (current) => ({
            ...current,
            activeVideoJobs: expired
              ? current.activeVideoJobs.filter((item) => item.jobId !== job.jobId)
              : current.activeVideoJobs.map((item) =>
                item.jobId === job.jobId
                  ? { ...item, error: message, pollAttempts: (item.pollAttempts ?? 0) + 1, lastPolledAt: new Date().toISOString() }
                  : item,
              ),
            agent: expired ? {
              ...current.agent,
              runStatus: current.agent.controlMode === "agent" && current.agent.runStatus === "working"
                ? "failed"
                : current.agent.runStatus,
              execution: {
                ...current.agent.execution,
                currentJobIds: current.agent.execution.currentJobIds.filter((id) => id !== job.jobId),
                lastError: `Video polling stopped after 30 minutes: ${message}`,
              },
            } : current.agent,
          }));
          if (studioRef.current.activeSessionId === sessionId) setGenerationError(message);
        }
      }));
      polling.current = false;
      schedule();
    };
    schedule();
    return () => {
      active = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [activeVideoJobIds, credential?.configured, patchSession]);

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

  const addAssetAsReference = (assetId: string) => {
    const asset = assetMap.get(assetId);
    if (!asset || draft.references.some((reference) => reference.assetId === assetId) || draft.references.length >= referenceLimit) return;
    const validRole = asset.kind === "video"
      ? roles.includes("video_reference") ? "video_reference" : null
      : roles.includes("reference") ? "reference" : roles.find((role) => role !== "video_reference") ?? null;
    if (!validRole) {
      toast.error(t("unsupportedAssetInput"));
      return;
    }
    patchDraft({ references: [...draft.references, { assetId, role: validRole, slot: nextReferenceSlot(draft.references) }], enhancedPrompt: "", enhancedPromptDirty: false });
  };

  const editImageAsset = (assetId: string) => {
    patchActive((current) => {
      const imageDraft = current.drafts.image;
      const existing = imageDraft.references.find((reference) => reference.assetId === assetId);
      const previousTarget = imageDraft.references.find((reference) => `#${reference.slot}` === imageDraft.imageEditTarget);
      const slot = existing?.slot ?? nextReferenceSlot(imageDraft.references);
      return {
        ...current,
        mode: "image",
        drafts: {
          ...current.drafts,
          image: {
            ...imageDraft,
            imageEditMode: true,
            imageEditTarget: `#${slot}`,
            maskStrokes: previousTarget?.assetId === assetId ? imageDraft.maskStrokes : [],
            maskInstructions: previousTarget?.assetId === assetId ? imageDraft.maskInstructions : "",
            enhancedPrompt: "",
            enhancedPromptDirty: false,
            references: existing ? imageDraft.references : [...imageDraft.references, { assetId, slot, role: "reference" }],
          },
        },
      };
    });
  };

  const setEditTargetAsset = (assetId: string, incomingAsset?: SessionAsset) => {
    const asset = assetMap.get(assetId) ?? incomingAsset;
    const expectedKind = mode === "image" ? "image" : "video";
    if (!asset || asset.kind !== expectedKind) {
      toast.error(t(expectedKind === "image" ? "editImageRequired" : "editVideoRequired"));
      return;
    }
    patchActive((current) => {
      const currentKey = draftKey(current);
      const currentDraft = current.drafts[currentKey];
      const role = current.mode === "video" ? "video_reference" as const : "reference" as const;
      const previousTarget = current.mode === "image"
        ? currentDraft.references.find((reference) => `#${reference.slot}` === currentDraft.imageEditTarget)
        : currentDraft.references.find((reference) => reference.role === "video_reference");
      const existing = currentDraft.references.find((reference) => reference.assetId === assetId);
      const slot = existing?.slot
        ?? (current.mode === "video" ? previousTarget?.slot : undefined)
        ?? nextReferenceSlot(currentDraft.references);
      const references = currentDraft.references
        .filter((reference) => current.mode !== "video" || reference.role !== "video_reference" || reference.assetId === assetId)
        .map((reference) => reference.assetId === assetId ? { ...reference, role } : reference);
      if (!references.some((reference) => reference.assetId === assetId)) references.push({ assetId, slot, role });
      return {
        ...current,
        drafts: {
          ...current.drafts,
          [currentKey]: {
            ...currentDraft,
            imageEditTarget: current.mode === "image" ? `#${slot}` : currentDraft.imageEditTarget,
            references,
            maskStrokes: previousTarget?.assetId === assetId ? currentDraft.maskStrokes : [],
            maskInstructions: previousTarget?.assetId === assetId ? currentDraft.maskInstructions : "",
            enhancedPrompt: "",
            enhancedPromptDirty: false,
          },
        },
      };
    });
  };

  const applyImportedEditTarget = (assets: SessionAsset[]) => {
    const expectedKind = mode === "image" ? "image" : "video";
    const target = assets.find((asset) => asset.kind === expectedKind);
    if (target) setEditTargetAsset(target.id, target);
    else toast.error(t(expectedKind === "image" ? "editImageRequired" : "editVideoRequired"));
  };
  const importEditTarget = async (files: FileList | File[]) => applyImportedEditTarget(await importFiles(files));
  const pickEditTarget = async () => applyImportedEditTarget(await pickFiles());

  const routeImageToVideo = (assetId: string) => {
    const videoId = session.selectedModelIds.video;
    const videoModel = catalogs.video.find((model) => model.id === videoId) ?? null;
    const videoRoles = allowedAssetRoles("video", videoModel, "generate");
    const role = videoRoles.includes("reference")
      ? "reference"
      : videoRoles.includes("first_frame") ? "first_frame" : null;
    if (!role) {
      toast.error(t("chooseVideoImageInput"));
      switchMode("video");
      return;
    }
    patchActive((current) => {
      const videoDraft = current.drafts.videoGenerate;
      const exists = videoDraft.references.some((reference) => reference.assetId === assetId);
      return {
        ...current,
        mode: "video",
        videoWorkflow: "generate",
        drafts: {
          ...current.drafts,
          videoGenerate: {
            ...videoDraft,
            references: exists ? videoDraft.references : [...videoDraft.references, {
              assetId,
              slot: nextReferenceSlot(videoDraft.references),
              role,
            }],
            enhancedPrompt: "",
            enhancedPromptDirty: false,
          },
        },
      };
    });
  };

  const selectStageModel = (targetMode: GenerationMode, id: string) => {
    const model = catalogs[targetMode].find((item) => item.id === id) ?? null;
    patchActive((current) => {
      const currentKey = targetMode === "image"
        ? "image"
        : current.videoWorkflow === "generate" ? "videoGenerate" : "videoEdit";
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
        selectedModelIds: { ...current.selectedModelIds, [targetMode]: id },
        drafts: {
          ...current.drafts,
          [currentKey]: { ...current.drafts[currentKey], options: defaultOptions(targetMode, model) },
        },
      };
    });
    setGenerationError(null);
  };
  const selectModel = (id: string) => selectStageModel(mode, id);

  const switchMode = (next: GenerationMode) => {
    patchActive((current) => ({ ...current, mode: next }));
    setGenerationError(null);
  };

  const switchWorkflow = (next: "generate" | "edit") => {
    const candidates = next === "edit"
      ? (catalogs.video as VideoModel[]).filter(supportsVideoInput)
      : catalogs.video as VideoModel[];
    patchActive((current) => ({
      ...current,
      videoWorkflow: next,
      selectedModelIds: {
        ...current.selectedModelIds,
        video: candidates.some((model) => model.id === current.selectedModelIds.video)
          ? current.selectedModelIds.video : candidates[0]?.id ?? "",
      },
    }));
    setGenerationError(null);
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
      && `#${reference.slot}` === draft.imageEditTarget.trim()
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
        videoWorkflow: workflow,
        model: selectedId,
        prompt: preparedPrompt,
        assets: previewReferences,
        options: draft.options,
        providerJson: draft.providerJson,
      }, selectedModel);
    } catch {
      return {};
    }
  }, [draft.options, draft.providerJson, mode, preparedPrompt, previewReferences, selectedId, selectedModel, workflow]);

  const editTargetError = useMemo(() => {
    if (mode !== "image" || !draft.imageEditMode) return null;
    if (!draft.imageEditTarget.trim()) return t("chooseEditTarget");
    const match = draft.imageEditTarget.trim().match(/^#(\d+)$/);
    if (!match) return t("editTargetFormat");
    const reference = draft.references.find((item) => item.slot === Number(match[1]));
    const asset = reference ? assetMap.get(reference.assetId) : null;
    return !asset || asset.kind !== "image" ? t("targetNotAttached", { target: draft.imageEditTarget || t("thatTarget") }) : null;
  }, [assetMap, draft.imageEditMode, draft.imageEditTarget, draft.references, mode, t]);
  const imageEditReference = mode === "image" && draft.imageEditMode
    ? draft.references.find((reference) => `#${reference.slot}` === draft.imageEditTarget.trim())
    : undefined;
  const videoEditReference = mode === "video" && workflow === "edit"
    ? draft.references.find((reference) => reference.role === "video_reference")
    : undefined;
  const editReference = imageEditReference ?? videoEditReference;
  const editTargetAsset = editReference ? assetMap.get(editReference.assetId) ?? null : null;

  const inputValidationError = useMemo(() => {
    const unsupported = draft.references.find((reference) => {
      const asset = assetMap.get(reference.assetId);
      if (!asset) return true;
      if (asset.kind === "video") return !roles.includes("video_reference") || reference.role !== "video_reference";
      return !roles.includes(reference.role);
    });
    if (unsupported) return t("unsupportedReference", { slot: unsupported.slot });
    if (draft.references.length > referenceLimit) return t("tooManyInputs", { count: referenceLimit });
    if (mode === "video" && workflow === "generate") {
      const hasReference = draft.references.some((reference) => reference.role === "reference");
      const hasFrame = draft.references.some((reference) => reference.role === "first_frame" || reference.role === "last_frame");
      if (hasReference && hasFrame) return t("mixedInputStyles");
    }
    if (mode === "video" && workflow === "edit" && !draft.references.some((reference) => reference.role === "video_reference")) {
      return t("attachSourceVideo");
    }
    return null;
  }, [assetMap, draft.references, mode, referenceLimit, roles, t, workflow]);

  const promptReferenceError = useMemo(() => {
    const slots = new Set(draft.references.map((reference) => reference.slot));
    const mentioned = [...draft.prompt.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
    const missing = mentioned.find((slot) => !slots.has(slot));
    return missing ? t("missingMention", { slot: missing }) : null;
  }, [draft.prompt, draft.references, t]);

  const maskReferenceError = useMemo(() => {
    if (mode !== "image" || !draft.imageEditMode || !draft.maskStrokes.length) return null;
    const slots = new Set(draft.references.map((reference) => reference.slot));
    const mentioned = [...draft.maskInstructions.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
    const missing = mentioned.find((slot) => !slots.has(slot));
    return missing ? t("missingMention", { slot: missing }) : null;
  }, [draft.imageEditMode, draft.maskInstructions, draft.maskStrokes.length, draft.references, mode, t]);

  const approvalValidationError = useMemo(() => {
    if (!session.agentBridge || mode !== "video" || !draft.references.length) return null;
    const unapproved = draft.references.find((reference) => {
      const asset = assetMap.get(reference.assetId);
      return asset?.kind === "image"
        && session.agent.artifacts.find((artifact) => artifact.assetId === reference.assetId)?.approval !== "approved";
    });
    return unapproved ? "Approve every image or keyframe before using it for video generation." : null;
  }, [assetMap, draft.references, mode, session.agent.artifacts, session.agentBridge]);

  const generationValidationError = editTargetError
    ?? inputValidationError
    ?? promptReferenceError
    ?? maskReferenceError
    ?? approvalValidationError;

  const runEnhancement = async () => {
    if (!draft.prompt.trim()) throw new Error(t("enterPromptFirst"));
    setEnhancing(true);
    try {
      const text = await enhancePrompt({
        promptModel: studio.promptModel,
        mode,
        videoWorkflow: workflow,
        editMode: draft.imageEditMode,
        editTarget: draft.imageEditTarget,
        prompt: draft.prompt,
        references: draft.references.flatMap((reference) => {
          const asset = assetMap.get(reference.assetId);
          return asset ? [{ slot: reference.slot, name: asset.name, mediaType: asset.mimeType, role: reference.role }] : [];
        }),
      });
      patchDraft({ enhancedPrompt: text, enhancedPromptDirty: false });
      return text;
    } finally {
      setEnhancing(false);
    }
  };

  const hydrateReferences = async (): Promise<ReferenceAsset[]> => Promise.all(draft.references.map(async (reference) => {
    const asset = assetMap.get(reference.assetId);
    if (!asset) throw new Error(t("missingReference", { slot: reference.slot }));
    const source = await assetRequestUrl(asset);
    const masked = mode === "image"
      && draft.imageEditMode
      && `#${reference.slot}` === draft.imageEditTarget.trim()
      && draft.maskStrokes.length > 0;
    return {
      id: asset.id,
      name: masked ? `${asset.name} (transparent edit mask)` : asset.name,
      mediaType: masked ? "image/png" : asset.mimeType,
      dataUrl: masked
        ? isTauriRuntime()
          ? await materializeRequestBlob(await applyAlphaMaskBlob(source, draft.maskStrokes), `mask-${asset.id}.png`)
          : await applyAlphaMask(source, draft.maskStrokes)
        : source,
      role: reference.role,
      slot: reference.slot,
    };
  }));

  const runGeneration = async () => {
    if (session.agent.controlMode === "agent") {
      toast.info("The agent has control. Switch to Human control to run this request yourself.");
      return;
    }
    if (!credential?.configured) { setSettingsOpen(true); return; }
    if (session.agent.execution.generationLimit != null
      && session.agent.execution.generationCount >= session.agent.execution.generationLimit) {
      toast.error("This session has reached its user-confirmed generation limit.");
      return;
    }
    if (!selectedModel || !draft.prompt.trim() || providerError || generationValidationError) return;
    setGenerating(true);
    setGenerationError(null);
    try {
      let prompt = draft.prompt.trim();
      if (draft.enhancePrompt) {
        if (draft.enhancedPromptDirty && draft.enhancedPrompt.trim()) {
          prompt = draft.enhancedPrompt.trim();
          const enhancedError = validateEnhancedPrompt(draft.prompt, prompt, draft.imageEditMode ? draft.imageEditTarget : undefined);
          if (enhancedError) throw new Error(enhancedError);
        } else {
          try {
            prompt = await runEnhancement();
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
      prompt = prepareGenerationPrompt(prompt);
      const payload = buildRequest({
        mode,
        videoWorkflow: workflow,
        model: selectedId,
        prompt,
        assets: await hydrateReferences(),
        options: draft.options,
        providerJson: draft.providerJson,
      }, selectedModel);
      if (mode === "image") {
        const result = await generateImage(payload);
        const generated = await Promise.all(result.urls.map((url, index) =>
          importGeneratedImage(
            url,
            `image-${new Date().toISOString().replaceAll(":", "-")}-${index + 1}.png`,
            draft.imageEditMode ? "edited" : "generated",
          ),
        ));
        patchActive((current) => {
          const parentAssetIds = current.drafts[draftKey(current)].references.map((reference) => reference.assetId);
          return {
            ...current,
            assets: [...current.assets, ...generated],
            lastResultAssetIds: { ...current.lastResultAssetIds, image: generated.map((asset) => asset.id) },
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
                  role: current.agent.currentStepId === "keyframes" ? "keyframe_candidate" : "generated_image",
                  parentAssetIds,
                  planStepId: current.agent.currentStepId,
                  prompt,
                  modelId: selectedId,
                  approval: "unreviewed" as const,
                })),
              ],
            }, {
              actor: current.agent.controlMode === "agent" ? "agent" : "user",
              kind: "generation",
              title: `Generated ${generated.length} image candidate${generated.length === 1 ? "" : "s"}`,
              prompt,
              modelId: selectedId,
              assetIds: generated.map((asset) => asset.id),
            }),
          };
        });
      } else {
        const result = await submitVideo(payload);
        patchActive((current) => ({
          ...current,
          activeVideoJobs: [...current.activeVideoJobs, {
            ...result,
            workflow,
            model: selectedId,
            submittedAt: new Date().toISOString(),
            request: JSON.parse(prettyRequest(payload)) as Record<string, unknown>,
            inputAssetIds: draft.references.map((reference) => reference.assetId),
          }],
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
            title: "Submitted video shot",
            prompt,
            modelId: selectedId,
            assetIds: draft.references.map((reference) => reference.assetId),
          }),
        }));
      }
    } catch (error) {
      setGenerationError(errorMessage(error));
      patchAgent((current) => ({
        ...current,
        execution: { ...current.execution, lastError: errorMessage(error) },
      }));
    } finally {
      setGenerating(false);
    }
  };

  const deleteAssets = async (ids: string[]) => {
    const deleting = session.assets.filter((asset) => ids.includes(asset.id));
    const inUse = Object.values(session.drafts).some((value) =>
      value.references.some((reference) => ids.includes(reference.assetId)),
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
      drafts: Object.fromEntries(Object.entries(current.drafts).map(([draftName, value]) => [
        draftName, (() => {
          const removedTarget = value.references.some((reference) =>
            ids.includes(reference.assetId) && `#${reference.slot}` === value.imageEditTarget,
          );
          return {
            ...value,
            references: value.references.filter((reference) => !ids.includes(reference.assetId)),
            imageEditTarget: removedTarget ? "" : value.imageEditTarget,
            maskStrokes: removedTarget ? [] : value.maskStrokes,
            maskInstructions: removedTarget ? "" : value.maskInstructions,
          };
        })(),
      ])) as StudioSession["drafts"],
      lastResultAssetIds: {
        image: current.lastResultAssetIds.image.filter((id) => !ids.includes(id)),
        video: current.lastResultAssetIds.video.filter((id) => !ids.includes(id)),
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

  const mentionMatch = draft.prompt.match(/(?:^|\s)#(\d*)$/);
  const mentionSuggestions = mentionMatch
    ? draft.references.filter((reference) => String(reference.slot).startsWith(mentionMatch[1]))
    : [];
  const agentModelConfirmed = session.agent.controlMode === "human"
    || (session.agent.modelSelections[mode].status === "selected" && session.agent.modelSelections[mode].modelId === selectedId);
  const withinGenerationLimit = session.agent.execution.generationLimit == null
    || session.agent.execution.generationCount < session.agent.execution.generationLimit;
  const canGenerate = Boolean(selectedModel && draft.prompt.trim() && !providerError && !generationValidationError && credential?.configured && !generating && !enhancing && agentModelConfirmed && session.agent.controlMode === "human" && withinGenerationLimit);
  const showResult = Boolean(lastAssets.length || visibleJob || generating || generationError);
  const resultSignal = [
    generating ? "generating" : "",
    generationError ?? "",
    ...session.lastResultAssetIds[mode],
    visibleJob ? `${visibleJob.jobId}:${visibleJob.status}:${visibleJob.progress ?? ""}` : "",
  ].join("|");
  const previousResultSignal = useRef("");
  useEffect(() => {
    if (!showResult || !resultSignal || resultSignal === previousResultSignal.current) return;
    previousResultSignal.current = resultSignal;
    const frame = window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      composerViewportRef.current?.scrollTo({ top: 0, left: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resultSignal, showResult]);
  const selectSession = (id: string) => {
    setStudio((current) => ({ ...current, activeSessionId: id }));
    setSelectedAssetIds(new Set());
  };
  const createNewSession = () => {
    const created = createSession(t("newSessionName", { count: studio.sessions.length + 1 }));
    setStudio((current) => ({ ...current, activeSessionId: created.id, sessions: [...current.sessions, created] }));
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
    const currentDraft = session.drafts[draftKey(session)];
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
      const currentDraft = current.drafts[draftKey(current)];
      const seeded = current.agent.connection.status === "disconnected"
        ? exposeAgentSession(current.agent, currentDraft.prompt)
        : setControlMode(current.agent, "agent");
      return { ...current, agent: seeded, agentBridge: true };
    });
  };

  const assembleVideo = async (clips: VideoAssemblyClip[]) => {
    try {
      if (!isTauriRuntime()) throw new Error("Final rendering requires the Tauri desktop runtime and FFmpeg installed on this Mac.");
      if (session.agent.controlMode !== "human") throw new Error("Switch to Human control before starting a desktop render.");
      if (session.agent.plan.some((step) => step.id === "assembly")) {
        const transitionError = validatePlanStepTransition(session.agent, "assembly", "completed");
        if (transitionError) throw new Error(transitionError);
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
      patchActive((current) => ({
        ...current,
        assets: [...current.assets, finalAsset],
        lastResultAssetIds: { ...current.lastResultAssetIds, video: [finalAsset.id] },
        agent: recordAgentActivity({
          ...current.agent,
          runStatus: "waiting",
          plan: current.agent.plan.map((step) => step.id === "assembly" ? { ...step, status: "completed" as const } : step),
          currentStepId: current.agent.plan.some((step) => step.id === "complete") ? "complete" : current.agent.currentStepId,
          assembly: { ...current.agent.assembly, clips, outputAssetId: finalAsset.id, status: "completed", error: undefined },
          artifacts: [...current.agent.artifacts, {
            assetId: finalAsset.id,
            role: "final_video",
            parentAssetIds: clips.map((clip) => clip.assetId),
            planStepId: "assembly",
            approval: "unreviewed",
          }],
          decisions: [...current.agent.decisions, {
            id: crypto.randomUUID(),
            semanticKey: "final_approval",
            title: "Final video approval",
            prompt: "Review the assembled result. Approve it as final or leave revision feedback.",
            kind: "approval",
            status: "pending",
            blocking: true,
            relatedStepId: "complete",
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
      }));
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
    <div className="app-shell">
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><span className="brand-mark"><OppaGenMark /></span><strong>Oppa Gen</strong><button type="button" className={`brand-badge ${session.agent.controlMode}`} onClick={() => {
          setRightPanelTab("agent");
        }}>{session.agent.controlMode === "agent" ? t("agent") : t("humanDriven")}</button></div>
        <ModelSelector mode={mode} models={models} selectedId={selectedId} loading={catalogLoading} disabled={session.agent.controlMode === "agent"} onSelect={selectModel} />
        <ToggleGroup className="mode-switcher" aria-label={t("generationMode")} value={[mode]} onValueChange={(value) => {
          const next = value[0];
          if (next === "image" || next === "video") switchMode(next);
        }}>
          <Toggle value="image" aria-label={t("image")}><ImageIcon /> {t("image")}</Toggle>
          <Toggle value="video" aria-label={t("video")}><Video /> {t("video")}</Toggle>
        </ToggleGroup>
        <div className="topbar-actions">
          <div className="connection-pill" role="status"><i className={credential?.configured ? "online" : ""} />{credential?.configured ? credential.maskedKey : t("addApiKey")}</div>
          <Button type="button" variant="ghost" size="icon" aria-label={t("settings")} onClick={() => setSettingsOpen(true)}><Settings /></Button>
        </div>
      </header>

      <main
        className={`workspace ${sessionSidebarOpen ? "session-sidebar-open" : "session-sidebar-closed"}`}
        style={{ "--sessions-width": `${sessionSidebarWidth}px` } as CSSProperties}
      >
        {!sessionSidebarOpen ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="session-sidebar-reopen"
            aria-label={t("openSessionSidebar")}
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
          />
        ) : null}
        <section className="composer">
          <ScrollArea className="composer-scroll" viewportRef={composerViewportRef}>
          {catalogError ? <div className="catalog-error"><CircleAlert /><span><strong>{t("catalogLoadFailed")}</strong><small>{catalogError}</small></span><Button variant="outline" size="sm" onClick={() => void refreshCatalog()}><RefreshCw /> {t("retry")}</Button></div> : null}
          <header className="composer-header">
            <div>
              <p>{mode === "image" ? draft.imageEditMode ? t("imageEdit") : t("imageGeneration") : workflow === "edit" ? t("videoEdit") : t("videoGeneration")}</p>
              <h1>{selectedModel?.name ?? (catalogLoading ? t("loadingModels") : t("chooseModel"))}</h1>
            </div>
            {selectedModel ? <div className="model-meta"><span>{providerLabel(selectedModel)}</span>{mode === "image" && imageEndpoints[selectedId] ? <span>{t("endpointsVerified", { count: imageEndpoints[selectedId].length })}</span> : null}</div> : null}
          </header>
          {showResult ? <section className={`result-canvas ${lastAssets.length || visibleJob || generating ? "active" : ""}`}>
            <header className="result-canvas-header">
              <div><span className="panel-eyebrow">{t("latestOutput")}</span><strong>{lastAssets.length ? t("savedResults", { count: lastAssets.length }) : t("generationCanvas")}</strong></div>
            </header>
            <div className="result-view">
              {generationError ? <div className="generation-error"><CircleAlert /><div><strong>{t("generationFailed")}</strong><p>{generationError}</p></div></div> : null}
              {generating && !lastAssets.length ? <div className="result-loading"><span><LoaderCircle className="spin" /></span><strong>{t("submittingRequest")}</strong><small>{t("processingPrompt")}</small></div> : null}
              {lastAssets.length ? <div className={`result-assets count-${lastAssets.length}`}>{lastAssets.map((asset) => <div className="result-asset" key={asset.id}><AssetPreview asset={asset} controls /><div>{asset.kind === "image" ? <><Button size="sm" variant="outline" onClick={() => editImageAsset(asset.id)}><Pencil /> {t("editThisImage")}</Button><Button size="sm" variant="outline" onClick={() => routeImageToVideo(asset.id)}><Film /> {t("useInVideo")}</Button></> : null}<Button size="sm" variant="outline" onClick={() => addAssetAsReference(asset.id)}>{t("useAsInput")}</Button></div></div>)}<div className="result-details"><span><Check /> {t("completedSaved")}</span></div></div> : null}
              {visibleJob ? (
                <Progress.Root className="video-progress" value={visibleJob.progress ?? null}>
                  <span className="progress-orbit"><Video /></span>
                  <Progress.Label className="progress-heading">{visibleJob.status === "failed" ? t("videoJobFailed") : t("generatingVideo")}</Progress.Label>
                  <p>{visibleJob.error ?? t("jobResumeHint")}</p>
                  <Progress.Track className="progress-track"><Progress.Indicator /></Progress.Track>
                  <div className="job-timeline"><span className="done"><Check /> {t("submitted")}</span><i /><span className={visibleJob.status === "failed" ? "failed" : "active"}><Clock3 /> {t(JOB_STATUS_KEYS[visibleJob.status] ?? "statusPending")}</span></div>
                  <code className="job-id">{visibleJob.jobId}</code>
                </Progress.Root>
              ) : null}
            </div>
          </section> : null}
          {mode === "video" ? (
            <div className="workflow-row">
              <ToggleGroup className="workflow-switch" aria-label={t("videoWorkflow")} value={[workflow]} onValueChange={(value) => {
                const next = value[0];
                if (next === "generate" || next === "edit") switchWorkflow(next);
              }}>
                <Toggle value="generate">{t("generate")}</Toggle>
                <Toggle value="edit">{t("edit")}</Toggle>
              </ToggleGroup>
              <small>{workflow === "edit" ? t("editWorkflowHint") : t("generateWorkflowHint")}</small>
            </div>
          ) : null}
          <div className="composer-form">
            {mode === "image" ? (
              <Field.Root className="edit-mode-row">
                <Field.Label className="edit-mode-label" nativeLabel={false} render={<div />}><span><strong>{t("editMode")}</strong><small>{t("editModeHint")}</small></span></Field.Label>
                <Switch checked={draft.imageEditMode} onCheckedChange={(value) => patchDraft({ imageEditMode: value })} />
              </Field.Root>
            ) : null}
            {(mode === "image" && draft.imageEditMode) || (mode === "video" && workflow === "edit") ? (
              <>
                <EditMediaPanel
                  asset={editTargetAsset}
                  targetLabel={editReference ? `#${editReference.slot}` : ""}
                  kind={mode === "image" ? "image" : "video"}
                  maskStrokes={mode === "image" ? draft.maskStrokes : undefined}
                  maskInstructions={mode === "image" ? draft.maskInstructions : undefined}
                  maskError={mode === "image" ? maskReferenceError : undefined}
                  onMaskStrokesChange={mode === "image" ? (maskStrokes) => patchDraft({
                    maskStrokes,
                    maskInstructions: maskStrokes.length ? draft.maskInstructions : "",
                    enhancedPrompt: "",
                    enhancedPromptDirty: false,
                  }) : undefined}
                  onMaskInstructionsChange={mode === "image" ? (maskInstructions) => patchDraft({ maskInstructions, enhancedPrompt: "", enhancedPromptDirty: false }) : undefined}
                  onDropAsset={setEditTargetAsset}
                  onImport={importEditTarget}
                  onPick={pickEditTarget}
                />
                {editTargetError ? <div className="field-error edit-canvas-error">{editTargetError}</div> : null}
              </>
            ) : null}
            <Field.Root className="prompt-field" invalid={Boolean(promptReferenceError)}>
              <Field.Label className="section-label-row"><span className="section-label">{t("prompt")}</span><small>{t("characters", { count: draft.prompt.length.toLocaleString(language === "ko" ? "ko-KR" : "en-US") })}</small></Field.Label>
              <div className="prompt-input-wrap">
                <Textarea
                  autoFocus
                  rows={7}
                  value={draft.prompt}
                  placeholder={mode === "image" ? t("imagePromptPlaceholder") : t("videoPromptPlaceholder")}
                  onChange={(event) => patchDraft({ prompt: event.target.value, enhancedPrompt: "", enhancedPromptDirty: false })}
                  onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void runGeneration(); }}
                />
                {mentionSuggestions.length ? (
                  <div className="mention-menu" role="listbox" aria-label={t("numberedInputs")}>
                    {mentionSuggestions.map((reference) => {
                      const asset = assetMap.get(reference.assetId);
                      return <Button type="button" variant="ghost" key={reference.assetId} onClick={() => patchDraft({ prompt: draft.prompt.replace(/#\d*$/, `#${reference.slot} `) })}><b>#{reference.slot}</b>{asset?.name}</Button>;
                    })}
                  </div>
                ) : null}
              </div>
              {draft.references.length ? <div className="prompt-references">{draft.references.map((reference) => {
                const asset = assetMap.get(reference.assetId);
                return asset ? (
                  <Tooltip.Root key={reference.assetId}>
                    <Tooltip.Trigger render={<Button type="button" variant="ghost" />} onClick={() => patchDraft({ prompt: `${draft.prompt}${draft.prompt.endsWith(" ") || !draft.prompt ? "" : " "}#${reference.slot} ` })}>#{reference.slot}</Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Positioner sideOffset={6}>
                        <Tooltip.Popup className="token-tooltip"><AssetPreview asset={asset} /><span>{asset.name}</span></Tooltip.Popup>
                      </Tooltip.Positioner>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                ) : <Button type="button" variant="ghost" key={reference.assetId} onClick={() => patchDraft({ prompt: `${draft.prompt}${draft.prompt.endsWith(" ") || !draft.prompt ? "" : " "}#${reference.slot} ` })}>#{reference.slot}</Button>;
              })}</div> : null}
              {promptReferenceError ? <Field.Error className="field-error" match>{promptReferenceError}</Field.Error> : null}
            </Field.Root>

            <Field.Root className="enhance-row">
              <Field.Label className="enhance-label" nativeLabel={false} render={<div />}><span><Sparkles /><span><strong>{t("promptEnhancement")}</strong><small>{studio.promptModel.endsWith("luna") ? "GPT-5.6 Luna · xhigh" : "GPT-5.6 Terra · high"}</small></span></span></Field.Label>
              <div><Button size="xs" variant="ghost" disabled={enhancing || !draft.prompt.trim()} onClick={() => void runEnhancement().catch((error) => setGenerationError(errorMessage(error)))}>{enhancing ? <LoaderCircle className="spin" /> : <RefreshCw />} {draft.enhancedPrompt ? t("reEnhance") : t("preview")}</Button><Switch checked={draft.enhancePrompt} onCheckedChange={(value) => patchDraft({ enhancePrompt: value })} /></div>
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

            <InputTray references={draft.references} assets={session.assets} roles={roles} limit={referenceLimit} error={inputValidationError} onChange={(references) => {
              const targetStillAttached = references.some((reference) => `#${reference.slot}` === draft.imageEditTarget);
              patchDraft({
                references,
                imageEditTarget: mode === "image" && draft.imageEditMode && !targetStillAttached ? "" : draft.imageEditTarget,
                maskStrokes: mode === "image" && draft.imageEditMode && !targetStillAttached ? [] : draft.maskStrokes,
                maskInstructions: mode === "image" && draft.imageEditMode && !targetStillAttached ? "" : draft.maskInstructions,
                enhancedPrompt: "",
                enhancedPromptDirty: false,
              });
            }} onImport={importFiles} onPick={pickFiles} />
            <OptionsFields key={`${mode}:${workflow}:${selectedModel?.id ?? ""}`} mode={mode} model={selectedModel} options={draft.options} providerJson={draft.providerJson} providerError={providerError} onOptionsChange={(options) => patchDraft({ options })} onProviderJsonChange={(providerJson) => patchDraft({ providerJson })} />
          </div>
          <footer className="generate-bar">
            <div className="generate-meta">
              <div><span>{selectedModel ? t("requestFields", { count: Object.keys(requestPayload).length }) : t("noModelSelected")}</span><small>{mode === "video" ? t("backgroundJobs", { count: session.activeVideoJobs.length }) : t("commandGenerate")}</small></div>
              <RequestPreviewDialog mode={mode} request={prettyRequest(requestPayload)} references={previewReferences} />
            </div>
            <Button size="lg" className="generate-button" disabled={!canGenerate} onClick={() => void runGeneration()}>
              {generating || enhancing ? <LoaderCircle className="spin" /> : mode === "image" ? <Sparkles /> : <Play />}
              {generating || enhancing
                ? t("preparing")
                : mode === "image"
                  ? draft.imageEditMode ? t("editImage") : t("generateMode", { mode: t("image") })
                  : workflow === "edit" ? t("editVideo") : t("generateMode", { mode: t("video") })}
              {!generating && !enhancing ? <ChevronRight /> : null}
            </Button>
          </footer>
          </ScrollArea>
        </section>

        <RightPanel
          tab={rightPanelTab}
          onTabChange={setRightPanelTab}
          agent={(
            <AgentPanel
              state={session.agent}
              jobs={session.activeVideoJobs}
              onToggleControl={toggleControlMode}
              onPauseResume={() => patchAgent((current) => ({
                ...current,
                runStatus: current.runStatus === "paused" ? "working" : "paused",
                pausedReason: current.runStatus === "paused" ? undefined : "Paused by user.",
              }))}
              onStop={() => patchAgent((current) => ({ ...current, runStatus: "idle", pausedReason: "Stopped by user." }))}
            />
          )}
          assets={(
            <AssetLibrary assets={session.assets} jobs={session.activeVideoJobs} artifacts={session.agent.artifacts} approvedVideoCount={approvedVideoCount} onOpenAssembly={() => setAssemblyOpen(true)} selectedIds={selectedAssetIds} onSelectedIdsChange={setSelectedAssetIds} onImport={async (files) => { await importFiles(files); }} onPick={async () => { await pickFiles(); }} onUse={addAssetAsReference} onDelete={(ids) => void deleteAssets(ids)} />
          )}
        />
      </main>

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
      </Suspense>
      <ConfirmDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />
      <UpdatePrompt />
    </div>
    </Tooltip.Provider>
  );
}
