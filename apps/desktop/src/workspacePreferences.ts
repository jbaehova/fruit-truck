import type { StudioStorage } from "./studio.ts";

// Deliberately exclude credentials and workspace snapshots from this mirror.
export const WORKSPACE_PREFERENCE_KEYS = [
  "fruit-truck.language",
  "fruit-truck.favorite-models.v1",
  "fruit-truck.recent-models.v1",
  "fruit-truck.session-sidebar.open",
  "fruit-truck.session-sidebar.width",
  "fruit-truck.right-panel.open",
  "fruit-truck.session-budget-usd.v1",
  "fruit-truck.onboarding.complete.v1",
  "fruit-truck.prompt-enhancement-notice.v1",
] as const;

export const PREFERENCES_CHANGED = "fruit-truck:preferences-changed";

export function captureWorkspacePreferences(storage: StudioStorage): Record<string, string | null> {
  return Object.fromEntries(WORKSPACE_PREFERENCE_KEYS.map((key) => [key, storage.getItem(key)]));
}

export function restoreWorkspacePreferences(storage: StudioStorage, payload: unknown): void {
  if (!payload || typeof payload !== "object" || !("preferences" in payload)) return;
  const values = payload.preferences;
  if (!values || typeof values !== "object") return;
  for (const key of WORKSPACE_PREFERENCE_KEYS) {
    if (!(key in values)) continue;
    const value = (values as Record<string, unknown>)[key];
    if (typeof value === "string") storage.setItem(key, value);
    else if (value === null) storage.removeItem(key);
  }
}

export function saveWorkspacePreference(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  window.dispatchEvent(new Event(PREFERENCES_CHANGED));
}
