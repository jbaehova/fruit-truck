import assert from "node:assert/strict";
import test from "node:test";
import { localizedAttemptAction, localizedAttemptMessage } from "./attemptPresentation.ts";
import type { MessageKey } from "./i18n.tsx";

const ko = (key: MessageKey) => ({
  attemptEnhancementInterruptedMessage: "향상 중단",
  attemptSubmissionUncertainMessage: "접수 불확실",
  recoveryActionRetrySnapshot: "스냅샷 복원",
  recoveryActionRequeryOrConfirmRetry: "원격 결과 확인",
  recoveryActionRequeryRemote: "원격 상태 확인",
} as Partial<Record<MessageKey, string>>)[key] ?? key;

test("persisted recovery codes render localized messages and actions", () => {
  assert.equal(localizedAttemptMessage({ error: "raw English", errorCode: "enhancement_interrupted" }, ko), "향상 중단");
  assert.equal(localizedAttemptMessage({ error: "raw English", errorCode: "submission_uncertain" }, ko), "접수 불확실");
  assert.equal(localizedAttemptAction("retry_snapshot", ko), "스냅샷 복원");
  assert.equal(localizedAttemptAction("requery_remote", ko), "원격 상태 확인");
  assert.equal(localizedAttemptAction("Provider-specific guidance", ko), "Provider-specific guidance");
});
