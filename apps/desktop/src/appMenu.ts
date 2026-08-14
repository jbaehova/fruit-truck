import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
  type PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu";
import type { MessageKey } from "@/i18n";
import { APP_COMMAND_MAP, NATIVE_MENU_COMMAND_IDS, type AppCommandId } from "@/shortcuts";

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

export type NativeMenuState = {
  enabled: Partial<Record<AppCommandId, boolean>>;
  checked: Partial<Record<AppCommandId, boolean>>;
};

export type NativeAppMenu = {
  update: (state: NativeMenuState) => Promise<void>;
  close: () => Promise<void>;
};

export async function createNativeAppMenu(
  t: Translate,
  dispatch: (id: AppCommandId) => void,
): Promise<NativeAppMenu> {
  const commandItems = new Map<AppCommandId, MenuItem | CheckMenuItem>();
  const item = async (id: AppCommandId, checked = false) => {
    const definition = APP_COMMAND_MAP.get(id);
    if (!definition) throw new Error(`Unknown app command: ${id}`);
    const options = {
      id: `command-${id}`,
      text: t(definition.labelKey),
      accelerator: definition.accelerator,
      action: () => dispatch(id),
      ...(checked ? { checked: false } : {}),
    };
    const result = checked
      ? await CheckMenuItem.new(options)
      : await MenuItem.new(options);
    commandItems.set(id, result);
    return result;
  };
  const predefined = (type: PredefinedMenuItemOptions["item"]) =>
    PredefinedMenuItem.new({ item: type });
  const separator = () => predefined("Separator");

  const [
    about, services, hide, hideOthers, showAll,
    settings, quit,
    newSession, newThread, duplicateThread, archiveThread, restoreThread, importAssets, exportAsset, generate,
    undo, redo, cut, copy, paste, selectAll,
    findSessions, toggleSidebar, toggleInspector, imageMode, videoMode, showAssets, previousThread, nextThread,
    minimize, fullscreen, bringAllToFront,
    shortcutHelp,
  ] = await Promise.all([
    predefined({ About: null }), predefined("Services"), predefined("Hide"), predefined("HideOthers"), predefined("ShowAll"),
    item("settings"), item("quit"),
    item("newSession"), item("newThread"), item("duplicateThread"), item("archiveThread"), item("restoreThread"), item("importAssets"), item("exportAsset"), item("generate"),
    predefined("Undo"), predefined("Redo"), predefined("Cut"), predefined("Copy"), predefined("Paste"), predefined("SelectAll"),
    item("findSessions"), item("toggleSessionSidebar", true), item("toggleInspector", true), item("imageMode", true), item("videoMode", true), item("showAssets", true), item("previousThread"), item("nextThread"),
    predefined("Minimize"), predefined("Fullscreen"), predefined("BringAllToFront"),
    item("shortcutHelp"),
  ]);

  const [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu] = await Promise.all([
    Submenu.new({
      id: "fruit-truck-menu",
      text: "Fruit Truck",
      items: [about, await separator(), services, await separator(), settings, await separator(), hide, hideOthers, showAll, await separator(), quit],
    }),
    Submenu.new({
      id: "file-menu",
      text: t("menuFile"),
      items: [newSession, newThread, duplicateThread, await separator(), importAssets, exportAsset, await separator(), generate, await separator(), archiveThread, restoreThread],
    }),
    Submenu.new({
      id: "edit-menu",
      text: t("menuEdit"),
      items: [undo, redo, await separator(), cut, copy, paste, selectAll, await separator(), findSessions],
    }),
    Submenu.new({
      id: "view-menu",
      text: t("menuView"),
      items: [toggleSidebar, toggleInspector, await separator(), imageMode, videoMode, await separator(), showAssets, await separator(), previousThread, nextThread],
    }),
    Submenu.new({
      id: "window-menu",
      text: t("menuWindow"),
      items: [minimize, fullscreen, await separator(), bringAllToFront],
    }),
    Submenu.new({
      id: "help-menu",
      text: t("menuHelp"),
      items: [shortcutHelp],
    }),
  ]);
  const missingNativeCommands = [...NATIVE_MENU_COMMAND_IDS].filter((id) => !commandItems.has(id));
  if (missingNativeCommands.length) {
    throw new Error(`Native menu is missing commands: ${missingNativeCommands.join(", ")}`);
  }
  const menu = await Menu.new({ items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu] });
  const previous = await menu.setAsAppMenu();
  try {
    await helpMenu.setAsHelpMenuForNSApp();
    await windowMenu.setAsWindowsMenuForNSApp();
  } catch (error) {
    if (previous) {
      const failed = await previous.setAsAppMenu();
      if (failed) await failed.close().catch(() => undefined);
    } else {
      await menu.close().catch(() => undefined);
    }
    throw error;
  }
  if (previous) await previous.close().catch(() => undefined);

  let updateQueue = Promise.resolve();
  const appliedEnabled = new Map<AppCommandId, boolean>();
  const appliedChecked = new Map<AppCommandId, boolean>();
  const applyUpdate = async ({ enabled, checked }: NativeMenuState) => {
    await Promise.all([...commandItems].flatMap(([id, menuItem]) => {
      const operations: Promise<void>[] = [];
      if (id in enabled) {
        const value = enabled[id] !== false;
        if (appliedEnabled.get(id) !== value) {
          operations.push(menuItem.setEnabled(value).then(() => { appliedEnabled.set(id, value); }));
        }
      }
      if (menuItem instanceof CheckMenuItem && id in checked) {
        const value = Boolean(checked[id]);
        if (appliedChecked.get(id) !== value) {
          operations.push(menuItem.setChecked(value).then(() => { appliedChecked.set(id, value); }));
        }
      }
      return operations;
    }));
  };

  return {
    update: (state) => {
      const next = updateQueue.catch(() => undefined).then(() => applyUpdate(state));
      updateQueue = next;
      return next;
    },
    close: () => updateQueue.catch(() => undefined).then(() => menu.close()),
  };
}
