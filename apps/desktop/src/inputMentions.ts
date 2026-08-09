export type InputMention = {
  slot: number;
  start: number;
  end: number;
};

const INPUT_MENTION_PATTERN = /(^|[^\p{L}\p{N}_])@(\d+)/gu;
const LEGACY_INPUT_MENTION_PATTERN = /(^|[^\p{L}\p{N}_])#(\d+)/gu;

export function migrateLegacyInputMentions(value: string, validSlots: Iterable<number>): string {
  const available = new Set(validSlots);
  return value.replace(LEGACY_INPUT_MENTION_PATTERN, (match, prefix: string, digits: string) => {
    if (!/^[1-9]\d*$/.test(digits) || !available.has(Number(digits))) return match;
    return `${prefix}@${digits}`;
  });
}

export function findInputMentions(value: string, validSlots: Iterable<number>): InputMention[] {
  const available = new Set(validSlots);
  return [...value.matchAll(INPUT_MENTION_PATTERN)].flatMap((match) => {
    if (!/^[1-9]\d*$/.test(match[2])) return [];
    const slot = Number(match[2]);
    if (!available.has(slot)) return [];
    const token = `@${match[2]}`;
    const start = (match.index ?? 0) + match[0].length - token.length;
    return [{ slot, start, end: start + token.length }];
  });
}

export function mentionedInputSlots(value: string, validSlots: Iterable<number>): number[] {
  return [...new Set(findInputMentions(value, validSlots).map((mention) => mention.slot))];
}
