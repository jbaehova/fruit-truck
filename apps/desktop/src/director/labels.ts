import type { MessageKey } from "../i18n";
import type { DirectorFidelity } from "./types";

export const FIDELITY_KEYS: Record<DirectorFidelity, MessageKey> = {
  native: "directorFidelityNative",
  keyframe: "directorFidelityKeyframe",
  visual: "directorFidelityVisual",
  prompt: "directorFidelityPrompt",
  unsupported: "directorFidelityUnsupported",
};
