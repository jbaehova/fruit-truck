import type { MessageKey } from "./i18n.tsx";
import type { GenerationAttempt } from "./studio.ts";

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const ERROR_MESSAGE_KEYS: Partial<Record<string, MessageKey>> = {
  enhancement_interrupted: "attemptEnhancementInterruptedMessage",
  submission_uncertain: "attemptSubmissionUncertainMessage",
};

const ACTION_KEYS: Partial<Record<string, MessageKey>> = {
  retry_snapshot: "recoveryActionRetrySnapshot",
  requery_remote_or_retry_with_confirmation: "recoveryActionRequeryOrConfirmRetry",
  requery_remote: "recoveryActionRequeryRemote",
  avoid_duplicate_retry: "recoveryActionAvoidDuplicateRetry",
};

export function localizedAttemptMessage(
  attempt: Pick<GenerationAttempt, "error" | "errorCode">,
  t: Translate,
): string | undefined {
  const key = attempt.errorCode ? ERROR_MESSAGE_KEYS[attempt.errorCode] : undefined;
  return key ? t(key) : attempt.error;
}

export function localizedAttemptAction(action: string | undefined, t: Translate): string | undefined {
  if (!action) return undefined;
  const key = ACTION_KEYS[action];
  return key ? t(key) : action;
}
