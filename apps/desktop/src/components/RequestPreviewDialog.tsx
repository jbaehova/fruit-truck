import { Dialog } from "@base-ui/react/dialog";
import { Braces, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import type { ReferenceAsset } from "@/openrouter";

export function RequestPreviewDialog({
  mode,
  request,
  references,
}: {
  mode: "image" | "video";
  request: string;
  references: ReferenceAsset[];
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
              {references.length ? (
                <div className="request-mapping">
                  <strong>{t("inputMapping")}</strong>
                  {references.map((reference) => (
                    <span key={reference.id}>
                      <b>@{reference.slot}</b>
                      <span>{reference.name}</span>
                      <code>→ {reference.role === "first_frame" || reference.role === "last_frame" ? `frame_images.${reference.role}` : "input_references"}</code>
                    </span>
                  ))}
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
