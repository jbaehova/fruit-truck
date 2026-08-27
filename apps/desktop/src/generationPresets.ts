import type { DraftOptions, GenerationMode } from "./openrouter.ts";
import type { GenerationPreset } from "./studio.ts";

export type GenerationPresetDiff = {
  field: string;
  current: unknown;
  preset: unknown;
};

function comparable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function generationPresetDiff(
  preset: GenerationPreset,
  current: { mode: GenerationMode; modelId: string; options: DraftOptions; providerJson: string },
): GenerationPresetDiff[] {
  const diffs: GenerationPresetDiff[] = [];
  if (preset.mode !== current.mode) diffs.push({ field: "mode", current: current.mode, preset: preset.mode });
  if (preset.modelId !== current.modelId) diffs.push({ field: "model", current: current.modelId, preset: preset.modelId });
  const optionKeys = [...new Set([...Object.keys(current.options), ...Object.keys(preset.options)])].toSorted();
  for (const key of optionKeys) {
    if (comparable(current.options[key]) !== comparable(preset.options[key])) {
      diffs.push({ field: key, current: current.options[key], preset: preset.options[key] });
    }
  }
  const currentProvider = current.providerJson.trim() || "{}";
  const presetProvider = preset.providerJson.trim() || "{}";
  if (currentProvider !== presetProvider) diffs.push({ field: "provider", current: currentProvider, preset: presetProvider });
  return diffs;
}
