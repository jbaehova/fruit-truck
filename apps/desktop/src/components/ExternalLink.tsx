import type { ComponentProps } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "@/components/ui/toast-manager";
import { useI18n } from "@/i18n";

export function ExternalLink({ href, onClick, ...props }: ComponentProps<"a"> & { href: string }) {
  const { t } = useI18n();
  return <a
    {...props}
    href={href}
    target="_blank"
    rel="noreferrer"
    onClick={(event) => {
      onClick?.(event);
      if (event.defaultPrevented || !("__TAURI_INTERNALS__" in window)) return;
      event.preventDefault();
      void openUrl(href).catch((error) => toast.error(t("externalLinkFailed", { error: error instanceof Error ? error.message : String(error) })));
    }}
  />;
}
