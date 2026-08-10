import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

type TraceContext = { traceId: string; commandId: string };
type SpanFields = Record<string, number | boolean | undefined>;

const traces = new AsyncLocalStorage<TraceContext>();
const MAX_TELEMETRY_BYTES = 5 * 1024 * 1024;
let writeChain = Promise.resolve();
let localSalt: Promise<string> | undefined;

export function telemetryEnabled() {
  return process.env.FRUIT_TRUCK_TELEMETRY !== "0";
}

export function currentTrace() {
  return traces.getStore();
}

export function withTrace<T>(action: () => Promise<T>) {
  return traces.run({ traceId: randomUUID(), commandId: randomUUID() }, action);
}

export async function span<T>(
  dataDirectory: string,
  name: string,
  action: () => Promise<T>,
  fields: SpanFields = {},
): Promise<T> {
  if (!telemetryEnabled()) return action();
  const started = process.hrtime.bigint();
  try {
    return await action();
  } finally {
    const durationUs = Number((process.hrtime.bigint() - started) / 1_000n);
    recordSpan(dataDirectory, name, durationUs, fields);
  }
}

export function recordSpan(
  dataDirectory: string,
  name: string,
  durationUs: number,
  fields: SpanFields = {},
) {
  if (!telemetryEnabled()) return;
  const context = currentTrace();
  const safeFields = Object.fromEntries(Object.entries(fields).filter(([, value]) =>
    typeof value === "number" && Number.isFinite(value) || typeof value === "boolean"
  ));
  const line = `${JSON.stringify({
    schemaVersion: 1,
    traceId: context?.traceId ?? randomUUID(),
    commandId: context?.commandId,
    name,
    durationUs,
    fields: safeFields,
    createdAtMs: Date.now(),
  })}\n`;
  writeChain = writeChain.then(async () => {
    const directory = join(dataDirectory, "telemetry");
    const path = join(directory, "mcp-spans.jsonl");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const size = await stat(path).then((metadata) => metadata.size).catch(() => 0);
    if (size + Buffer.byteLength(line) > MAX_TELEMETRY_BYTES) {
      await rename(path, join(directory, "mcp-spans.previous.jsonl")).catch(() => undefined);
    }
    await appendFile(path, line, { mode: 0o600 });
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error("Fruit Truck telemetry write failed:", error instanceof Error ? error.message : String(error));
  });
}

export async function localIdHash(dataDirectory: string, id: string) {
  if (!localSalt) {
    const path = join(dataDirectory, "telemetry-salt");
    localSalt = readFile(path, "utf8").catch(async () => {
      const salt = randomUUID();
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path, salt, { mode: 0o600 });
      return salt;
    });
  }
  const salt = await localSalt;
  return createHash("sha256").update(salt).update("\0").update(id).digest("hex").slice(0, 16);
}
