import { Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionAsset } from "@/studio";
import { resolveAssetSource } from "@/studio";
import { useI18n } from "@/i18n";

function videoThumbnailSource(source: string) {
  if (/(?:^|[&#])t=/.test(source)) return source;
  return `${source}${source.includes("#") ? "&" : "#"}t=0.001`;
}

function formatMediaTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const totalSeconds = Math.floor(value);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function TransparentVideoPlayer({ source, name, className }: { source: string; name: string; className?: string }) {
  const { t } = useI18n();
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else if (playerRef.current) void playerRef.current.requestFullscreen().catch(() => undefined);
  };

  return (
    <div className={`asset-video-player ${className ?? ""}`} ref={playerRef}>
      <video
        ref={videoRef}
        src={source}
        aria-label={name}
        playsInline
        preload="metadata"
        draggable={false}
        onClick={togglePlayback}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          togglePlayback();
        }}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onVolumeChange={(event) => {
          setMuted(event.currentTarget.muted);
          setVolume(event.currentTarget.volume);
        }}
        tabIndex={0}
      />
      <div className="asset-video-controls">
        <button type="button" aria-label={t(paused ? "playVideo" : "pauseVideo")} onClick={togglePlayback}>
          {paused ? <Play /> : <Pause />}
        </button>
        <span>{formatMediaTime(currentTime)}</span>
        <input
          className="asset-video-timeline"
          type="range"
          min="0"
          max={duration || 0}
          step="0.01"
          value={Math.min(currentTime, duration || 0)}
          aria-label={t("videoTimeline")}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (videoRef.current) videoRef.current.currentTime = next;
            setCurrentTime(next);
          }}
        />
        <span>{formatMediaTime(duration)}</span>
        <button
          type="button"
          aria-label={t(muted || volume === 0 ? "unmuteVideo" : "muteVideo")}
          onClick={() => {
            if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
          }}
        >
          {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
        </button>
        <input
          className="asset-video-volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={muted ? 0 : volume}
          aria-label={t("videoVolume")}
          onChange={(event) => {
            if (!videoRef.current) return;
            videoRef.current.muted = false;
            videoRef.current.volume = Number(event.target.value);
          }}
        />
        <button type="button" aria-label={t(fullscreen ? "exitFullscreen" : "enterFullscreen")} onClick={toggleFullscreen}>
          {fullscreen ? <Minimize2 /> : <Maximize2 />}
        </button>
      </div>
    </div>
  );
}

export function AssetPreview({
  asset,
  className,
  controls = false,
  transparentControls = false,
  interactiveError = false,
}: {
  asset: SessionAsset;
  className?: string;
  controls?: boolean;
  transparentControls?: boolean;
  interactiveError?: boolean;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState(asset.externalUrl ?? "");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setLoadState("loading");
    void resolveAssetSource(asset).then((value) => {
      if (!active) {
        if (value.startsWith("blob:")) URL.revokeObjectURL(value);
        return;
      }
      objectUrl = value;
      setSource(value);
      setLoadState(value ? "ready" : "error");
    }).catch(() => {
      if (active) {
        setSource("");
        setLoadState("error");
      }
    });
    return () => {
      active = false;
      if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [asset, revision]);

  if (loadState === "loading") return <span className={`asset-missing loading ${className ?? ""}`} role="status">{t("loading")}</span>;
  if (!source || loadState === "error") return <span className={`asset-missing error ${className ?? ""}`} role="alert"><span>{t("mediaLoadFailed")}</span>{interactiveError ? <button type="button" onClick={() => setRevision((current) => current + 1)}>{t("retryMedia")}</button> : null}</span>;
  if (asset.kind === "image") return <img className={className} src={source} alt={asset.name} draggable={false} onError={() => setLoadState("error")} />;
  if (asset.kind === "audio") return <audio className={className} src={source} controls preload="metadata" onError={() => setLoadState("error")} />;
  if (transparentControls) return <TransparentVideoPlayer source={source} name={asset.name} className={className} />;
  return <video
    className={className}
    src={controls ? source : videoThumbnailSource(source)}
    controls={controls}
    muted={!controls}
    playsInline
    preload={controls ? "metadata" : "auto"}
    draggable={false}
    onError={() => setLoadState("error")}
  />;
}
