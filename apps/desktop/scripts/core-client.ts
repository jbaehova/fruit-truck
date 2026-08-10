import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentTrace, recordSpan } from "./telemetry.ts";

export type CoreMode = "off" | "shadow" | "canonical";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
let requestSequence = 0;
const startPromises = new Map<string, Promise<void>>();

export function configuredCoreMode(): CoreMode {
  const index = process.argv.findIndex((value) => value === "--core-mode");
  const inline = process.argv.find((value) => value.startsWith("--core-mode="))?.slice("--core-mode=".length);
  const value = inline ?? (index >= 0 ? process.argv[index + 1] : process.env.FRUIT_TRUCK_CORE_MODE);
  return value === "off" || value === "shadow" ? value : "canonical";
}

function socketPath(dataDirectory: string) {
  return join(dataDirectory, "run", "core.sock");
}

function coreBinaryCandidates(dataDirectory: string) {
  const configured = process.env.FRUIT_TRUCK_CORE_BIN;
  return [
    configured ? resolve(configured) : "",
    join(dataDirectory, "bin", "fruit-truckd"),
    resolve(scriptDirectory, "../src-tauri/target/debug/fruit-truckd"),
    resolve(scriptDirectory, "../src-tauri/target/release/fruit-truckd"),
    "/Applications/Fruit Truck.app/Contents/MacOS/fruit-truckd",
  ].filter(Boolean);
}

async function canConnect(dataDirectory: string) {
  try {
    const handshake = await rawRequest(dataDirectory, "core.handshake", {}, 600) as {
      protocolVersion?: number;
      storeSchemaVersion?: number;
    };
    return handshake.protocolVersion === 2 && handshake.storeSchemaVersion === 1;
  } catch {
    return false;
  }
}

async function startCore(dataDirectory: string) {
  if (await canConnect(dataDirectory)) return;
  const binary = coreBinaryCandidates(dataDirectory).find((candidate) => existsSync(candidate));
  if (!binary) {
    throw new Error("Fruit Truck Core is unavailable. Install a build containing fruit-truckd or set FRUIT_TRUCK_CORE_BIN.");
  }
  const child = spawn(binary, ["--home", dataDirectory], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FRUIT_TRUCK_HOME: dataDirectory },
  });
  child.unref();
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (await canConnect(dataDirectory)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Fruit Truck Core did not become ready within 4 seconds.");
}

export async function ensureCore(dataDirectory: string) {
  let startPromise = startPromises.get(dataDirectory);
  if (!startPromise) {
    startPromise = startCore(dataDirectory).catch((error) => {
      startPromises.delete(dataDirectory);
      throw error;
    });
    startPromises.set(dataDirectory, startPromise);
  }
  return startPromise;
}

export async function coreRequest(
  dataDirectory: string,
  method: string,
  params: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  const started = process.hrtime.bigint();
  const requestBytes = Buffer.byteLength(JSON.stringify(params) ?? "");
  let responseBytes = 0;
  let succeeded = false;
  try {
    await ensureCore(dataDirectory);
    let result: unknown;
    try {
      result = await rawRequest(dataDirectory, method, params, timeoutMs);
    } catch (error) {
      startPromises.delete(dataDirectory);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      await ensureCore(dataDirectory);
      result = await rawRequest(dataDirectory, method, params, timeoutMs);
    }
    responseBytes = Buffer.byteLength(JSON.stringify(result) ?? "");
    succeeded = true;
    return result;
  } finally {
    recordSpan(
      dataDirectory,
      "core.ipc",
      Number((process.hrtime.bigint() - started) / 1_000n),
      {
        requestBytes,
        responseBytes,
        succeeded,
        eventWait: method === "event.wait",
        mutation: method === "session.commit" || method === "session.commit_snapshot",
      },
    );
  }
}

async function rawRequest(
  dataDirectory: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const id = ++requestSequence;
  const trace = currentTrace();
  const tracedParams = params && typeof params === "object" && !Array.isArray(params)
    ? { ...(params as Record<string, unknown>), ...(trace ? { _trace: trace } : {}) }
    : params;
  const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params: tracedParams })}\n`;
  return new Promise((resolveResult, reject) => {
    const socket = connect(socketPath(dataDirectory));
    let response = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolveResult(value);
    };
    const timer = setTimeout(() => finish(new Error(`Fruit Truck Core request timed out: ${method}`)), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 50 * 1024 * 1024) {
        finish(new Error("Fruit Truck Core response exceeds the 50 MB safety limit."));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(response.slice(0, newline)) as {
          id?: number;
          result?: unknown;
          error?: { code?: string; message?: string };
        };
        if (message.id !== id) throw new Error("Fruit Truck Core returned a mismatched response ID.");
        if (message.error) {
          const error = new Error(`${message.error.code ?? "CORE_ERROR"}: ${message.error.message ?? "Core request failed."}`);
          Object.assign(error, { code: message.error.code });
          finish(error);
        } else {
          finish(undefined, message.result);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled) finish(new Error("Fruit Truck Core closed the connection before replying."));
    });
  });
}
