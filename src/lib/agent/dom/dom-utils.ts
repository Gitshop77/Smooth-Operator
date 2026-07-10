/**
 * Re-export shim — the canonical implementation now lives in `./utils/`
 * (categorised into `classification`, `visibility`, `tree-walker`,
 * `selectors`). This file preserves the legacy
 * `@/lib/agent/dom/dom-utils` import path used across the codebase.
 *
 * Re-exported symbols:
 *   - `SKIP_TAGS`, `isInteractive`, `isPropagatingElement`,
 *     `PROPAGATING_ELEMENTS`, `PropagatingElementPattern`,
 *     `DEFAULT_CONTAINMENT_THRESHOLD`, `containmentRatio`, `isContained`,
 *     `nearestPropagatingAncestor`, `shouldExcludeAsContained`
 *     (from `./utils/classification`)
 *   - `isLikelyHidden`, `isVisibleFull` (from `./utils/visibility`)
 *   - `directText` (from `./utils/tree-walker`)
 *   - `escapeCss`, `By`, `LocatorUsing`, `findByLocator`
 *     (from `./utils/selectors`)
 */
export * from "./utils/classification";
export * from "./utils/visibility";
export * from "./utils/tree-walker";
export * from "./utils/selectors";
