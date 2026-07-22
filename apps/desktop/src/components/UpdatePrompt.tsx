import { useEffect, useRef, useState } from "react";
import { ArrowRight, Download, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "@/components/ui/button";

type UpdatePhase = "ready" | "installing" | "failed";

let updateCheck: Promise<Update | null> | null = null;

function checkOnce() {
  updateCheck ??= check();
  return updateCheck;
}

export function UpdatePrompt() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("ready");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const downloadedRef = useRef(0);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    void checkOnce()
      .then((available) => { if (active && available) setUpdate(available); })
      .catch(() => { /* A failed background check should not interrupt the workspace. */ });
    return () => { active = false; };
  }, []);

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
      await relaunch();
    } catch (error) {
      setPhase("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (!update) return null;
  const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  return (
    <div className="update-backdrop" role="presentation">
      <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <div className="update-art" aria-hidden="true"><Sparkles /><i /><i /><i /></div>
        <div className="update-copy">
          <p className="update-kicker">UPDATE AVAILABLE</p>
          <h2 id="update-title">A sharper build is ready.</h2>
          <p className="update-version"><span>v{update.currentVersion}</span><ArrowRight /><strong>v{update.version}</strong></p>
          {update.body ? <p className="update-notes">{update.body}</p> : <p className="update-notes">Install the latest fixes and improvements, then return to your workspace.</p>}

          {phase === "installing" ? (
            <div className="update-progress" aria-live="polite">
              <div><span>Downloading and verifying…</span><b>{percent == null ? "" : `${percent}%`}</b></div>
              <span className="update-progress-track"><i style={{ width: percent == null ? "18%" : `${percent}%` }} /></span>
            </div>
          ) : null}
          {phase === "failed" ? <p className="update-error" role="alert">Update failed. {message}</p> : null}

          <div className="update-actions">
            <Button type="button" variant="ghost" disabled={phase === "installing"} onClick={dismiss}>Later</Button>
            <Button type="button" disabled={phase === "installing"} onClick={() => void install()}>
              {phase === "installing" ? <LoaderCircle className="spin" /> : phase === "failed" ? <RefreshCw /> : <Download />}
              {phase === "installing" ? "Installing…" : phase === "failed" ? "Try again" : "Update and restart"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
