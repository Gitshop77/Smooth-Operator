/**
 * Re-export shim — the canonical indexed-DOM-tree extractor implementation
 * now lives in `./extraction/page-state` (the walker + cached selectorMap +
 * `extractBrowserState` / `resetDomBaseline` / `getSelectorMap` + the
 * `isVisible` wrapper) and `./extraction/element-info` (`buildAttrs` +
 * `hashElement` + the shared `DOM_CONFIG` / `BOOLEAN_ATTRS` constants).
 *
 * This file preserves the legacy `@/lib/agent/dom/extractor` import path
 * used by `extension/content-utils.ts`, `agent/loop/helpers/action-queue.ts`,
 * `agent/loop/phases/observe-state.ts`, and the extractor tests.
 *
 * All historically-exported symbols are re-exported here:
 * - `extractBrowserState`, `resetDomBaseline`, `getSelectorMap`,
 * `isVisible` (from `./extraction/page-state`)
 * - `buildAttrs`, `hashElement` (from `./extraction/element-info`)
 * - `isInteractive` (from `./utils/classification`)
 *
 * Note on `isInteractive`: it is re-exported here from `./utils/classification`
 * — the single source of truth that `./extraction/page-state` also sources it
 * from — so the legacy `extractor` import path resolves to the same symbol.
 */
export {
  extractBrowserState,
  resetDomBaseline,
  getSelectorMap,
  isVisible,
} from "./extraction/page-state";
export { buildAttrs, hashElement } from "./extraction/element-info";
export { isInteractive } from "./utils/classification";
