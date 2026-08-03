import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { SW_RPC_TIMEOUT_MS, TIMINGS, sleep } from "../constants";
import { generateCssSelector } from "../helpers";
import { type ActionContext, hasPageChanged, isExtensionContext } from "./types";

type CdpClickResult = { ok?: boolean; error?: string } | undefined | null;

export type ClickStrategyResult = {
  clicked: boolean;
  strategyUsed: string;
  error?: string;
};

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

function isOutsideViewport(x: number, y: number): boolean {
  // Coords are 0-based: the last visible pixel column is `innerWidth - 1`, so
  // a point AT `innerWidth`/`innerHeight` is already outside the viewport.
  return x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
}

export function tryCdpClick(el: HTMLElement): ClickStrategyResult {
  if (!isExtensionContext()) {
    return { clicked: false, strategyUsed: "" };
  }
  const r = el.getBoundingClientRect();
  const centerX = r.x + r.width / 2;
  const centerY = r.y + r.height / 2;
  if (isOutsideViewport(centerX, centerY)) {
    return {
      clicked: false,
      strategyUsed: "",
      error: `element center (${Math.round(centerX)},${Math.round(centerY)}) is outside the viewport (${window.innerWidth}x${window.innerHeight}) — skipping CDP coordinate click`,
    };
  }
  return { clicked: false, strategyUsed: "CDP" };
}

export async function executeCdpClick(
  el: HTMLElement,
): Promise<{ clicked: boolean; strategyUsed: string; error?: string; cdpUncertain?: boolean }> {
  const r = el.getBoundingClientRect();
  try {
    const cdpResult = await sendCdpClick({ x: r.x, y: r.y, width: r.width, height: r.height });
    if (cdpResult?.ok) {
      return { clicked: true, strategyUsed: "CDP" };
    } else if (cdpResult?.error) {
      return { clicked: false, strategyUsed: "", error: `CDP click failed: ${cdpResult.error}` };
    } else {
      return { clicked: false, strategyUsed: "", error: "CDP click: no response from service worker", cdpUncertain: true };
    }
  } catch (e) {
    const msg = (e as Error).message;
    return {
      clicked: false,
      strategyUsed: "",
      error: `CDP click failed: ${msg}`,
      cdpUncertain: msg.includes("CDP_CLICK timeout"),
    };
  }
}

export function tryNativeClick(el: HTMLElement): ClickStrategyResult {
  try {
    el.click();
    return { clicked: true, strategyUsed: "native" };
  } catch (e) {
    return { clicked: false, strategyUsed: "", error: `native click failed: ${(e as Error).message}` };
  }
}

export function tryCssSelectorClick(el: HTMLElement): ClickStrategyResult {
  const css = generateCssSelector(el);
  if (!css) return { clicked: false, strategyUsed: "" };
  try {
    // `generateCssSelector` can return a NON-unique selector (bare tag or
    // tag+classes when the element has no id), so `querySelector` — which
    // returns the FIRST match — could click a different element than the
    // target and report success. Require exactly one match (mirroring
    // `tryTextSearchClick`'s ambiguity guard): a unique match is either the
    // target or its re-created twin (the strategy's documented purpose);
    // anything else falls back to the next strategy instead of misclicking.
    const matches = Array.from(document.querySelectorAll(css));
    if (matches.length === 0) {
      return {
        clicked: false,
        strategyUsed: "",
        error: `CSS selector click skipped: selector "${css}" did not match any element`,
      };
    }
    if (matches.length > 1) {
      return {
        clicked: false,
        strategyUsed: "",
        error: `CSS selector click skipped: selector "${css}" matches ${matches.length} elements ambiguously`,
      };
    }
    const found = matches[0] as HTMLElement;
    if (found !== el) {
      found.click();
      return { clicked: true, strategyUsed: "css-selector" };
    }
    return { clicked: false, strategyUsed: "" };
  } catch (e) {
    return { clicked: false, strategyUsed: "", error: `CSS selector click failed: ${(e as Error).message}` };
  }
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

const TEXT_SEARCH_SCAN_CAP = 10000;

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

export function tryTextSearchClick(el: HTMLElement): ClickStrategyResult {
  try {
    if (!el.isConnected) {
      return { clicked: false, strategyUsed: "", error: "element became detached before JS text search click" };
    }
    const inputEl = el as HTMLInputElement;
    const targetText = (
      el.textContent ||
      inputEl.value ||
      el.getAttribute("placeholder") ||
      el.getAttribute("aria-label") ||
      ""
    ).trim();
    const targetType = el.tagName.toLowerCase();
    if (!targetText) return { clicked: false, strategyUsed: "" };
    const needle = normalize(targetText);
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    let count = 0;
    let firstMatch: Element | null = null;
    let scanned = 0;
    let cand: Element | null;
    while ((cand = walker.nextNode() as Element | null) && scanned < TEXT_SEARCH_SCAN_CAP) {
      scanned++;
      const candTag = cand.tagName.toLowerCase();
      if (candTag !== targetType) continue;
      if (typeof (cand as HTMLElement).click !== "function") continue;
      const candText = candidateText(cand);
      if (candText.length < needle.length) continue;
      if (normalize(candText) === needle) {
        count++;
        if (count === 1) firstMatch = cand;
        else if (count > 1) break;
      }
    }
    if (count === 1) {
      const match = firstMatch as HTMLElement;
      if (match !== el) {
        match.click();
        return { clicked: true, strategyUsed: "text-search" };
      }
      return { clicked: false, strategyUsed: "" };
    } else if (count > 1) {
      return {
        clicked: false,
        strategyUsed: "",
        error: `JS text search skipped: "${targetText}" matches ${count} elements ambiguously`,
      };
    }
    return { clicked: false, strategyUsed: "" };
  } catch (e) {
    return { clicked: false, strategyUsed: "", error: `JS text search click failed: ${(e as Error).message}` };
  }
}

export function tryDispatchedEventClick(el: HTMLElement): ClickStrategyResult {
  try {
    if (!el.isConnected) {
      return { clicked: false, strategyUsed: "", error: "element became detached before dispatched-event click" };
    }
    let ev: MouseEvent;
    try {
      ev = new MouseEvent("click", { view: window, bubbles: true, cancelable: true });
    } catch {
      ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    }
    el.dispatchEvent(ev);
    return { clicked: true, strategyUsed: "dispatched-event" };
  } catch (e) {
    return { clicked: false, strategyUsed: "", error: `dispatched event click failed: ${(e as Error).message}` };
  }
}

/** Handle clicking a vision-detected element via CDP coordinate click. */
export async function handleVisionClick(
  ctx: ActionContext,
  action: Extract<Action, { type: "click" }>,
  indexStr: string,
): Promise<ActionResult> {
  if (!isExtensionContext()) {
    return {
      action,
      success: false,
      message: `Vision click [${indexStr}] skipped: extension context unavailable`,
    };
  }
  try {
    const result = await sendCdpClick({ x: 0, y: 0, width: 1, height: 1 }, indexStr);
    if (result?.ok) {
      await sleep(TIMINGS.clickAfterSettle, ctx.signal);
      const changed = hasPageChanged(ctx);
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
