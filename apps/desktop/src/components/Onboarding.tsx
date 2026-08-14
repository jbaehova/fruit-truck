import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Fieldset } from "@base-ui/react/fieldset";
import { Form } from "@base-ui/react/form";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { isTauriRuntime } from "@/openrouter";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";

type OnboardingStep = "welcome" | "connect" | "complete";

type Props = {
  ready: boolean;
  onSave: (apiKey: string) => Promise<void>;
  onComplete: () => void;
};

export function Onboarding({ ready, onSave, onComplete }: Props) {
  const { t } = useI18n();
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completionTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (completionTimer.current) window.clearTimeout(completionTimer.current);
  }, []);

  useEffect(() => {
    if (ready) setStep("welcome");
  }, [ready]);

  const openKeys = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isTauriRuntime()) return;
    event.preventDefault();
    void openUrl(OPENROUTER_KEYS_URL);
  };

  const save = async () => {
    try {
      setBusy(true);
      setError(null);
      await onSave(apiKey.trim());
      finish();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error:\s*/, "") : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    setStep("complete");
    completionTimer.current = window.setTimeout(onComplete, 900);
  };

  const activeStep = step === "welcome" ? 1 : 2;

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Viewport className="onboarding-viewport">
          <Dialog.Popup className="onboarding-dialog" aria-describedby="onboarding-description">
            {!ready ? (
              <div className="onboarding-loading" role="status">
                <span className="onboarding-loading-mark"><img src="/fruit-truck-icon.png" alt="" /></span>
                <LoaderCircle className="spin" aria-hidden="true" />
                <span>{t("onboardingLoading")}</span>
              </div>
            ) : (
              <>
                <aside className="onboarding-rail">
                  <div className="onboarding-brand">
                    <span className="brand-mark"><img src="/fruit-truck-icon.png" alt="" /></span>
                    <strong>Fruit Truck</strong>
                  </div>

                  <div className="onboarding-progress" aria-label={t("onboardingProgress")}>
                    <span className="onboarding-progress-label">{t("onboardingSetup")}</span>
                    <ol>
                      <li className={activeStep === 1 ? "active" : "complete"}>
                        <span>{activeStep > 1 ? <Check /> : "01"}</span>
                        <div><strong>{t("onboardingWelcomeStep")}</strong><small>{t("onboardingWelcomeStepHint")}</small></div>
                      </li>
                      <li className={activeStep === 2 ? "active" : ""}>
                        <span>{step === "complete" ? <Check /> : "02"}</span>
                        <div><strong>{t("onboardingConnectStep")}</strong><small>{t("onboardingConnectStepHint")}</small></div>
                      </li>
                    </ol>
                  </div>

                  <div className="onboarding-rail-note">
                    <LockKeyhole aria-hidden="true" />
                    <span><strong>{t("onboardingLocalFirst")}</strong><small>{t("onboardingLocalFirstHint")}</small></span>
                  </div>
                </aside>

                <main className="onboarding-main">
                  {step === "welcome" ? (
                    <section className="onboarding-stage onboarding-welcome" key="welcome">
                      <span className="onboarding-kicker"><Sparkles /> {t("onboardingKicker")}</span>
                      <Dialog.Title className="onboarding-title">{t("onboardingTitle")}</Dialog.Title>
                      <Dialog.Description id="onboarding-description" className="onboarding-description">
                        {t("onboardingDescription")}
                      </Dialog.Description>

                      <div className="onboarding-flow-visual" aria-label={t("onboardingFlowLabel")}>
                        <div>
                          <span>01</span>
                          <p><small>{t("onboardingFlowPromptLabel")}</small><strong>{t("onboardingFlowPrompt")}</strong></p>
                          <CheckCircle2 />
                        </div>
                        <div>
                          <span>02</span>
                          <p><small>{t("onboardingFlowModelLabel")}</small><strong>{t("onboardingFlowModel")}</strong></p>
                          <span className="onboarding-live-dot" />
                        </div>
                        <div>
                          <span>03</span>
                          <p><small>{t("onboardingFlowResultLabel")}</small><strong>{t("onboardingFlowResult")}</strong></p>
                          <ArrowRight />
                        </div>
                      </div>

                      <footer className="onboarding-actions">
                        <span>{t("onboardingTime")}</span>
                        <Button type="button" size="lg" onClick={() => setStep("connect")}>
                          {t("onboardingStart")} <ArrowRight />
                        </Button>
                      </footer>
                    </section>
                  ) : step === "connect" ? (
                    <section className="onboarding-stage onboarding-connect" key="connect">
                      <span className="onboarding-kicker"><KeyRound /> {t("onboardingConnectionKicker")}</span>
                      <Dialog.Title className="onboarding-title">{t("onboardingConnectionTitle")}</Dialog.Title>
                      <Dialog.Description id="onboarding-description" className="onboarding-description">
                        {t("onboardingConnectionDescription")}
                      </Dialog.Description>

                      <Form className="onboarding-form" onFormSubmit={() => void save()}>
                        <Fieldset.Root className="onboarding-fieldset">
                          <Fieldset.Legend className="onboarding-legend">{t("onboardingOpenRouterLegend")}</Fieldset.Legend>
                          <p className="onboarding-provider-copy">{t("onboardingOpenRouterCopy")}</p>
                          <a
                            className="onboarding-external-link"
                            href={OPENROUTER_KEYS_URL}
                            target="_blank"
                            rel="noreferrer"
                            onClick={openKeys}
                          >
                            <span><strong>{t("onboardingCreateKey")}</strong><small>{t("onboardingCreateKeyHint")}</small></span>
                            <ExternalLink aria-hidden="true" />
                          </a>

                          <Field.Root className="onboarding-key-field" name="apiKey" invalid={Boolean(error)}>
                            <Field.Label>{t("apiKey")}</Field.Label>
                            <div className="onboarding-input-wrap">
                              <Input
                                autoFocus
                                type={showKey ? "text" : "password"}
                                autoComplete="off"
                                spellCheck={false}
                                aria-describedby="onboarding-key-help"
                                placeholder="sk-or-v1-…"
                                value={apiKey}
                                onChange={(event) => {
                                  setApiKey(event.target.value);
                                  if (error) setError(null);
                                }}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={showKey ? t("onboardingHideKey") : t("onboardingShowKey")}
                                onClick={() => setShowKey((current) => !current)}
                              >
                                {showKey ? <EyeOff /> : <Eye />}
                              </Button>
                            </div>
                            <div id="onboarding-key-help" className="onboarding-key-help">
                              <span className={apiKey.trim().length >= 12 ? "detected" : ""}>
                                {apiKey.trim().length >= 12 ? <><Check /> {t("onboardingKeyDetected")}</> : t("onboardingPasteKey")}
                              </span>
                              <span><LockKeyhole /> {t("onboardingStoredLocally")}</span>
                            </div>
                            {error ? <Field.Error className="field-error" match>{error}</Field.Error> : null}
                          </Field.Root>
                        </Fieldset.Root>

                        <footer className="onboarding-actions">
                          <Button type="button" variant="ghost" size="lg" onClick={() => setStep("welcome")}>
                            <ArrowLeft /> {t("onboardingBack")}
                          </Button>
                          <Button type="submit" size="lg" disabled={busy || apiKey.trim().length < 12}>
                            {busy ? <LoaderCircle className="spin" /> : <KeyRound />}
                            {busy ? t("onboardingSaving") : t("onboardingSaveAndStart")}
                          </Button>
                        </footer>
                      </Form>
                    </section>
                  ) : (
                    <section className="onboarding-stage onboarding-complete" key="complete" role="status">
                      <span className="onboarding-success-mark"><Check /></span>
                      <Dialog.Title className="onboarding-title">{t("onboardingCompleteTitle")}</Dialog.Title>
                      <Dialog.Description id="onboarding-description" className="onboarding-description">
                        {t("onboardingCompleteDescription")}
                      </Dialog.Description>
                      <span className="onboarding-opening"><i />{t("onboardingOpeningWorkspace")}</span>
                    </section>
                  )}
                </main>
              </>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
