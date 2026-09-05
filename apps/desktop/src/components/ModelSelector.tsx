import { saveWorkspacePreference } from "@/workspacePreferences";
import { Field } from "@base-ui/react/field";
import { Popover } from "@base-ui/react/popover";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ExternalLink as ExternalLinkIcon, ImageIcon, Search, Star, Video } from "lucide-react";
import { ExternalLink } from "@/components/ExternalLink";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useI18n } from "@/i18n";
import { modelInputSignature, modelPriceLabel, type GenerationMode, type GenerationModel, type ImageModel, type VideoModel } from "@/openrouter";
import { modelSearchMatches } from "@/optionValues";
import { preferredCatalogModel } from "@/studio";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/models";
const MODEL_LIST_MAX_HEIGHT = 360;
const FAVORITE_MODELS_KEY = "fruit-truck.favorite-models.v1";
const RECENT_MODELS_KEY = "fruit-truck.recent-models.v1";

type Props = {
  mode: GenerationMode;
  models: GenerationModel[];
  selectedId: string;
  loading: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
};

function providerName(model: GenerationModel) {
  return model.name.includes(":") ? model.name.split(":", 1)[0] : model.id.split("/", 1)[0];
}

function modelName(model: GenerationModel) {
  return model.name.replace(`${providerName(model)}: `, "");
}

function modelResolutions(mode: GenerationMode, model: GenerationModel) {
  const descriptor = mode === "image" ? (model as ImageModel).supported_parameters.resolution : undefined;
  const descriptorValues = descriptor && typeof descriptor === "object" && "values" in descriptor && Array.isArray(descriptor.values)
    ? descriptor.values.filter((value): value is string => typeof value === "string")
    : [];
  return mode === "image"
    ? [...new Set([...(model as ImageModel).supported_sizes ?? [], ...descriptorValues])]
    : [...new Set((model as VideoModel).supported_resolutions ?? [])];
}

function modelSupportsReferences(mode: GenerationMode, model: GenerationModel) {
  return mode === "image"
    ? ((model as ImageModel).supported_parameters.input_references?.max ?? 0) > 0
    : ((model as VideoModel).max_input_references ?? 0) > 0;
}

function modelSupportsAudio(mode: GenerationMode, model: GenerationModel) {
  if (mode === "image") return false;
  const video = model as VideoModel;
  return video.generate_audio === true || video.input_reference_types?.includes("audio") === true;
}

function modelHasVerifiedEndpoint(mode: GenerationMode, model: GenerationModel) {
  return mode === "image"
    ? ((model as ImageModel).endpoint_details?.length ?? 0) > 0
    : (model as VideoModel).endpoints?.some((endpoint) => Boolean(endpoint.endpoint_id || endpoint.id)) === true;
}

function localizedInputSignature(mode: GenerationMode, model: GenerationModel, language: string, t: ReturnType<typeof useI18n>["t"]) {
  const signature = modelInputSignature(mode, model);
  if (language === "en") return signature;
  return signature
    .replace("first frame", t("inputFirstFrame"))
    .replace("last frame", t("inputLastFrame"))
    .replace("Text", t("inputText"))
    .replaceAll("image", t("inputImage"));
}

export function ModelSelector({ mode, models, selectedId, loading, disabled, onSelect }: Props) {
  const { language, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FAVORITE_MODELS_KEY) ?? "[]") as string[]); } catch { return new Set(); }
  });
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  const [providerFilter, setProviderFilter] = useState("");
  const [resolutionFilter, setResolutionFilter] = useState("");
  const [inputFilter, setInputFilter] = useState<"" | "references" | "audio">("");
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_MODELS_KEY) ?? "[]") as string[]; } catch { return []; }
  });
  const selected = models.find((model) => model.id === selectedId) ?? null;
  const recommendedId = preferredCatalogModel(mode, models)?.id;
  const providers = useMemo(() => [...new Set(models.map(providerName))].toSorted(), [models]);
  const resolutions = useMemo(() => [...new Set(models.flatMap((model) => modelResolutions(mode, model)))].toSorted(), [mode, models]);
  const price = (model: GenerationModel) => {
    const value = modelPriceLabel(mode, model);
    return value === "Price unavailable" ? t("priceUnavailable") : value;
  };
  const filtered = useMemo(() => {
    return models
      .filter((model) => !query.trim() || modelSearchMatches(model, query))
      .filter((model) => !favoritesOnly || favorites.has(model.id))
      .filter((model) => !recommendedOnly || model.id === recommendedId)
      .filter((model) => !providerFilter || providerName(model) === providerFilter)
      .filter((model) => !resolutionFilter || modelResolutions(mode, model).includes(resolutionFilter))
      .filter((model) => inputFilter !== "references" || modelSupportsReferences(mode, model))
      .filter((model) => inputFilter !== "audio" || modelSupportsAudio(mode, model))
      .toSorted((left, right) => {
        if (favorites.has(left.id) !== favorites.has(right.id)) return favorites.has(left.id) ? -1 : 1;
        if (recent.includes(left.id) !== recent.includes(right.id)) return recent.includes(left.id) ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [favorites, favoritesOnly, inputFilter, mode, models, providerFilter, query, recent, recommendedId, recommendedOnly, resolutionFilter]);
  const toggleFavorite = (id: string) => {
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id); else next.add(id);
    setFavorites(next);
    saveWorkspacePreference(FAVORITE_MODELS_KEY, JSON.stringify([...next]));
  };
  const listHeight = Math.min(MODEL_LIST_MAX_HEIGHT, Math.max(74, (loading ? 6 : Math.max(filtered.length, 1)) * 52 + 10));

  useEffect(() => {
    setQuery("");
    setProviderFilter("");
    setResolutionFilter("");
    setInputFilter("");
  }, [mode]);

  const selectAndRemember = (id: string) => {
    const next = [id, ...recent.filter((candidate) => candidate !== id)].slice(0, 8);
    setRecent(next);
    saveWorkspacePreference(RECENT_MODELS_KEY, JSON.stringify(next));
    onSelect(id);
    setOpen(false);
    setQuery("");
  };

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
                  : t("availableModels", { count: models.length })}</small>
              </div>
              <ExternalLink
                href={OPENROUTER_MODELS_URL}
              >
                {t("browsePricing")}
                <ExternalLinkIcon aria-hidden="true" />
              </ExternalLink>
            </header>
            <div className="model-default-actions">
              <Button type="button" size="xs" variant={recommendedOnly ? "outline" : "ghost"} aria-pressed={recommendedOnly} onClick={() => { setRecommendedOnly((current) => !current); setFavoritesOnly(false); }}>{t("recommendedModels")}</Button>
              <Button type="button" size="xs" variant={favoritesOnly ? "outline" : "ghost"} aria-pressed={favoritesOnly} onClick={() => { setFavoritesOnly((current) => !current); setRecommendedOnly(false); }}><Star /> {t("favoriteModels")}</Button>
            </div>
            <div className="model-contract-filters">
              <select aria-label={t("filterByProvider")} value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
                <option value="">{t("allProviders")}</option>
                {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
              </select>
              <select aria-label={t("filterByResolution")} value={resolutionFilter} onChange={(event) => setResolutionFilter(event.target.value)}>
                <option value="">{t("allResolutions")}</option>
                {resolutions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
              </select>
              <select aria-label={t("filterByInput")} value={inputFilter} onChange={(event) => setInputFilter(event.target.value as "" | "references" | "audio")}>
                <option value="">{t("allInputTypes")}</option>
                <option value="references">{t("supportsReferences")}</option>
                {mode === "video" ? <option value="audio">{t("supportsAudio")}</option> : null}
              </select>
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
                  <div key={model.id} className={`model-dropdown-row ${active ? "active" : ""}`}>
                    <div className="model-row-actions">
                      <Button type="button" variant="ghost" size="icon-xs" className="model-favorite" aria-label={t("favoriteModel", { name: model.name })} aria-pressed={favorites.has(model.id)} onClick={() => toggleFavorite(model.id)}><Star fill={favorites.has(model.id) ? "currentColor" : "none"} /></Button>
                    </div>
                    <Button type="button" variant="ghost" className="model-select-main" onClick={() => selectAndRemember(model.id)}>
                      <span className="model-icon">{mode === "image" ? <ImageIcon /> : <Video />}</span>
                      <span className="model-copy">
                        <strong>{modelName(model)}</strong>
                        <small>{[providerName(model), localizedInputSignature(mode, model, language, t), price(model), model.id === recommendedId ? t("recommended") : "", modelHasVerifiedEndpoint(mode, model) ? t("endpointVerified") : ""].filter(Boolean).join(" / ")}</small>
                      </span>
                      {active ? <Check className="model-check" /> : null}
                    </Button>
                  </div>
                );
              })}
            </ScrollArea>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
