/** `hover` action handler — dispatch mouseover + mousemove on the element. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { moveCursorToElement } from "../../dom/phantom-cursor";
import { TIMINGS, sleep } from "../constants";
import { resolveElement, safeScrollIntoView } from "../helpers";
import type { ActionContext } from "./types";

export async function handleHover(
  ctx: ActionContext,
  action: Extract<Action, { type: "hover" }>,
): Promise<ActionResult> {
  const { state } = ctx;
  const el = resolveElement(state, action.index);
  if (!el || !el.isConnected) {
    return {
      action,
      success: false,
      message: `element [${action.index}] is detached (page may have changed — extract state again)`,
    };
  }
  highlightElement(el, `hover [${action.index}]`);
  // Scroll the element into view BEFORE moving the phantom cursor and computing
  // the rect, so the cursor targets the element's post-scroll viewport position
  // and the dispatched events use coordinates that match what the user sees.
  safeScrollIntoView(el);
  await sleep(TIMINGS.clickScrollIntoView);
  const rect = el.getBoundingClientRect();
  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  // In a real browser screenX/Y = viewport coords + window offset on screen;
  // they are essentially never equal to the viewport coordinates, so derive
  // them from the window offset rather than mirroring clientX/Y (a synthetic
  // tell some bot detectors check).
  const screenX = clientX + window.screenX;
  const screenY = clientY + window.screenY;

  // Construct a MouseEvent once from a shared coordinate bundle so the same
  // clientX/clientY/screenX/screenY/relatedTarget are applied consistently.
  const makeMouseEvent = (type: string, init: MouseEventInit) =>
    new MouseEvent(type, init);
  // A real hover first emits a parallel PointerEvent sequence
  // (pointerover -> pointerenter -> pointermove) before the mouse events.
  // Many sites key hover/tooltip/drag handlers to pointer events, so dispatch
  // both sequences; the existing MouseEvent path is preserved.
  const makePointerEvent = (type: string, init: PointerEventInit) =>
    new PointerEvent(type, init);
  // jsdom (used by the test suite) doesn't implement PointerEvent, so guard the
  // whole parallel pointer sequence — real browsers still get the full
  // pointerover -> pointerenter -> pointermove sequence alongside the mouse
  // events below.
  if (typeof PointerEvent !== "undefined") {
    el.dispatchEvent(
      makePointerEvent("pointerover", {
        bubbles: true,
        relatedTarget: document.body,
        clientX,
        clientY,
        screenX,
        screenY,
      }),
    );
    el.dispatchEvent(
      makePointerEvent("pointerenter", {
        bubbles: false,
        relatedTarget: document.body,
        clientX,
        clientY,
        screenX,
        screenY,
      }),
    );
    el.dispatchEvent(
      makePointerEvent("pointermove", {
        bubbles: true,
        clientX,
        clientY,
        screenX,
        screenY,
      }),
    );
  }

  // Simulate a real hover. When a pointer enters a new element the browser
  // first emits `mouseover` (which bubbles and carries the `relatedTarget` of
  // the element just left) on the element entered, then the non-bubbling
  // `mouseenter` on the element being entered, followed by `mousemove` with the
  // pointer coordinates. Dispatching the full `mouseover` -> `mouseenter` ->
  // `mousemove` sequence makes hover widgets keyed off any of those events open
  // correctly and mirrors the order a real DOM hover produces.
  el.dispatchEvent(
    makeMouseEvent("mouseover", {
      bubbles: true,
      relatedTarget: document.body,
      clientX,
      clientY,
      screenX,
      screenY,
    }),
  );
  el.dispatchEvent(
    makeMouseEvent("mouseenter", {
      bubbles: false,
      relatedTarget: document.body,
      clientX,
      clientY,
      screenX,
      screenY,
    }),
  );
  el.dispatchEvent(
    makeMouseEvent("mousemove", {
      bubbles: true,
      clientX,
      clientY,
      screenX,
      screenY,
    }),
  );

  // Move the phantom cursor last, now that the page is scrolled and the rect
  // is final, so it lands on the element's post-scroll position.
  await moveCursorToElement(el);

  return { action, success: true, message: `Hovered [${action.index}] <${el.tagName.toLowerCase()}>` };
}
