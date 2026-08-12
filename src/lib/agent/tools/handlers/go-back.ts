/**
 * `go_back` action handler — `history.back()` + reliable page-change detection.
 *
 * `history.back()` is the browser's own "navigate to the previous session
 * history entry". The agent's contract is: *issue* the back navigation and
 * report whether we successfully did so. A genuine failure is only when the
 * History API is unavailable or `history.back()` itself throws — both are
 * outside the agent's control, so we surface `success: false` there. When the
 * call is accepted we report `success: true` (the no-op case, where there is no
 * earlier entry, is silent and harmless — the browser simply does nothing and
 * we will report `pageChanged: false` below).
 *
 * We wait for the target document to actually settle before deciding whether
 * the page changed. The naive "sleep a fixed amount then check" form is a false
 * negative on slow back-navigations (network round-trip, heavy SPA) where the
 * target document hasn't committed yet. We instead poll `location.href` + DOM
 * fingerprint until they stop changing, then compare against the pre-action
 * baseline, so the result reflects the page as it actually settled.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, sleep } from "../constants";
import { domFingerprint } from "../helpers";
import { resolveBeforeFingerprint, type ActionContext } from "./types";

export async function handleGoBack(
  ctx: ActionContext,
  action: Extract<Action, { type: "go_back" }>,
): Promise<ActionResult> {
  // Genuine failure: the History API is not present (e.g. a non-browser
  // environment) or is not callable. There is nothing we can do but report it.
  if (typeof history === "undefined" || typeof history.back !== "function") {
    return {
      action,
      success: false,
      message: "Cannot go back: history API unavailable",
      pageChanged: false,
    };
  }

  // Issue the back navigation. `history.back()` returns void and only throws on
  // a malformed call; a no-op (no earlier entry) is silent. Either way the call
  // was *accepted*, so we report success — the page-settle check below records
  // whether anything actually changed.
  try {
    history.back();
  } catch {
    return {
      action,
      success: false,
      message: "Cannot go back: history.back() threw",
      pageChanged: false,
    };
  }

  // Wait for the target document to actually settle before deciding whether the
  // page changed (fixes false negatives on slow back-navigations).
  const pageChanged = await waitForPageSettle(ctx);
  return {
    action,
    success: true,
    message: "Navigated back",
    pageChanged,
  };
}

/**
 * Poll `location.href` + DOM fingerprint until two consecutive reads are
 * identical (the page has stopped changing), then report whether the settled
 * page differs from the pre-action baseline. Falls back to the last observed
 * state if the page never stabilizes within the navigation window.
 */
async function waitForPageSettle(ctx: ActionContext): Promise<boolean> {
  const deadline = Date.now() + TIMINGS.navigationBack;
  let prevUrl: string | null = null;
  let prevFp: string | null = null;
  while (Date.now() < deadline) {
    await sleep(TIMINGS.extractWait, ctx.signal);
    const url = location.href;
    // Fast path: if the URL already diverged from the pre-action baseline, the
    // navigation succeeded — return immediately without computing a fingerprint.
    if (url !== ctx.beforeUrl) return true;
    const fp = domFingerprint();
    // Seed both baselines on the first real read and only start the stability
    // comparison on the second read, so the page is declared stable only after
    // two consecutive identical reads (the full navigation window is honored).
    if (prevUrl === null) {
      prevUrl = url;
      prevFp = fp;
      continue;
    }
    if (url === prevUrl && fp === prevFp) {
      // Stable — stop polling.
      break;
    }
    prevUrl = url;
    prevFp = fp;
  }
  return prevUrl !== ctx.beforeUrl || prevFp !== resolveBeforeFingerprint(ctx);
}
