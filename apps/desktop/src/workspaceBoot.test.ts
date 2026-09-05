import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadLegacyWorkspace } from "./workspaceBoot.ts";
import { captureWorkspacePreferences, restoreWorkspacePreferences } from "./workspacePreferences.ts";
import { exportStudioStateJson, loadStudioState, STUDIO_STORAGE_KEY, type StudioStorage } from "./studio.ts";

function memory(entries: [string, string][] = []): StudioStorage {
  const values = new Map(entries);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
  };
}

test("native first boot migrates legacy sessions and tabs without touching browser source", () => {
  const raw = readFileSync(new URL("../fixtures/studio/phase-3/v6-production-workspace.json", import.meta.url), "utf8");
  const previous = JSON.parse(raw);
  const storage = memory([[STUDIO_STORAGE_KEY, raw]]);
  const result = loadLegacyWorkspace(storage, true);
  assert.equal(result.recovery.requiresUserAction, false);
  assert.equal(storage.getItem(STUDIO_STORAGE_KEY), raw);
  assert.equal(storage.length, 1);
  assert.deepEqual(result.state.sessions.map((session) => ({
    id: session.id, assets: session.assets.map((asset) => asset.id),
    imageTabs: session.threads.image.map((thread) => thread.id),
    videoTabs: session.threads.video.map((thread) => thread.id),
    active: session.activeThreadIds,
  })), previous.sessions.map((session: typeof result.state.sessions[number]) => ({
    id: session.id, assets: session.assets.map((asset) => asset.id),
    imageTabs: session.threads.image.map((thread) => thread.id),
    videoTabs: session.threads.video.map((thread) => thread.id),
    active: session.activeThreadIds,
  })));
});

test("missing or corrupt metadata with existing media requires recovery", () => {
  for (const storage of [memory(), memory([[STUDIO_STORAGE_KEY, "broken"]])]) {
    assert.equal(loadLegacyWorkspace(storage, true).recovery.requiresUserAction, true);
  }
  assert.equal(loadLegacyWorkspace(memory(), false).recovery.requiresUserAction, false);
});

test("workspace preferences survive origin changes and workspace serialization without credentials", () => {
  const source = memory([
    ["fruit-truck.language", "ko"],
    ["fruit-truck.favorite-models.v1", '["bytedance-seed/seedream-4.5"]'],
    ["fruit-truck.session-sidebar.width", "280"],
    ["fruit-truck.api-key", "secret"],
  ]);
  const state = { ...loadLegacyWorkspace(memory(), false).state, preferences: captureWorkspacePreferences(source) };
  const roundTrip = loadStudioState({ storage: memory([[STUDIO_STORAGE_KEY, exportStudioStateJson(state)]]) });
  const destination = memory([["fruit-truck.session-budget-usd.v1", "5"]]);
  restoreWorkspacePreferences(destination, roundTrip);
  assert.equal(destination.getItem("fruit-truck.language"), "ko");
  assert.equal(destination.getItem("fruit-truck.favorite-models.v1"), source.getItem("fruit-truck.favorite-models.v1"));
  assert.equal(destination.getItem("fruit-truck.session-sidebar.width"), "280");
  assert.equal(destination.getItem("fruit-truck.session-budget-usd.v1"), null);
  assert.equal(destination.getItem("fruit-truck.api-key"), null);
  restoreWorkspacePreferences(destination, { preferences: { "fruit-truck.api-key": "injected" } });
  assert.equal(destination.getItem("fruit-truck.api-key"), null);
});
