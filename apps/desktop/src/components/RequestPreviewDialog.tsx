import { Dialog } from "@base-ui/react/dialog";
import { Braces, X } from "lucide-react";
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
}: {
  mode: "image" | "video";
  request: string;
  references: ReferenceAsset[];
  coverage?: ReferenceCoverage[];
  error?: string | null;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root>
      <Dialog.Trigger render={<Button variant="outline" size="sm" />}><Braces /> {t("request")}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Viewport className="dialog-viewport">
          <Dialog.Popup className="request-dialog">
            <header className="dialog-header">
              <div>
                <span className="dialog-eyebrow">POST · /api/v1/{mode}s</span>
                <Dialog.Title className="dialog-title">{t("requestPreview")}</Dialog.Title>
                <Dialog.Description className="dialog-description">{t("requestPreviewHint")}</Dialog.Description>
              </div>
              <Dialog.Close render={<Button variant="ghost" size="icon" />} aria-label={t("closeRequestPreview")}><X /></Dialog.Close>
            </header>
            <ScrollArea className="request-dialog-body">
              {error ? <div className="request-build-alert" role="alert"><strong>{t("requestBuildFailed")}</strong><span>{error}</span></div> : null}
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
            </ScrollArea>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
