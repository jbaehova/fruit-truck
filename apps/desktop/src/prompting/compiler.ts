import type {
  CompiledPrompt,
  PromptPlan,
  PromptPlanReference,
  PromptProfile,
  PromptReferenceInput,
  PromptWorkflow,
} from "./types.ts";

function clean(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean);
}

function sentence(values: string[]) {
  return clean(values).join("; ");
}

function quotedExactText(values: string[]) {
  return clean(values).map((value) => JSON.stringify(value)).join(", ");
}

function fallbackReference(reference: PromptReferenceInput): PromptPlanReference {
  const purpose = reference.purpose;
  const target = purpose === "style" ? "the final visual style"
    : purpose === "composition" ? "the final composition"
      : purpose === "pose" ? "the subject pose"
        : purpose === "motion" ? "the requested motion"
          : purpose === "audio" ? "the requested audio"
            : purpose === "first_frame" ? "the opening frame"
              : purpose === "last_frame" ? "the closing frame"
                : purpose === "edit_target" ? "the edit canvas"
                  : "the referenced subject";
  return {
    slot: reference.slot,
    purpose,
    target,
    priority: "required",
    evidence: "role",
    copy: [purpose.replaceAll("_", " ")],
    preserve: purpose.includes("identity") || purpose === "character"
      ? ["defining appearance and proportions"]
      : [],
    ignore: ["incidental source details unrelated to the assigned purpose"],
  };
}

function referenceBinding(reference: PromptPlanReference, profile: PromptProfile) {
  const copy = sentence(reference.copy);
  const preserve = sentence(reference.preserve);
  const ignore = sentence(reference.ignore);
  const assignment = reference.priority === "required"
    ? `@${reference.slot} is required as the ${reference.purpose.replaceAll("_", " ")} reference for ${reference.target}`
    : reference.priority === "preferred"
      ? `Prefer @${reference.slot} as the ${reference.purpose.replaceAll("_", " ")} reference for ${reference.target} when it agrees with the requested result`
      : `Optionally use @${reference.slot} as the ${reference.purpose.replaceAll("_", " ")} reference for ${reference.target}, only where it helps the requested result`;
  if (profile.negativePolicy === "positive_rewrite") {
    return [
      assignment,
      copy ? `use these visible properties: ${copy}` : "",
      preserve ? `keep these invariants: ${preserve}` : "",
      ignore ? `the requested final scene governs details beyond this assigned role (${ignore})` : "",
    ].filter(Boolean).join("; ");
  }
  return [
    assignment,
    copy ? `copy: ${copy}` : "",
    preserve ? `preserve: ${preserve}` : "",
    ignore ? `ignore from the source: ${ignore}` : "",
  ].filter(Boolean).join("; ");
}

function compileConstraints(plan: PromptPlan, profile: PromptProfile) {
  const requirements = clean(plan.constraints.map((constraint) => constraint.requirement));
  const desired = clean(plan.constraints.map((constraint) => constraint.desiredState));
  if (profile.negativePolicy === "positive_rewrite") return { prompt: sentence(desired) };
  if (profile.negativePolicy === "separate_field") {
    return { prompt: sentence(desired), negativePrompt: sentence(requirements) || undefined };
  }
  return { prompt: sentence([...requirements, ...desired]) };
}

function imageSections(plan: PromptPlan, workflow: PromptWorkflow) {
  const sections: Array<[string, string]> = [
    ["Deliverable", sentence([plan.deliverable, plan.intent])],
    ["Scene", sentence(plan.scene)],
    ["Subjects", sentence(plan.subjects)],
    ["Action", sentence(plan.action)],
    ["Composition", sentence(plan.composition)],
    ["Camera", sentence(plan.camera)],
    ["Lighting", sentence(plan.lighting)],
    ["Color", sentence(plan.color)],
    ["Style", sentence(plan.style)],
    ["Materials", sentence(plan.materials)],
    ["Exact text", quotedExactText(plan.exactText)],
    ["Deliberate ambiguity", sentence(plan.ambiguities)],
  ];
  if (workflow === "image_edit" || workflow === "inpaint") {
    sections.push(["Change", sentence(plan.editChanges)]);
    sections.push(["Preserve", sentence(plan.preserve)]);
  }
  return sections;
}

function videoSections(plan: PromptPlan, workflow: PromptWorkflow, profile: PromptProfile) {
  const motionFocused = profile.motionFocusedImageToVideo
    && ["image_to_video", "first_last_frame", "video_to_video"].includes(workflow);
  const sections: Array<[string, string]> = [
    ["Deliverable", sentence([plan.deliverable, plan.intent])],
  ];
  if (!motionFocused) {
    sections.push(["Scene", sentence(plan.scene)]);
    sections.push(["Subjects", sentence(plan.subjects)]);
    sections.push(["Style", sentence([...plan.style, ...plan.lighting, ...plan.color])]);
  }
  sections.push(["Subject motion", sentence([...plan.action, ...plan.subjectMotion])]);
  sections.push(["Camera motion", sentence([...plan.cameraMotion, ...plan.camera])]);
  sections.push(["Continuity", sentence(plan.preserve)]);
  sections.push(["Audio", sentence(plan.audio)]);
  sections.push(["Exact text or dialogue", quotedExactText(plan.exactText)]);
  sections.push(["Deliberate ambiguity", sentence(plan.ambiguities)]);
  return sections;
}

function renderSections(
  sections: Array<[string, string]>,
  references: string[],
  constraints: string,
  plan: PromptPlan,
  profile: PromptProfile,
) {
  const populated = sections.filter(([, value]) => value);
  if (profile.structure === "compact" || profile.structure === "prose") {
    return [
      ...populated.map(([, value]) => value),
      sentence(plan.temporalBeats),
      ...references,
      constraints,
    ].filter(Boolean).join(profile.structure === "compact" ? ". " : "\n");
  }
  const lines = populated.map(([label, value]) => `${label}: ${value}`);
  if (references.length) lines.push(`References:\n${references.map((value) => `- ${value}`).join("\n")}`);
  if (profile.structure === "shot_blocks" && plan.temporalBeats.length) {
    lines.push(`Shots:\n${clean(plan.temporalBeats).map((beat, index) => `Shot ${index + 1}: ${beat}`).join("\n")}`);
  } else if (plan.temporalBeats.length) {
    lines.push(`Temporal beats: ${sentence(plan.temporalBeats)}`);
  }
  if (constraints) lines.push(`Constraints: ${constraints}`);
  return lines.join("\n");
}

export function compilePromptPlan({
  plan,
  profile,
  workflow,
  references,
}: {
  plan: PromptPlan;
  profile: PromptProfile;
  workflow: PromptWorkflow;
  references: PromptReferenceInput[];
}): CompiledPrompt {
  const warnings: string[] = [];
  const available = new Map(references.map((reference) => [reference.slot, reference]));
  const supplied = new Map<number, PromptPlanReference>();
  for (const contract of plan.references) {
    if (!available.has(contract.slot)) {
      warnings.push(`The planner invented unavailable reference @${contract.slot}; it was discarded.`);
      continue;
    }
    if (supplied.has(contract.slot)) {
      warnings.push(`The planner duplicated reference @${contract.slot}; the first contract was kept.`);
      continue;
    }
    const authoritative = available.get(contract.slot)!;
    supplied.set(contract.slot, { ...contract, purpose: authoritative.purpose });
  }
  const contracts = references.map((reference) => {
    const contract = supplied.get(reference.slot);
    if (contract) return contract;
    warnings.push(`The planner omitted reference @${reference.slot}; a deterministic ${reference.purpose} contract was added.`);
    return fallbackReference(reference);
  });
  if (plan.temporalBeats.length > profile.maxRecommendedBeats) {
    warnings.push(`${profile.id} recommends at most ${profile.maxRecommendedBeats} temporal beats; received ${plan.temporalBeats.length}.`);
  }
  const constraints = compileConstraints(plan, profile);
  const sections = profile.mode === "image"
    ? imageSections(plan, workflow)
    : videoSections(plan, workflow, profile);
  const bindings = contracts.map((reference) => referenceBinding(reference, profile));
  const prompt = renderSections(sections, bindings, constraints.prompt, plan, profile).trim();
  if (!prompt) throw new Error("The compiled prompt is empty.");
  return {
    prompt,
    negativePrompt: constraints.negativePrompt,
    profileId: profile.id,
    profileVersion: profile.version,
    workflow,
    coveredSlots: contracts.map((reference) => reference.slot),
    requiredSlots: contracts.filter((reference) => reference.priority === "required").map((reference) => reference.slot),
    referencePriorities: Object.fromEntries(contracts.map((reference) => [reference.slot, reference.priority])),
    warnings,
  };
}

export function validateCompiledPrompt(
  compiled: CompiledPrompt,
  references: PromptReferenceInput[],
): string | null {
  if (!compiled.prompt.trim()) return "The compiled prompt is empty.";
  const expected = new Set(references.map((reference) => reference.slot));
  const required = new Set(compiled.requiredSlots ?? references.map((reference) => reference.slot));
  const covered = new Set(compiled.coveredSlots);
  for (const slot of required) {
    if (!expected.has(slot)) return `The compiled prompt requires unavailable reference @${slot}.`;
    if (!covered.has(slot)) return `The compiled prompt does not cover required reference @${slot}.`;
    if (!new RegExp(`@${slot}(?!\\d)`).test(compiled.prompt)) return `The compiled prompt does not bind required reference @${slot}.`;
  }
  for (const slot of covered) {
    if (!expected.has(slot)) return `The compiled prompt covered unavailable reference @${slot}.`;
  }
  for (const slot of [...compiled.prompt.matchAll(/@(\d+)/g)].map((match) => Number(match[1]))) {
    if (!expected.has(slot)) return `The compiled prompt invented reference @${slot}.`;
  }
  return null;
}
