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

  // Shared coordinate bundle + relatedTarget so every event in the hover
  // sequence reports the same clientX/clientY/screenX/screenY (a real hover
  // does), then dispatch the full pointer + mouse sequences.
  const coords = { clientX, clientY, screenX, screenY };
  const relatedTarget: EventTarget | null = document.body;
  // A real hover first emits a parallel PointerEvent sequence
  // (pointerover -> pointerenter -> pointermove) before the mouse events.
  // Many sites key hover/tooltip/drag handlers to pointer events, so dispatch
  // both sequences. jsdom (used by the test suite) doesn't implement
  // PointerEvent, so guard the whole parallel pointer sequence — real browsers
  // still get the full pointerover -> pointerenter -> pointermove sequence.
  if (typeof PointerEvent !== "undefined") {
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget, ...coords }));
    el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, relatedTarget, ...coords }));
    el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, ...coords }));
  }

  // Simulate a real hover. When a pointer enters a new element the browser
  // first emits `mouseover` (which bubbles and carries the `relatedTarget` of
  // the element just left) on the element entered, then the non-bubbling
  // `mouseenter`, followed by `mousemove` with the pointer coordinates.
  // Dispatching the full `mouseover` -> `mouseenter` -> `mousemove` sequence
  // makes hover widgets keyed off any of those events open correctly.
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget, ...coords }));
  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, relatedTarget, ...coords }));
  el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...coords }));

  // Move the phantom cursor last, now that the page is scrolled and the rect
  // is final, so it lands on the element's post-scroll position.
  await moveCursorToElement(el);

  return { action, success: true, message: `Hovered [${action.index}] <${el.tagName.toLowerCase()}>` };
}
