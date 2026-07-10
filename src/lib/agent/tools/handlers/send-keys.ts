/**
 * `send_keys` action handler — dispatch synthetic keydown/keyup (and
 * keypress for Enter) to the active element, plus submit the enclosing form
 * when the main key is `Enter`.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, sleep } from "../constants";
import { parseKeys } from "../helpers";
import type { ActionContext } from "./types";

export async function handleSendKeys(
  _ctx: ActionContext,
  action: Extract<Action, { type: "send_keys" }>,
): Promise<ActionResult> {
  const parsed = parseKeys(action.keys);
  const target = (document.activeElement as HTMLElement) || document.body;
  const opts: KeyboardEventInit = {
    key: parsed.main,
    bubbles: true,
    cancelable: true,
    ctrlKey: parsed.ctrl,
    shiftKey: parsed.shift,
    altKey: parsed.alt,
    metaKey: parsed.meta,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  if (parsed.main === "Enter") {
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
  }
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
  if (parsed.main === "Enter") {
    const form = target.closest("form");
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
  }
  await sleep(TIMINGS.keyEventAfter);
  return { action, success: true, message: `Sent keys: ${action.keys}` };
}
