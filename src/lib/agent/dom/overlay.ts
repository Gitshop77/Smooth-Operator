/**
 * Re-export shim — the canonical visual-overlay implementation now lives in
 * `./annotation/overlay-renderer`. This file preserves the legacy
 * `@/lib/agent/dom/overlay` import path used by the executor handlers
 * (click, input, hover, press-and-hold, select-dropdown) and
 * `extension/content.ts`.
 *
 * All historically-exported symbols are re-exported here:
 * - `highlightElement`, `setPersistentHighlight`, `OverlayHandle` (interface)
 *
 * (`showStatusBanner` was removed — it had no callers.)
 *
 * New code should import from
 * `@/lib/agent/dom/annotation/overlay-renderer` or from the top-level

 */
export * from "./annotation/overlay-renderer";
