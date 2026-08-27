import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

export function RightPanel({
  assets,
  onClose,
}: {
  assets: ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className="right-panel">
      <Button type="button" className="right-panel-close" variant="ghost" size="icon-xs" aria-label={t("closeAssetPanel")} onClick={onClose}>
        <X />
      </Button>
      <div className="right-panel-content">{assets}</div>
    </aside>
  );
}
