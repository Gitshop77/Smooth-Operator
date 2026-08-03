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

export async function handleClick(
  ctx: ActionContext,
  action: Extract<Action, { type: "click" }>,
): Promise<ActionResult> {
  const { state } = ctx;

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
  await moveCursorToElement(el);
  safeScrollIntoView(el);
  await sleep(TIMINGS.clickScrollIntoView, ctx.signal);
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
    if (cdpCheck.error) {
      errors.push(cdpCheck.error);
    } else if (cdpCheck.strategyUsed === "CDP") {
      const cdpResult = await executeCdpClick(el);
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
  attempt(() => tryNativeClick(el));
  attempt(() => tryCssSelectorClick(el));
  attempt(() => tryTextSearchClick(el));
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
