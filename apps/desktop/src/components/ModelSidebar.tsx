import { Field } from "@base-ui/react/field";
import { useMemo, useState } from "react";
import { Check, ImageIcon, Search, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { modelInputSignature, type GenerationMode, type GenerationModel } from "@/openrouter";

type Props = {
  mode: GenerationMode;
  models: GenerationModel[];
  selectedId: string;
  loading: boolean;
  onSelect: (id: string) => void;
};

function providerName(model: GenerationModel) {
  return model.name.includes(":") ? model.name.split(":", 1)[0] : model.id.split("/", 1)[0];
}

export function ModelSidebar({ mode, models, selectedId, loading, onSelect }: Props) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return models;
    return models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(value));
  }, [models, query]);

  return (
    <aside className="model-sidebar">
      <div className="model-sidebar-heading">
        <span>{t("models")}</span>
        <span className="model-count">{loading ? "—" : models.length}</span>
      </div>
      <Field.Root className="model-search">
        <Field.Label className="sr-only">{t("searchModels")}</Field.Label>
        <Search aria-hidden="true" />
        <Input
          aria-label={t("searchModels")}
          placeholder={t("searchModels")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field.Root>
      <ScrollArea className="model-list" aria-label={`${t(mode)} ${t("models")}`}>
        {loading ? Array.from({ length: 7 }, (_, index) => (
          <div className="model-skeleton" key={index}><i /><span /></div>
        )) : null}
        {!loading && !filtered.length ? <p className="model-empty">{t("noMatchingModels")}</p> : null}
        {filtered.map((model) => {
          const active = model.id === selectedId;
          return (
            <Button
              type="button"
              variant="ghost"
              key={model.id}
              className={`model-row ${active ? "active" : ""}`}
              onClick={() => onSelect(model.id)}
            >
              <span className="model-icon">{mode === "image" ? <ImageIcon /> : <Video />}</span>
              <span className="model-copy">
                <strong>{model.name.replace(`${providerName(model)}: `, "")}</strong>
                <small>{providerName(model)} · {language === "en" ? modelInputSignature(mode, model) : modelInputSignature(mode, model)
                  .replace("first frame", t("inputFirstFrame"))
                  .replace("last frame", t("inputLastFrame"))
                  .replace("Text", t("inputText"))
                  .replaceAll("image", t("inputImage"))
                  .replaceAll("video", t("inputVideo"))}</small>
              </span>
              {active ? <Check className="model-check" /> : null}
            </Button>
          );
        })}
      </ScrollArea>
    </aside>
  );
}
