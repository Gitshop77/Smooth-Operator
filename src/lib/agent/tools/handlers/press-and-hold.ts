/**
 * `press_and_hold` action handler — CDP press-and-hold via the background SW
 * (trusted events that anti-bot widgets accept), with a native-click
 * fallback for the in-page demo + tests.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { moveCursorToElement } from "../../dom/phantom-cursor";
import { TIMINGS, sleep } from "../constants";
import { resolveElement, safeScrollIntoView } from "../helpers";
import { domFingerprint } from "../helpers";
import type { ActionContext } from "./types";

export async function handlePressAndHold(
  ctx: ActionContext,
  action: Extract<Action, { type: "press_and_hold" }>,
): Promise<ActionResult> {
  const { state } = ctx;
  // Press-and-hold via the CDP controller (chrome.debugger).
  // CDP-dispatched `Input.dispatchMouseEvent` events are treated as
  // trusted user input by the browser — required by anti-bot widgets
  // (Cloudflare Turnstile checkboxes, "press and hold to verify"
  // buttons) that detect synthetic clicks via `event.isTrusted`.
  //
  // Falls back to a regular `el.click()` (strategy 2 path) when the
  // debugger isn't available (in-page demo, tests, or extension
  // contexts where the user hasn't accepted the debugger infobar).
  const el = resolveElement(state, action.index);
  highlightElement(el, `press_and_hold [${action.index}]`);
  await moveCursorToElement(el);
  safeScrollIntoView(el);
  await sleep(TIMINGS.clickScrollIntoView);
  const rect = el.getBoundingClientRect();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  const holdMs = action.hold_ms;
  const delayMs = action.delay_ms;

  // Strategy 1: CDP press-and-hold via the background script's
  // CDP_PRESS_AND_HOLD message handler. Only available in extension
  // context (chrome.runtime.id).
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    try {
      const cdpResult = await chrome.runtime.sendMessage({
        type: "CDP_PRESS_AND_HOLD",
        x: cx,
        y: cy,
        holdMs,
        delayMs,
      });
      if (cdpResult?.ok) {
        const changed = location.href !== ctx.beforeUrl || domFingerprint() !== ctx.beforeFingerprint;
        return {
          action,
          success: true,
          message: `Pressed and held [${action.index}] <${el.tagName.toLowerCase()}> (CDP, ${holdMs}ms)`,
          pageChanged: changed,
        };
      }
    } catch (e) {
      // Fall through to the native-click fallback below.
      // Swallow the CDP error — the fallback path will still produce
      // a usable result, and the LLM sees the final action-result
      // message rather than an internal CDP failure.
      void e;
    }
  }

  // Strategy 2: Native click fallback (no hold). Useful for tests +
  // in-page demo. The fallback degenerates to a click (no hold) — the
  // hold semantics can't be replicated without CDP. Real anti-bot
  // widgets will reject this, but at least the action doesn't crash.
  try {
    el.click();
    const changed = location.href !== ctx.beforeUrl || domFingerprint() !== ctx.beforeFingerprint;
    return {
      action,
      success: true,
      message: `Pressed [${action.index}] <${el.tagName.toLowerCase()}> (native fallback — no hold)`,
      pageChanged: changed,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `press_and_hold failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
