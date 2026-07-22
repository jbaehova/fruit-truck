import { useMemo, useState } from "react";
import { Check, ImageIcon, Search, Video } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { GenerationMode, GenerationModel } from "@/openrouter";

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
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return models;
    return models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(value));
  }, [models, query]);

  return (
    <aside className="model-sidebar">
      <div className="model-sidebar-heading">
        <span>Models</span>
        <span className="model-count">{loading ? "—" : models.length}</span>
      </div>
      <label className="model-search">
        <Search aria-hidden="true" />
        <Input
          aria-label="Search models"
          placeholder={`Search ${mode} models`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="model-list" aria-label={`${mode} generation models`}>
        {loading ? Array.from({ length: 7 }, (_, index) => (
          <div className="model-skeleton" key={index}><i /><span /></div>
        )) : null}
        {!loading && !filtered.length ? <p className="model-empty">No matching models</p> : null}
        {filtered.map((model) => {
          const active = model.id === selectedId;
          return (
            <button
              type="button"
              key={model.id}
              className={`model-row ${active ? "active" : ""}`}
              onClick={() => onSelect(model.id)}
            >
              <span className="model-icon">{mode === "image" ? <ImageIcon /> : <Video />}</span>
              <span className="model-copy">
                <strong>{model.name.replace(`${providerName(model)}: `, "")}</strong>
                <small>{providerName(model)}</small>
              </span>
              {active ? <Check className="model-check" /> : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
