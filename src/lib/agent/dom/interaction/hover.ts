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

/** The cursor SVG markup (a pointer arrow with a white outline). */
const CURSOR_SVG = `
<svg width="20" height="26" viewBox="0 0 20 26" style="position:absolute; top:0; left:0; overflow:visible;">
  <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z"
    stroke="white" stroke-width="3" stroke-linejoin="round" fill="white" />
  <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z"
    fill="#111" />
</svg>
`;

/** z-index for the cursor (just below the highlight badge). */
const CURSOR_Z_INDEX = "2147483646";
/** CSS transition for cursor movement. */
const CURSOR_TRANSITION = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
/** Safety timeout for `transitionend` (slightly longer than the transition). */
const CURSOR_MOVE_TIMEOUT_MS = 220;
/** ID assigned to the cursor element so it can be styled externally. */
const CURSOR_ELEMENT_ID = "open-cowork-phantom-cursor";

let cursorEl: HTMLDivElement | null = null;
/**
 * The `finish` callback of the currently in-flight move, or `null` when no move
 * is pending. Tracking a single active move lets a new `movePhantomCursor` cancel
 * the prior one so stacked `transitionend` listeners can't accumulate across
 * rapid moves.
 */
let activeMoveFinish: (() => void) | null = null;

/**
 * Move the phantom cursor to a viewport-relative `(x, y)` position.
 * Resolves once the CSS transition completes (or after a safety timeout).
 * No-op if the tab is hidden.
 */
export function movePhantomCursor(x: number, y: number): Promise<void> {
  if (document.hidden) return Promise.resolve();

  if (!cursorEl) {
    cursorEl = document.createElement("div");
    cursorEl.id = CURSOR_ELEMENT_ID;
    cursorEl.setAttribute("aria-hidden", "true");
    cursorEl.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      pointer-events: none;
      z-index: ${CURSOR_Z_INDEX};
      transform: translate3d(${x}px, ${y}px, 0);
      transition: ${CURSOR_TRANSITION};
      will-change: transform;
    `;
    cursorEl.innerHTML = CURSOR_SVG;
    document.body.appendChild(cursorEl);
    return Promise.resolve();
  }

  cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;

 // Cancel any in-flight move before starting a new one. Without this, rapid
 // sequential moves stack a `transitionend` listener per call, and an earlier
 // move's promise would only resolve when a *later* transition ends (its own
 // transform was overwritten before it could finish). Cancelling resolves the
 // prior promise promptly and drops its listener.
  if (activeMoveFinish) {
    activeMoveFinish();
  }

 // Wait for the transition to complete (with safety timeout).
 // `cursorEl` is non-null here (we just set its transform above), but TS
 // can't narrow across the Promise boundary, so capture a local reference.
  const target = cursorEl;
  return new Promise<void>((resolve) => {
    if (!target) {
      resolve();
      return;
    }
    let done = false;
 // Captured so `finish` can always reclaim the safety timer, even when the
 // transition ends before the timeout fires (or vice-versa). Previously the
 // handle was never stored, leaving a dangling one-shot timer per move.
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      target.removeEventListener("transitionend", finish);
      if (activeMoveFinish === finish) {
        activeMoveFinish = null;
      }
      resolve();
    };
    activeMoveFinish = finish;
    target.addEventListener("transitionend", finish, { once: true });
    const safetyTimer = setTimeout(finish, CURSOR_MOVE_TIMEOUT_MS);
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
