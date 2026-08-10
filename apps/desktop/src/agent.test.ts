import assert from "node:assert/strict";
import test from "node:test";
import { diffAgentBridgeSession, serializeAgentSessionForBridge } from "./agentBridge.ts";
import { createSession } from "./studio.ts";
import {
  assemblyDurationSeconds,
  createAgentState,
  createCustomSkillDraft,
  normalizeAgentState,
  recordActualCost,
  resolveAgentDecision,
  resolveAgentDecisionFromDesktop,
  resolveAgentDecisionFromChat,
  resolveAgentDecisionWithModelSelection,
  exposeAgentSession,
  validateAssemblyDuration,
  validateAgentState,
  validatePlanStepTransition,
  type AgentSessionState,
} from "./agent.ts";

test("actual cost ledger sums distinct charges and updates duplicate operation IDs", () => {
  const initial = createAgentState();
  const generated = recordActualCost(initial, {
    id: "generation:one",
    category: "generation",
    actualCostUsd: 0.040000009,
  });
  const enhanced = recordActualCost(generated, {
    id: "prompt-enhancement:one",
    category: "prompt_enhancement",
    actualCostUsd: 0.00123456,
  });
  const corrected = recordActualCost(enhanced, {
    id: "generation:one",
    category: "generation",
    actualCostUsd: 0.05,
  });

  assert.equal(corrected.execution.costLedger.length, 2);
  assert.equal(corrected.execution.spentUsd, 0.05123456);
  assert.equal(corrected.execution.costLedger.find((entry) => entry.id === "generation:one")?.actualCostUsd, 0.05);
});

test("actual cost ledger preserves confirmed charges below eight decimal places", () => {
  const actualCostUsd = 0.000000004;
  const recorded = recordActualCost(createAgentState(), {
    id: "prompt-enhancement:micro",
    category: "prompt_enhancement",
    actualCostUsd,
  });

  assert.equal(recorded.execution.costLedger[0]?.actualCostUsd, actualCostUsd);
  assert.equal(recorded.execution.spentUsd, actualCostUsd);
  assert.equal(normalizeAgentState(recorded).execution.spentUsd, actualCostUsd);
});

test("agent schema 4 resets legacy tracked spend and retains current cost ledgers", () => {
  const current = recordActualCost(createAgentState(), {
    id: "generation:current",
    category: "generation",
    actualCostUsd: 0.12,
  });
  assert.equal(normalizeAgentState(current).execution.spentUsd, 0.12);

  const legacy = {
    ...current,
    schemaVersion: 3 as const,
    execution: { ...current.execution, spentUsd: 99 },
  };
  const migrated = normalizeAgentState(legacy);
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.execution.costLedger, []);
  assert.equal(migrated.execution.spentUsd, 0);
});

function productionState(): AgentSessionState {
  const state = createAgentState("Create a live action 9:16 Instagram reel, 15 seconds long.");
  const createdAt = new Date().toISOString();
  return {
    ...state,
    connection: { status: "claimed" as const, claimedAt: createdAt, claimedBy: "test-agent" },
    controlMode: "agent" as const,
    runStatus: "waiting" as const,
    brief: {
      ...state.brief,
      deliverable: "Video",
      usage: "Instagram reel",
      outputSpec: "9:16 · 15 seconds",
    },
    requirements: [{
      id: "req-visual",
      label: "Visual approach",
      value: "",
      status: "missing" as const,
      source: "skill" as const,
      blocking: true,
    }],
    plan: [
      { id: "brief", title: "Confirm brief", description: "Confirm direction.", status: "waiting" as const, dependsOn: [] },
      { id: "production", title: "Generate shots", description: "Generate.", status: "pending" as const, dependsOn: ["brief"] },
      { id: "assembly", title: "Assemble", description: "Assemble.", status: "pending" as const, dependsOn: ["production"] },
      { id: "complete", title: "Approve final", description: "Approve.", status: "pending" as const, dependsOn: ["assembly"] },
    ],
    currentStepId: "brief",
    decisions: [{
      id: "decision-visual",
      semanticKey: "visual_approach" as const,
      title: "Visual approach",
      prompt: "Choose in the app.",
      kind: "choice" as const,
      status: "pending" as const,
      blocking: true,
      relatedAssetIds: [],
      options: [{ id: "live-action", label: "Live action", recommended: true }],
      createdAt,
    }],
    revision: 1,
    updatedAt: createdAt,
  };
}

test("blocking decisions keep the run waiting until all are resolved", () => {
  let state = productionState();
  for (const item of state.decisions) {
    state = resolveAgentDecision(state, item.id, item.options[0]?.id, "Use the recommended direction.");
  }
  assert.equal(state.runStatus, "working");
  assert.equal(state.activity.filter((item) => item.kind === "decision").length, state.decisions.length);
  assert.ok(state.requirements.every((item) => !item.blocking));
  assert.match(state.brief.visualApproach, /Live action/);
});

test("resolving a model decision records the user selection atomically", () => {
  const state = productionState();
  const withModelDecision = {
    ...state,
    decisions: [...state.decisions, {
      id: "decision-model",
      semanticKey: "model_selection_image" as const,
      title: "Choose image model",
      prompt: "Choose the model for this stage.",
      kind: "choice" as const,
      status: "pending" as const,
      blocking: true,
      relatedAssetIds: [],
      options: [{ id: "test/image", label: "Test image model" }],
      createdAt: new Date().toISOString(),
    }],
    modelSelections: {
      ...state.modelSelections,
      image: { status: "pending_user" as const },
    },
  };
  const resolved = resolveAgentDecisionWithModelSelection(withModelDecision, "decision-model", "test/image");
  assert.equal(resolved.decisions.at(-1)?.status, "resolved");
  assert.deepEqual(resolved.modelSelections.image, {
    status: "selected",
    modelId: "test/image",
    selectedBy: "user",
    selectedAt: resolved.updatedAt,
  });
});

test("resolving a thread-scoped model decision leaves mode-global modelSelections unchanged", () => {
  const state = productionState();
  const priorSelection = state.modelSelections.image;
  const withScopedDecision = {
    ...state,
    decisions: [...state.decisions, {
      id: "decision-model-scoped",
      semanticKey: "model_selection_image" as const,
      title: "Choose image model",
      prompt: "Choose the model for these threads.",
      kind: "choice" as const,
      status: "pending" as const,
      blocking: true,
      relatedAssetIds: [],
      relatedThreadIds: ["thread-a", "thread-b"],
      options: [{ id: "test/image", label: "Test image model" }],
      createdAt: new Date().toISOString(),
    }],
  };
  const resolved = resolveAgentDecisionWithModelSelection(withScopedDecision, "decision-model-scoped", "test/image");
  const decision = resolved.decisions.find((item) => item.id === "decision-model-scoped");
  assert.equal(decision?.status, "resolved");
  assert.equal(decision?.resolution?.optionId, "test/image");
  assert.deepEqual(resolved.modelSelections.image, priorSelection);
});

test("agent-chat decisions preserve the exact user reply and reject invalid choices", () => {
  const state = productionState();
  assert.throws(
    () => resolveAgentDecisionFromChat(state, "decision-visual", "다른 방향", "missing"),
    /not valid for decision/i,
  );
  const resolved = resolveAgentDecisionFromChat(
    state,
    "decision-visual",
    "추천한 라이브 액션으로 진행해 주세요.",
    "live-action",
  );
  const resolution = resolved.decisions[0]?.resolution;
  assert.equal(resolution?.optionId, "live-action");
  assert.equal(resolution?.userResponse, "추천한 라이브 액션으로 진행해 주세요.");
  assert.equal(resolution?.channel, "agent_chat");
});

test("Fruit Truck UI decisions record selected media and cannot resolve chat checkpoints", () => {
  const base = productionState();
  const state: AgentSessionState = {
    ...base,
    artifacts: [{
      assetId: "asset-a",
      role: "keyframe_candidate",
      parentAssetIds: [],
      approval: "unreviewed",
    }],
    decisions: [{
      id: "decision-keyframe",
      title: "Choose a keyframe",
      prompt: "Choose visually in Fruit Truck.",
      kind: "approval",
      channel: "fruit_truck_ui",
      presentation: "media_grid",
      selectionMode: "single",
      minSelections: 1,
      maxSelections: 1,
      status: "pending",
      blocking: true,
      relatedAssetIds: ["asset-a"],
      options: [
        { id: "approve", label: "Approve" },
        { id: "revise", label: "Revise" },
      ],
      createdAt: new Date().toISOString(),
    }],
  };
  assert.throws(
    () => resolveAgentDecisionFromChat(state, "decision-keyframe", "Approve", "approve"),
    /Fruit Truck/i,
  );
  const resolved = resolveAgentDecisionFromDesktop(state, "decision-keyframe", ["approve"], ["asset-a"]);
  assert.equal(resolved.decisions[0]?.resolution?.channel, "fruit_truck_ui");
  assert.deepEqual(resolved.decisions[0]?.resolution?.selectedAssetIds, ["asset-a"]);
  assert.equal(resolved.artifacts[0]?.approval, "approved");
});

test("media-grid approval options approve their selected asset candidates", () => {
  const createdAt = new Date().toISOString();
  const base = productionState();
  const state: AgentSessionState = {
    ...base,
    artifacts: ["asset-a", "asset-b"].map((assetId) => ({
      assetId,
      role: "video_candidate",
      parentAssetIds: [],
      approval: "unreviewed" as const,
    })),
    decisions: [{
      id: "decision-videos",
      title: "Approve video clips",
      prompt: "Choose the clips to approve.",
      kind: "approval",
      channel: "fruit_truck_ui",
      presentation: "media_grid",
      selectionMode: "multiple",
      minSelections: 1,
      maxSelections: 2,
      status: "pending",
      blocking: true,
      relatedAssetIds: ["asset-a", "asset-b"],
      options: [
        { id: "shot-a", label: "Shot A", assetId: "asset-a" },
        { id: "shot-b", label: "Shot B", assetId: "asset-b" },
      ],
      createdAt,
    }],
  };
  const resolved = resolveAgentDecisionFromDesktop(
    state,
    "decision-videos",
    ["shot-a", "shot-b"],
    ["asset-a", "asset-b"],
  );
  assert.deepEqual(resolved.artifacts.map((artifact) => artifact.approval), ["approved", "approved"]);

  const persistedWithOldBug = {
    ...resolved,
    artifacts: resolved.artifacts.map((artifact) => ({ ...artifact, approval: "unreviewed" as const })),
  };
  const normalized = normalizeAgentState(persistedWithOldBug);
  assert.deepEqual(normalized.artifacts.map((artifact) => artifact.approval), ["approved", "approved"]);

  const rejectedAfterApproval = normalizeAgentState({
    ...persistedWithOldBug,
    artifacts: persistedWithOldBug.artifacts.map((artifact) => ({ ...artifact, approval: "unreviewed" as const })),
    decisions: [...persistedWithOldBug.decisions, {
      id: "decision-revise-a",
      title: "Revise shot A",
      prompt: "Reject the first approved shot and generate a replacement.",
      kind: "approval",
      channel: "agent_chat",
      presentation: "form",
      selectionMode: "single",
      status: "resolved",
      blocking: true,
      relatedAssetIds: ["asset-a"],
      options: [
        { id: "approve", label: "Approve" },
        { id: "revise", label: "Revise" },
      ],
      resolution: {
        optionId: "revise",
        selectedOptionIds: ["revise"],
        selectedAssetIds: [],
        channel: "agent_chat",
        resolvedAt: new Date(Date.now() + 1_000).toISOString(),
      },
      createdAt: new Date(Date.now() + 500).toISOString(),
    }],
  });
  assert.deepEqual(rejectedAfterApproval.artifacts.map((artifact) => artifact.approval), ["rejected", "approved"]);
});

test("normalization drops invalid duplicate assembly checkpoints", () => {
  const base = createAgentState();
  const createdAt = new Date().toISOString();
  const normalized = normalizeAgentState({
    ...base,
    connection: { status: "claimed", claimedAt: createdAt, claimedBy: "migration-test" },
    controlMode: "agent",
    runStatus: "waiting",
    uiAttention: { requestedAt: createdAt, decisionId: "decision-invalid-assembly" },
    decisions: [{
      id: "decision-invalid-assembly",
      title: "Duplicate assembly review",
      prompt: "This was incorrectly queued after propose_assembly.",
      kind: "feedback",
      channel: "fruit_truck_ui",
      presentation: "assembly_review",
      selectionMode: "single",
      status: "pending",
      blocking: true,
      relatedAssetIds: [],
      options: [],
      createdAt,
    }],
  });
  assert.deepEqual(normalized.decisions, []);
  assert.equal(normalized.runStatus, "working");
  assert.equal(normalized.uiAttention, undefined);
});

test("normalization keeps waiting for surviving blockers after dropping an invalid checkpoint", () => {
  const base = createAgentState();
  const createdAt = new Date().toISOString();
  const validDecision = {
    id: "decision-valid-ui",
    title: "Choose a direction",
    prompt: "Choose the surviving direction.",
    kind: "choice" as const,
    channel: "fruit_truck_ui" as const,
    presentation: "form" as const,
    selectionMode: "single" as const,
    status: "pending" as const,
    blocking: true,
    relatedAssetIds: [],
    options: [{ id: "continue", label: "Continue" }],
    createdAt,
  };
  const normalized = normalizeAgentState({
    ...base,
    connection: { status: "claimed", claimedAt: createdAt, claimedBy: "migration-test" },
    controlMode: "agent",
    runStatus: "waiting",
    uiAttention: { requestedAt: createdAt, decisionId: "decision-invalid-assembly" },
    decisions: [validDecision, {
      id: "decision-invalid-assembly",
      title: "Duplicate assembly review",
      prompt: "This invalid checkpoint should be discarded.",
      kind: "feedback",
      channel: "fruit_truck_ui",
      presentation: "assembly_review",
      selectionMode: "single",
      status: "pending",
      blocking: true,
      relatedAssetIds: [],
      options: [],
      createdAt,
    }],
  });
  assert.deepEqual(normalized.decisions.map((decision) => decision.id), [validDecision.id]);
  assert.equal(normalized.runStatus, "waiting");
  assert.equal(normalized.uiAttention?.decisionId, validDecision.id);
});

test("normalization gives legacy assembly clips stable render keys", () => {
  const base = createAgentState();
  const legacyClip = {
    assetId: "asset-video",
    startSeconds: 0,
    endSeconds: 3,
    order: 0,
  };
  const normalized = normalizeAgentState({
    ...base,
    assembly: {
      ...base.assembly,
      clips: [legacyClip as AgentSessionState["assembly"]["clips"][number]],
    },
  });
  assert.equal(normalized.assembly.clips[0].id, "assembly-asset-video-0-0");
});

test("Codex image backend selection is session-scoped and user-owned", () => {
  const createdAt = new Date().toISOString();
  const base = createAgentState("Generate a product still.");
  const state: AgentSessionState = {
    ...base,
    connection: {
      status: "claimed",
      claimedAt: createdAt,
      claimedBy: "codex-test",
      agentHost: "codex",
    },
    runStatus: "waiting",
    decisions: [{
      id: "decision-backend",
      semanticKey: "image_generation_backend",
      title: "Choose image generation backend",
      prompt: "Choose a backend.",
      kind: "choice",
      status: "pending",
      blocking: true,
      relatedAssetIds: [],
      options: [
        { id: "codex_builtin", label: "Codex built-in" },
        { id: "openrouter", label: "OpenRouter" },
      ],
      createdAt,
    }],
  };
  const selected = resolveAgentDecisionFromChat(
    state,
    "decision-backend",
    "Codex 내장 생성을 사용할게요.",
    "codex_builtin",
  );
  assert.deepEqual(selected.imageGeneration, {
    status: "selected",
    backend: "codex_builtin",
    selectedBy: "user_chat",
    selectedAt: selected.updatedAt,
    decisionId: "decision-backend",
  });
  assert.equal(validateAgentState(selected).length, 0);

  const wrongHost = {
    ...selected,
    connection: { ...selected.connection, agentHost: "claude" as const },
  };
  assert.match(validateAgentState(wrongHost).join(" "), /requires a Codex agent host/i);
});

test("final approval completes the run and its checkpoint", () => {
  const state = productionState();
  const finalState = {
    ...state,
    currentStepIds: ["production", "complete"],
    artifacts: [{
      assetId: "asset-final",
      role: "final_video",
      parentAssetIds: [],
      approval: "unreviewed" as const,
    }],
    decisions: [{
      id: "decision-final",
      semanticKey: "final_approval" as const,
      title: "Final video approval",
      prompt: "Approve the final.",
      kind: "approval" as const,
      status: "pending" as const,
      blocking: true,
      relatedStepId: "complete",
      relatedAssetIds: ["asset-final"],
      options: [{ id: "approve", label: "Approve final" }],
      createdAt: new Date().toISOString(),
    }],
  };
  const approved = resolveAgentDecision(finalState, "decision-final", "approve");
  assert.equal(approved.runStatus, "completed");
  assert.ok(approved.plan.every((step) => step.status === "completed" || step.status === "skipped"));
  assert.equal(approved.artifacts[0].approval, "approved");
  assert.deepEqual(approved.currentStepIds, []);
});

test("final approval waits for every other blocking decision before completing", () => {
  const state = productionState();
  const createdAt = new Date().toISOString();
  const withFinal = {
    ...state,
    decisions: [
      ...state.decisions,
      {
        id: "decision-final",
        semanticKey: "final_approval" as const,
        title: "Final approval",
        prompt: "Approve the final.",
        kind: "approval" as const,
        status: "pending" as const,
        blocking: true,
        relatedAssetIds: [],
        options: [{ id: "approve", label: "Approve" }],
        createdAt,
      },
    ],
  };
  assert.throws(
    () => resolveAgentDecisionFromChat(
      withFinal,
      "decision-final",
      "최종 결과는 승인합니다.",
      "approve",
    ),
    /every other blocking decision/i,
  );
  const visualResolved = resolveAgentDecisionFromChat(
    withFinal,
    "decision-visual",
    "라이브 액션으로 진행합니다.",
    "live-action",
  );
  assert.equal(visualResolved.runStatus, "waiting");
  const allResolved = resolveAgentDecisionFromChat(
    visualResolved,
    "decision-final",
    "이제 최종 결과를 승인합니다.",
    "approve",
  );
  assert.equal(allResolved.runStatus, "completed");
});

test("decision resolution never resumes a paused or human-controlled run", () => {
  const drafted = productionState();
  const pending = drafted.decisions[0];
  assert.ok(pending);
  const paused = {
    ...drafted,
    runStatus: "paused" as const,
    pausedReason: "Paused by user.",
  };
  const resolvedPaused = resolveAgentDecision(paused, pending.id, pending.options[0]?.id, "Confirmed.");
  assert.equal(resolvedPaused.runStatus, "paused");
  assert.equal(resolvedPaused.pausedReason, "Paused by user.");

  const human = {
    ...drafted,
    controlMode: "human" as const,
    runStatus: "paused" as const,
  };
  const resolvedHuman = resolveAgentDecision(human, pending.id, pending.options[0]?.id, "Confirmed.");
  assert.equal(resolvedHuman.runStatus, "paused");
  assert.equal(resolvedHuman.controlMode, "human");
});

test("publishing an agent session preserves state and waits without drafting a plan", () => {
  const existing = {
    ...createAgentState(),
    artifacts: [{
      assetId: "asset-existing",
      role: "approved_reference",
      parentAssetIds: [],
      approval: "approved" as const,
    }],
    activity: [{
      id: "activity-existing",
      createdAt: new Date().toISOString(),
      actor: "user" as const,
      kind: "decision" as const,
      title: "Approved existing reference",
    }],
    execution: {
      currentJobIds: ["job-existing"],
      generationCount: 2,
      costLedger: [{
        id: "generation:attempt-existing",
        category: "generation" as const,
        actualCostUsd: 0.4,
        recordedAt: new Date().toISOString(),
      }],
      spentUsd: 0.4,
      retryCount: 1,
    },
    revision: 9,
  };
  const seeded = exposeAgentSession(
    existing,
    "Create a live action 9:16 Instagram reel, 15 seconds long.",
  );
  assert.equal(seeded.controlMode, "agent");
  assert.equal(seeded.connection.status, "waiting");
  assert.equal(seeded.runStatus, "idle");
  assert.equal(seeded.revision, 10);
  assert.equal(seeded.brief.originalIntent, "Create a live action 9:16 Instagram reel, 15 seconds long.");
  assert.deepEqual(seeded.artifacts, existing.artifacts);
  assert.deepEqual(seeded.execution, existing.execution);
  assert.ok(seeded.activity.some((item) => item.id === "activity-existing"));
  assert.deepEqual(seeded.plan, existing.plan);
  assert.deepEqual(seeded.decisions, existing.decisions);
});

test("legacy claimed sessions normalize to OpenRouter without losing resolutions", () => {
  const state = productionState();
  const resolved = resolveAgentDecision(state, "decision-visual", "live-action", "Confirmed.");
  const legacy = structuredClone(resolved) as Omit<AgentSessionState, "imageGeneration"> & {
    imageGeneration?: AgentSessionState["imageGeneration"];
  };
  delete legacy.imageGeneration;
  if (legacy.decisions[0]?.resolution) delete legacy.decisions[0].resolution.channel;
  const normalized = normalizeAgentState(legacy as AgentSessionState);
  assert.equal(normalized.imageGeneration.backend, "openrouter");
  assert.equal(normalized.imageGeneration.selectedBy, "policy");
  assert.equal(normalized.decisions[0]?.resolution?.channel, "legacy_desktop");
});

test("custom skills are text-only and gated until video production", () => {
  const state = productionState();
  assert.throws(() => createCustomSkillDraft(state, "Perfume Film"));
  const progressed = {
    ...state,
    activity: [...state.activity, { id: "assembly-activity", createdAt: new Date().toISOString(), actor: "runtime" as const, kind: "assembly" as const, title: "Prepared video work" }],
  };
  const draft = createCustomSkillDraft(progressed, "Perfume Film");
  assert.match(draft.markdown, /fruit-truck-custom/);
  assert.doesNotMatch(draft.markdown, /assetId|blob:|file:\/\//);
});

test("plan invariants reject cycles and skipped dependencies while allowing parallel active steps", () => {
  const base = createAgentState();
  const cycle = {
    ...base,
    currentStepId: undefined,
    plan: [
      { id: "a", title: "A", description: "A", status: "pending" as const, dependsOn: ["b"] },
      { id: "b", title: "B", description: "B", status: "pending" as const, dependsOn: ["a"] },
    ],
  };
  assert.match(validateAgentState(cycle).join(" "), /cycle/i);
  const parallel = {
    ...base,
    currentStepId: "a",
    currentStepIds: ["a", "b"],
    plan: [
      { id: "a", title: "A", description: "A", status: "in_progress" as const, dependsOn: [] },
      { id: "b", title: "B", description: "B", status: "waiting" as const, dependsOn: [] },
    ],
  };
  assert.deepEqual(validateAgentState(parallel), []);
  const dependency = {
    ...base,
    plan: [
      { id: "a", title: "A", description: "A", status: "pending" as const, dependsOn: [] },
      { id: "b", title: "B", description: "B", status: "pending" as const, dependsOn: ["a"] },
    ],
  };
  assert.match(validatePlanStepTransition(dependency, "b", "in_progress") ?? "", /dependency a/i);
});

test("artifact, decision, and assembly references must exist", () => {
  const state = {
    ...createAgentState(),
    artifacts: [{
      assetId: "asset-child",
      role: "candidate",
      parentAssetIds: ["asset-missing"],
      planStepId: "step-missing",
      approval: "unreviewed" as const,
    }],
    decisions: [{
      id: "decision-1",
      title: "Approve",
      prompt: "Approve it.",
      kind: "approval" as const,
      status: "pending" as const,
      blocking: true,
      relatedAssetIds: ["asset-missing"],
      options: [],
      createdAt: new Date().toISOString(),
    }],
    assembly: {
      status: "ready" as const,
      clips: [{ id: "clip-1", assetId: "asset-missing", startSeconds: 0, endSeconds: 1, order: 0 }],
    },
  };
  const errors = validateAgentState(state).join(" ");
  assert.match(errors, /unknown parent asset/i);
  assert.match(errors, /unknown plan step/i);
  assert.match(errors, /unknown asset/i);
});

test("assembly duration matches the confirmed final length", () => {
  const state = productionState();
  const clips = [
    { id: "one", assetId: "one", startSeconds: 0, endSeconds: 7.5, order: 0 },
    { id: "two", assetId: "two", startSeconds: 1, endSeconds: 8.5, order: 1 },
  ];
  assert.equal(assemblyDurationSeconds(clips), 15);
  assert.equal(validateAssemblyDuration(state, 15), null);
  assert.match(validateAssemblyDuration(state, 14) ?? "", /confirmed output length/i);
});

test("Desktop projection diff excludes Core-owned metadata and replaces array leaves", async () => {
  const base = await serializeAgentSessionForBridge(createSession("Patch fixture"));
  const next = structuredClone(base);
  next.updatedAt = "2030-01-01T00:00:00.000Z";
  next.agent.updatedAt = "2030-01-01T00:00:00.000Z";
  next.agent.revision += 9;
  next.agent.brief.goal = "Patched through Core";
  next.agent.requirements = [{ id: "duration", label: "Duration", value: "8 seconds", status: "confirmed", source: "user", blocking: false }];
  const patches = diffAgentBridgeSession(base, next);
  assert.deepEqual(patches.map((patch) => patch.path), ["/agent/brief/goal", "/agent/requirements"]);
  assert.ok(patches.every((patch) => !patch.path.includes("revision") && !patch.path.includes("updatedAt")));
});
