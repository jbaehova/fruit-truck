export function normalizeRangeValue(raw: string, min?: number, max?: number): number | undefined {
  if (!raw.trim()) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
}
