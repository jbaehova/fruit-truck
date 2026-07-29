import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Bot, Images } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "@/i18n";

export function RightPanel({
  tab,
  onTabChange,
  agent,
  assets,
}: {
  tab: "agent" | "assets";
  onTabChange: (tab: "agent" | "assets") => void;
  agent: ReactNode;
  assets: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <aside className="right-panel">
      <ToggleGroup
        className="right-panel-tabs"
        aria-label={t("rightPanel")}
        value={[tab]}
        onValueChange={(values) => {
          const next = values[0];
          if (next === "agent" || next === "assets") onTabChange(next);
        }}
      >
        <Toggle value="agent"><Bot /> {t("agent")}</Toggle>
        <Toggle value="assets"><Images /> {t("assets")}</Toggle>
      </ToggleGroup>
      <div className="right-panel-content">
        {tab === "agent" ? agent : assets}
      </div>
    </aside>
  );
}
