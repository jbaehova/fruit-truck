import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { useEffect, useState } from "react";
import { ExternalLink, KeyRound, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n, type Language } from "@/i18n";
import type { CredentialStatus } from "@/openrouter";
import { PROMPT_MODELS, type PromptModel } from "@/studio";

type Props = {
  open: boolean;
  status: CredentialStatus | null;
  onClose: () => void;
  onSave: (key: string) => Promise<void>;
  onRemove: () => Promise<void>;
  promptModel: PromptModel;
  onPromptModelChange: (model: PromptModel) => void;
};

export function SettingsDialog({ open, status, onClose, onSave, onRemove, promptModel, onPromptModelChange }: Props) {
  const { language, setLanguage, t } = useI18n();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKey("");
      setError(null);
    }
  }, [open]);

  const saveKey = async () => {
    try {
      setBusy(true);
      setError(null);
      await onSave(key);
      setKey("");
    } catch (cause) {
      setError(String(cause));
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
                <span className="dialog-icon"><KeyRound /></span>
                <div>
                  <Dialog.Title className="dialog-title">{t("openRouterConnection")}</Dialog.Title>
                  <Dialog.Description className="dialog-description">{t("connectionHint")}</Dialog.Description>
                </div>
              </div>
              <Dialog.Close render={<Button type="button" variant="ghost" size="icon" />} aria-label={t("closeSettings")}><X /></Dialog.Close>
            </header>
            <div className="settings-body">
              <Form onFormSubmit={() => void saveKey()}>
                <Field.Root className="settings-key-field" name="apiKey" invalid={Boolean(error)}>
                  <Field.Label>{t("apiKey")}</Field.Label>
                  <div>
                    <Input type="password" autoComplete="off" placeholder={status?.maskedKey ?? "sk-or-v1-…"} value={key} onChange={(event) => setKey(event.target.value)} />
                    <Button type="submit" disabled={busy || key.trim().length < 12}>{t("saveKey")}</Button>
                  </div>
                  {error ? <Field.Error className="field-error" match>{error}</Field.Error> : null}
                </Field.Root>
              </Form>
              <div className="credential-location">
                <ShieldCheck />
                <span>
                  <strong>{t("localPlaintextStorage")}</strong>
                  <small>{status?.path ?? "~/.open-gen-ui/credentials.json"}<br />{t("storagePermissions")}</small>
                </span>
              </div>
              <Field.Root className="settings-key-field">
                <Field.Label className="settings-field-label" nativeLabel={false} render={<div />}>{t("language")}</Field.Label>
                <Select value={language} onValueChange={(value) => value && setLanguage(value as Language)}>
                  <SelectTrigger><span className="base-select-value">{language === "en" ? t("english") : t("korean")}</span></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">{t("english")}</SelectItem>
                    <SelectItem value="ko">{t("korean")}</SelectItem>
                  </SelectContent>
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
              <p className="settings-note">{t("keyPrivacyHint")}</p>
              <Button
                variant="ghost"
                size="sm"
                className="external-link"
                nativeButton={false}
                render={<a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" />}
              >
                {t("manageKeys")} <ExternalLink />
              </Button>
            </div>
            <footer className="settings-footer">
              <Button type="button" variant="outline" disabled={!status?.configured || busy} onClick={() => void (async () => {
                try {
                  setBusy(true);
                  await onRemove();
                } finally {
                  setBusy(false);
                }
              })()}>{t("removeSavedKey")}</Button>
              <Dialog.Close render={<Button type="button" />}>{t("done")}</Dialog.Close>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
