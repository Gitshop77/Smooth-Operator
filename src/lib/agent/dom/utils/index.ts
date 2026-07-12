/**
 * Barrel re-export for the `dom/utils/` subdirectory.
 *
 * Each file in this subdirectory owns a single concern:
 * - {@link ./classification} — `SKIP_TAGS`, `isInteractive`, and the
 * `PROPAGATING_ELEMENTS` taxonomy.
 * NOTE: the bounding-box containment helpers defined in that module
 * (`containmentRatio`, `isContained`, `nearestPropagatingAncestor`,
 * `shouldExcludeAsContained`, `isPropagatingElement`,
 * `DEFAULT_CONTAINMENT_THRESHOLD`) are currently NOT consumed by the
 * page-state indexed-tree walker, so they perform no runtime
 * de-duplication today. They are exported for completeness only; see the
 * owning module for the full picture.
 * - {@link ./visibility} — `isLikelyHidden` (cheap pre-check) +
 * `isVisibleFull` (expensive full check).
 * - {@link ./tree-walker} — `directText` text-node helper.
 * - {@link ./selectors} — `By` locator taxonomy + `escapeCss` /
 * `findByLocator`.
 *
 * These were originally a single `dom/dom-utils.ts`; the categorisation
 * keeps each concern in its own file while letting callers `import { ... }
 * from "@/lib/agent/dom/utils"` to reach the full set.
 *
 * The legacy `@/lib/agent/dom/dom-utils` import path stays working via a
 * re-export shim in `dom/dom-utils.ts`.
 */
export * from "./classification";
export * from "./visibility";
export * from "./tree-walker";
export * from "./selectors";
