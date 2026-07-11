/**
 * Re-export shim — the canonical indexed-DOM-tree extractor implementation
 * now lives in `./extraction/page-state` (the walker + cached selectorMap +
 * `extractBrowserState` / `resetDomBaseline` / `getSelectorMap` + the
 * `isVisible` wrapper) and `./extraction/element-info` (`buildAttrs` +
 * `hashElement` + the shared `DOM_CONFIG` / `BOOLEAN_ATTRS` constants).
 *
 * This file preserves the legacy `@/lib/agent/dom/extractor` import path
 * used by `extension/content.ts`, `agent/loop/{helpers,orchestrator,
 * observe-state}.ts`, and the extractor tests.
 *
 * All historically-exported symbols are re-exported here:
 *   - `extractBrowserState`, `resetDomBaseline`, `getSelectorMap`,
 *     `isVisible` (from `./extraction/page-state`)
 *   - `buildAttrs`, `hashElement` (from `./extraction/element-info`)
 *   - `isInteractive` (from `./utils/classification`)
 *
 * Module-load side effect preserved: importing this shim triggers
 * `./extraction/page-state` to evaluate, which calls
 * `installShadowPiercer({ tagExisting: true })` inside a try/catch (the
 * original `extractor.ts` did this at module load). The guard catches
 * non-DOM environments (Node.js without jsdom) where `Element` is undefined.
 *
 * Note on `isInteractive`: the original `extractor.ts` re-exported this
 * symbol (as `export const isInteractive = isInteractiveImpl`). It is
 * re-exported here from `./utils/classification` rather than from
 * `./extraction/page-state` (which does not export it) so callers importing
 * from this shim see no difference.
 */
export {
  extractBrowserState,
  resetDomBaseline,
  getSelectorMap,
  isVisible,
} from "./extraction/page-state";
export { buildAttrs, hashElement } from "./extraction/element-info";
export { isInteractive } from "./utils/classification";
