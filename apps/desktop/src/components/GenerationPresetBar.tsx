import { Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { generationPresetDiff } from "@/generationPresets";
import type { DraftOptions, GenerationMode } from "@/openrouter";
import type { GenerationPreset } from "@/studio";

export function GenerationPresetBar({
  mode,
  modelId,
  options,
  providerJson,
  presets,
  onSave,
  onApply,
  onDelete,
}: {
  mode: GenerationMode;
  modelId: string;
  options: DraftOptions;
  providerJson: string;
  presets: GenerationPreset[];
  onSave: (name: string) => string;
  onApply: (preset: GenerationPreset) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();
  const available = useMemo(() => presets.filter((preset) => preset.mode === mode), [mode, presets]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    if (selectedId && !available.some((preset) => preset.id === selectedId)) setSelectedId(available[0]?.id ?? "");
  }, [available, selectedId]);
  const selected = available.find((preset) => preset.id === selectedId);
  const diffs = selected ? generationPresetDiff(selected, { mode, modelId, options, providerJson }) : [];
  return <section className="generation-presets" aria-label={t("generationPresets")}>
    <div className="generation-preset-create">
      <Input aria-label={t("presetName")} placeholder={t("presetName")} value={name} onChange={(event) => setName(event.target.value)} />
      <Button type="button" size="xs" variant="outline" disabled={!name.trim() || !modelId} onClick={() => {
        const id = onSave(name.trim());
        setSelectedId(id);
        setName("");
      }}><Save /> {t("savePreset")}</Button>
    </div>
    {available.length ? <div className="generation-preset-use">
      <select aria-label={t("savedPresets")} value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
        <option value="">{t("choosePreset")}</option>
        {available.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </select>
      <Button type="button" size="xs" variant="outline" disabled={!selected} onClick={() => selected && onApply(selected)}>{t("applyPreset")}</Button>
      <Button type="button" size="icon-xs" variant="ghost" disabled={!selected} aria-label={t("deletePreset")} onClick={() => selected && onDelete(selected.id)}><Trash2 /></Button>
    </div> : null}
    {selected ? <details className="generation-preset-diff">
      <summary>{t("presetSettingsDiff", { count: diffs.length })}</summary>
      {diffs.length ? <dl>{diffs.map((diff) => <div key={diff.field}><dt>{diff.field}</dt><dd>{String(diff.current ?? "—")} → {String(diff.preset ?? "—")}</dd></div>)}</dl> : <p>{t("presetAlreadyApplied")}</p>}
    </details> : null}
  </section>;
}
