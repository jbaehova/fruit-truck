import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, History, Pencil, ShieldCheck, SlidersHorizontal, Upload, WandSparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n, type Language } from "@/i18n";
import type { CredentialStatus } from "@/openrouter";
import { PROMPT_MODELS, type PromptModel } from "@/studio";
import {
  importCustomSkill,
  listCustomSkills,
  readCustomSkill,
  rollbackCustomSkill,
  type CustomSkillSummary,
} from "@/agentBridge";

type Props = {
  open: boolean;
  status: CredentialStatus | null;
  onClose: () => void;
  onSave: (key: string) => Promise<void>;
  onRemove: () => Promise<void>;
  promptModel: PromptModel;
  onPromptModelChange: (model: PromptModel) => void;
  activeCustomSkillNames: string[];
};

export function SettingsDialog({
  open,
  status,
  onClose,
  onSave,
  onRemove,
  promptModel,
  onPromptModelChange,
  activeCustomSkillNames,
}: Props) {
  const { language, setLanguage, t } = useI18n();
  const [key, setKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skills, setSkills] = useState<CustomSkillSummary[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const refreshSkills = async () => {
    try {
      setSkillsBusy(true);
      setSkills(await listCustomSkills());
    } catch (cause) {
      setSkillError(String(cause));
    } finally {
      setSkillsBusy(false);
    }
  };

  useEffect(() => {
    if (open) {
      setKey("");
      setEditingKey(false);
      setKeyError(null);
      setSkillError(null);
      void refreshSkills();
    }
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
                    <small>{status === null ? t("loading") : status.configured ? t("apiKeyConfiguredHint") : t("apiKeyMissingHint")}</small>
                  </div>
                  {status?.configured && !editingKey ? (
                    <Button type="button" variant="outline" size="xs" onClick={() => setEditingKey(true)}>
                      <Pencil /> {t("changeApiKey")}
                    </Button>
                  ) : null}
                </header>
                {status === null ? (
                  <p className="settings-credential-loading">{t("loading")}</p>
                ) : status.configured && !editingKey ? (
                  <div className="credential-summary">
                    <span className="credential-summary-icon"><Check /></span>
                    <span>
                      <strong>{t("apiKeyConfigured")}</strong>
                      <small>{status.maskedKey}</small>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => void removeKey()}
                    >{t("removeSavedKey")}</Button>
                  </div>
                ) : (
                  <Form onFormSubmit={() => void saveKey()}>
                    <Field.Root className="settings-key-field" name="apiKey" invalid={Boolean(keyError)}>
                      <Field.Label className="sr-only">{t("apiKey")}</Field.Label>
                      <div>
                        <Input
                          autoFocus={editingKey}
                          type="password"
                          autoComplete="off"
                          placeholder="sk-or-v1-…"
                          value={key}
                          onChange={(event) => setKey(event.target.value)}
                        />
                        {status?.configured ? (
                          <Button type="button" variant="outline" onClick={() => {
                            setKey("");
                            setKeyError(null);
                            setEditingKey(false);
                          }}>{t("cancel")}</Button>
                        ) : null}
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
                    <strong>{t("localPlaintextStorage")}</strong>
                    <small>{status?.path ?? "~/.fruit-truck/credentials.json"}<br />{t("storagePermissions")}</small>
                  </span>
                </div>
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
              </section>
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
              <section className="settings-agent-skills" aria-labelledby="settings-agent-skills-title">
                <header>
                  <span><WandSparkles /></span>
                  <div><strong id="settings-agent-skills-title">{t("agentSkills")}</strong><small>{t("agentSkillsHint")}</small></div>
                  <Button size="xs" variant="outline" onClick={() => importRef.current?.click()}><Upload /> {t("import")}</Button>
                </header>
                <Input ref={importRef} className="sr-only" type="file" accept=".md,text/markdown,text/plain" onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  void file.text()
                    .then((markdown) => importCustomSkill(file.name.replace(/\.md$/i, ""), markdown))
                    .then(refreshSkills)
                    .catch((cause) => setSkillError(String(cause)));
                }} />
                <div className="settings-skill-list">
                  {skills.map((skill) => {
                    const active = activeCustomSkillNames.includes(skill.name);
                    return <article key={skill.path}>
                      <div><strong>{skill.name}</strong><small>v{skill.version} · {skill.versions.length} {t("versions")}</small></div>
                      {active ? <span className="settings-skill-active">{t("activeInSession")}</span> : null}
                      <Button size="icon-xs" variant="ghost" aria-label={t("viewSkill")} onClick={() => void readCustomSkill(skill.name).then((value) => {
                        const blob = new Blob([value.markdown], { type: "text/markdown" });
                        const url = URL.createObjectURL(blob);
                        window.open(url, "_blank", "noopener,noreferrer");
                        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
                      }).catch((cause) => setSkillError(String(cause)))}><ExternalLink /></Button>
                      {skill.versions.length > 1 ? <Button size="icon-xs" variant="ghost" aria-label={t("rollbackSkill")} onClick={() => void rollbackCustomSkill(skill.name, skill.versions[1]).then(refreshSkills).catch((cause) => setSkillError(String(cause)))}><History /></Button> : null}
                    </article>;
                  })}
                  {!skills.length ? <p>{skillsBusy ? t("loading") : t("noAgentSkills")}</p> : null}
                </div>
                {skillError ? <p className="settings-skill-error" role="alert">{skillError}</p> : null}
              </section>
              <p className="settings-note">
                {t("ffmpegNotice")}{" "}
                <a href="https://github.com/jbaehova/fruit-truck/releases/latest" target="_blank" rel="noreferrer">
                  {t("ffmpegSource")} <ExternalLink />
                </a>
              </p>
            </div>
            <footer className="settings-footer">
              <Dialog.Close render={<Button type="button" />}>{t("done")}</Dialog.Close>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
