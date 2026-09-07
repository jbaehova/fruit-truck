import type { DraftReference, GenerationDraftState } from "./studio.ts";

/** Retain legacy plans for workspace compatibility, but edit and send ordinary inputs. */
export function simplifyVideoDraft(draft: GenerationDraftState): GenerationDraftState {
  const plan = draft.directorPlan;
  if (!plan?.enabled) return draft;

  const references = draft.references.map((reference) => ({ ...reference }));
  const frames = [...plan.keyframes];
  if (plan.sourceAssetId && !frames.some((frame) => frame.role === "first")) {
    frames.unshift({ id: "legacy-source", assetId: plan.sourceAssetId, role: "first", time: 0 });
  }
  for (const frame of frames) {
    const role = frame.role === "first" ? "first_frame" : frame.role === "last" ? "last_frame" : "reference";
    // The visible input roles win over stale plan bindings.
    if (role !== "reference" && references.some((reference) => reference.role === role)) continue;
    if (references.some((reference) => reference.assetId === frame.assetId && (role === "reference" || reference.role === role))) continue;
    const reusable = references.find((reference) => reference.assetId === frame.assetId && reference.role === "reference");
    const purpose = role === "reference" ? "composition" : role;
    if (reusable) {
      reusable.role = role;
      reusable.purpose = purpose;
    } else {
      references.push({
        assetId: frame.assetId,
        slot: references.reduce((maximum, reference) => Math.max(maximum, reference.slot), 0) + 1,
        role,
        purpose,
      } satisfies DraftReference);
    }
  }
  return { ...draft, references, directorPlan: { ...plan, enabled: false } };
}
