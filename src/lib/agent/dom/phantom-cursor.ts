/**
 * Re-export shim — the canonical phantom-cursor implementation now lives in
 * `./interaction/hover`. This file preserves the legacy
 * `@/lib/agent/dom/phantom-cursor` import path used by the executor handlers
 * (click, hover, press-and-hold).
 *
 * All historically-exported symbols are re-exported here:
 * - `movePhantomCursor`, `moveCursorToElement`, `startPhantomCursor`,
 * `stopPhantomCursor`
 *
 * The file lives in `interaction/hover.ts` (rather than
 * `interaction/phantom-cursor.ts`) because the phantom cursor is the only
 * real interaction-feedback helper at the DOM layer — click / hover /
 * press-and-hold handlers live in `agent/tools/handlers/` and call INTO
 * this module for visual feedback, but the action dispatch + state
 * bookkeeping is in tools/, not here. Keeping `interaction/` minimal
 * avoids creating empty stub files (click-strategies, keyboard, file-upload)
 * that the blueprint called out as optional.
 *
 * New code should import from `@/lib/agent/dom/interaction/hover`
 *
 */
export * from "./interaction/hover";
