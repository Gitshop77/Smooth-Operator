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
import { SW_RPC_TIMEOUT_MS, TIMINGS, sleep } from "../constants";
import {
  generateCssSelector,
  resolveElement,
  safeScrollIntoView,
} from "../helpers";
import type { ActionContext } from "./types";
import { hasPageChanged } from "./types";

type CdpClickResult = { ok?: boolean; error?: string } | undefined | null;

/** Send a CDP_CLICK to the background SW and return the normalized result.
 *
 * Races the round-trip against a timeout so a SW that accepts the message
 * but never calls sendResponse can't hang the agent step indefinitely. The
 * timeout timer is cleared in a finally block regardless of outcome. */
async function sendCdpClick(
  rect: { x: number; y: number; width: number; height: number },
  visionIndex?: string,
): Promise<CdpClickResult> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      chrome.runtime.sendMessage(
        visionIndex !== undefined
          ? { type: "CDP_CLICK", rect, visionIndex }
          : { type: "CDP_CLICK", rect },
      ),
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error("CDP_CLICK timeout")), SW_RPC_TIMEOUT_MS);
      }),
    ])) as CdpClickResult;
  } finally {
    if (t) clearTimeout(t);
  }
}

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

 // Reject stale/detached nodes before doing anything with them. A node may
 // become detached between state extraction and this click (SPA re-render,
 // navigation, or a node replacement). Strategy 1 (CDP) calls
 // `getBoundingClientRect()`, which returns all-zero rects for a detached
 // node, so CDP would dispatch a click at the viewport origin (0,0) — often
 // a fixed header or nothing — while still reporting `ok: true`. That is a
 // silent wrong-target click reported as success, which is worse than
 // failing. Returning a clear "detached" error lets the orchestrator
 // re-extract state rather than act on a stale node. (Also guards the
 // highlight/scroll/focus side effects below against a dead reference.)
  if (!el || !el.isConnected) {
    return {
      action,
      success: false,
      message: `element [${numericIndex}] is detached (page may have changed — extract state again)`,
    };
  }

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
 // 1. CDP coordinate click (extension context only) —
 // `Input.dispatchMouseEvent` at the element's center, via the
 // background script. Slower (~135-215ms, 100ms settle + debugger
 // attach + message round-trip) but produces `isTrusted: true` events
 // that hostile sites (Cloudflare Turnstile, anti-bot widgets) accept.
 // 2. Native `el.click()` — the standard DOM click. Fires a
 // bubbling `MouseEvent` that React/jQuery/etc. listeners
 // handle correctly. Cheapest (~0ms), works for ~70% of sites.
 // Used as the fallback when CDP isn't available (tests, in-page
 // demo) or when CDP fails (debugger rejected, tab closed).
 // 3. CSS-selector click — re-find the element via a generated CSS
 // selector, but ONLY when that selector resolves to exactly one
 // element in the document. The generated selector is explicitly NOT
 // guaranteed unique (e.g. a classless element yields the raw tag
 // "div"); clicking the first document-order match of a non-unique
 // selector would hit an unrelated element, so non-unique selectors
 // are skipped rather than risked.
 // 4. JS text search — walk `document.querySelectorAll('*')` to find a
 // UNIQUE element whose (whitespace-normalized) textContent is an
 // EXACT match for the target's text, and click it. Substring hits
 // and ambiguous multi-matches are skipped to avoid wrong-element
 // clicks.
 // 5. Dispatched `MouseEvent` — `el.dispatchEvent(new MouseEvent(
 // 'click', { bubbles, cancelable, view }))`.
 //
 // CDP-first in extension context is deliberate: native `el.click()`
 // silently fails on ~30% of sites (isTrusted-gated handlers), so trying
 // native first would report false success and never reach CDP. Mirrors
 // `press-and-hold.ts`.
  const errors: string[] = [];
  let clicked = false;
  // Set when a CDP click is dispatched but its outcome is unknown (SW timeout
  // or no response). The in-flight SW click may still land after the JS-side
  // timeout, so we must NOT fall through to the native/dispatch fallbacks —
  // doing so would double-click the target.
  let cdpUncertain = false;
 // Every path that sets `clicked = true` also assigns `strategyUsed`, so the
 // only value that can reach the success message is one of those. Initialize
 // to an empty sentinel to make that invariant explicit (the previous
 // "native" default was dead — it could never be returned).
  let strategyUsed = "";

 // Strategy 1: CDP coordinate click (extension context only).
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    try {
 // `DOMRect`'s x/y/width/height are prototype accessors, not own-enumerable
 // properties, so passing the raw rect through structured-clone messaging
 // serializes to `{}` and the background rejects it (rect.x !== "number").
 // Send a plain object with the coordinates copied out (mirrors
 // `press-and-hold.ts`).
      {
        const r = el.getBoundingClientRect();
 // Reject coordinates outside the visual viewport. CDP
 // `Input.dispatchMouseEvent` does NOT error on out-of-bounds coordinates, so
 // a click dispatched past a viewport edge would silently no-op (or hit a
 // fixed overlay) while being reported ok:true — a silent misclick. Bounds
 // are checked on the element CENTER; if it falls outside, skip CDP and let
 // the native/selector fallbacks below handle it instead of firing blind.
        const centerX = r.x + r.width / 2;
        const centerY = r.y + r.height / 2;
        if (
          centerX < 0 || centerY < 0 ||
          centerX > window.innerWidth || centerY > window.innerHeight
        ) {
          errors.push(
            `element center (${Math.round(centerX)},${Math.round(centerY)}) is outside the viewport (${window.innerWidth}x${window.innerHeight}) — skipping CDP coordinate click`,
          );
        } else {
          const cdpResult = await sendCdpClick({ x: r.x, y: r.y, width: r.width, height: r.height });
          if (cdpResult?.ok) {
            clicked = true;
            strategyUsed = "CDP";
          } else if (cdpResult?.error) {
            errors.push(`CDP click failed: ${cdpResult.error}`);
          } else {
            errors.push("CDP click: no response from service worker");
            cdpUncertain = true;
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`CDP click failed: ${msg}`);
      if (msg.includes("CDP_CLICK timeout")) cdpUncertain = true;
    }
  }

 // Strategy 2: Native el.click() — the standard DOM click.
  if (!clicked && !cdpUncertain) {
    try {
      if (el.isConnected) {
        el.click();
        clicked = true;
        strategyUsed = "native";
      } else {
        errors.push("element became detached before native click");
      }
    } catch (e) {
      errors.push(`native click failed: ${(e as Error).message}`);
    }
  }

 // Strategy 3: CSS-selector click — re-find via a generated selector.
 //
 // `generateCssSelector` is documented as NOT guaranteed unique (a classless
 // element resolves to its raw tag, e.g. "div"). `document.querySelector`
 // returns the first document-order match, so a non-unique selector could
 // click an unrelated element. We therefore only proceed when the selector
 // resolves to exactly ONE element in the document — that single match is
 // guaranteed to be the intended target (whether it's the element we already
 // hold or, in the stale-node case, the live element that replaced it).
  if (!clicked && !cdpUncertain) {
    const css = generateCssSelector(el);
    if (css) {
      try {
        const matches = document.querySelectorAll(css);
        if (matches.length === 1) {
          const found = matches[0] as HTMLElement;
          if (found !== el) {
            found.click();
            clicked = true;
            strategyUsed = "css-selector";
          } else {
 // Unique match is the same node we already hold — a re-click
 // would fire a second click on the same target. Skip and move
 // to the next strategy.
          }
        } else {
          errors.push(
            `CSS selector click skipped: selector "${css}" is not unique (${matches.length} matches)`,
          );
        }
      } catch (e) {
        errors.push(`CSS selector click failed: ${(e as Error).message}`);
      }
    }
  }

 // Strategy 4: JS text search — find element by EXACT text content, click.
 //
 // A substring match (the old `includes()`) against a short target like
 // "OK", "Save", or "1" would match many unrelated elements of the same
 // tag, and an element that only *contains* the target as a substring
 // (e.g. a "Save changes" label for target "Save") would win the find and
 // get clicked. We therefore require an EXACT, whitespace-normalized,
 // full-text match, and we require that match to be UNIQUE. Multiple
 // identical labels are ambiguous — skipping is safer than guessing the
 // first document-order match. The unique match is clicked only when it is
 // a different node (the stale-element replacement); if it's the element we
 // already hold, a re-click would double-fire, so we skip.
  if (!clicked && !cdpUncertain) {
    try {
      if (!el.isConnected) {
        errors.push("element became detached before JS text search click");
      } else {
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
        const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
        const needle = normalize(targetText);
       // Mirror how `targetText` is derived from `el`: for value-bearing form
       // controls (input/textarea/select) the visible label lives in `value` /
       // `placeholder` / `aria-label`, NOT `textContent` (which is empty for an
       // <input>). Comparing candidates by `textContent` alone would never
       // match a target chosen by its value, so derive the candidate's
       // comparable text the same way (finding: text-search fallback never
       // matched value-bearing form controls).
        const candidateText = (c: Element): string => {
          const t = c.tagName.toLowerCase();
          const ce = c as HTMLInputElement;
          if (t === "input" || t === "textarea" || t === "select") {
            return (
              ce.value ||
              ce.getAttribute("placeholder") ||
              ce.getAttribute("aria-label") ||
              ce.textContent ||
              ""
            ).trim();
          }
          return (c.textContent || "").trim();
        };
        const all = document.querySelectorAll("*");
        let count = 0;
        let firstMatch: Element | null = null;
        for (let i = 0; i < all.length; i++) {
          const cand = all[i];
          const candTag = cand.tagName.toLowerCase();
          const candText = candidateText(cand);
          if (
            candTag === targetType &&
            typeof (cand as HTMLElement).click === "function" &&
            candText.length >= needle.length &&
            normalize(candText) === needle
          ) {
            count++;
            if (count === 1) firstMatch = cand;
            else if (count > 1) break; // ambiguous — stop scanning
          }
        }
        if (count === 1) {
          const match = firstMatch as HTMLElement;
          if (match !== el) {
            match.click();
            clicked = true;
            strategyUsed = "text-search";
          } else {
 // Unique match is the same node we already hold — skip to avoid
 // a double click.
          }
        } else if (count > 1) {
          errors.push(
            `JS text search skipped: "${targetText}" matches ${count} elements ambiguously`,
          );
        }
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
  if (!clicked && !cdpUncertain) {
    try {
      if (!el.isConnected) {
        errors.push("element became detached before dispatched-event click");
      } else {
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
      }
    } catch (e) {
      errors.push(`dispatched event click failed: ${(e as Error).message}`);
    }
  }

  await sleep(TIMINGS.clickAfterSettle);
  // If the CDP click is still in flight (timed out / no SW response) we did not
  // fall through to the other strategies, so report the uncertain state instead
  // of a misleading "failed after 5 strategies" (which would under-count a
  // click that may yet land).
  if (!clicked && cdpUncertain) {
    return {
      action,
      success: false,
      message: `CDP click for [${numericIndex}] is still in flight (timed out / no response from service worker) — not falling back to other strategies to avoid a double click`,
    };
  }
  const changed = hasPageChanged(ctx);
  if (!clicked) {
    return {
      action,
      success: false,
      message: `Failed to click [${numericIndex}] after 5 strategies: ${errors.slice(-3).join("; ")}`,
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
  // The numeric-index path guards `chrome.runtime` presence; the vision path
 // must too — without it a missing extension context would throw a raw
 // ReferenceError instead of reporting a clean failure .
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    return {
      action,
      success: false,
      message: `Vision click [${indexStr}] skipped: extension context unavailable`,
    };
  }
  try {
 // Send CDP_CLICK to the background service worker with the vision element's pixel coordinates
 // The background's message-routing.ts CDP_CLICK handler does Input.dispatchMouseEvent
    const result = await sendCdpClick({ x: 0, y: 0, width: 1, height: 1 }, indexStr);
    if (result?.ok) {
      await sleep(TIMINGS.clickAfterSettle);
      const changed = hasPageChanged(ctx);
      return {
        action,
        success: true,
        message: `Clicked [${indexStr}] vision element (CDP)`,
        pageChanged: changed,
      };
    }
 // Include the FULL result (not just `result?.error`, which may be undefined
 // for a malformed SW response) so a CDP hiccup is diagnosable. Unlike
 // numeric-index clicks, vision indices have no native/dispatch fallback
 // strategy, so a clear error is the only recourse .
    return {
      action,
      success: false,
      message: `CDP click failed for vision element [${indexStr}]: ${
        result?.error || "unknown error"
      } (result: ${JSON.stringify(result ?? null)})`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `Vision click [${indexStr}] failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
