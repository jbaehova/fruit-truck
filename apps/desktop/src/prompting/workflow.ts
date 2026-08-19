import type { PromptReferenceInput, PromptWorkflow } from "./types.ts";

export function resolvePromptWorkflow({
  mode,
  editMode = false,
  hasMask = false,
  references,
}: {
  mode: "image" | "video";
  editMode?: boolean;
  hasMask?: boolean;
  references: PromptReferenceInput[];
}): PromptWorkflow {
  if (mode === "image") {
    if (editMode) return hasMask ? "inpaint" : "image_edit";
    return references.length > 1 ? "multi_reference_compose" : "text_to_image";
  }
  const hasFirst = references.some((reference) => reference.role === "first_frame");
  const hasLast = references.some((reference) => reference.role === "last_frame");
  const general = references.filter((reference) => reference.role === "reference");
  if (hasFirst && hasLast) return "first_last_frame";
  if (hasFirst) return "image_to_video";
  if (general.some((reference) => reference.mediaType.startsWith("audio/"))) return "audio_visual_reference";
  if (general.some((reference) => reference.mediaType.startsWith("video/"))) return "video_to_video";
  if (general.length) return "reference_to_video";
  return "text_to_video";
}
