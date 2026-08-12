/**
 * `detect_visual` action handler — runs local vision detection on the current
 * screenshot via the background service worker. Returns detected UI elements
 * as [v1], [v2] etc. that the LLM can click on the next step.
 *
 * Only available in AI Adaptive vision mode. The SW handles the actual
 * detection (it has access to chrome.tabs.captureVisibleTab + the vision
 * assistant singleton). The content script just forwards the request.
 *
 * The action is exclusive (must be the only action in its step) because
 * detection takes 2-5 seconds and the results change the element indices
 * for subsequent actions.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { type ActionContext, isExtensionContext } from "./types";
import { rejectOnAbort } from "./abort";

// Vision detection is deliberately 2x the generic SW-RPC timeout
// (SW_RPC_TIMEOUT_MS = 15s): unlike CDP clicks / tab actions (fast message
// hops), `DETECT_VISUAL` runs the on-device vision model in the SW — the
// round trip includes a screenshot capture plus model inference, which
// routinely lands between 2-5s and can exceed 15s on first load / cold model
// startup (the action docblock above documents the 2-5s typical latency).
// The 30s cap still bounds a hung SW; a user STOP aborts immediately via
// `rejectOnAbort` regardless of the timeout.
const DETECT_VISUAL_TIMEOUT_MS = 30000;

type DetectVisualResponse = {
  ok?: boolean;
  count?: number;
  description?: string;
  error?: string;
};

export async function handleDetectVisual(
  ctx: ActionContext,
  action: Extract<Action, { type: "detect_visual" }>,
): Promise<ActionResult> {
  if (!isExtensionContext()) {
    return {
      action,
      success: false,
      message: "detect_visual requires the extension context",
    };
  }
  try {
    // `chrome.runtime.sendMessage` resolves `undefined` (not a rejection) when
    // no listener is present, so read the response through a typed shape and
    // validate each field before consuming it. Race the call against a timeout
    // so a busy/hung/crashed SW can't hang the agent step indefinitely.
    let t: ReturnType<typeof setTimeout> | undefined;
    let res: DetectVisualResponse | undefined | null;
    // Race the SW call against the timeout AND the step's abort signal so a user
    // STOP is honored mid-step instead of waiting out the full 30s timeout.
    const abort = rejectOnAbort(ctx.signal);
    try {
      res = (await Promise.race([
        chrome.runtime.sendMessage({
          type: "DETECT_VISUAL",
          query: action.query,
          ...(ctx.dispatchToken ? { token: ctx.dispatchToken } : {}),
          ...(ctx.effectCapability ? { effectCapability: ctx.effectCapability } : {}),
        }),
        new Promise<never>((_, reject) => {
          t = setTimeout(
            () => reject(new Error("detect_visual timed out waiting for the extension")),
            DETECT_VISUAL_TIMEOUT_MS,
          );
        }),
        abort.promise,
      ])) as DetectVisualResponse | undefined | null;
    } finally {
      if (t) clearTimeout(t);
      abort.cleanup();
    }
    if (typeof res?.ok !== "boolean" || !res.ok) {
      const err =
        res && typeof res.error === "string" && res.error ? res.error : "no response from extension";
      return {
        action,
        success: false,
        message: `detect_visual failed: ${err}`,
      };
    }
    const count = Number.isFinite(res.count) ? res.count : 0;
    const description =
      typeof res.description === "string" && res.description
        ? res.description
        : `Detected ${count} visual element(s). Use [v1], [v2] etc. to click them on the next step.`;
    return {
      action,
      success: true,
      message: `Detected ${count} visual element(s)`,
      extractedContent: description,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `detect_visual failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
