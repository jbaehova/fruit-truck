export const UPDATE_CHECK_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

export function createRetryableCheck<T>(check: () => Promise<T>) {
  let current: Promise<T> | null = null;

  return () => {
    if (current === null) {
      const attempt = Promise.resolve().then(check);
      current = attempt;
      void attempt.catch(() => {
        if (current === attempt) current = null;
      });
    }
    return current;
  };
}
