/**
 * `press_and_hold` action handler — CDP press-and-hold via the background SW
 * (trusted events that anti-bot widgets accept), with a native-click
 * fallback for the in-page demo + tests.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { moveCursorToElement } from "../../dom/phantom-cursor";
import { TIMINGS, sleep, SW_RPC_TIMEOUT_MS } from "../constants";
import { domFingerprint, resolveElement, safeScrollIntoView } from "../helpers";
import { type ActionContext, isExtensionContext } from "./types";

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
  safeScrollIntoView(el);
  await sleep(TIMINGS.clickScrollIntoView);
  const rect = el.getBoundingClientRect();
  await moveCursorToElement(el);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  const holdMs = action.hold_ms;
  const delayMs = action.delay_ms;

 // Strategy 1: CDP press-and-hold via the background script's
 // CDP_PRESS_AND_HOLD message handler. ONLY reachable in an extension
 // context (chrome.runtime.id). When the debugger is genuinely unavailable
 // (in-page demo, tests, no extension context) we skip straight to the
 // native fallback (Strategy 2) — that is the only case where a synthetic
 // click is an acceptable stand-in.
  const debuggerAvailable = isExtensionContext();

  if (debuggerAvailable) {
    try {
 // Race against a timeout so a SW that receives the message but never
 // responds (debugger attach race / hung SW) can't block the agent loop.
      const cdpResult = await Promise.race([
        chrome.runtime.sendMessage({
          type: "CDP_PRESS_AND_HOLD",
          x: cx,
          y: cy,
          holdMs,
          delayMs,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("CDP_PRESS_AND_HOLD timeout")), SW_RPC_TIMEOUT_MS),
        ),
      ]);
      if (cdpResult?.ok) {
        const changed = location.href !== ctx.beforeUrl || domFingerprint() !== ctx.beforeFingerprint;
        return {
          action,
          success: true,
          message: `Pressed and held [${action.index}] <${el.tagName.toLowerCase()}> (CDP, ${holdMs}ms)`,
          pageChanged: changed,
        };
      }
 // CDP responded but the hold was NOT performed (e.g. debugger not
 // attached). Do NOT fall back to a synthetic click: that would report
 // success while the hold never happened, so the agent might believe it
 // passed an anti-bot gate it didn't. Fail loudly instead.
      return {
        action,
        success: false,
        message:
          `press_and_hold: hold was NOT performed (CDP returned ` +
          `${cdpResult ? JSON.stringify(cdpResult) : "no result"}); ` +
          `anti-bot widgets will reject a synthetic click`,
      };
    } catch (e) {
 // The CDP hold genuinely failed (debugger attach error, messaging error,
 // or cdpPressAndHold threw). Surface the real error instead of swallowing
 // it into a false success — the agent must know the hold didn't happen so
 // it can retry or escalate rather than proceed past a verification gate it
 // didn't actually satisfy.
      if (typeof console !== "undefined" && typeof console.error === "function") {
        console.error("[press_and_hold] CDP hold failed:", e);
      }
      return {
        action,
        success: false,
        message:
          `press_and_hold failed: hold NOT performed ` +
          `(${e instanceof Error ? e.message : String(e)}); ` +
          `anti-bot widgets will reject a synthetic click`,
      };
    }
  }

 // Strategy 2: Native click fallback (no hold). ONLY reached when the debugger
 // is genuinely unavailable. The fallback degenerates to a click (no hold) —
 // the hold semantics can't be replicated without CDP. Real anti-bot widgets
 // will reject this, so the message says so explicitly.
  try {
    el.click();
    const changed = location.href !== ctx.beforeUrl || domFingerprint() !== ctx.beforeFingerprint;
    return {
      action,
      success: true,
      message: `Pressed [${action.index}] <${el.tagName.toLowerCase()}> (native fallback — no hold, debugger unavailable)`,
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
