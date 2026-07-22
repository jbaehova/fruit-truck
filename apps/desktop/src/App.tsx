import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  ImageIcon,
  LoaderCircle,
  PanelRight,
  Play,
  RefreshCw,
  Settings,
  Sparkles,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import "./App.css";
import { ModelSidebar } from "@/components/ModelSidebar";
import { OptionsFields } from "@/components/OptionsFields";
import { ReferenceUploader } from "@/components/ReferenceUploader";
import { SettingsDialog } from "@/components/SettingsDialog";
import { UpdatePrompt } from "@/components/UpdatePrompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  allowedAssetRoles,
  buildRequest,
  cacheVideo,
  defaultOptions,
  generateImage,
  getCredentialStatus,
  imageReferenceLimit,
  loadModels,
  pollVideo,
  prettyRequest,
  removeApiKey,
  saveApiKey,
  submitVideo,
  type CredentialStatus,
  type DraftOptions,
  type GenerationMode,
  type GenerationModel,
  type ImageModel,
  type ImageResult,
  type ReferenceAsset,
  type VideoModel,
  type VideoResult,
} from "@/openrouter";

type DraftState = {
  prompt: string;
  assets: ReferenceAsset[];
  options: DraftOptions;
  providerJson: string;
};

const EMPTY_DRAFT: DraftState = { prompt: "", assets: [], options: {}, providerJson: "" };
const ACTIVE_VIDEO_KEY = "open-gen-ui.active-video-job";

function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error:\s*/, "").slice(0, 800);
}

function providerLabel(model: GenerationModel | null) {
  return model?.name.split(":", 1)[0] ?? "OpenRouter";
}

function priceHint(model: GenerationModel | null, mode: GenerationMode) {
  if (mode !== "video" || !model) return null;
  const prices = Object.values((model as VideoModel).pricing_skus ?? {}).map(Number).filter(Number.isFinite);
  if (!prices.length) return null;
  return `from $${Math.min(...prices).toFixed(3)}`;
}

function OpenGenMark() {
  return <img src="/open-gen-ui-icon.png" alt="" aria-hidden="true" />;
}

export default function App() {
  const [mode, setMode] = useState<GenerationMode>("image");
  const [catalogs, setCatalogs] = useState<Record<GenerationMode, GenerationModel[]>>({ image: [], video: [] });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<GenerationMode, string>>({ image: "", video: "" });
  const [drafts, setDrafts] = useState<Record<GenerationMode, DraftState>>({ image: { ...EMPTY_DRAFT }, video: { ...EMPTY_DRAFT } });
  const [credential, setCredential] = useState<CredentialStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [imageResult, setImageResult] = useState<ImageResult | null>(null);
  const [videoResult, setVideoResult] = useState<VideoResult | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"result" | "request">("result");
  const composerRef = useRef<HTMLElement>(null);

  const models = catalogs[mode];
  const selectedId = selectedIds[mode];
  const selectedModel = models.find((model) => model.id === selectedId) ?? null;
  const draft = drafts[mode];
  const roles = allowedAssetRoles(mode, selectedModel);
  const referenceLimit = mode === "image" ? imageReferenceLimit(selectedModel as ImageModel | null) : 12;

  const refreshCatalog = useCallback(async () => {
    if (!credential?.configured) return;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const [images, videos] = await Promise.all([loadModels("image"), loadModels("video")]);
      setCatalogs({ image: images, video: videos });
      setSelectedIds((current) => ({
        image: images.some((item) => item.id === current.image) ? current.image : images[0]?.id ?? "",
        video: videos.some((item) => item.id === current.video) ? current.video : videos[0]?.id ?? "",
      }));
      setDrafts((current) => ({
        image: { ...current.image, options: Object.keys(current.image.options).length ? current.image.options : defaultOptions("image", images[0] ?? null) },
        video: { ...current.video, options: Object.keys(current.video.options).length ? current.video.options : defaultOptions("video", videos[0] ?? null) },
      }));
    } catch (error) {
      setCatalogError(errorMessage(error));
    } finally {
      setCatalogLoading(false);
    }
  }, [credential?.configured]);

  useEffect(() => {
    void getCredentialStatus().then((status) => {
      setCredential(status);
      if (!status.configured) setSettingsOpen(true);
    }).catch((error) => {
      toast.error(errorMessage(error));
      setSettingsOpen(true);
    });
  }, []);

  useEffect(() => { void refreshCatalog(); }, [refreshCatalog]);

  useEffect(() => {
    const stored = window.localStorage.getItem(ACTIVE_VIDEO_KEY);
    if (credential?.configured && stored && !videoResult) {
      setVideoResult({ kind: "video", jobId: stored, status: "in_progress" });
    }
  }, [credential?.configured, videoResult]);

  useEffect(() => {
    if (!videoResult || !["pending", "in_progress"].includes(videoResult.status)) return;
    const timer = window.setTimeout(() => {
      void pollVideo(videoResult.jobId).then(async (next) => {
        if (next.status === "completed" && !next.url) next.url = await cacheVideo(next.jobId);
        setVideoResult(next);
        if (next.status === "completed" || next.status === "failed") {
          window.localStorage.removeItem(ACTIVE_VIDEO_KEY);
          setGenerating(false);
        }
      }).catch((error) => {
        setGenerationError(errorMessage(error));
        setGenerating(false);
      });
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [videoResult]);

  const patchDraft = (patch: Partial<DraftState>) => {
    setDrafts((current) => ({ ...current, [mode]: { ...current[mode], ...patch } }));
  };

  const providerError = useMemo(() => {
    if (!draft.providerJson.trim()) return null;
    try {
      const value = JSON.parse(draft.providerJson) as unknown;
      return !value || Array.isArray(value) || typeof value !== "object" ? "Enter a JSON object." : null;
    } catch {
      return "Invalid JSON.";
    }
  }, [draft.providerJson]);

  const requestPayload = useMemo(() => {
    try {
      return buildRequest({ mode, model: selectedId, ...draft }, selectedModel);
    } catch {
      return {};
    }
  }, [draft, mode, selectedId, selectedModel]);

  const selectModel = (id: string) => {
    const model = models.find((item) => item.id === id) ?? null;
    setSelectedIds((current) => ({ ...current, [mode]: id }));
    setDrafts((current) => {
      const allowed = allowedAssetRoles(mode, model);
      const assets = current[mode].assets
        .filter(() => allowed.length > 0)
        .map((asset) => ({ ...asset, role: allowed.includes(asset.role) ? asset.role : allowed[0] }));
      return {
        ...current,
        [mode]: { ...current[mode], assets, options: defaultOptions(mode, model) },
      };
    });
    setGenerationError(null);
  };

  const runGeneration = async () => {
    if (!credential?.configured) { setSettingsOpen(true); return; }
    if (!selectedModel || !draft.prompt.trim() || providerError) return;
    try {
      setGenerating(true);
      setGenerationError(null);
      setInspectorTab("result");
      const payload = buildRequest({ mode, model: selectedId, ...draft }, selectedModel);
      if (mode === "image") {
        setImageResult(await generateImage(payload));
        setGenerating(false);
      } else {
        const result = await submitVideo(payload);
        setVideoResult(result);
        window.localStorage.setItem(ACTIVE_VIDEO_KEY, result.jobId);
      }
    } catch (error) {
      setGenerationError(errorMessage(error));
      setGenerating(false);
    }
  };

  const switchMode = (next: GenerationMode) => {
    setMode(next);
    setGenerationError(null);
    window.requestAnimationFrame(() => composerRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
  };

  const result = mode === "image" ? imageResult : videoResult;
  const canGenerate = Boolean(selectedModel && draft.prompt.trim() && !providerError && credential?.configured && !generating);

  return (
    <div className="app-shell">
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><span className="brand-mark"><OpenGenMark /></span><strong>OpenGen UI</strong><Badge variant="outline">Beta</Badge></div>
        <nav className="mode-switcher" aria-label="Generation mode">
          <span className={`mode-indicator ${mode}`} />
          <button type="button" className={mode === "image" ? "active" : ""} onClick={() => switchMode("image")}><ImageIcon /> Image</button>
          <button type="button" className={mode === "video" ? "active" : ""} onClick={() => switchMode("video")}><Video /> Video</button>
        </nav>
        <div className="topbar-actions">
          <button type="button" className="connection-pill" onClick={() => setSettingsOpen(true)}><i className={credential?.configured ? "online" : ""} />{credential?.configured ? credential.maskedKey : "Add API key"}</button>
          <Button type="button" variant="ghost" size="icon" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings /></Button>
        </div>
      </header>

      <main className="workspace">
        <ModelSidebar mode={mode} models={models} selectedId={selectedId} loading={catalogLoading} onSelect={selectModel} />

        <section className="composer" ref={composerRef}>
          {catalogError ? (
            <div className="catalog-error"><CircleAlert /><span><strong>Couldn’t load the model catalog</strong><small>{catalogError}</small></span><Button variant="outline" size="sm" onClick={() => void refreshCatalog()}><RefreshCw /> Retry</Button></div>
          ) : null}
          <header className="composer-header">
            <div>
              <p>{mode === "image" ? "Image generation" : "Video generation"}</p>
              <h1>{selectedModel?.name ?? (catalogLoading ? "Loading models…" : "Choose a model")}</h1>
            </div>
            {selectedModel ? <div className="model-meta"><span>{providerLabel(selectedModel)}</span>{priceHint(selectedModel, mode) ? <span>{priceHint(selectedModel, mode)}</span> : null}</div> : null}
          </header>
          {selectedModel?.description ? <p className="model-description">{selectedModel.description}</p> : null}

          <div className="composer-form">
            <label className="prompt-field">
              <div className="section-label-row"><span className="section-label">Prompt</span><small>{draft.prompt.length.toLocaleString()} characters</small></div>
              <Textarea
                autoFocus
                rows={7}
                value={draft.prompt}
                placeholder={mode === "image" ? "Describe the image you want to create…" : "Describe the scene, motion, camera, and pacing…"}
                onChange={(event) => patchDraft({ prompt: event.target.value })}
                onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void runGeneration(); }}
              />
              <small className="prompt-hint"><Sparkles /> Tip: reference images are sent in the order shown below.</small>
            </label>

            <ReferenceUploader assets={draft.assets} roles={roles} limit={referenceLimit} onChange={(assets) => patchDraft({ assets })} />
            <OptionsFields mode={mode} model={selectedModel} options={draft.options} providerJson={draft.providerJson} providerError={providerError} onOptionsChange={(options) => patchDraft({ options })} onProviderJsonChange={(providerJson) => patchDraft({ providerJson })} />
          </div>

          <footer className="generate-bar">
            <div><span>{selectedModel ? `${Object.keys(requestPayload).length} request fields` : "No model selected"}</span><small>{mode === "video" ? "Jobs continue in the background" : "⌘ Enter to generate"}</small></div>
            <Button size="lg" className="generate-button" disabled={!canGenerate} onClick={() => void runGeneration()}>
              {generating ? <LoaderCircle className="spin" /> : mode === "image" ? <Sparkles /> : <Play />}
              {generating ? (mode === "video" ? "Generating video…" : "Generating…") : `Generate ${mode}`}
              {!generating ? <ChevronRight /> : null}
            </Button>
          </footer>
        </section>

        <aside className="inspector">
          <div className="inspector-tabs">
            <button type="button" className={inspectorTab === "result" ? "active" : ""} onClick={() => setInspectorTab("result")}><PanelRight /> Result</button>
            <button type="button" className={inspectorTab === "request" ? "active" : ""} onClick={() => setInspectorTab("request")}><Braces /> Request</button>
          </div>
          {inspectorTab === "request" ? (
            <div className="request-view">
              <div className="request-endpoint"><Badge variant="secondary">POST</Badge><code>/api/v1/{mode}s</code></div>
              <pre>{prettyRequest(requestPayload)}</pre>
              <p>Local base64 payloads are hidden in this preview. Unsupported fields are removed before sending.</p>
            </div>
          ) : (
            <div className="result-view">
              {generationError ? <div className="generation-error"><CircleAlert /><div><strong>Generation failed</strong><p>{generationError}</p></div></div> : null}
              {!result && !generating && !generationError ? (
                <div className="result-empty"><span>{mode === "image" ? <ImageIcon /> : <Video />}</span><h2>Your {mode} will appear here</h2><p>Configure the request, then generate to preview and download the result.</p></div>
              ) : null}
              {generating && !result && mode === "image" ? <div className="result-loading"><span><LoaderCircle className="spin" /></span><strong>Generating image</strong><small>OpenRouter is processing your request…</small></div> : null}
              {mode === "image" && imageResult ? (
                <div className="image-results">
                  <div className={`image-grid count-${imageResult.urls.length}`}>{imageResult.urls.map((url, index) => <img key={`${url.slice(0, 40)}-${index}`} src={url} alt={`Generated result ${index + 1}`} />)}</div>
                  <div className="result-details"><span><Check /> Completed</span>{imageResult.usage?.cost != null ? <span>${String(imageResult.usage.cost)}</span> : null}</div>
                  <div className="result-actions">{imageResult.urls.map((url, index) => <Button key={index} variant="outline" nativeButton={false} render={<a href={url} download={`open-gen-${index + 1}.png`} />}><ArrowDownToLine /> Download{imageResult.urls.length > 1 ? ` ${index + 1}` : ""}</Button>)}</div>
                </div>
              ) : null}
              {mode === "video" && videoResult ? (
                <div className="video-result">
                  {videoResult.status === "completed" && videoResult.url ? <video src={videoResult.url} controls autoPlay loop playsInline /> : (
                    <div className="video-progress"><span className="progress-orbit"><Video /><i /></span><h2>{videoResult.status === "pending" ? "Waiting for a provider" : videoResult.status === "failed" ? "Video job failed" : "Generating video"}</h2><p>{videoResult.error ?? "This can take several minutes. You can close and reopen the app without losing the job."}</p>{videoResult.progress != null ? <div className="progress-track"><i style={{ width: `${videoResult.progress}%` }} /></div> : null}</div>
                  )}
                  <div className="job-timeline">
                    <span className="done"><Check /> Submitted</span><i /><span className={videoResult.status === "completed" ? "done" : videoResult.status === "failed" ? "failed" : "active"}>{videoResult.status === "completed" ? <Check /> : <Clock3 />} {videoResult.status.replace("_", " ")}</span>
                  </div>
                  <code className="job-id">{videoResult.jobId}</code>
                  {videoResult.status === "completed" && videoResult.url ? <Button variant="outline" nativeButton={false} render={<a href={videoResult.url} download={`open-gen-${videoResult.jobId}.mp4`} />}><ArrowDownToLine /> Download video</Button> : null}
                </div>
              ) : null}
            </div>
          )}
        </aside>
      </main>

      <SettingsDialog
        open={settingsOpen}
        status={credential}
        onClose={() => setSettingsOpen(false)}
        onSave={async (key) => { const status = await saveApiKey(key); setCredential(status); toast.success("OpenRouter key saved"); }}
        onRemove={async () => { const status = await removeApiKey(); setCredential(status); setCatalogs({ image: [], video: [] }); toast.success("Saved key removed"); }}
      />
      <UpdatePrompt />
    </div>
  );
}
