/**
 * `send_keys` action handler.
 *
 * IMPORTANT — synthetic events do not mutate fields:
 * Browsers never apply *default actions* for synthetic (non-trusted)
 * `KeyboardEvent`s. So dispatching `keydown`/`keyup` to an `<input>`/`<textarea>`
 * does NOT change its `.value`: typing a character, `Backspace`, `Delete`,
 * `ArrowLeft`, etc. are all no-ops at the DOM level. The only path that ever
 * produced a real side effect was `Enter` → `form.requestSubmit()`.
 *
 * To make `send_keys` actually do something for the common text-editing keys,
 * we apply the equivalent edit imperatively (mirroring `input.ts`, which exists
 * precisely because value-setting must bypass React's tracked setter) and then
 * still dispatch the synthetic events so any key listeners fire. We also report
 * an honest `success`/`message` instead of claiming success for a no-op.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, sleep } from "../constants";
import { parseKeys } from "../helpers";
import type { ActionContext } from "./types";
import {
  keyEventCodes,
  isPrintableKey,
  isTextInput,
  isEditableTarget,
  applyEditableMutation,
  CARET_KEYS,
  CONTENT_KEYS,
} from "./send-keys-utils";

export { keyEventCodes } from "./send-keys-utils";

export async function handleSendKeys(
  ctx: ActionContext,
  action: Extract<Action, { type: "send_keys" }>,
): Promise<ActionResult> {
  let parsed;
  try {
    parsed = parseKeys(action.keys);
  } catch (e) {
    return {
      action,
      success: false,
      message: `Sent keys: failed to parse "${action.keys}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  const target = (document.activeElement as HTMLElement) || document.body;
  if (!target) {
    return {
      action,
      success: false,
      message: `Sent keys: ${action.keys} — no focusable target (no active element or body)`,
    };
  }

  const { keyCode, which, code } = keyEventCodes(parsed.main);
  const opts: KeyboardEventInit = {
    key: parsed.main,
    keyCode,
    which,
    code,
    bubbles: true,
    cancelable: true,
    ctrlKey: parsed.ctrl,
    shiftKey: parsed.shift,
    altKey: parsed.alt,
    metaKey: parsed.meta,
  };
  const textTarget = isTextInput(target) ? target : null;
  const valueBefore = textTarget ? textTarget.value : undefined;
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  if (parsed.main === "Enter" || isPrintableKey(parsed)) {
    target.dispatchEvent(new KeyboardEvent("keypress", opts));
  }
  target.dispatchEvent(new KeyboardEvent("keyup", opts));

  let mutated = textTarget !== null && textTarget.value !== valueBefore;
  if (!mutated) {
    try {
      mutated = applyEditableMutation(target, parsed);
    } catch (e) {
      return {
        action,
        success: false,
        message: `Sent keys: ${action.keys} — edit application failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }

  if (parsed.main === "Enter" && !parsed.shift && !parsed.ctrl && !parsed.alt && !parsed.meta) {
    const form = target.closest("form");
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
  }

  await sleep(TIMINGS.keyEventAfter, ctx.signal);

  const isMutationKey =
    isPrintableKey(parsed) || CONTENT_KEYS.has(parsed.main);
  const isNavigationKey = CARET_KEYS.has(parsed.main);

  if (isMutationKey) {
    if (!isEditableTarget(target)) {
      return {
        action,
        success: false,
        message: `Sent keys: ${action.keys} — target is not an editable field, so no text was entered or modified`,
      };
    }
    if (!mutated) {
      return {
        action,
        success: false,
        message: `Sent keys: ${action.keys} — the field did not accept the edit (e.g. contentEditable rejected it or selection was invalid)`,
      };
    }
  }

  if (isNavigationKey && !isEditableTarget(target)) {
    return {
      action,
      success: true,
      message: `Sent keys: ${action.keys} (dispatched to non-editable control; native action suppressed for synthetic events)`,
    };
  }

  const isArrowUpDown = parsed.main === "ArrowUp" || parsed.main === "ArrowDown";
  const message = mutated
    ? `Sent keys: ${action.keys} (applied to editable field)`
    : isArrowUpDown && isEditableTarget(target)
      ? `Sent keys: ${action.keys} (dispatched; native caret movement not applied for synthetic events)`
      : `Sent keys: ${action.keys}`;
  return { action, success: true, message };
}
