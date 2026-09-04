import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultDirectorPlan } from "./defaults.ts";
import {
  createDirectorHistory,
  pushDirectorHistory,
  redoDirectorHistory,
  undoDirectorHistory,
} from "./history.ts";

function plan(enabled: boolean, updatedAt: string) {
  return {
    ...createDefaultDirectorPlan({
      now: updatedAt,
      createId: (prefix) => `${prefix}-fixed`,
    }),
    enabled,
  };
}

test("Director history restores edits through undo and redo", () => {
  const original = plan(true, "2026-09-04T00:00:00.000Z");
  const edited = { ...original, enabled: false, updatedAt: "2026-09-04T00:01:00.000Z" };
  const committed = pushDirectorHistory(createDirectorHistory(original), edited);

  const undone = undoDirectorHistory(committed);
  assert.equal(undone.present.enabled, true);
  assert.equal(undone.future.length, 1);

  const redone = redoDirectorHistory(undone);
  assert.equal(redone.present.enabled, false);
  assert.equal(redone.past.length, 1);
});

test("Director history clears redo on a new branch and bounds retained edits", () => {
  const original = plan(true, "2026-09-04T00:00:00.000Z");
  const first = { ...original, enabled: false };
  const undone = undoDirectorHistory(pushDirectorHistory(createDirectorHistory(original), first));
  const branched = pushDirectorHistory(undone, { ...original, canvas: { sourceWidth: 16, sourceHeight: 9 } }, 1);

  assert.equal(branched.future.length, 0);
  assert.equal(branched.past.length, 1);
  assert.notEqual(branched.past[0], original);
});
