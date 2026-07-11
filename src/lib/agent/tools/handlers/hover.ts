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
  highlightElement(el, `hover [${action.index}]`);
  await moveCursorToElement(el);
  safeScrollIntoView(el);
  await sleep(TIMINGS.clickScrollIntoView);
  const rect = el.getBoundingClientRect();
  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  // Simulate a real hover, which the browser emits as a sequence of
  // `mouseover` -> `mouseenter` -> `mousemove`. `mouseenter` is non-bubbling,
  // so it must be dispatched directly on the target element (it is not derived
  // from `mouseover` in synthetic dispatch). We dispatch all three so the
  // element receives the genuine hover event chain.
  el.dispatchEvent(
    new MouseEvent("mouseover", {
      bubbles: true,
      relatedTarget: document.body,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
    }),
  );
  el.dispatchEvent(
    new MouseEvent("mouseenter", {
      bubbles: false,
      relatedTarget: document.body,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
    }),
  );
  el.dispatchEvent(
    new MouseEvent("mousemove", {
      bubbles: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
    }),
  );
  return { action, success: true, message: `Hovered [${action.index}] <${el.tagName.toLowerCase()}>` };
}
