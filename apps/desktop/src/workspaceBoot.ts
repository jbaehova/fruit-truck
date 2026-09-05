import { loadStudioStateWithRecovery, type StudioLoadResult, type StudioStorage } from "./studio.ts";

/** Migrate in memory so the original browser snapshot remains recoverable. */
export function loadLegacyWorkspace(storage: StudioStorage, hasManagedMedia: boolean): StudioLoadResult {
  const values = new Map<string, string>();
  for (let index = 0; index < (storage.length ?? 0); index++) {
    const key = storage.key?.(index);
    if (!key || !["fruit-truck.studio.", "oppa-gen.studio.", "open-gen-ui.studio."].some((prefix) => key.startsWith(prefix))) continue;
    const value = storage.getItem(key);
    if (value !== null) values.set(key, value);
  }
  const result = loadStudioStateWithRecovery({ storage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
  } });
  if (result.recovery.kind === "fresh" && hasManagedMedia) {
    const recovery = {
      ...result.recovery,
      kind: "corrupt" as const,
      status: "corrupt" as const,
      requiresUserAction: true,
      reason: "Workspace metadata is missing, but managed media still exists. Automatic saving and asset recovery are paused to preserve session and tab ownership. Restore a workspace backup to continue.",
    };
    return { state: { ...result.state, recovery }, recovery };
  }
  return result;
}
