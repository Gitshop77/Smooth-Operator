/**
 * Re-export shim — the canonical shadow-DOM piercer implementation now lives
 * in `./annotation/shadow-piercer`. This file preserves the legacy
 * `@/lib/agent/dom/shadow-piercer` import path used by
 * `extension/background.ts`, the dom-extraction-enhancements tests, and
 * `./extraction/page-state.ts`.
 *
 * All historically-exported symbols are re-exported here:
 *   - `installShadowPiercer`, `getShadowRoot`, `isShadowHost`,
 *     `pierceShadowRoots`, `_resetShadowPiercerForTests`,
 *     `ShadowPiercerOptions` (interface), `ShadowPiercerBackdoor` (interface)
 *
 * Note: `./extraction/page-state.ts` imports directly from
 * `../annotation/shadow-piercer` (skipping this shim) to avoid an extra
 * indirection on the hot extraction path. Both paths resolve to the same
 * module instance — ES modules are singletons per resolved path.
 *
 * New code should import from
 * `@/lib/agent/dom`.
 */
export * from "./annotation/shadow-piercer";
