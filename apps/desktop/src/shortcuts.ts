import type { MessageKey } from "@/i18n";

export type AppCommandId =
  | "newSession"
  | "newThread"
  | "duplicateThread"
  | "archiveThread"
  | "restoreThread"
  | "nextThread"
  | "previousThread"
  | "findSessions"
  | "importAssets"
  | "exportAsset"
  | "imageMode"
  | "videoMode"
  | "toggleSessionSidebar"
  | "toggleInspector"
  | "showAgent"
  | "showAssets"
  | "focusPrompt"
  | "generate"
  | "settings"
  | "shortcutHelp"
  | "quit";

export type ShortcutGroup = "app" | "sessions" | "workspace" | "assets";

export type ShortcutBinding = {
  key: string;
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export type CommandDefinition = {
  id: AppCommandId;
  labelKey: MessageKey;
  group: ShortcutGroup;
  display: string;
  accelerator?: string;
  binding: ShortcutBinding;
  aliases?: ShortcutBinding[];
};

const command = (definition: CommandDefinition) => definition;

export const APP_COMMANDS = [
  command({ id: "newSession", labelKey: "commandNewSession", group: "sessions", display: "⌘N", accelerator: "CmdOrCtrl+N", binding: { key: "n", meta: true } }),
  command({ id: "newThread", labelKey: "commandNewThread", group: "sessions", display: "⌘T", accelerator: "CmdOrCtrl+T", binding: { key: "t", meta: true } }),
  command({ id: "duplicateThread", labelKey: "commandDuplicateThread", group: "sessions", display: "⌘D", accelerator: "CmdOrCtrl+D", binding: { key: "d", meta: true } }),
  command({ id: "archiveThread", labelKey: "commandArchiveThread", group: "sessions", display: "⌘W", accelerator: "CmdOrCtrl+W", binding: { key: "w", meta: true } }),
  command({ id: "restoreThread", labelKey: "commandRestoreThread", group: "sessions", display: "⇧⌘T", accelerator: "CmdOrCtrl+Shift+T", binding: { key: "t", meta: true, shift: true } }),
  command({
    id: "nextThread",
    labelKey: "commandNextThread",
    group: "sessions",
    display: "⌃Tab / ⇧⌘]",
    accelerator: "Ctrl+Tab",
    binding: { key: "tab", ctrl: true },
    aliases: [{ key: "]", code: "BracketRight", meta: true, shift: true }],
  }),
  command({
    id: "previousThread",
    labelKey: "commandPreviousThread",
    group: "sessions",
    display: "⌃⇧Tab / ⇧⌘[",
    accelerator: "Ctrl+Shift+Tab",
    binding: { key: "tab", ctrl: true, shift: true },
    aliases: [{ key: "[", code: "BracketLeft", meta: true, shift: true }],
  }),
  command({ id: "findSessions", labelKey: "commandFindSessions", group: "sessions", display: "⌘F", accelerator: "CmdOrCtrl+F", binding: { key: "f", meta: true } }),
  command({ id: "importAssets", labelKey: "commandImportAssets", group: "assets", display: "⌘O", accelerator: "CmdOrCtrl+O", binding: { key: "o", meta: true } }),
  command({ id: "exportAsset", labelKey: "commandExportAsset", group: "assets", display: "⇧⌘E", accelerator: "CmdOrCtrl+Shift+E", binding: { key: "e", meta: true, shift: true } }),
  command({ id: "imageMode", labelKey: "commandImageMode", group: "workspace", display: "⌘1", accelerator: "CmdOrCtrl+1", binding: { key: "1", meta: true } }),
  command({ id: "videoMode", labelKey: "commandVideoMode", group: "workspace", display: "⌘2", accelerator: "CmdOrCtrl+2", binding: { key: "2", meta: true } }),
  command({ id: "toggleSessionSidebar", labelKey: "commandToggleSidebar", group: "workspace", display: "⌃⌘S", accelerator: "Ctrl+Cmd+S", binding: { key: "s", meta: true, ctrl: true } }),
  command({ id: "toggleInspector", labelKey: "commandToggleInspector", group: "workspace", display: "⌥⌘I", accelerator: "Cmd+Alt+I", binding: { key: "i", meta: true, alt: true } }),
  command({ id: "showAgent", labelKey: "commandShowAgent", group: "workspace", display: "⌥⌘1", accelerator: "Cmd+Alt+1", binding: { key: "1", meta: true, alt: true } }),
  command({ id: "showAssets", labelKey: "commandShowAssets", group: "workspace", display: "⌥⌘2", accelerator: "Cmd+Alt+2", binding: { key: "2", meta: true, alt: true } }),
  command({ id: "focusPrompt", labelKey: "commandFocusPrompt", group: "workspace", display: "⇧Esc", binding: { key: "escape", shift: true } }),
  command({ id: "generate", labelKey: "commandGenerateShortcut", group: "workspace", display: "⌘Enter", accelerator: "CmdOrCtrl+Enter", binding: { key: "enter", meta: true } }),
  command({ id: "settings", labelKey: "settings", group: "app", display: "⌘,", accelerator: "CmdOrCtrl+,", binding: { key: ",", meta: true } }),
  command({ id: "shortcutHelp", labelKey: "keyboardShortcuts", group: "app", display: "⌘/", accelerator: "CmdOrCtrl+/", binding: { key: "/", meta: true } }),
  command({ id: "quit", labelKey: "quitApp", group: "app", display: "⌘Q", accelerator: "CmdOrCtrl+Q", binding: { key: "q", meta: true } }),
] as const satisfies readonly CommandDefinition[];

export const APP_COMMAND_MAP = new Map<AppCommandId, CommandDefinition>(
  APP_COMMANDS.map((definition) => [definition.id, definition]),
);

export const NATIVE_MENU_COMMAND_IDS = new Set<AppCommandId>(
  APP_COMMANDS.flatMap((definition) => definition.accelerator ? [definition.id] : []),
);

function modifierMatches(actual: boolean, expected = false) {
  return actual === expected;
}

export function bindingMatches(event: KeyboardEvent, binding: ShortcutBinding) {
  const key = event.key.toLowerCase();
  const mac = navigator.platform.toLowerCase().includes("mac");
  const meta = mac
    ? event.metaKey
    : binding.ctrl && !binding.meta ? event.metaKey : event.ctrlKey;
  const ctrl = mac
    ? event.ctrlKey
    : binding.meta ? (binding.ctrl ? event.metaKey : false) : event.ctrlKey;
  return (key === binding.key.toLowerCase() || Boolean(binding.code && event.code === binding.code))
    && modifierMatches(meta, binding.meta)
    && modifierMatches(ctrl, binding.ctrl)
    && modifierMatches(event.altKey, binding.alt)
    && modifierMatches(event.shiftKey, binding.shift);
}

export function commandForKeyboardEvent(event: KeyboardEvent) {
  for (const definition of APP_COMMANDS) {
    if (bindingMatches(event, definition.binding) || definition.aliases?.some((binding) => bindingMatches(event, binding))) {
      return definition;
    }
  }
  return null;
}
