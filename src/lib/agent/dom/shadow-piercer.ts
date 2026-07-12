/**
 * Re-export shim — the canonical shadow-DOM piercer implementation now lives
 * in `./annotation/shadow-piercer`. This file preserves the legacy
 * `@/lib/agent/dom/shadow-piercer` import path used by
 * `extension/background.ts` and the dom-extraction-enhancements /
 * dom-shim-consistency tests.
 *
 * All historically-exported symbols are re-exported here:
 *   - `installShadowPiercer`, `getShadowRoot`, `isShadowHost`,
 *     `pierceShadowRoots`, `_resetShadowPiercerForTests`,
 *     `ShadowPiercerOptions` (interface), `ShadowPiercerBackdoor` (interface)
 *
 * Import graph (as of this writing):
 *   - `src/lib/agent/dom/extraction/page-state.ts` imports `installShadowPiercer`
 *     STATICALLY and directly from `../annotation/shadow-piercer` (skipping this
 *     shim) to avoid an extra indirection on the hot extraction path; it also
 *     triggers the piercer install at module load (page-state.ts).
 *   - The MAIN-world entry point `src/lib/agent/dom/annotation/shadow-piercer.ts`
 *     is the canonical module; there is NO dynamic `import(...)` of it from
 *     `extractor.ts` (that file is now a pure re-export shim and contains no
 *     imports at all).
 *
 * Both the legacy shim and the canonical path resolve to the same module
 * instance — ES modules are singletons per resolved path.
 *
 * New code should import from `@/lib/agent/dom/annotation/shadow-piercer`.
 */
export * from "./annotation/shadow-piercer";
