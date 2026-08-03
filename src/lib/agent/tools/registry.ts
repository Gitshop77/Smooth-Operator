/**
 * Tool registry — re-exports from registry-data and registry-utils.
 *
 * This module owns the module-level side effect (chrome.storage.onChanged
 * listener) and serves as the public API barrel for all registry exports.
 */

import { isExtensionWithLocal } from "../runtime";
import { CUSTOM_TOOLS_STORAGE_KEY } from "./registry-data";
import { invalidateCustomToolsCache } from "./registry-utils";

// Register the storage onChanged listener once (idempotent).
if (isExtensionWithLocal() && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[CUSTOM_TOOLS_STORAGE_KEY]) {
      invalidateCustomToolsCache();
    }
  });
}

// Non-extension fallback (tests / embedding): `loadCustomTools` reads
// localStorage in these contexts, but localStorage writes from ANOTHER
// tab/context fire a `storage` event only in the OTHER contexts — so without
// this listener this context's `customToolsCache` would stay stale for its
// whole lifetime after an edit elsewhere. The chrome.* path needs no window
// listener: chrome.storage.local writes from other extension contexts fire
// `onChanged` in every context.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    // `e.key === null` is a `localStorage.clear()` — invalidate for that too.
    if (e.key === CUSTOM_TOOLS_STORAGE_KEY || e.key === null) {
      invalidateCustomToolsCache();
    }
  });
}

// Re-export the original public API from sub-modules for backward compatibility.
export {
  CUSTOM_TOOL_NAME_REGEX,
  MAX_CUSTOM_TOOL_CODE_LENGTH,
} from "./registry-data";

export {
  formatCustomToolsBlock,
  getFormatInstructions,
  substituteCustomToolCalls,
} from "./registry-utils";
