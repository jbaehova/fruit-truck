import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_DRAG_TYPE,
  clearAssetDragData,
  hasAssetDragData,
  readAssetDragId,
  writeAssetDragData,
} from "./assetDrag.ts";

function transfer(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get types() {
      return [...values.keys()];
    },
    getData: (format: string) => values.get(format) ?? "",
    setData: (format: string, data: string) => values.set(format, data),
  };
}

test.afterEach(clearAssetDragData);

test("asset drags include a plain-text WebView fallback", () => {
  const data = transfer();
  writeAssetDragData(data, "asset-123");

  assert.equal(data.getData(ASSET_DRAG_TYPE), "asset-123");
  assert.equal(data.getData("text/plain"), "fruit-truck-asset:asset-123");
  assert.equal(hasAssetDragData(data), true);
});

test("asset IDs survive when a WebView strips custom drag MIME data", () => {
  const data = transfer({ "text/plain": "fruit-truck-asset:asset-456" });

  assert.equal(hasAssetDragData(data), true);
  assert.equal(readAssetDragId(data), "asset-456");
  assert.equal(readAssetDragId(transfer({ "text/plain": "unrelated text" })), "");
});

test("asset drags still work when a WebView rejects custom MIME writes", () => {
  const values = new Map<string, string>();
  const data = {
    get types() {
      return [...values.keys()];
    },
    getData: (format: string) => values.get(format) ?? "",
    setData: (format: string, value: string) => {
      if (format === ASSET_DRAG_TYPE) throw new Error("unsupported drag type");
      values.set(format, value);
    },
  };

  assert.doesNotThrow(() => writeAssetDragData(data, "asset-789"));
  assert.equal(readAssetDragId(data), "asset-789");
  clearAssetDragData();
});

test("same-window asset drags survive when a WebView strips every payload", () => {
  const strippedData = {
    types: [] as string[],
    getData: () => "",
    setData: () => undefined,
  };

  writeAssetDragData(strippedData, "asset-webview");
  assert.equal(hasAssetDragData(strippedData), true);
  assert.equal(readAssetDragId(strippedData), "asset-webview");

  clearAssetDragData();
  assert.equal(hasAssetDragData(strippedData), false);
  assert.equal(readAssetDragId(strippedData), "");
});
