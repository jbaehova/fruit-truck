import { Dialog } from "@base-ui/react/dialog";
import { Braces, CheckCircle2, Cloud, LoaderCircle, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n, type MessageKey } from "@/i18n";
import type { ReferenceAsset, ReferenceCoverage } from "@/openrouter";
import type { ReferencePurpose } from "@/prompting";

const PURPOSE_LABEL_KEYS: Record<ReferencePurpose, MessageKey> = {
  subject_identity: "purposeSubjectIdentity",
  product_identity: "purposeProductIdentity",
  character: "purposeCharacter",
  wardrobe: "purposeWardrobe",
  style: "purposeStyle",
  composition: "purposeComposition",
  pose: "purposePose",
  first_frame: "purposeFirstFrame",
  last_frame: "purposeLastFrame",
  motion: "purposeMotion",
  audio: "purposeAudio",
  edit_target: "purposeEditTarget",
  context: "purposeContext",
};

export function RequestPreviewDialog({
  mode,
  request,
  references,
  coverage,
  error,
  status = "draft",
  preflightErrors = [],
  estimatedCost,
  transferredBytes = 0,
  plannerEnabled = false,
  plannerModel,
  plannerCost,
  routeSummary,
  routeDefinitive = false,
  privacySummary,
  onPrepare,
}: {
  mode: "image" | "video";
  request: string;
  references: ReferenceAsset[];
  coverage?: ReferenceCoverage[];
  error?: string | null;
  status?: "draft" | "preparing" | "final";
  preflightErrors?: string[];
  estimatedCost?: string;
  transferredBytes?: number;
  plannerEnabled?: boolean;
  plannerModel?: string;
  plannerCost?: string;
  routeSummary?: string;
  routeDefinitive?: boolean;
  privacySummary?: string;
  onPrepare?: () => void;
}) {
  const { t } = useI18n();
  const uniquePreflightErrors = [...new Set(preflightErrors)];
  return (
    <Dialog.Root>
      <Dialog.Trigger render={<Button variant="outline" size="sm" className="request-dialog-trigger" />}><Braces /> {t("request")}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="request-dialog">
            <header className="dialog-header">
              <div>
                <span className="dialog-eyebrow">POST · /api/v1/{mode}s</span>
                <Dialog.Title className="dialog-title">{t("requestPreview")}</Dialog.Title>
                <Dialog.Description className="dialog-description">{t("requestPreviewHint")}</Dialog.Description>
                <span className="request-readiness" data-status={status}>
                  {status === "final" ? <CheckCircle2 /> : status === "preparing" ? <LoaderCircle className="spin" /> : <ShieldAlert />}
                  {t(status === "final" ? "requestFinal" : status === "preparing" ? "preparingRequest" : "requestDraft")}
                </span>
              </div>
              <Dialog.Close render={<Button variant="ghost" size="icon" />} aria-label={t("closeRequestPreview")}><X /></Dialog.Close>
            </header>
            <ScrollArea className="request-dialog-body">
              {error ? <div className="request-build-alert" role="alert"><strong>{t("requestBuildFailed")}</strong><span>{error}</span></div> : null}
              {uniquePreflightErrors.length ? <div className="request-build-alert" role="alert"><strong>{t("requestPreflightErrors")}</strong>{uniquePreflightErrors.map((message) => <span key={message}>{message}</span>)}</div> : null}
              <section className="request-disclosure" aria-label={t("privacyBeforeGenerate")}>
                <Cloud />
                <div>
                  <strong>{t("privacyBeforeGenerate")}</strong>
                  <p>{t("cloudTransferNotice")}</p>
                  <small>{t("sentMediaSummary", { count: references.length, size: (transferredBytes / 1024 / 1024).toFixed(2) })}{estimatedCost ? ` · ${t("generationCostEstimate")}: ${estimatedCost}` : ""}</small>
                  {routeSummary ? <small>{t("providerRoute")}: {routeSummary} · {t(routeDefinitive ? "routeDefinitive" : "routeNotDefinitive")}</small> : null}
                  {privacySummary ? <small>{privacySummary}</small> : null}
                  {plannerEnabled ? <small>{t("plannerPrivacyNotice")} {t("plannerRouteAndCost", { model: plannerModel ?? t("plannerUnknownModel"), cost: plannerCost ?? t("plannerCostPending") })}</small> : null}
                </div>
              </section>
              {references.length ? (
                <div className="request-mapping">
                  <strong>{t("inputMapping")}</strong>
                  {references.map((reference) => {
                    const entry = coverage?.find((candidate) => candidate.slot === reference.slot);
                    return (
                    <span key={reference.id} data-coverage={entry?.severity ?? "unknown"}>
                      <b>@{reference.slot}</b>
                      <span>{reference.name}</span>
                      <code>
                        → {entry?.providerLabel ?? "unmapped"}
                        {` · ${t(PURPOSE_LABEL_KEYS[reference.purpose])}`}
                        {` · ${entry?.nativeControl ?? (reference.role === "first_frame" || reference.role === "last_frame" ? `frame_images.${reference.role}` : "input_references")}`}
                        {` · ${t(entry?.severity === "ok" ? "coverageOk" : entry?.severity === "warning" ? "coverageWarning" : "coverageError")}`}
                      </code>
                    </span>
                    );
                  })}
                </div>
              ) : null}
              <pre>{request}</pre>
              <p>{t("localPlaceholderHint")}</p>
              {onPrepare && status !== "final" ? (
                <Button type="button" size="lg" className="request-prepare-button" disabled={status === "preparing" || Boolean(error) || uniquePreflightErrors.length > 0} onClick={onPrepare}>
                  {status === "preparing" ? <LoaderCircle className="spin" /> : <Braces />}
                  {t(status === "preparing" ? "preparingRequest" : "prepareRequest")}
                </Button>
              ) : null}
            </ScrollArea>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
