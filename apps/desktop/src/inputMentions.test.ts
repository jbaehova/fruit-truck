import assert from "node:assert/strict";
import test from "node:test";
import { findInputMentions, mentionedInputSlots, migrateLegacyInputMentions } from "./inputMentions.ts";

test("legacy mentions migrate only when their numbered input exists", () => {
  assert.equal(
    migrateLegacyInputMentions("Use #3, keep #4 plain, and preserve color #00ff00.", [2, 3]),
    "Use @3, keep #4 plain, and preserve color #00ff00.",
  );
  assert.equal(migrateLegacyInputMentions("mail#2.test (#2)", [2]), "mail#2.test (@2)");
});

test("input mentions include only attached @number tokens", () => {
  assert.deepEqual(mentionedInputSlots("Use @3, then @2 and @3 again. Leave @4 plain.", [2, 3]), [3, 2]);
  assert.deepEqual(findInputMentions("mail@2.test @2", [2]), [{ slot: 2, start: 12, end: 14 }]);
});

test("partial and unattached input mentions remain plain text", () => {
  assert.deepEqual(findInputMentions("@ @4 @02", [2, 3]), []);
});
