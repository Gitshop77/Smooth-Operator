/** `hover` action handler — dispatch mouseenter/mouseover/mousemove on the element. */

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
  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  return { action, success: true, message: `Hovered [${action.index}] <${el.tagName.toLowerCase()}>` };
}
