import type { CompiledDirector, DirectorFidelity, DirectorPlan } from "./types.ts";

export type DirectorDiagnosticSummary = {
  schemaVersion: number;
  enabled: boolean;
  sourceAssetPresent: boolean;
  referencedAssets: { present: number; missing: number };
  controls: {
    cameraRig: number;
    subjects: number;
    motions: number;
    keyframes: number;
    shots: number;
  };
  fidelity: Partial<Record<DirectorFidelity, number>>;
  validationErrorCodes: string[];
};

/**
 * Produces support-safe Director diagnostics without asset IDs, path
 * coordinates, labels, or prompt content.
 */
export function directorDiagnosticSummary(
  plan: DirectorPlan,
  availableAssetIds: ReadonlySet<string>,
  compiled?: CompiledDirector,
  validationErrorCodes: readonly string[] = [],
): DirectorDiagnosticSummary {
  const referencedAssetIds = new Set([
    ...(plan.sourceAssetId ? [plan.sourceAssetId] : []),
    ...plan.subjects.map((subject) => subject.sourceAssetId),
    ...plan.keyframes.map((keyframe) => keyframe.assetId),
  ]);
  let present = 0;
  let missing = 0;
  for (const assetId of referencedAssetIds) {
    if (availableAssetIds.has(assetId)) present += 1;
    else missing += 1;
  }
  const fidelity: Partial<Record<DirectorFidelity, number>> = {};
  for (const value of Object.values(compiled?.fidelityByControlId ?? {})) {
    fidelity[value] = (fidelity[value] ?? 0) + 1;
  }
  return {
    schemaVersion: plan.schemaVersion,
    enabled: plan.enabled,
    sourceAssetPresent: Boolean(plan.sourceAssetId && availableAssetIds.has(plan.sourceAssetId)),
    referencedAssets: { present, missing },
    controls: {
      cameraRig: 1,
      subjects: plan.subjects.length,
      motions: plan.motions.length,
      keyframes: plan.keyframes.length,
      shots: plan.shots.length,
    },
    fidelity,
    validationErrorCodes: [...new Set(validationErrorCodes)].toSorted(),
  };
}
