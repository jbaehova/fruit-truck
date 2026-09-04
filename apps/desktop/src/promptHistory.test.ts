import assert from "node:assert/strict";
import test from "node:test";
import {
  beginPromptEnhancement,
  canEnhancePrompt,
  completePromptEnhancement,
  currentPromptEnhancementArtifact,
  editPromptHistory,
  failPromptEnhancement,
  initialPromptHistory,
  promptHistoryCanRedo,
  redoPromptEnhancement,
  trimPromptHistory,
  undoPromptEnhancement,
} from "./promptHistory.ts";
import type { PromptEnhancementArtifact } from "./prompting/index.ts";

const artifact = (prompt: string): PromptEnhancementArtifact => ({
  schemaVersion: 1,
  prompt,
  negativePrompt: "blur",
  plannerModel: "google/gemini-3.8-flash",
  signature: "sig",
  createdAt: "2026-09-04T00:00:01.000Z",
  actualCostUsd: 0.01,
  profileId: "image-default",
  profileVersion: "1",
  workflow: "text_to_image",
  coveredSlots: [],
  warnings: [],
  target: { id: "test/image", name: "Test image", options: {}, providerJson: "" },
  profileSources: [],
  repairAttempts: 0,
  plan: {
    version: 1,
    mode: "image",
    workflow: "text_to_image",
    language: "en",
    deliverable: "image",
    intent: "test",
    scene: [], subjects: [], action: [], composition: [], camera: [], lighting: [], color: [], style: [], materials: [], exactText: [], temporalBeats: [], subjectMotion: [], cameraMotion: [], audio: [], editChanges: [], preserve: [], ambiguities: [], constraints: [], references: [],
  },
});

test("enhancement locks on success, unlocks on edit and failure", () => {
  const initial = initialPromptHistory("fruit", { id: "initial", createdAt: "2026-09-04T00:00:00.000Z" });
  assert.equal(canEnhancePrompt({ prompt: "fruit", history: initial, enhancing: false, plannerAvailable: true, generationModelAvailable: true }), true);
  const started = beginPromptEnhancement(initial, "fruit", {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    id: "before-1",
  });
  const completed = completePromptEnhancement(started, "fruit", artifact("ripe fruit"), {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    autoApply: true,
    outputHash: "output-context-signature",
    id: "result-1",
  });
  assert.equal(completed.prompt, "ripe fruit");
  assert.equal(completed.history.enhancementLocked, true);
  assert.deepEqual(
    completed.history.entries.filter((entry) => entry.enhancementAttemptId === "attempt-1").map((entry) => entry.actualCostUsd),
    [0.01, 0.01],
  );
  assert.equal(editPromptHistory(completed.history, completed.prompt).enhancementLocked, false);
  assert.equal(failPromptEnhancement(started, "attempt-1").enhancementLocked, false);
});

test("a successful result keeps input provenance while the output prompt owns the context", () => {
  const initial = initialPromptHistory("fruit", { id: "initial" });
  const started = beginPromptEnhancement(initial, "fruit", {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    inputHash: "input-context-signature",
    id: "before-1",
  });
  const completed = completePromptEnhancement(started, "fruit", {
    ...artifact("ripe fruit"),
    signature: "input-context-signature",
  }, {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    autoApply: true,
    outputHash: "output-context-signature",
    id: "result-1",
  });

  const result = completed.history.entries[completed.history.cursor];
  assert.equal(result.inputHash, "input-context-signature");
  assert.equal(currentPromptEnhancementArtifact(
    completed.prompt,
    completed.history,
    "output-context-signature",
  )?.negativePrompt, "blur");
  assert.equal(currentPromptEnhancementArtifact(
    completed.prompt,
    completed.history,
    "changed-output-context-signature",
  ), undefined);
  assert.equal(currentPromptEnhancementArtifact(
    completed.prompt,
    editPromptHistory(completed.history, completed.prompt),
    "output-context-signature",
  ), undefined);
});

test("a failed enhancement removes its transient checkpoints and restores the original cursor", () => {
  const original = initialPromptHistory("", { id: "initial", createdAt: "2026-09-04T00:00:00.000Z" });
  const started = beginPromptEnhancement(original, "fruit", {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    inputHash: "input-context-signature",
    id: "before-1",
    createdAt: "2026-09-04T00:00:01.000Z",
  });
  assert.equal(started.entries.length, 3);

  const failed = failPromptEnhancement(started, "attempt-1");
  assert.deepEqual(failed, original);
  assert.equal(failed.entries.some((entry) => entry.enhancementAttemptId === "attempt-1"), false);
});

test("undo and redo navigate enhancement checkpoints without a request", () => {
  const initial = initialPromptHistory("fruit", { id: "initial" });
  const started = beginPromptEnhancement(initial, "fruit", {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    id: "before-1",
  });
  const completed = completePromptEnhancement(started, "fruit", artifact("ripe fruit"), {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    autoApply: true,
    id: "result-1",
  });
  const undone = undoPromptEnhancement(completed.history, completed.prompt);
  assert.ok(undone);
  assert.equal(undone.prompt, "fruit");
  assert.equal(promptHistoryCanRedo(undone.history, undone.prompt), true);
  const redone = redoPromptEnhancement(undone.history);
  assert.ok(redone);
  assert.equal(redone.prompt, "ripe fruit");
});

test("a stale response preserves the edited prompt and exposes the result through redo", () => {
  const initial = initialPromptHistory("fruit", { id: "initial" });
  const started = beginPromptEnhancement(initial, "fruit", {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    id: "before-1",
  });
  const edited = editPromptHistory(started, "fruit");
  const completed = completePromptEnhancement(edited, "fruit with leaves", artifact("ripe fruit with leaves"), {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    autoApply: false,
    id: "result-1",
  });
  assert.equal(completed.prompt, "fruit with leaves");
  assert.equal(completed.history.enhancementLocked, false);
  const redone = redoPromptEnhancement(completed.history);
  assert.ok(redone);
  assert.equal(redone.prompt, "ripe fruit with leaves");
});

test("editing after undo removes the redo branch", () => {
  const initial = initialPromptHistory("fruit", { id: "initial" });
  const started = beginPromptEnhancement(initial, "fruit", {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    id: "before-1",
  });
  const completed = completePromptEnhancement(started, "fruit", artifact("ripe fruit"), {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    autoApply: true,
    id: "result-1",
  });
  const undone = undoPromptEnhancement(completed.history, completed.prompt);
  assert.ok(undone);
  const edited = editPromptHistory(undone.history, undone.prompt);
  assert.equal(edited.entries.some((entry) => entry.id === "result-1"), false);
});

test("a new enhancement after undo keeps distinct attempt checkpoints", () => {
  const initial = initialPromptHistory("fruit", { id: "initial" });
  const firstStarted = beginPromptEnhancement(initial, "fruit", {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    id: "before-1",
  });
  const firstCompleted = completePromptEnhancement(firstStarted, "fruit", artifact("ripe fruit"), {
    attemptId: "attempt-1",
    plannerModel: "google/gemini-3.8-flash",
    autoApply: true,
    id: "result-1",
  });
  const undone = undoPromptEnhancement(firstCompleted.history, firstCompleted.prompt);
  assert.ok(undone);
  const edited = editPromptHistory(undone.history, undone.prompt);
  const secondStarted = beginPromptEnhancement(edited, undone.prompt, {
    attemptId: "attempt-2",
    plannerModel: "google/gemini-3.8-flash",
    id: "before-2",
  });

  assert.equal(secondStarted.entries.some((entry) => entry.id === "result-1"), false);
  assert.deepEqual(
    secondStarted.entries
      .filter((entry) => entry.kind === "before_enhancement")
      .map((entry) => [entry.id, entry.enhancementAttemptId]),
    [["before-1", "attempt-1"], ["before-2", "attempt-2"]],
  );
});

test("history trimming keeps the selected checkpoint and attempt pairs", () => {
  const entries = Array.from({ length: 26 }, (_, attempt) => ([
    { id: `before-${attempt}`, text: `before ${attempt}`, kind: "before_enhancement" as const, createdAt: "2026-09-04T00:00:00.000Z", enhancementAttemptId: `attempt-${attempt}` },
    { id: `result-${attempt}`, text: `result ${attempt}`, kind: "enhancement_result" as const, createdAt: "2026-09-04T00:00:01.000Z", enhancementAttemptId: `attempt-${attempt}` },
  ])).flat();
  const trimmed = trimPromptHistory({ schemaVersion: 1, entries, cursor: 51, enhancementLocked: true, editRevision: 0 });
  assert.equal(trimmed.entries.length, 50);
  assert.equal(trimmed.entries.some((entry) => entry.enhancementAttemptId === "attempt-0"), false);
  assert.equal(trimmed.entries.filter((entry) => entry.enhancementAttemptId === "attempt-25").length, 2);
  assert.equal(trimmed.entries[trimmed.cursor].id, "result-25");
});
