/**
 * Phantom cursor — a fake mouse cursor that animates to each element the agent
 * interacts with, giving the user real-time visual feedback of agent actions.
 *
 * The cursor is a fixed-position SVG overlay with a CSS transform transition.
 * Movement is awaited via `transitionend` (with a safety timeout) so the agent
 * can sequence "move → click" naturally.
 *
 * The file lives in `dom/interaction/` because phantom-cursor movement is the
 * only real "interaction feedback" the agent renders (the click / hover /
 * press logic itself lives in `agent/tools/handlers/`). The
 * `@/lib/agent/dom/phantom-cursor` import path also works via a re-export
 * shim in `dom/phantom-cursor.ts`.
 */

import { isStealthEnabledSync } from "../../anti-detection-utils";

/** The cursor SVG markup (a pointer arrow with a white outline). */
const CURSOR_SVG = `
<svg width="20" height="26" viewBox="0 0 20 26" style="position:absolute; top:0; left:0; overflow:visible;">
  <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z"
    stroke="white" stroke-width="3" stroke-linejoin="round" fill="white" />
  <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z"
    fill="#111" />
</svg>
`;

/** z-index for the cursor (just below the highlight badge). A large but
 * always-valid value (max ~2000999999, safely below the CSS z-index limit of
 * 2^31-1 = 2147483647) — the previous formula could overflow into an invalid
 * integer ~83% of the time, dropping the cursor behind page content. The
 * random spread still preserves the stealth intent. */
const CURSOR_Z_INDEX = String(2000000000 + Math.floor(Math.random() * 1000000));
/** CSS transition for cursor movement. */
const CURSOR_TRANSITION = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
/** Safety timeout for `transitionend` (slightly longer than the transition). */
const CURSOR_MOVE_TIMEOUT_MS = 220;
/** Whether the user prefers reduced motion (computed once at module load). */
const REDUCE_MOTION =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let cursorEl: HTMLDivElement | null = null;
/**
 * The `finish` callback of the currently in-flight move, or `null` when no move
 * is pending. Tracking a single active move lets a new `movePhantomCursor` cancel
 * the prior one so stacked `transitionend` listeners can't accumulate across
 * rapid moves.
 */
let activeMoveFinish: ((e?: TransitionEvent) => void) | null = null;

/**
 * Move the phantom cursor to a viewport-relative `(x, y)` position.
 * Resolves once the CSS transition completes (or after a safety timeout).
 * No-op if the tab is hidden.
 */
/** Lazily create, style, and append the phantom-cursor element (exactly once). */
function ensureCursor(x: number, y: number): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
 // `data-oc-cursor` is the stable, styleable hook (external CSS targets the
 // attribute selector, not a fixed id — a constant element id is a detectable
 // fingerprint that anti-automation scanners enumerate).
  el.setAttribute("data-oc-cursor", "");
  el.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    pointer-events: none;
    z-index: ${CURSOR_Z_INDEX};
    transform: translate3d(${x}px, ${y}px, 0);
    transition: ${REDUCE_MOTION ? "none" : CURSOR_TRANSITION};
  `;
  el.innerHTML = CURSOR_SVG;
  document.body.appendChild(el);
  return el;
}

export function movePhantomCursor(x: number, y: number): Promise<void> {
  // Stealth gate: the phantom cursor is a page-visible artifact (an SVG overlay
  // appended to `document.body` that any page script can observe). It moves in
  // NORMAL mode (the user's visual "where is the agent pointing" indicator) and
  // is suppressed when stealth mode is on — see
  // `anti-detection-utils.isStealthEnabledSync`.
  if (isStealthEnabledSync()) return Promise.resolve();
  if (document.hidden) return Promise.resolve();

  if (!cursorEl || !cursorEl.isConnected) {
    // Re-create when the page detached it (e.g. a page framework replaced
    // `document.body` mid-session) — a stale reference to a removed node would
    // otherwise silently swallow every later move, mirroring the live-region
    // re-creation pattern in overlay-renderer.ts.
    cursorEl = ensureCursor(x, y);
    return Promise.resolve();
  }

  cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;

 // Honor prefers-reduced-motion: resolve immediately so reduced-motion moves
 // are instant rather than delayed by the safety timeout (no transition fires).
  if (REDUCE_MOTION) {
    if (activeMoveFinish) {
      activeMoveFinish();
    }
    return Promise.resolve();
  }

 // Cancel any in-flight move before starting a new one. Without this, rapid
 // sequential moves stack a `transitionend` listener per call, and an earlier
 // move's promise would only resolve when a *later* transition ends (its own
 // transform was overwritten before it could finish). Cancelling resolves the
 // prior promise promptly and drops its listener.
  if (activeMoveFinish) {
    activeMoveFinish();
  }

  // Wait for the transition to complete (with safety timeout).
  // `cursorEl` is non-null here (we just set its transform above); capture a
  // local reference so the closure type-checks without a null assertion.
  const target = cursorEl;
  return new Promise<void>((resolve) => {
    let done = false;
    // Resolve the move promise. Marked `done` so neither the transitionend nor
    // the safety-timeout path can resolve twice.
    const settle = (): void => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      target.removeEventListener("transitionend", onTransitionEnd);
      if (activeMoveFinish === onTransitionEnd) {
        activeMoveFinish = null;
      }
      resolve();
    };
    // Only the transform transition drives the move; ignore unrelated
    // transitionend events (e.g. a future opacity transition). The safety
    // timeout below covers the identical-coordinates case where no transition
    // fires at all — in environments without a layout engine (jsdom) the
    // safety timeout is the ONLY thing that resolves the promise, so it must
    // call `settle()` unconditionally.
    const onTransitionEnd = (e?: TransitionEvent): void => {
      if (e && e.propertyName !== "transform") return;
      settle();
    };
    activeMoveFinish = onTransitionEnd;
 // Do NOT pass `{ once: true }`: the listener is removed manually in `settle()`,
 // and a non-transform `transitionend` would otherwise consume the listener
 // (returning early without settling) and force the move to resolve only via the
 // safety timeout. Keeping it registered lets the transform transition still fire.
    target.addEventListener("transitionend", onTransitionEnd);
    const safetyTimer = setTimeout(settle, CURSOR_MOVE_TIMEOUT_MS);
  });
}

/**
 * Move the phantom cursor to the center of an element. Returns the resolved
 * `(x, y)` center coordinates so callers can perform follow-up actions
 * (e.g. dispatching a synthetic click at the same position).
 */
export async function moveCursorToElement(el: HTMLElement): Promise<{ x: number; y: number }> {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  await movePhantomCursor(x, y);
  return { x, y };
}
