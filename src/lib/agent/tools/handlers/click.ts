/**
 * `click` action handler — 5-strategy click fallback.
 *
 * Strategy order: CDP coordinate click (extension context) → native
 * `el.click()` → CSS-selector re-find → JS text search → dispatched
 * `MouseEvent`. Stops at the first strategy that succeeds; if all fail,
 * returns `success: false` with the aggregated error messages.
 *
 * CDP is strategy 1 (not 2) in extension context. A "native first, CDP only
 * on throw" order would make CDP dead code for its intended purpose —
 * `el.click()` essentially never throws, so on hostile sites where the
 * handler checks `event.isTrusted` and silently rejects synthetic clicks,
 * native "succeeds" (no throw) but nothing happens, and CDP (which produces
 * `isTrusted: true` events) never runs. The `cdp-controller.ts` docstring
 * explicitly warns "`element.click()` silently fails on ~30% of real
 * websites". CDP-first matches `press-and-hold.ts` and gives the
 * production-grade interaction guarantee. The ~135-215ms/click overhead
 * (100ms MOUSE_MOVE_SETTLE_MS + debugger attach + message round-trip) is the
 * cost of correctness on the 30% of sites where native fails silently.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { moveCursorToElement } from "../../dom/phantom-cursor";
import { TIMINGS, sleep } from "../constants";
import {
  generateCssSelector,
  resolveElement,
  safeScrollIntoView,
} from "../helpers";
import { domFingerprint } from "../helpers";
import type { ActionContext } from "./types";

export async function handleClick(
  ctx: ActionContext,
  action: Extract<Action, { type: "click" }>,
): Promise<ActionResult> {
  const { state } = ctx;

  // Vision-detected elements have a `vN` string index (e.g. "v1"). They have
  // no DOM counterpart in `state.selectorMap` — they were detected purely by
  // the Local Vision Assistant — so we route them to a CDP coordinate click
  // at the cached pixel rect (populated by agent-bridge's extractState).
  // The ClickSchema's regex arm (`/^v\d+$/`) guarantees any string index is a
  // vision index, so we don't need a `startsWith("v")` re-check here.
  if (typeof action.index === "string") {
    return handleVisionClick(ctx, action, action.index);
  }

  // Numeric index → resolve a live HTMLElement from the browser state's
  // selector map. TypeScript narrows `action.index` to `number` here.
  const numericIndex = action.index;
  const el = resolveElement(state, numericIndex);
  highlightElement(el, `click [${numericIndex}]`);
  // Move phantom cursor to the element for visual feedback.
  await moveCursorToElement(el);
  safeScrollIntoView(el);
  await sleep(TIMINGS.clickScrollIntoView);
  // Focus before clicking (triggers focus handlers used by some frameworks).
  if (typeof el.focus === "function") el.focus();

  // ─── 5-strategy click fallback ────────────────────────────────────
  //
  // Each strategy is wrapped in try/catch. We stop as soon as one
  // succeeds (no exception + the operation completed). If all 5
  // strategies fail, the action returns `success: false` with the
  // aggregated error messages.
  //
  //   1. CDP coordinate click (extension context only) —
  //      `Input.dispatchMouseEvent` at the element's center, via the
  //      background script. Slower (~135-215ms, 100ms settle + debugger
  //      attach + message round-trip) but produces `isTrusted: true` events
  //      that hostile sites (Cloudflare Turnstile, anti-bot widgets) accept.
  //      This is the production-grade interaction method.
  //   2. Native `el.click()` — the standard DOM click. Fires a
  //      bubbling `MouseEvent` that React/jQuery/etc. listeners
  //      handle correctly. Cheapest (~0ms), works for ~70% of sites.
  //      Used as the fallback when CDP isn't available (tests, in-page
  //      demo) or when CDP fails (debugger rejected, tab closed).
  //   3. CSS-selector click — re-find the element via a generated CSS
  //      selector and click the re-found element.
  //   4. JS text search — walk `document.querySelectorAll('*')` to
  //      find an element whose textContent matches, and click it.
  //   5. Dispatched `MouseEvent` — `el.dispatchEvent(new MouseEvent(
  //      'click', { bubbles, cancelable, view }))`.
  //
  // CDP-first in extension context is deliberate: native `el.click()`
  // silently fails on ~30% of sites (isTrusted-gated handlers), so trying
  // native first would report false success and never reach CDP. Mirrors
  // `press-and-hold.ts`.
  const errors: string[] = [];
  let clicked = false;
  let strategyUsed = "native";

  // Strategy 1: CDP coordinate click (extension context only).
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    try {
      const cdpResult = await chrome.runtime.sendMessage({
        type: "CDP_CLICK",
        rect: el.getBoundingClientRect(),
      });
      if (cdpResult?.ok) {
        clicked = true;
        strategyUsed = "CDP";
      } else if (cdpResult?.error) {
        errors.push(`CDP click failed: ${cdpResult.error}`);
      }
    } catch (e) {
      errors.push(`CDP click failed: ${(e as Error).message}`);
    }
  }

  // Strategy 2: Native el.click() — the standard DOM click.
  if (!clicked) {
    try {
      el.click();
      clicked = true;
      strategyUsed = "native";
    } catch (e) {
      errors.push(`native click failed: ${(e as Error).message}`);
    }
  }

  // Strategy 3: CSS-selector click — re-find via a generated selector.
  if (!clicked) {
    const css = generateCssSelector(el);
    if (css) {
      try {
        const found = document.querySelector(css) as HTMLElement | null;
        if (found && found !== el) {
          found.click();
          clicked = true;
          strategyUsed = "css-selector";
        } else if (found === el) {
          // Selector matches the same element — calling .click() again
          // would fire a second click on the same target. Skip and
          // move to the next strategy.
        }
      } catch (e) {
        errors.push(`CSS selector click failed: ${(e as Error).message}`);
      }
    }
  }

  // Strategy 4: JS text search — find element by text content, click.
  if (!clicked) {
    try {
      const inputEl = el as HTMLInputElement;
      const targetText = (
        el.textContent ||
        inputEl.value ||
        el.getAttribute("placeholder") ||
        el.getAttribute("aria-label") ||
        ""
      ).trim();
      const targetType = el.tagName.toLowerCase();
      if (targetText) {
        const all = Array.from(document.querySelectorAll("*"));
        const match = all.find((cand) => {
          const candText = (cand.textContent || "").trim();
          const candTag = cand.tagName.toLowerCase();
          return (
            candText.length > 0 &&
            candText.includes(targetText) &&
            candTag === targetType &&
            typeof (cand as HTMLElement).click === "function"
          );
        });
        if (match && match !== el) {
          (match as HTMLElement).click();
          clicked = true;
          strategyUsed = "text-search";
        }
      }
    } catch (e) {
      errors.push(`JS text search click failed: ${(e as Error).message}`);
    }
  }

  // Strategy 5: Dispatched MouseEvent.
  //
  // Some environments (jsdom, certain embedded WebViews) reject the
  // `view: window` member of the MouseEvent init dict because their
  // `window` doesn't pass their own `Window` interface check — the
  // constructor throws `TypeError: member view is not of type Window`.
  // We retry without `view` in that case so the dispatch path still
  // fires the click listener (the `view` property is rarely read by
  // application code; it's mostly used by frameworks that already
  // fell back to `isTrusted`).
  if (!clicked) {
    try {
      let ev: MouseEvent;
      try {
        ev = new MouseEvent("click", {
          view: window,
          bubbles: true,
          cancelable: true,
        });
      } catch {
        ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      }
      el.dispatchEvent(ev);
      clicked = true;
      strategyUsed = "dispatched-event";
    } catch (e) {
      errors.push(`dispatched event click failed: ${(e as Error).message}`);
    }
  }

  await sleep(TIMINGS.clickAfterSettle);
  const changed = location.href !== ctx.beforeUrl || domFingerprint() !== ctx.beforeFingerprint;
  if (!clicked) {
    return {
      action,
      success: false,
      message: `Failed to click [${numericIndex}] after 5 strategies: ${errors.join("; ")}`,
    };
  }
  return {
    action,
    success: true,
    message: `Clicked [${numericIndex}] <${el.tagName.toLowerCase()}> (${strategyUsed})`,
    pageChanged: changed,
  };
}

/** Handle clicking a vision-detected element via CDP coordinate click. */
async function handleVisionClick(
  ctx: ActionContext,
  action: Extract<Action, { type: "click" }>,
  indexStr: string,
): Promise<ActionResult> {
  const { beforeUrl, beforeFingerprint } = ctx;
  try {
    // Send CDP_CLICK to the background service worker with the vision element's pixel coordinates
    // The background's message-routing.ts CDP_CLICK handler does Input.dispatchMouseEvent
    const result = await chrome.runtime.sendMessage({
      type: "CDP_CLICK",
      rect: { x: 0, y: 0, width: 1, height: 1 }, // placeholder — the background will use the vision cache
      visionIndex: indexStr,
    });
    if (result?.ok) {
      await sleep(TIMINGS.clickAfterSettle);
      const changed = location.href !== beforeUrl || domFingerprint() !== beforeFingerprint;
      return {
        action,
        success: true,
        message: `Clicked [${indexStr}] vision element (CDP)`,
        pageChanged: changed,
      };
    }
    return {
      action,
      success: false,
      message: `CDP click failed for vision element [${indexStr}]: ${result?.error || "unknown"}`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `Vision click [${indexStr}] failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
