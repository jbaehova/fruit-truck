import { useEffect, useState } from "react";
import { ExternalLink, KeyRound, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CredentialStatus } from "@/openrouter";

type Props = {
  open: boolean;
  status: CredentialStatus | null;
  onClose: () => void;
  onSave: (key: string) => Promise<void>;
  onRemove: () => Promise<void>;
};

export function SettingsDialog({ open, status, onClose, onSave, onRemove }: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setKey(""); setError(null); } }, [open]);
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><span className="dialog-icon"><KeyRound /></span><div><h2 id="settings-title">OpenRouter connection</h2><p>One key, stored only on this device.</p></div></div>
          <Button type="button" variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}><X /></Button>
        </header>
        <div className="settings-body">
          <label className="settings-key-field">
            <span>API key</span>
            <div><Input type="password" autoComplete="off" placeholder={status?.maskedKey ?? "sk-or-v1-…"} value={key} onChange={(event) => setKey(event.target.value)} /><Button type="button" disabled={busy || key.trim().length < 12} onClick={() => void (async () => { try { setBusy(true); setError(null); await onSave(key); setKey(""); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } })()}>Save key</Button></div>
            {error ? <small className="field-error">{error}</small> : null}
          </label>
          <div className="credential-location"><ShieldCheck /><span><strong>Local plaintext storage</strong><small>{status?.path ?? "~/.open-gen-ui/credentials.json"}<br />Directory 0700 · file 0600 on macOS and Linux</small></span></div>
          <p className="settings-note">The key never enters the request preview or application logs. It is attached by the Tauri process only when calling OpenRouter.</p>
          <a className="external-link" href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Manage keys on OpenRouter <ExternalLink /></a>
        </div>
        <footer>
          <Button type="button" variant="destructive" disabled={!status?.configured || busy} onClick={() => void (async () => { try { setBusy(true); await onRemove(); } finally { setBusy(false); } })()}>Remove saved key</Button>
          <Button type="button" variant="outline" onClick={onClose}>Done</Button>
        </footer>
      </section>
    </div>
  );
}
