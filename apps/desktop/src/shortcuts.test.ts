import assert from "node:assert/strict";
import test from "node:test";
import { APP_COMMANDS, NATIVE_MENU_COMMAND_IDS, bindingMatches, commandForKeyboardEvent } from "./shortcuts.ts";

test("app shortcuts have unique ids and native accelerators", () => {
  assert.equal(new Set(APP_COMMANDS.map((command) => command.id)).size, APP_COMMANDS.length);
  const accelerators = APP_COMMANDS.flatMap((command) => command.accelerator ? [command.accelerator] : []);
  assert.equal(new Set(accelerators).size, accelerators.length);
});

test("primary and alias key bindings do not conflict", () => {
  const signatures = APP_COMMANDS.flatMap((command) => [command.binding, ...(command.aliases ?? [])])
    .map((binding) => [binding.key, binding.code ?? "", binding.meta ?? false, binding.ctrl ?? false, binding.alt ?? false, binding.shift ?? false].join(":"));
  assert.equal(new Set(signatures).size, signatures.length);
});

test("single-character commands always use a modifier", () => {
  for (const command of APP_COMMANDS) {
    if (command.binding.key.length === 1) {
      assert.ok(command.binding.meta || command.binding.ctrl || command.binding.alt, command.id);
    }
  }
});

test("shifted bracket aliases match the physical bracket keys", () => {
  const mac = navigator.platform.toLowerCase().includes("mac");
  const event = {
    key: "}",
    code: "BracketRight",
    metaKey: mac,
    ctrlKey: !mac,
    altKey: false,
    shiftKey: true,
  } as KeyboardEvent;
  assert.equal(bindingMatches(event, { key: "]", code: "BracketRight", meta: true, shift: true }), true);
});

test("thread cycling and inspector shortcuts stay in the WebView instead of native defaults", () => {
  assert.equal(NATIVE_MENU_COMMAND_IDS.has("nextThread"), false);
  assert.equal(NATIVE_MENU_COMMAND_IDS.has("previousThread"), false);
  assert.equal(NATIVE_MENU_COMMAND_IDS.has("toggleInspector"), false);
  const next = commandForKeyboardEvent({
    key: "Tab",
    code: "Tab",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
  } as KeyboardEvent);
  assert.equal(next?.id, "nextThread");
});
