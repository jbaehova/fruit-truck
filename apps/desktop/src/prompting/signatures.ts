import type { PromptReferenceInput, PromptTarget, PromptWorkflow } from "./types.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function promptEnhancementSignature(input: {
  plannerModel: string;
  promptVersion: string;
  promptProfile?: { id: string; version: string };
  target: PromptTarget;
  workflow: PromptWorkflow;
  prompt: string;
  maskInstructions?: string;
  editTarget?: string;
  maskState?: unknown;
  references: PromptReferenceInput[];
}) {
  const normalizedProvider = (() => {
    try { return input.target.providerJson.trim() ? JSON.parse(input.target.providerJson) : {}; } catch { return input.target.providerJson; }
  })();
  const serialized = JSON.stringify(canonical({
    plannerModel: input.plannerModel,
    promptVersion: input.promptVersion,
    promptProfile: input.promptProfile ?? null,
    target: {
      id: input.target.id,
      options: input.target.options,
      provider: normalizedProvider,
      capabilities: input.target.capabilities ?? null,
    },
    workflow: input.workflow,
    prompt: input.prompt,
    maskInstructions: input.maskInstructions ?? "",
    editTarget: input.editTarget ?? "",
    maskState: input.maskState ?? null,
    references: input.references.map((reference) => ({
      slot: reference.slot,
      mediaType: reference.mediaType,
      role: reference.role,
      purpose: reference.purpose,
      fingerprint: reference.fingerprint ?? reference.name,
      durationSeconds: reference.durationSeconds ?? null,
    })),
  }));
  return `prompt-v2:${fnv1a(serialized)}:${serialized.length}`;
}
