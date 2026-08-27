import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_BODY_OMITTED,
  buildSupportBundle,
  createDiagnosticLog,
  createPersistentDiagnosticLog,
  redactDiagnostic,
  serializeSupportBundle,
  supportBundleFromLog,
} from "./diagnostics.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("diagnostic redaction removes credentials, prompt text, and media bodies", () => {
  const source = {
    apiKey: "sk-or-v1-super-secret",
    authorization: "Bearer live-secret",
    prompt: "A private prompt that must not leave the app",
    request: {
      body: { prompt: "nested prompt", image: "data:image/png;base64,AAAA" },
      headers: { Authorization: "Bearer another-secret" },
    },
    imageData: "A".repeat(120),
    videoData: "short-media-body",
    safe: "attempt-123",
  };
  const redacted = redactDiagnostic(source);
  assert.equal(redacted.apiKey, "[REDACTED]");
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.prompt, "[REDACTED]");
  assert.equal(redacted.request.body, MEDIA_BODY_OMITTED);
  assert.equal(redacted.request.headers.Authorization, "[REDACTED]");
  assert.equal(redacted.imageData, MEDIA_BODY_OMITTED);
  assert.equal(redacted.videoData, MEDIA_BODY_OMITTED);
  assert.equal(redacted.safe, source.safe);
  assert.equal(source.request.body.prompt, "nested prompt");
});

test("diagnostic log rotates by entry count and never stores raw secrets", () => {
  let timestamp = 1_700_000_000_000;
  const log = createDiagnosticLog({
    maxEntries: 2,
    now: () => timestamp,
    idFactory: (() => {
      let id = 0;
      return () => `diag-${++id}`;
    })(),
  });
  log.append({ level: "info", event: "first", details: { apiKey: "secret" } });
  timestamp += 1_000;
  log.append({ level: "warn", event: "second" });
  timestamp += 1_000;
  log.append({ level: "error", event: "third", details: { prompt: "private" } });
  const entries = log.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, "second");
  assert.equal((entries[1].details as { prompt: string }).prompt, "[REDACTED]");
  assert.ok(!JSON.stringify(entries).includes("secret"));
});

test("diagnostic log enforces a byte budget for oversized entries", () => {
  const log = createDiagnosticLog({ maxEntries: 10, maxBytes: 180, idFactory: () => "diag-large" });
  log.append({ level: "error", event: "x".repeat(10_000), details: { prompt: "private" } });
  assert.ok(log.byteSize() <= 180);
  assert.equal(log.entries().length, 1);
});

test("persistent diagnostic log survives reload, stays redacted, and clears its backing store", () => {
  const storage = memoryStorage();
  const first = createPersistentDiagnosticLog(storage, "diagnostics", { idFactory: () => "persisted" });
  first.append({ level: "error", event: "request_failed", details: { prompt: "private", apiKey: "secret" } });

  const reloaded = createPersistentDiagnosticLog(storage, "diagnostics");
  assert.equal(reloaded.entries().length, 1);
  assert.equal((reloaded.entries()[0].details as { prompt: string }).prompt, "[REDACTED]");
  assert.ok(!JSON.stringify(reloaded.entries()).includes("secret"));

  reloaded.clear();
  assert.equal(storage.getItem("diagnostics"), null);
});

test("support bundles carry diagnostic context while excluding sensitive payloads", () => {
  const log = createDiagnosticLog({ idFactory: () => "diag-fixed" });
  log.append({ level: "error", event: "generation_failed", details: { token: "secret", stage: "polling" } });
  const bundle = supportBundleFromLog({
    appVersion: "0.6.4",
    platform: "darwin-arm64",
    os: "macOS",
    diagnosticId: "diag-fixed",
    attemptStage: "polling",
    attempts: [{ id: "attempt-1", status: "uncertain", prompt: "private", request: { data: "AAAA" } }],
  }, log);
  const serialized = serializeSupportBundle(bundle);
  assert.ok(serialized.includes("diag-fixed"));
  assert.ok(serialized.includes("darwin-arm64"));
  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(serialized.includes(MEDIA_BODY_OMITTED));
  assert.ok(!serialized.includes("private"));
  assert.ok(!serialized.includes("secret"));

  const explicit = buildSupportBundle({ appVersion: "0.6.4", platform: "test", context: { authorization: "Bearer secret" } });
  assert.equal((explicit.context as { authorization: string }).authorization, "[REDACTED]");
});
