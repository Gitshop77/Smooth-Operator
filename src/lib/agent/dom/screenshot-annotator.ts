/**
 * Re-export shim — the canonical screenshot annotator implementation now
 * lives in `./annotation/screenshot-annotator`. This file preserves the
 * legacy `@/lib/agent/dom/screenshot-annotator` import path used by
 * `extension/background.ts` and `tests/dom-extraction-enhancements.test.ts`.
 *
 * All historically-exported symbols are re-exported here:
 *   - `annotateScreenshot`, `DEFAULT_ANNOTATE_PALETTE`,
 *     `AnnotatableElement` (interface), `AnnotateOptions` (interface)
 *
 * New code should import from
 * `@/lib/agent/dom/annotation/screenshot-annotator` or from the top-level

 */
export * from "./annotation/screenshot-annotator";
