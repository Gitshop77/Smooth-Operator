/**
 * Re-export shim — the canonical visual-overlay implementation now lives in
 * `./annotation/overlay-renderer`. This file preserves the legacy
 * `@/lib/agent/dom/overlay` import path used by the executor handlers
 * (click, input, hover, press-and-hold, select-dropdown) and
 * `extension/content.ts`.
 *
 * Historically-exported symbols:
 * - `highlightElement`, `OverlayHandle` (interface)
 *
 * (`showStatusBanner` and `setPersistentHighlight` were removed — they had no
 * callers.)
 *
 * New code should import from
 * `@/lib/agent/dom/annotation/overlay-renderer`.
 */
export { highlightElement, type OverlayHandle } from "./annotation/overlay-renderer";
