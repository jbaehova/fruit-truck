export const ASSET_DRAG_TYPE = "application/x-fruit-truck-asset";
const ASSET_DRAG_TEXT_PREFIX = "fruit-truck-asset:";
const ASSET_POINTER_DROP_EVENT = "fruit-truck:asset-pointer-drop";
let activeAssetDragId = "";
let removePointerListeners: (() => void) | null = null;

type AssetDragData = {
  getData: (format: string) => string;
  setData: (format: string, data: string) => void;
  types: readonly string[];
};

export function writeAssetDragData(dataTransfer: AssetDragData, assetId: string) {
  beginAssetPointerDrag(assetId);
  try {
    dataTransfer.setData("text/plain", `${ASSET_DRAG_TEXT_PREFIX}${assetId}`);
  } catch {
    // The in-memory fallback below still identifies same-window drags.
  }
  try {
    dataTransfer.setData(ASSET_DRAG_TYPE, assetId);
  } catch {
    // Some desktop WebViews only allow standard drag data types.
  }
}

export function hasAssetDragData(dataTransfer: Pick<AssetDragData, "types">) {
  return Boolean(activeAssetDragId) || Array.from(dataTransfer.types).some((type) =>
    type.toLowerCase() === ASSET_DRAG_TYPE || type.toLowerCase() === "text/plain"
  );
}

export function readAssetDragId(dataTransfer: Pick<AssetDragData, "getData">) {
  let customValue = "";
  try {
    customValue = dataTransfer.getData(ASSET_DRAG_TYPE).trim();
  } catch {
    // Fall through to the standard text payload.
  }
  if (customValue) return customValue;
  let plainValue = "";
  try {
    plainValue = dataTransfer.getData("text/plain").trim();
  } catch {
    // Some WebViews hide every payload until after the drop.
  }
  if (plainValue.startsWith(ASSET_DRAG_TEXT_PREFIX)) {
    return plainValue.slice(ASSET_DRAG_TEXT_PREFIX.length).trim();
  }
  return activeAssetDragId;
}

export function clearAssetDragData() {
  activeAssetDragId = "";
  removePointerListeners?.();
  removePointerListeners = null;
}

export function beginAssetPointerDrag(assetId: string) {
  clearAssetDragData();
  activeAssetDragId = assetId;
  if (typeof window === "undefined") return;

  const finish = (event: PointerEvent) => {
    const draggedAssetId = activeAssetDragId;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-asset-drop-target]")
      ?.dataset.assetDropTarget;
    clearAssetDragData();
    if (!draggedAssetId || !target) return;
    window.dispatchEvent(new CustomEvent(ASSET_POINTER_DROP_EVENT, {
      detail: { assetId: draggedAssetId, target },
    }));
  };
  const cancel = () => clearAssetDragData();
  removePointerListeners = () => {
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", cancel, true);
  };
  window.addEventListener("pointerup", finish, true);
  window.addEventListener("pointercancel", cancel, true);
}

export function readActiveAssetDragId() {
  return activeAssetDragId;
}

export function subscribeToAssetPointerDrop(target: string, onDrop: (assetId: string) => void) {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ assetId?: string; target?: string }>).detail;
    if (detail?.target === target && detail.assetId) onDrop(detail.assetId);
  };
  window.addEventListener(ASSET_POINTER_DROP_EVENT, listener);
  return () => window.removeEventListener(ASSET_POINTER_DROP_EVENT, listener);
}
