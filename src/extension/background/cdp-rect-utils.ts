/**
 * Pure coordinate helpers for CDP (chrome.debugger) mouse effects.
 *
 * The content script sends element bounding boxes in CSS pixels, viewport-
 * relative (what `getBoundingClientRect()` returns — the browser already
 * subtracts the scroll offset). CDP `Input.dispatchMouseEvent` consumes the
 * same coordinate space (CSS pixels, viewport-relative), so the click point
 * is the box CENTER with NO DPR scaling and NO scroll offset added.
 *
 * Extracted so both the DOM-rect path and the vision-rect path of the
 * CDP_CLICK handler share one formula, and so the coordinate contract is
 * unit-testable without a live browser.
 */

/** A CSS-pixel bounding box (viewport-relative), e.g. from getBoundingClientRect. */
export interface CdpRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Center of a CSS-pixel bounding box — the CDP mouse-press point. */
export function rectCenter(rect: CdpRect): { x: number; y: number } {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}
