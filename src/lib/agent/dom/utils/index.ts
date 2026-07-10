/**
 * Barrel re-export for the `dom/utils/` subdirectory.
 *
 * Each file in this subdirectory owns a single concern:
 *   - {@link ./classification} — `SKIP_TAGS`, `isInteractive`, the
 *     `PROPAGATING_ELEMENTS` taxonomy + bounding-box containment helpers.
 *   - {@link ./visibility}    — `isLikelyHidden` (cheap pre-check) +
 *     `isVisibleFull` (expensive full check).
 *   - {@link ./tree-walker}   — `directText` text-node helper.
 *   - {@link ./selectors}     — `By` locator taxonomy + `escapeCss` /
 *     `findByLocator`.
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
