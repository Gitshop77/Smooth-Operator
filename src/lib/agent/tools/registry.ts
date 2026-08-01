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
