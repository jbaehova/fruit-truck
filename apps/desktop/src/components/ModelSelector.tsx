import { Field } from "@base-ui/react/field";
import { Popover } from "@base-ui/react/popover";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ImageIcon, Search, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { modelInputSignature, modelPriceLabel, type GenerationMode, type GenerationModel } from "@/openrouter";

type Props = {
  mode: GenerationMode;
  models: GenerationModel[];
  selectedId: string;
  loading: boolean;
  catalogCount?: number;
  disabled?: boolean;
  onSelect: (id: string) => void;
  inherited?: boolean;
  onUseDefault?: () => void;
  onSetDefault?: () => void;
};

function providerName(model: GenerationModel) {
  return model.name.includes(":") ? model.name.split(":", 1)[0] : model.id.split("/", 1)[0];
}

function modelName(model: GenerationModel) {
  return model.name.replace(`${providerName(model)}: `, "");
}

function localizedInputSignature(mode: GenerationMode, model: GenerationModel, language: string, t: ReturnType<typeof useI18n>["t"]) {
  const signature = modelInputSignature(mode, model);
  if (language === "en") return signature;
  return signature
    .replace("first frame", t("inputFirstFrame"))
    .replace("last frame", t("inputLastFrame"))
    .replace("Text", t("inputText"))
    .replaceAll("image", t("inputImage"))
    .replaceAll("video", t("inputVideo"));
}

export function ModelSelector({ mode, models, selectedId, loading, catalogCount, disabled, onSelect, inherited, onUseDefault, onSetDefault }: Props) {
  const { language, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = models.find((model) => model.id === selectedId) ?? null;
  const price = (model: GenerationModel) => {
    const value = modelPriceLabel(mode, model);
    return value === "Price unavailable" ? t("priceUnavailable") : value;
  };
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return models;
    return models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(value));
  }, [models, query]);
  const listHeight = Math.min(410, Math.max(74, (loading ? 6 : Math.max(filtered.length, 1)) * 52 + 10));

  useEffect(() => {
    setQuery("");
  }, [mode]);

  return (
    <Popover.Root open={open} onOpenChange={(next) => {
      if (disabled) return;
      setOpen(next);
      if (!next) setQuery("");
    }}>
      <Popover.Trigger className="model-selector-trigger" aria-label={t("chooseModel")} disabled={disabled}>
        <span className="model-selector-icon">{mode === "image" ? <ImageIcon /> : <Video />}</span>
        <span className="model-selector-copy">
          <small>{t("models")}</small>
          <strong>{selected ? modelName(selected) : loading ? t("loadingModels") : t("chooseModel")}</strong>
        </span>
        {selected ? <span className="model-selector-provider">{providerName(selected)}</span> : null}
        {selected ? <span className="model-selector-price">{price(selected)}</span> : null}
        <ChevronDown className="model-selector-chevron" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="model-selector-positioner" side="bottom" sideOffset={7} align="start">
          <Popover.Popup className="model-selector-popup">
            <header className="model-selector-header">
              <div>
                <strong>{t("chooseModel")}</strong>
                <small>{loading
                  ? t("loadingModels")
                  : catalogCount != null && catalogCount > models.length
                    ? t("filteredVideoModels", { shown: models.length, total: catalogCount })
                    : t("availableModels", { count: models.length })}</small>
              </div>
            </header>
            <div className="model-default-actions">
              <Button type="button" size="xs" variant={inherited ? "outline" : "ghost"} disabled={inherited} onClick={() => onUseDefault?.()}>{t("useModeDefault")}</Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => onSetDefault?.()}>{t("setModeDefault")}</Button>
            </div>
            <Field.Root className="model-dropdown-search">
              <Field.Label className="sr-only">{t("searchModels")}</Field.Label>
              <Search aria-hidden="true" />
              <Input
                autoFocus
                aria-label={t("searchModels")}
                placeholder={t("searchModels")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field.Root>
            <ScrollArea
              className="model-dropdown-list"
              style={{ height: listHeight }}
              aria-label={`${t(mode)} ${t("models")}`}
            >
              {loading ? Array.from({ length: 6 }, (_, index) => (
                <div className="model-dropdown-skeleton" key={index}><i /><span /></div>
              )) : null}
              {!loading && !filtered.length ? <p className="model-empty">{t("noMatchingModels")}</p> : null}
              {filtered.map((model) => {
                const active = model.id === selectedId;
                return (
                  <Button
                    type="button"
                    variant="ghost"
                    key={model.id}
                    className={`model-dropdown-row ${active ? "active" : ""}`}
                    onClick={() => {
                      onSelect(model.id);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <span className="model-icon">{mode === "image" ? <ImageIcon /> : <Video />}</span>
                    <span className="model-copy">
                      <strong>{modelName(model)}</strong>
                      <small>{providerName(model)} · {localizedInputSignature(mode, model, language, t)} · {price(model)}</small>
                    </span>
                    {active ? <Check className="model-check" /> : null}
                  </Button>
                );
              })}
            </ScrollArea>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
