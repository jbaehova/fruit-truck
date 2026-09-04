import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAndBindDirectorSubject,
  synchronizeDirectorFrameReferences,
  synchronizeDirectorPlanFrames,
} from "./bindings.ts";
import { createDefaultDirectorPlan, createDefaultDirectorShot } from "./defaults.ts";
import type { DirectorMotion, DirectorSubject } from "./types.ts";

test("portable subject groups bind one at a time without losing identity", () => {
  const plan = createDefaultDirectorPlan({
    sourceAssetId: "new-frame",
    now: "2026-09-04T00:00:00.000Z",
    createId: (prefix) => `${prefix}-fixture`,
  });
  const motions: DirectorMotion[] = [
    {
      id: "motion-a",
      targetType: "subject",
      targetId: "portable-a",
      kind: "translate",
      intensity: 0.5,
      start: 0,
      end: 1,
      easing: "linear",
      order: 1,
    },
    {
      id: "motion-b",
      targetType: "subject",
      targetId: "portable-b",
      kind: "depth_in",
      intensity: 0.7,
      start: 0,
      end: 1,
      easing: "ease_in_out",
      order: 2,
    },
  ];
  plan.motions = motions;
  plan.cameraRig.focusSubjectId = "portable-b";
  const first: DirectorSubject = {
    id: "new-a",
    label: "New A",
    sourceAssetId: "new-frame",
    region: { type: "box", x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  };
  const second: DirectorSubject = {
    id: "new-b",
    label: "New B",
    sourceAssetId: "new-frame",
    region: { type: "polygon", points: [{ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 }, { x: 0.7, y: 0.8 }] },
  };

  const afterFirst = appendAndBindDirectorSubject(plan, first);
  assert.equal(afterFirst.motions[0].targetId, "new-a");
  assert.equal(afterFirst.motions[1].targetId, "portable-b");
  assert.equal(afterFirst.cameraRig.focusSubjectId, "portable-b");

  const afterSecond = appendAndBindDirectorSubject(afterFirst, second);
  assert.equal(afterSecond.motions[1].targetId, "new-b");
  assert.equal(afterSecond.cameraRig.focusSubjectId, "new-b");
});

test("Director frame relinking updates Input Tray roles in both directions", () => {
  const plan = createDefaultDirectorPlan({ sourceAssetId: "first-b", now: "2026-09-04T00:00:00.000Z" });
  const shot = createDefaultDirectorShot();
  plan.keyframes = [
    { id: "first", assetId: "first-b", role: "first", time: 0 },
    { id: "last", assetId: "last-b", role: "last", time: 1 },
  ];
  plan.shots = [{ ...shot, keyframeIds: ["first", "last"] }];

  const synchronized = synchronizeDirectorFrameReferences(plan, [
    { assetId: "first-a", slot: 1, role: "first_frame", purpose: "first_frame" },
    { assetId: "last-a", slot: 2, role: "last_frame", purpose: "last_frame" },
    { assetId: "first-b", slot: 3, role: "reference", purpose: "composition" },
  ]);

  assert.deepEqual(synchronized, [
    { assetId: "first-a", slot: 1, role: "reference", purpose: "subject_identity" },
    { assetId: "last-a", slot: 2, role: "reference", purpose: "subject_identity" },
    { assetId: "first-b", slot: 3, role: "first_frame", purpose: "first_frame" },
    { assetId: "last-b", slot: 4, role: "last_frame", purpose: "last_frame" },
  ]);
});

test("Director frame deletion demotes stale Input Tray roles without dropping assets", () => {
  const plan = createDefaultDirectorPlan({ sourceAssetId: "source", now: "2026-09-04T00:00:00.000Z" });
  const synchronized = synchronizeDirectorFrameReferences(plan, [
    { assetId: "first-a", slot: 1, role: "first_frame", purpose: "first_frame" },
    { assetId: "last-a", slot: 2, role: "last_frame", purpose: "last_frame" },
  ]);

  assert.deepEqual(synchronized.map(({ assetId, role, purpose }) => ({ assetId, role, purpose })), [
    { assetId: "first-a", role: "reference", purpose: "subject_identity" },
    { assetId: "last-a", role: "reference", purpose: "subject_identity" },
  ]);
});

test("Input Tray frame changes update only the matching plan anchors", () => {
  const plan = createDefaultDirectorPlan({ sourceAssetId: "first-a", now: "2026-09-04T00:00:00.000Z" });
  plan.subjects = [{
    id: "subject",
    label: "Subject",
    sourceAssetId: "first-a",
    region: { type: "box", x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  }];
  plan.keyframes = [{ id: "first", assetId: "first-a", role: "first", time: 0 }];
  plan.shots = [{ ...createDefaultDirectorShot(), keyframeIds: ["first"] }];

  const synchronized = synchronizeDirectorPlanFrames(
    plan,
    [{ assetId: "first-a", slot: 1, role: "first_frame", purpose: "first_frame" }],
    [
      { assetId: "first-b", slot: 1, role: "first_frame", purpose: "first_frame" },
      { assetId: "last-b", slot: 2, role: "last_frame", purpose: "last_frame" },
    ],
    (prefix) => `${prefix}-new`,
  );

  assert.equal(synchronized.sourceAssetId, "first-b");
  assert.equal(synchronized.subjects[0]!.sourceAssetId, "first-b");
  assert.deepEqual(synchronized.keyframes.map(({ id, assetId, role }) => ({ id, assetId, role })), [
    { id: "first", assetId: "first-b", role: "first" },
    { id: "keyframe-new", assetId: "last-b", role: "last" },
  ]);
  assert.deepEqual(synchronized.shots[0]!.keyframeIds, ["first", "keyframe-new"]);
});
