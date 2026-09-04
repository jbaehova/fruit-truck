export const PROMPT_MODELS = [
  {
    id: "openai/gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    reasoningEffort: "high",
    supportsImageContext: true,
  },
  {
    id: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    reasoningEffort: "high",
    supportsImageContext: true,
  },
  {
    id: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    reasoningEffort: "high",
    supportsImageContext: true,
  },
] as const;

export type PromptModel = (typeof PROMPT_MODELS)[number]["id"];
export type PromptModelDefinition = (typeof PROMPT_MODELS)[number];

export const DEFAULT_PROMPT_MODEL: PromptModel = "google/gemini-3.8-flash";

export function isPromptModel(value: unknown): value is PromptModel {
  return typeof value === "string" && PROMPT_MODELS.some((model) => model.id === value);
}

export function promptModelDefinition(id: PromptModel): PromptModelDefinition {
  const definition = PROMPT_MODELS.find((model) => model.id === id);
  if (!definition) throw new Error(`Unknown prompt model: ${String(id)}`);
  return definition;
}

export function migrateLegacyPromptModel(value: unknown): PromptModel {
  return isPromptModel(value) ? value : DEFAULT_PROMPT_MODEL;
}
