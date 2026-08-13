import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { highlightElement } from "../../dom/overlay";
import { moveCursorToElement } from "../../dom/phantom-cursor";
import { TIMINGS, sleep } from "../constants";
import { resolveElement, safeScrollIntoView } from "../helpers";
import { type ActionContext, hasPageChanged, isExtensionContext } from "./types";
import {
  type ClickStrategyResult,
  executeCdpClick,
  handleVisionClick,
  tryCdpClick,
  tryCssSelectorClick,
  tryDispatchedEventClick,
  tryNativeClick,
  tryTextSearchClick,
} from "./click-utils";
import { throwIfAborted } from "./abort";

export async function handleClick(
  ctx: ActionContext,
  action: Extract<Action, { type: "click" }>,
): Promise<ActionResult> {
  const { state } = ctx;
  throwIfAborted(ctx.signal);

  if (typeof action.index === "string") {
    return handleVisionClick(ctx, action, action.index);
  }

  const numericIndex = action.index;
  const el = resolveElement(state, numericIndex);

  if (!el || !el.isConnected) {
    return {
      action,
      success: false,
      message: `element [${numericIndex}] is detached (page may have changed — extract state again)`,
    };
  }

  highlightElement(el, `click [${numericIndex}]`);
  throwIfAborted(ctx.signal);
  // Scroll + settle BEFORE moving the phantom cursor (mirrors the hover
  // contract): the cursor must target the element's POST-scroll viewport
  // position, and the visual feedback should match what the user sees.
  safeScrollIntoView(el);
  await sleep(TIMINGS.clickScrollIntoView, ctx.signal);
  throwIfAborted(ctx.signal);
  await moveCursorToElement(el);
  throwIfAborted(ctx.signal);
  if (typeof el.focus === "function") el.focus();

  const errors: string[] = [];
  let clicked = false;
  let cdpUncertain = false;
  let strategyUsed = "";

  const attempt = (strategy: () => ClickStrategyResult): void => {
    if (clicked || cdpUncertain) return;
    const result = strategy();
    if (result.clicked) {
      clicked = true;
      strategyUsed = result.strategyUsed;
    } else if (result.error) {
      errors.push(result.error);
    }
  };

  // Strategy 1: CDP coordinate click (extension context only).
  const cdpCheck = tryCdpClick(el);
  if (isExtensionContext()) {
    if (cdpCheck.occluded) {
      // A covering overlay intercepts the center. The JS strategies would
      // dispatch onto the overlay (or "click through" visually) — hard-stop
      // and surface the real cause to the LLM instead.
      return {
        action,
        success: false,
        message: `Click [${numericIndex}] blocked: ${cdpCheck.error}`,
      };
    }
    if (cdpCheck.error) {
      errors.push(cdpCheck.error);
    } else if (cdpCheck.strategyUsed === "CDP") {
      const cdpResult = await executeCdpClick(el, ctx.dispatchToken, ctx.signal, action, ctx.effectCapability);
      if (cdpResult.clicked) {
        clicked = true;
        strategyUsed = "CDP";
      } else if (cdpResult.error) {
        errors.push(cdpResult.error);
      }
      if (cdpResult.cdpUncertain) cdpUncertain = true;
    }
  }

  // Strategies 2-5: fall back until one clicks.
  throwIfAborted(ctx.signal);
  attempt(() => tryNativeClick(el));
  throwIfAborted(ctx.signal);
  attempt(() => tryCssSelectorClick(el));
  throwIfAborted(ctx.signal);
  attempt(() => tryTextSearchClick(el));
  throwIfAborted(ctx.signal);
  attempt(() => tryDispatchedEventClick(el));

  await sleep(TIMINGS.clickAfterSettle, ctx.signal);

  if (!clicked && cdpUncertain) {
    return {
      action,
      success: false,
      message: `CDP click for [${numericIndex}] is still in flight (timed out / no response from service worker) — not falling back to other strategies to avoid a double click`,
    };
  }
  const tagName = el.tagName.toLowerCase();
  const isNavigationClick = tagName === "a" ||
    (tagName === "button" && (el as HTMLButtonElement).type === "submit") ||
    strategyUsed === "CDP";
  const changed = isNavigationClick ? hasPageChanged(ctx) : false;
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
    message: `Clicked [${numericIndex}] <${tagName}> (${strategyUsed})`,
    pageChanged: changed,
  };
}
