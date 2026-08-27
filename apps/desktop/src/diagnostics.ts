export const REDACTED_VALUE = "[REDACTED]";
export const MEDIA_BODY_OMITTED = "[MEDIA BODY OMITTED]";

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|cookie|credential|password|private[_-]?key|secret|session[_-]?token|refresh[_-]?token|token)/i;
const MEDIA_KEY_PATTERN = /(?:body|payload|b64|base64|bytes|blob|binary|content|data|media|file[_-]?data|image[_-]?data|video[_-]?data|audio[_-]?data)/i;
const PROMPT_KEY_PATTERN = /(?:prompt|instruction|negative[_-]?prompt|system[_-]?message|user[_-]?message|completion)/i;
const DATA_URL_PATTERN = /data:[^,\s]+,(?:[^\s]|\s(?!\s))/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const OPENROUTER_KEY_PATTERN = /\bsk-or-v1-[A-Za-z0-9_-]+/gi;
const LONG_BASE64_PATTERN = /^[A-Za-z0-9+/_-]{80,}={0,2}$/;

/** Replace credentials and media-bearing strings even when they are nested in an error message. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(DATA_URL_PATTERN, MEDIA_BODY_OMITTED)
    .replace(BEARER_PATTERN, REDACTED_VALUE)
    .replace(OPENROUTER_KEY_PATTERN, REDACTED_VALUE);
}

/**
 * Produce a JSON-safe, non-mutating redacted copy of diagnostic data. Prompt
 * text, credentials, base64/media bodies, and arbitrary payload fields are
 * never included in the returned value.
 */
export function redactDiagnostic<T>(value: T): T {
  return redactValue(value, undefined, new WeakSet<object>()) as T;
}

function redactValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) return REDACTED_VALUE;
  if (key && (MEDIA_KEY_PATTERN.test(key) || PROMPT_KEY_PATTERN.test(key))) {
    return key.toLowerCase().includes("prompt") || PROMPT_KEY_PATTERN.test(key)
      ? REDACTED_VALUE
      : MEDIA_BODY_OMITTED;
  }
  if (typeof value === "string") {
    const redacted = redactDiagnosticText(value);
    return LONG_BASE64_PATTERN.test(redacted.trim()) ? MEDIA_BODY_OMITTED : redacted;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, undefined, seen));
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = redactValue(entryValue, entryKey, seen);
  }
  return output;
}

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticEntry = {
  id: string;
  timestamp: string;
  level: DiagnosticLevel;
  event: string;
  details?: unknown;
};

export type DiagnosticLog = {
  append: (entry: Omit<DiagnosticEntry, "id" | "timestamp"> & Partial<Pick<DiagnosticEntry, "id" | "timestamp">>) => DiagnosticEntry;
  entries: () => DiagnosticEntry[];
  clear: () => void;
  byteSize: () => number;
};

export type DiagnosticLogOptions = {
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  idFactory?: () => string;
};

export type DiagnosticStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createDiagnosticId(): string {
  const cryptoObject = globalThis.crypto as Crypto & { randomUUID?: () => string } | undefined;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A bounded in-memory rotating log suitable for local support exports. */
export function createDiagnosticLog({
  maxEntries = 200,
  maxBytes = 256 * 1024,
  now = () => Date.now(),
  idFactory = createDiagnosticId,
}: DiagnosticLogOptions = {}): DiagnosticLog {
  const entries: DiagnosticEntry[] = [];
  const limitEntries = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 200;
  const limitBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.floor(maxBytes)) : 256 * 1024;
  const serializedSize = () => new TextEncoder().encode(JSON.stringify(entries)).byteLength;
  const trim = () => {
    while (entries.length > limitEntries || (entries.length > 1 && serializedSize() > limitBytes)) entries.shift();
    if (entries.length === 1 && serializedSize() > limitBytes) {
      const original = entries[0];
      let low = 0;
      let high = original.event.length;
      let best = "";
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = original.event.slice(0, middle);
        entries[0] = { ...original, event: candidate, details: "[TRUNCATED]" };
        if (serializedSize() <= limitBytes) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      entries[0] = { ...original, event: best, details: "[TRUNCATED]" };
    }
  };
  return {
    append(input) {
      const entry = redactDiagnostic<DiagnosticEntry>({
        id: input.id ?? idFactory(),
        timestamp: input.timestamp ?? new Date(now()).toISOString(),
        level: input.level,
        event: input.event,
        details: input.details,
      });
      entries.push(entry);
      trim();
      return entry;
    },
    entries: () => entries.map((entry) => structuredClone(entry)),
    clear: () => { entries.length = 0; },
    byteSize: serializedSize,
  };
}

export function createPersistentDiagnosticLog(
  storage: DiagnosticStorage | undefined = typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage,
  key = "fruit-truck.diagnostics.v1",
  options: DiagnosticLogOptions = {},
): DiagnosticLog {
  const log = createDiagnosticLog(options);
  if (storage) {
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? "[]") as DiagnosticEntry[];
      if (Array.isArray(parsed)) for (const entry of parsed) {
        if (entry && typeof entry.event === "string" && ["debug", "info", "warn", "error"].includes(entry.level)) log.append(entry);
      }
    } catch { /* A malformed diagnostic log is discarded, never fatal. */ }
  }
  const persist = () => {
    if (!storage) return;
    try { storage.setItem(key, JSON.stringify(log.entries())); } catch { /* Diagnostics must never block the app. */ }
  };
  return {
    append(entry) {
      const appended = log.append(entry);
      persist();
      return appended;
    },
    entries: log.entries,
    byteSize: log.byteSize,
    clear() {
      log.clear();
      try { storage?.removeItem(key); } catch { /* best effort */ }
    },
  };
}

let sharedDiagnosticLog: DiagnosticLog | undefined;

export function localDiagnosticLog(): DiagnosticLog {
  sharedDiagnosticLog ??= createPersistentDiagnosticLog();
  return sharedDiagnosticLog;
}

export type SupportBundleInput = {
  appVersion: string;
  platform: string;
  os?: string;
  diagnosticId?: string;
  generatedAt?: string;
  attemptStage?: string;
  attempts?: unknown;
  logs?: unknown;
  state?: unknown;
  context?: unknown;
};

export type SupportBundle = {
  formatVersion: 1;
  diagnosticId: string;
  generatedAt: string;
  app: {
    version: string;
    platform: string;
    os?: string;
  };
  attemptStage?: string;
  attempts?: unknown;
  logs?: unknown;
  state?: unknown;
  context?: unknown;
};

/** Build an exportable support bundle with only redacted, JSON-safe fields. */
export function buildSupportBundle(input: SupportBundleInput): SupportBundle {
  return redactDiagnostic<SupportBundle>({
    formatVersion: 1,
    diagnosticId: input.diagnosticId ?? createDiagnosticId(),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    app: {
      version: input.appVersion,
      platform: input.platform,
      os: input.os,
    },
    attemptStage: input.attemptStage,
    attempts: input.attempts,
    logs: input.logs,
    state: input.state,
    context: input.context,
  });
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  return JSON.stringify(redactDiagnostic(bundle), null, 2);
}

export function supportBundleFromLog(
  input: Omit<SupportBundleInput, "logs">,
  log: Pick<DiagnosticLog, "entries">,
): SupportBundle {
  return buildSupportBundle({ ...input, logs: log.entries() });
}
