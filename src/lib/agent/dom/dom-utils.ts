/**
 * Re-export shim — the canonical implementation now lives in `./utils/`
 * (categorised into `classification`, `visibility`, `tree-walker`,
 * `selectors`). This file preserves the legacy
 * `@/lib/agent/dom/dom-utils` import path used across the codebase.
 *
 * Re-exported symbols:
 * - `SKIP_TAGS`, `isInteractive`, `isPropagatingElement`,
 * `PROPAGATING_ELEMENTS`, `PropagatingElementPattern`,
 * `DEFAULT_CONTAINMENT_THRESHOLD`, `containmentRatio`, `isContained`,
 * `nearestPropagatingAncestor`, `shouldExcludeAsContained`,
 * `isSensitive`, `SENSITIVE_AUTOCOMPLETE`
 * (from `./utils/classification`)
 * - `isLikelyHidden`, `isVisibleFull` (from `./utils/visibility`)
 * - `directText` (from `./utils/tree-walker`)
 * - `escapeCss`, `By`, `LocatorUsing`, `findByLocator`
 * (from `./utils/selectors`)
 *
 * NOTE: the bounding-box containment / propagation helpers re-exported from
 * `./utils/classification` below (`isPropagatingElement`, `PROPAGATING_ELEMENTS`,
 * `DEFAULT_CONTAINMENT_THRESHOLD`, `containmentRatio`, `isContained`,
 * `nearestPropagatingAncestor`, `shouldExcludeAsContained`) are retained ONLY for
 * backwards-compat with the legacy `@/lib/agent/dom/dom-utils` import path. The
 * current extractor (`extraction/page-state.ts`) does NOT call them — they are
 * dead at the call site, kept solely so existing importers keep compiling (see
 * the full write-up in `./utils/classification`).
 */
export * from "./utils/classification";
export * from "./utils/visibility";
export * from "./utils/tree-walker";
export * from "./utils/selectors";
