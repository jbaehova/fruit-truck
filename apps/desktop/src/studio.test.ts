import assert from "node:assert/strict";
import test from "node:test";
import { createSession, saveStudioState, type StudioState } from "./studio.ts";

test("studio metadata rejects Base64 media and keeps managed paths", () => {
  const writes = new Map<string, string>();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => writes.get(key) ?? null,
      setItem: (key: string, value: string) => writes.set(key, value),
      removeItem: (key: string) => writes.delete(key),
    },
  });
  try {
    const session = createSession("Managed media");
    session.assets.push({
      id: "asset-managed",
      name: "result.png",
      kind: "image",
      mimeType: "image/png",
      origin: "generated",
      createdAt: new Date().toISOString(),
      localPath: "/Users/test/.oppa-gen/generated/result.png",
    });
    const state: StudioState = {
      schemaVersion: 1,
      activeSessionId: session.id,
      promptModel: "openai/gpt-5.6-luna",
      sessions: [session],
    };
    saveStudioState(state);
    const serialized = [...writes.values()][0];
    assert.match(serialized, /"localPath"/);
    assert.doesNotMatch(serialized, /;base64,/);

    session.assets[0] = {
      ...session.assets[0],
      localPath: undefined,
      externalUrl: "data:image/png;base64,AAAA",
    };
    assert.throws(() => saveStudioState(state), /data URLs cannot be written/);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
  }
});
