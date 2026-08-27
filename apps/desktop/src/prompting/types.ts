export type PromptWorkflow =
  | "text_to_image"
  | "image_edit"
  | "inpaint"
  | "multi_reference_compose"
  | "text_to_video"
  | "image_to_video"
  | "first_last_frame"
  | "reference_to_video"
  | "video_to_video"
  | "audio_visual_reference";

export type ReferencePurpose =
  | "subject_identity"
  | "product_identity"
  | "character"
  | "wardrobe"
  | "style"
  | "composition"
  | "pose"
  | "first_frame"
  | "last_frame"
  | "motion"
  | "audio"
  | "edit_target"
  | "context";

export type PromptPlanReference = {
  slot: number;
  target: string;
  purpose: ReferencePurpose;
  priority: "required" | "preferred" | "optional";
  evidence: "user" | "role" | "vision_suggested";
  copy: string[];
  preserve: string[];
  ignore: string[];
};

export type PromptPlanConstraint = {
  requirement: string;
  desiredState: string;
};

export type PromptPlan = {
  version: 1;
  mode: "image" | "video";
  workflow: PromptWorkflow;
  language: string;
  deliverable: string;
  intent: string;
  scene: string[];
  subjects: string[];
  action: string[];
  composition: string[];
  camera: string[];
  lighting: string[];
  color: string[];
  style: string[];
  materials: string[];
  exactText: string[];
  temporalBeats: string[];
  subjectMotion: string[];
  cameraMotion: string[];
  audio: string[];
  editChanges: string[];
  preserve: string[];
  ambiguities: string[];
  constraints: PromptPlanConstraint[];
  references: PromptPlanReference[];
};

export type PromptProfileStructure = "prose" | "labeled" | "compact" | "shot_blocks";
export type NegativePolicy = "positive_rewrite" | "separate_field" | "inline_constraints";
export type ReferenceSyntax = "image_number" | "runway_image_number" | "fruit_slot";

export type PromptProfileSource = {
  label: string;
  url: string;
  reviewedAt: string;
};

export type PromptProfile = {
  id: string;
  version: string;
  mode: "image" | "video";
  structure: PromptProfileStructure;
  negativePolicy: NegativePolicy;
  referenceSyntax: ReferenceSyntax;
  motionFocusedImageToVideo: boolean;
  maxRecommendedBeats: number;
  guidance: string[];
  sources: PromptProfileSource[];
};

export type PromptReferenceInput = {
  slot: number;
  name: string;
  mediaType: string;
  role: "reference" | "first_frame" | "last_frame";
  purpose: ReferencePurpose;
  fingerprint?: string;
  durationSeconds?: number;
};

export type PromptTarget = {
  id: string;
  name: string;
  options: Record<string, string | number | boolean | undefined>;
  providerJson: string;
  capabilities?: Record<string, unknown>;
};

export type CompiledPrompt = {
  prompt: string;
  negativePrompt?: string;
  profileId: string;
  profileVersion: string;
  workflow: PromptWorkflow;
  coveredSlots: number[];
  requiredSlots?: number[];
  referencePriorities?: Record<number, PromptPlanReference["priority"]>;
  warnings: string[];
};

export type PromptEnhancementArtifact = CompiledPrompt & {
  schemaVersion: 1;
  signature: string;
  plannerModel: string;
  target: PromptTarget;
  profileSources: PromptProfileSource[];
  repairAttempts: number;
  actualCostUsd?: number;
  createdAt: string;
  plan: PromptPlan;
};

export function defaultReferencePurpose(
  kind: "image" | "video" | "audio",
  role: "reference" | "first_frame" | "last_frame",
): ReferencePurpose {
  if (role === "first_frame") return "first_frame";
  if (role === "last_frame") return "last_frame";
  if (kind === "audio") return "audio";
  if (kind === "video") return "motion";
  return "subject_identity";
}

export function referencePurposesForKind(kind: "image" | "video" | "audio"): ReferencePurpose[] {
  if (kind === "audio") return ["audio", "context"];
  if (kind === "video") return ["motion", "style", "composition", "context"];
  return [
    "subject_identity",
    "product_identity",
    "character",
    "wardrobe",
    "style",
    "composition",
    "pose",
    "context",
  ];
}
