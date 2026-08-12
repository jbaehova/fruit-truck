import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, ExternalLink, History, LoaderCircle, Pencil, PlugZap, RefreshCw, ShieldCheck, SlidersHorizontal, Unplug, Upload, WandSparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n, type Language } from "@/i18n";
import type { CredentialStatus } from "@/openrouter";
import { PROMPT_MODELS, type PromptModel } from "@/studio";
import {
  importCustomSkill,
  installAgentIntegration,
  listAgentIntegrations,
  listCustomSkills,
  readCustomSkill,
  removeAgentIntegration,
  rollbackCustomSkill,
  type AgentIntegrationStatus,
  type AgentIntegrationTarget,
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
  const [connections, setConnections] = useState<AgentIntegrationStatus[]>([]);
  const [connectionBusy, setConnectionBusy] = useState<AgentIntegrationTarget | "all" | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [restartTargets, setRestartTargets] = useState<string[]>([]);
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

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await listAgentIntegrations());
    } catch {
      setConnectionError(t("agentConnectionFailed"));
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      setKey("");
      setEditingKey(false);
      setKeyError(null);
      setSkillError(null);
      setConnectionError(null);
      setRestartTargets([]);
      void refreshSkills();
      void refreshConnections();
    }
  }, [open, refreshConnections]);

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

  const connectAgent = async (target: AgentIntegrationTarget) => {
    const result = await installAgentIntegration(target);
    setConnections((current) => current.map((item) => item.target === target ? result.status : item));
    if (result.restartRequired) {
      setRestartTargets((current) => [...new Set([...current, result.status.displayName])]);
    }
  };

  const connectOne = async (target: AgentIntegrationTarget) => {
    try {
      setConnectionBusy(target);
      setConnectionError(null);
      await connectAgent(target);
    } catch {
      setConnectionError(t("agentConnectionFailed"));
      await refreshConnections();
    } finally {
      setConnectionBusy(null);
    }
  };

  const connectAll = async () => {
    try {
      setConnectionBusy("all");
      setConnectionError(null);
      for (const connection of connections.filter((item) => item.cliAvailable && (!item.connected || item.needsUpdate))) {
        await connectAgent(connection.target);
      }
    } catch {
      setConnectionError(t("agentConnectionFailed"));
      await refreshConnections();
    } finally {
      setConnectionBusy(null);
    }
  };

  const disconnectAgent = async (target: AgentIntegrationTarget) => {
    try {
      setConnectionBusy(target);
      setConnectionError(null);
      const result = await removeAgentIntegration(target);
      setConnections((current) => current.map((item) => item.target === target ? result.status : item));
      if (result.restartRequired) {
        setRestartTargets((current) => [...new Set([...current, result.status.displayName])]);
      }
    } catch {
      setConnectionError(t("agentConnectionFailed"));
      await refreshConnections();
    } finally {
      setConnectionBusy(null);
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
              <section className="settings-agent-connections" aria-labelledby="settings-agent-connections-title">
                <header>
                  <span><PlugZap /></span>
                  <div>
                    <strong id="settings-agent-connections-title">{t("agentConnections")}</strong>
                    <small>{t("agentConnectionsHint")}</small>
                  </div>
                  {connections.some((item) => item.cliAvailable && (!item.connected || item.needsUpdate)) ? (
                    <Button type="button" size="xs" disabled={connectionBusy !== null} onClick={() => void connectAll()}>
                      {connectionBusy === "all" ? <LoaderCircle className="spin" /> : <PlugZap />}
                      {t("connectAvailableAgents")}
                    </Button>
                  ) : null}
                </header>
                <div className="agent-connection-list">
                  {connections.length ? connections.map((connection) => {
                    const busyTarget = connectionBusy === connection.target || connectionBusy === "all";
                    const statusLabel = connection.needsUpdate
                        ? t("agentUpdateReady")
                        : connection.connected
                          ? t("agentConnected")
                          : !connection.cliAvailable ? t("agentNotInstalled") : t("agentReadyToConnect");
                    const detailLabel = connection.connected
                      ? t("agentConnectedHint")
                      : !connection.cliAvailable ? t("agentMissingHint") : t("agentReadyHint");
                    return (
                      <article className={connection.connected ? "connected" : ""} key={connection.target}>
                        <span className="agent-connection-mark" aria-hidden="true">{connection.target === "claude" ? "CL" : connection.target === "codex" ? "CX" : "HM"}</span>
                        <div>
                          <strong>{connection.displayName}</strong>
                          <small>{detailLabel}</small>
                        </div>
                        <span className={`agent-connection-status ${connection.connected ? "connected" : connection.cliAvailable ? "available" : "missing"}`}>
                          {connection.connected ? <Check /> : !connection.cliAvailable ? <CircleAlert /> : null}
                          {statusLabel}
                        </span>
                        {connection.cliAvailable ? (
                          <Button
                            type="button"
                            size="xs"
                            variant={connection.connected && !connection.needsUpdate ? "outline" : "default"}
                            disabled={connectionBusy !== null}
                            onClick={() => void connectOne(connection.target)}
                          >
                            {busyTarget ? <LoaderCircle className="spin" /> : connection.connected ? <RefreshCw /> : <PlugZap />}
                            {connection.needsUpdate ? t("updateConnection") : connection.connected ? t("repairConnection") : t("connectAgent")}
                          </Button>
                        ) : null}
                        {connection.connected ? (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            disabled={connectionBusy !== null}
                            aria-label={t("disconnectAgent", { name: connection.displayName })}
                            onClick={() => void disconnectAgent(connection.target)}
                          ><Unplug /></Button>
                        ) : null}
                      </article>
                    );
                  }) : <p className="agent-connections-loading">{t("loading")}</p>}
                </div>
                {restartTargets.length ? (
                  <p className="agent-connection-restart"><Check /> {t("restartAgentsToFinish", { names: restartTargets.join(", ") })}</p>
                ) : null}
                {connectionError ? <p className="settings-connection-error" role="alert">{connectionError}</p> : null}
                <p className="settings-note">{t("agentConnectionPrivacy")}</p>
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
                <input ref={importRef} hidden tabIndex={-1} type="file" accept=".md,text/markdown,text/plain" onChange={(event) => {
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
