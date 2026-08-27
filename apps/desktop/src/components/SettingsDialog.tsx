import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { useEffect, useState } from "react";
import { Check, Download, ExternalLink as ExternalLinkIcon, Pencil, RefreshCw, ShieldCheck, SlidersHorizontal, Upload, X } from "lucide-react";
import { ExternalLink } from "@/components/ExternalLink";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useI18n, type Language } from "@/i18n";
import type { CredentialStatus, CredentialValidationStatus } from "@/openrouter";
import { PROMPT_MODELS, type PromptModel } from "@/studio";

type Props = {
  open: boolean;
  status: CredentialStatus | null;
  connectionState: CredentialValidationStatus | "validating" | null;
  onClose: () => void;
  onSave: (key: string) => Promise<void>;
  onRemove: () => Promise<void>;
  promptModel: PromptModel;
  onPromptModelChange: (model: PromptModel) => void;
  defaultEnhancePrompt: boolean;
  onDefaultEnhancePromptChange: (enabled: boolean) => void;
  onExportSupport: () => void;
  onExportWorkspace: () => void;
  onImportWorkspace: () => void;
  onStartGuide: () => void;
  sessionBudgetUsd: number | null;
  onSessionBudgetChange: (value: number | null) => void;
};

export function SettingsDialog({
  open,
  status,
  connectionState,
  onClose,
  onSave,
  onRemove,
  promptModel,
  onPromptModelChange,
  defaultEnhancePrompt,
  onDefaultEnhancePromptChange,
  onExportSupport,
  onExportWorkspace,
  onImportWorkspace,
  onStartGuide,
  sessionBudgetUsd,
  onSessionBudgetChange,
}: Props) {
  const { language, setLanguage, t } = useI18n();
  const [key, setKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<{ status?: string; lastCheckedAt?: number | null }>({});

  useEffect(() => {
    if (!open) return;
    const sync = (event?: Event) => {
      if (event instanceof CustomEvent && event.detail) {
        setUpdateState(event.detail as { status?: string; lastCheckedAt?: number | null });
        return;
      }
      try { setUpdateState(JSON.parse(localStorage.getItem("fruit-truck.update.last-state") ?? "{}") as { status?: string; lastCheckedAt?: number | null }); } catch { setUpdateState({}); }
    };
    sync();
    window.addEventListener("fruit-truck:update-state", sync);
    return () => window.removeEventListener("fruit-truck:update-state", sync);
  }, [open]);

  const saveKey = async () => {
    try {
      setBusy(true);
      setKeyError(null);
      await onSave(key);
      setKey("");
      setEditingKey(false);
    } catch (cause) {
      setKeyError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    try {
      setBusy(true);
      setKeyError(null);
      await onRemove();
    } catch (cause) {
      setKeyError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="settings-dialog">
            <header className="dialog-header">
              <div className="dialog-heading">
                <span className="dialog-icon"><SlidersHorizontal /></span>
                <div>
                  <Dialog.Title className="dialog-title">{t("settingsTitle")}</Dialog.Title>
                  <Dialog.Description className="dialog-description">{t("settingsHint")}</Dialog.Description>
                </div>
              </div>
              <Dialog.Close render={<Button type="button" variant="ghost" size="icon" />} aria-label={t("closeSettings")}><X /></Dialog.Close>
            </header>
            <div className="settings-body">
              <section className="settings-credential" aria-labelledby="settings-api-key-title">
                <header className="settings-section-header">
                  <div>
                    <strong id="settings-api-key-title">{t("apiKey")}</strong>
                    <small>{status === null ? t("loading") : status.configured ? t(connectionState === "connected" ? "keyConnected" : connectionState === "validating" ? "keyValidating" : connectionState === "unauthorized" ? "keyUnauthorized" : connectionState === "rate_limited" ? "keyRateLimited" : connectionState === "offline" || connectionState === "server_error" ? "keyOffline" : "keyStored") : t("apiKeyMissingHint")}</small>
                  </div>
                  {status?.configured && !editingKey ? (
                    <Button type="button" variant="outline" size="xs" onClick={() => setEditingKey(true)}><Pencil /> {t("changeApiKey")}</Button>
                  ) : null}
                </header>
                {status === null ? (
                  <p className="settings-credential-loading">{t("loading")}</p>
                ) : status.configured && !editingKey ? (
                  <div className="credential-summary">
                    <span className="credential-summary-icon"><Check /></span>
                    <span><strong>{t(connectionState === "connected" ? "keyConnected" : connectionState === "validating" ? "keyValidating" : connectionState === "unauthorized" ? "keyUnauthorized" : connectionState === "rate_limited" ? "keyRateLimited" : connectionState === "offline" || connectionState === "server_error" ? "keyOffline" : "keyStored")}</strong><small>{status.maskedKey}</small></span>
                    <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void removeKey()}>{t("removeSavedKey")}</Button>
                  </div>
                ) : (
                  <Form onFormSubmit={() => void saveKey()}>
                    <Field.Root className="settings-key-field" name="apiKey" invalid={Boolean(keyError)}>
                      <Field.Label className="sr-only">{t("apiKey")}</Field.Label>
                      <div>
                        <Input autoFocus={editingKey} type="password" autoComplete="off" placeholder="sk-or-v1-…" value={key} onChange={(event) => setKey(event.target.value)} />
                        {status?.configured ? <Button type="button" variant="outline" onClick={() => { setKey(""); setKeyError(null); setEditingKey(false); }}>{t("cancel")}</Button> : null}
                        <Button type="submit" disabled={busy || key.trim().length < 12}>{t("saveKey")}</Button>
                      </div>
                      {keyError ? <Field.Error className="field-error" match>{keyError}</Field.Error> : null}
                    </Field.Root>
                  </Form>
                )}
                {keyError && status?.configured && !editingKey ? <p className="settings-key-error" role="alert">{keyError}</p> : null}
                <div className="credential-location">
                  <ShieldCheck />
                  <span>
                    <strong>{t(status?.path.startsWith("macOS Keychain") ? "secureCredentialStorage" : "localPlaintextStorage")}</strong>
                    <small>{status?.path ?? "~/.fruit-truck/credentials.json"}<br />{t(status?.path.startsWith("macOS Keychain") ? "keychainPermissions" : "storagePermissions")}</small>
                  </span>
                </div>
                <p className="settings-note">{t("keyPrivacyHint")}</p>
                <ExternalLink className="external-link" href="https://openrouter.ai/settings/keys">
                  {t("manageKeys")} <ExternalLinkIcon />
                </ExternalLink>
              </section>
              <Field.Root className="settings-key-field">
                <Field.Label className="settings-field-label" nativeLabel={false} render={<div />}>{t("language")}</Field.Label>
                <Select value={language} onValueChange={(value) => value && setLanguage(value as Language)}>
                  <SelectTrigger><span className="base-select-value">{language === "en" ? t("english") : t("korean")}</span></SelectTrigger>
                  <SelectContent><SelectItem value="en">{t("english")}</SelectItem><SelectItem value="ko">{t("korean")}</SelectItem></SelectContent>
                </Select>
                <Field.Description>{t("languageHint")}</Field.Description>
              </Field.Root>
              <Field.Root className="settings-key-field">
                <Field.Label className="settings-field-label" nativeLabel={false} render={<div />}>{t("promptModel")}</Field.Label>
                <Select value={promptModel} onValueChange={(value) => value && onPromptModelChange(value as PromptModel)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{PROMPT_MODELS.map((model) => <SelectItem key={model.id} value={model.id}>{model.label} · {model.effort}</SelectItem>)}</SelectContent>
                </Select>
                <Field.Description>{t("promptModelHint")}</Field.Description>
              </Field.Root>
              <Field.Root className="settings-key-field settings-switch-field">
                <Field.Label className="settings-field-label" nativeLabel={false} render={<div />}>
                  <span><strong>{t("defaultPromptEnhancement")}</strong><small>{t("defaultPromptEnhancementHint")}</small></span>
                </Field.Label>
                <Switch checked={defaultEnhancePrompt} onCheckedChange={onDefaultEnhancePromptChange} />
              </Field.Root>
              <Field.Root className="settings-key-field">
                <Field.Label className="settings-field-label">{t("sessionBudget")}</Field.Label>
                <Input type="number" min="0" step="0.01" placeholder="USD" value={sessionBudgetUsd ?? ""} onChange={(event) => {
                  const value = event.target.value.trim();
                  onSessionBudgetChange(value ? Math.max(0, Number(value)) : null);
                }} />
                <Field.Description>{t("sessionBudgetHint")}</Field.Description>
              </Field.Root>
              <section className="settings-support-scope" aria-labelledby="settings-support-title">
                <header><strong id="settings-support-title">{t("supportScope")}</strong><small>{t("supportScopeHint")}</small></header>
                <dl>
                  {(["imageEndpointScope", "videoEndpointScope", "plannerEndpointScope"] as const).map((key) => <div key={key}><dt>{t(key)}</dt><dd data-status="available">{t("supportedNow")}</dd></div>)}
                  <div><dt>{t("unsupportedEndpointScope")}</dt><dd data-status="unavailable">{t("unavailableNow")}</dd></div>
                </dl>
              </section>
              <Button type="button" variant="outline" size="sm" onClick={onStartGuide}>{t("startWorkflowGuide")}</Button>
              <div className="settings-workspace-actions">
                <Button type="button" variant="outline" size="sm" onClick={onExportWorkspace}><Download /> {t("exportWorkspace")}</Button>
                <Button type="button" variant="outline" size="sm" onClick={onImportWorkspace}><Upload /> {t("importWorkspace")}</Button>
              </div>
              <div className="settings-update-check">
                <Button type="button" variant="outline" size="sm" onClick={() => window.dispatchEvent(new Event("fruit-truck:check-update"))}><RefreshCw /> {t("checkForUpdates")}</Button>
                <small>{updateState.lastCheckedAt ? `${t("lastUpdateCheck")}: ${new Date(updateState.lastCheckedAt).toLocaleString(language === "ko" ? "ko-KR" : "en-US")} · ${updateState.status ?? "unknown"}` : t("updateNotChecked")}</small>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onExportSupport}><Download /> {t("exportDiagnostics")}</Button>
            </div>
            <footer className="settings-footer"><Dialog.Close render={<Button type="button" />}>{t("done")}</Dialog.Close></footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
