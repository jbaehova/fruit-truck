import type {
  PromptPlan,
  PromptPlanConstraint,
  PromptPlanReference,
  PromptReferenceInput,
  ReferencePurpose,
} from "./types.ts";

export const PROMPT_PLANNER_VERSION = "fruit-prompt-planner-v2.0.0";

const stringArray = { type: "array", items: { type: "string" } } as const;

export const PROMPT_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "integer", const: 1 },
    mode: { type: "string", enum: ["image", "video"] },
    workflow: {
      type: "string",
      enum: [
        "text_to_image", "image_edit", "inpaint", "multi_reference_compose",
        "text_to_video", "image_to_video", "first_last_frame", "reference_to_video",
        "video_to_video", "audio_visual_reference",
      ],
    },
    language: { type: "string" },
    deliverable: { type: "string" },
    intent: { type: "string" },
    scene: stringArray,
    subjects: stringArray,
    action: stringArray,
    composition: stringArray,
    camera: stringArray,
    lighting: stringArray,
    color: stringArray,
    style: stringArray,
    materials: stringArray,
    exactText: stringArray,
    temporalBeats: stringArray,
    subjectMotion: stringArray,
    cameraMotion: stringArray,
    audio: stringArray,
    editChanges: stringArray,
    preserve: stringArray,
    ambiguities: stringArray,
    constraints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          requirement: { type: "string" },
          desiredState: { type: "string" },
        },
        required: ["requirement", "desiredState"],
      },
    },
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          slot: { type: "integer" },
          target: { type: "string" },
          purpose: {
            type: "string",
            enum: [
              "subject_identity",
              "product_identity",
              "character",
              "wardrobe",
              "style",
              "composition",
              "pose",
              "first_frame",
              "last_frame",
              "motion",
              "audio",
              "edit_target",
              "context",
            ],
          },
          priority: { type: "string", enum: ["required", "preferred", "optional"] },
          evidence: { type: "string", enum: ["user", "role", "vision_suggested"] },
          copy: stringArray,
          preserve: stringArray,
          ignore: stringArray,
        },
        required: ["slot", "target", "purpose", "priority", "evidence", "copy", "preserve", "ignore"],
      },
    },
  },
  required: [
    "version",
    "mode",
    "workflow",
    "language",
    "deliverable",
    "intent",
    "scene",
    "subjects",
    "action",
    "composition",
    "camera",
    "lighting",
    "color",
    "style",
    "materials",
    "exactText",
    "temporalBeats",
    "subjectMotion",
    "cameraMotion",
    "audio",
    "editChanges",
    "preserve",
    "ambiguities",
    "constraints",
    "references",
  ],
} as const;

export const PROMPT_PLAN_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "fruit_truck_prompt_plan",
    strict: true,
    schema: PROMPT_PLAN_SCHEMA,
  },
} as const;

const PURPOSES = new Set<ReferencePurpose>(PROMPT_PLAN_SCHEMA.properties.references.items.properties.purpose.enum);
const ARRAY_KEYS = [
  "scene",
  "subjects",
  "action",
  "composition",
  "camera",
  "lighting",
  "color",
  "style",
  "materials",
  "exactText",
  "temporalBeats",
  "subjectMotion",
  "cameraMotion",
  "audio",
  "editChanges",
  "preserve",
  "ambiguities",
] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOnlyKeys(value: object, allowed: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function parseReference(value: unknown): PromptPlanReference | null {
  if (!value || typeof value !== "object") return null;
  if (!hasOnlyKeys(value, ["slot", "target", "purpose", "priority", "evidence", "copy", "preserve", "ignore"])) return null;
  const reference = value as Partial<PromptPlanReference>;
  return Number.isInteger(reference.slot)
    && Number(reference.slot) > 0
    && typeof reference.target === "string"
    && PURPOSES.has(reference.purpose as ReferencePurpose)
    && ["required", "preferred", "optional"].includes(String(reference.priority))
    && ["user", "role", "vision_suggested"].includes(String(reference.evidence))
    && isStringArray(reference.copy)
    && isStringArray(reference.preserve)
    && isStringArray(reference.ignore)
    ? reference as PromptPlanReference
    : null;
}

function parseConstraint(value: unknown): PromptPlanConstraint | null {
  if (!value || typeof value !== "object") return null;
  if (!hasOnlyKeys(value, ["requirement", "desiredState"])) return null;
  const constraint = value as Partial<PromptPlanConstraint>;
  return typeof constraint.requirement === "string" && typeof constraint.desiredState === "string"
    ? constraint as PromptPlanConstraint
    : null;
}

export function parsePromptPlan(raw: string): PromptPlan {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The prompt planner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The prompt planner returned a non-object plan.");
  }
  const topLevelKeys = ["version", "mode", "workflow", "language", "deliverable", "intent", ...ARRAY_KEYS, "constraints", "references"];
  if (!hasOnlyKeys(value, topLevelKeys)) {
    throw new Error("The prompt plan contains missing or unexpected top-level fields.");
  }
  const plan = value as Partial<PromptPlan>;
  if (plan.version !== 1 || !["image", "video"].includes(String(plan.mode)) || !PROMPT_PLAN_SCHEMA.properties.workflow.enum.includes(plan.workflow as never)) {
    throw new Error("The prompt plan has an invalid version, mode, or workflow.");
  }
  if (typeof plan.language !== "string" || typeof plan.deliverable !== "string" || typeof plan.intent !== "string") {
    throw new Error("The prompt plan is missing language, deliverable, or intent.");
  }
  for (const key of ARRAY_KEYS) {
    if (!isStringArray(plan[key])) throw new Error(`The prompt plan field ${key} must be a string array.`);
  }
  if (!Array.isArray(plan.constraints) || plan.constraints.some((item) => !parseConstraint(item))) {
    throw new Error("The prompt plan contains an invalid constraint.");
  }
  if (!Array.isArray(plan.references) || plan.references.some((item) => !parseReference(item))) {
    throw new Error("The prompt plan contains an invalid reference contract.");
  }
  const slots = plan.references.map((reference) => reference.slot);
  if (new Set(slots).size !== slots.length) {
    throw new Error("The prompt plan contains duplicate reference slots.");
  }
  return plan as PromptPlan;
}

export function plannerConstitutionInstruction() {
  return [
    `You are Fruit Truck's structured media prompt planner (${PROMPT_PLANNER_VERSION}).`,
    "Return only the requested JSON object; never return analysis, markdown, or hidden reasoning.",
    "Preserve the user's intent, language, names, numbers, exact text, explicit exclusions, and deliberate ambiguity.",
    "Do not invent assets, model controls, visual facts, or guarantees of perfect identity fidelity.",
    "Convert vague quality adjectives into concrete visible composition, lighting, material, motion, or continuity decisions only when they help the request.",
    "Keep exact text byte-for-byte in exactText. Do not translate or correct it.",
    "For each constraint, preserve its meaning in requirement and also provide a positive desired final state in desiredState.",
    "Create exactly one reference contract for every supplied numbered reference, using its supplied purpose.",
    "Copy the active mode and workflow exactly into the plan. Mark user-attached references required unless the user explicitly says they are optional, and record whether each contract came from the user, transport role, or visual suggestion.",
    "For every reference, distinguish what to copy, what must remain invariant, and incidental source details to ignore.",
    "For edits, put only requested deltas in editChanges and all compatible protected invariants in preserve.",
    "For short video clips, use the fewest plausible temporal beats needed for the requested result.",
  ].join(" ");
}

export function referenceCatalogInstruction(references: PromptReferenceInput[]) {
  if (!references.length) return "No external references are attached.";
  return [
    "Authoritative reference catalog:",
    ...references.map((reference) =>
      `@${reference.slot}: ${reference.name} (${reference.mediaType}${reference.durationSeconds != null ? `, ${reference.durationSeconds.toFixed(2)}s` : ""}); transport role=${reference.role}; semantic purpose=${reference.purpose}.`,
    ),
    "Every listed slot must appear exactly once in references. Never create another slot.",
  ].join("\n");
}
