import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultDirectorPlan } from "./director/defaults.ts";
import { createSession, effectiveThreadDraft, emptyDraft } from "./studio.ts";
import { simplifyVideoDraft } from "./videoDraft.ts";

function legacyDraft() {
  const draft = emptyDraft();
  draft.directorPlan = createDefaultDirectorPlan({ sourceAssetId: "start" });
  draft.directorPlan.keyframes = [
    { id: "first", assetId: "start", role: "first", time: 0 },
    { id: "middle", assetId: "middle", role: "middle", time: 0.5 },
    { id: "last", assetId: "end", role: "last", time: 1 },
  ];
  return draft;
}

test("legacy frames become ordinary inputs without mutating archived planning data", () => {
  const draft = legacyDraft();
  draft.references = [{ assetId: "product", slot: 4, role: "reference", purpose: "product_identity" }];
  const original = structuredClone(draft);
  const next = simplifyVideoDraft(draft);
  assert.deepEqual(next.references, [
    original.references[0],
    { assetId: "start", slot: 5, role: "first_frame", purpose: "first_frame" },
    { assetId: "middle", slot: 6, role: "reference", purpose: "composition" },
    { assetId: "end", slot: 7, role: "last_frame", purpose: "last_frame" },
  ]);
  assert.equal(next.directorPlan?.enabled, false);
  assert.deepEqual(next.directorPlan, { ...original.directorPlan, enabled: false });
  assert.deepEqual(draft, original);
  assert.equal(simplifyVideoDraft(next), next);
});

test("existing input roles and slot numbers win over stale Director frames", () => {
  const draft = legacyDraft();
  draft.references = [
    { assetId: "replacement", slot: 2, role: "first_frame", purpose: "first_frame" },
    { assetId: "end", slot: 7, role: "reference", purpose: "style" },
  ];
  const next = simplifyVideoDraft(draft);
  assert.deepEqual(next.references[0], draft.references[0]);
  assert.deepEqual(next.references[1], { assetId: "end", slot: 7, role: "last_frame", purpose: "last_frame" });
  assert.equal(next.references.some((reference) => reference.assetId === "start"), false);
});

test("removing frames after retirement does not resurrect them", () => {
  const draft = simplifyVideoDraft(legacyDraft());
  draft.references = [];
  assert.deepEqual(simplifyVideoDraft(draft).references, []);
  assert.equal(simplifyVideoDraft(emptyDraft()).directorPlan, undefined);
});

test("an explicitly disabled legacy plan does not add any inputs", () => {
  const draft = legacyDraft();
  draft.directorPlan!.enabled = false;
  assert.equal(simplifyVideoDraft(draft), draft);
  assert.deepEqual(draft.references, []);
});

test("the same image can remain both the first and last frame with separate slots", () => {
  const draft = legacyDraft();
  draft.directorPlan!.keyframes = [
    { id: "first", assetId: "start", role: "first", time: 0 },
    { id: "last", assetId: "start", role: "last", time: 1 },
  ];
  assert.deepEqual(simplifyVideoDraft(draft).references, [
    { assetId: "start", slot: 1, role: "first_frame", purpose: "first_frame" },
    { assetId: "start", slot: 2, role: "last_frame", purpose: "last_frame" },
  ]);
});

test("opening or restoring video drafts keeps defaults and retires hidden planning controls", () => {
  const session = createSession("Video frames");
  session.generationDefaults.options.video = { duration: 5 };
  const thread = session.threads.video[0];
  thread.draft = legacyDraft();
  thread.optionOverrides = { resolution: "720p" };
  const draft = effectiveThreadDraft(session, thread);
  assert.deepEqual(draft.options, { duration: 5, resolution: "720p" });
  assert.equal(draft.directorPlan?.enabled, false);
  assert.equal(draft.references.length, 3);
  assert.equal(thread.draft.directorPlan?.enabled, true);
  assert.deepEqual(thread.draft.references, []);
});
