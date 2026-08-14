import assert from "node:assert/strict";
import test from "node:test";
import {
  activeGenerationAttempt,
  applyDefaultEnhancePrompt,
  beginGeneratedImageEdit,
  createSession,
  createSiblingGenerationThread,
  effectiveThreadDraft,
  effectiveThreadModelId,
  importFileAsset,
  loadStudioState,
  mediaMimeFromSource,
  mediaNameForMime,
  nextAvailableSessionName,
  recordSessionCost,
  requestedImageDimensions,
  saveStudioState,
  type StudioState,
} from "./studio.ts";

function withLocalStorage(run: (writes: Map<string, string>) => void) {
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
    run(writes);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
  }
}

test("pre-v6 metadata resets to one empty v6 session without touching media storage", () => {
  withLocalStorage((writes) => {
    writes.set("unrelated-indexeddb-sentinel", "preserved");
    writes.set("fruit-truck.studio.v1", JSON.stringify({
      schemaVersion: 5,
      activeSessionId: "legacy-session",
      promptModel: "openai/gpt-5.6-luna",
      sessions: [{ id: "legacy-session", assets: [{ localPath: "/managed/keep.png" }] }],
    }));

    const state = loadStudioState();
    assert.equal(state.schemaVersion, 6);
    assert.equal(state.defaultEnhancePrompt, true);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].assets.length, 0);
    assert.equal(state.sessions[0].threads.image.length, 1);
    assert.equal(state.sessions[0].threads.video.length, 1);
    assert.equal(writes.get("unrelated-indexeddb-sentinel"), "preserved");
  });
});

test("prompt enhancement default applies to every thread and future work", () => {
  const first = createSession("First");
  first.threads.image.push(createSiblingGenerationThread(first.threads.image[0], 2));
  const second = createSession("Second");
  const state: StudioState = {
    schemaVersion: 6,
    activeSessionId: first.id,
    promptModel: "openai/gpt-5.6-luna",
    defaultEnhancePrompt: true,
    sessions: [first, second],
  };

  const disabled = applyDefaultEnhancePrompt(state, false);
  assert.equal(disabled.defaultEnhancePrompt, false);
  for (const session of disabled.sessions) {
    for (const thread of [...session.threads.image, ...session.threads.video]) {
      assert.equal(thread.draft.enhancePrompt, false);
    }
  }
  assert.equal(createSession("Future", disabled.defaultEnhancePrompt).threads.image[0].draft.enhancePrompt, false);
  assert.equal(createSiblingGenerationThread(first.threads.image[0], 3, disabled.defaultEnhancePrompt).draft.enhancePrompt, false);
});

test("session cost ledger records generation and enhancement once per id", () => {
  const session = createSession("Costs");
  const generation = recordSessionCost(session, {
    id: "generation:one",
    category: "generation",
    actualCostUsd: 0.25,
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  const duplicate = recordSessionCost(generation, {
    id: "generation:one",
    category: "generation",
    actualCostUsd: 0.25,
    recordedAt: "2026-01-01T00:00:01.000Z",
  });
  const enhanced = recordSessionCost(duplicate, {
    id: "prompt-enhancement:one",
    category: "prompt_enhancement",
    actualCostUsd: 0.01,
    recordedAt: "2026-01-01T00:00:02.000Z",
  });
  const corrected = recordSessionCost(enhanced, {
    id: "generation:one",
    category: "generation",
    actualCostUsd: 0.27,
    recordedAt: "2026-01-01T00:00:03.000Z",
  });
  assert.equal(enhanced.costLedger.length, 2);
  assert.equal(enhanced.costLedger.reduce((sum, entry) => sum + entry.actualCostUsd, 0), 0.26);
  assert.equal(corrected.costLedger.length, 2);
  assert.equal(corrected.costLedger.find((entry) => entry.id === "generation:one")?.actualCostUsd, 0.27);
  assert.equal(corrected.costLedger.reduce((sum, entry) => sum + entry.actualCostUsd, 0), 0.28);
});

test("current v6 metadata preserves its global enhancement preference", () => {
  withLocalStorage((writes) => {
    const session = createSession("Current", false);
    const state: StudioState = {
      schemaVersion: 6,
      activeSessionId: session.id,
      promptModel: "openai/gpt-5.6-luna",
      defaultEnhancePrompt: false,
      sessions: [session],
    };
    saveStudioState(state);
    assert.equal(loadStudioState().defaultEnhancePrompt, false);
    assert.equal(loadStudioState().sessions[0].threads.image[0].draft.enhancePrompt, false);
    assert.match(writes.get("fruit-truck.studio.v1") ?? "", /defaultEnhancePrompt/);
  });
});

test("thread defaults and active attempt helpers remain functional", () => {
  const session = createSession("Workspace");
  const thread = session.threads.image[0];
  session.generationDefaults.modelIds.image = "image/default";
  session.generationDefaults.options.image = { quality: "high" };
  assert.equal(effectiveThreadModelId(session, thread), "image/default");
  assert.deepEqual(effectiveThreadDraft(session, thread).options, { quality: "high" });
  const now = new Date().toISOString();
  thread.attempts.push({
    id: "attempt-active",
    status: "in_progress",
    draftRevision: 0,
    createdAt: now,
    updatedAt: now,
    inputAssetIds: [],
    assetIds: [],
  });
  assert.equal(activeGenerationAttempt(thread)?.id, "attempt-active");
});

test("generated-result editing starts with only that image as input one", () => {
  const session = createSession("Edit");
  const draft = session.threads.image[0].draft;
  draft.references = [{ assetId: "old", role: "reference", slot: 1 }];
  draft.maskInstructions = "old mask";
  const edit = beginGeneratedImageEdit(draft, "generated-result");
  assert.deepEqual(edit.references, [{ assetId: "generated-result", role: "reference", slot: 1 }]);
  assert.equal(edit.imageEditTarget, "@1");
  assert.equal(edit.maskInstructions, "");
});

test("browser imports reject empty and oversized media before storage", async () => {
  await assert.rejects(importFileAsset(new File([], "empty.jpg", { type: "image/jpeg" })), /is empty/);
  await assert.rejects(
    importFileAsset(new File([new Uint8Array(30 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" })),
    /30 MB local safety limit/,
  );
});

test("media helpers and generated session names remain stable", () => {
  assert.equal(mediaMimeFromSource("/generated/result.jpeg", "image/png"), "image/jpeg");
  assert.equal(mediaNameForMime("image-result.png", "image/jpeg"), "image-result.jpg");
  assert.deepEqual(requestedImageDimensions(592, 448, "512", "4:3"), { width: 512, height: 384 });
  assert.equal(nextAvailableSessionName([{ name: "Session 2" }], (count) => `Session ${count}`), "Session 3");
});
