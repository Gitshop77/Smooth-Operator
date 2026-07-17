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
import type { ActionContext } from "./types";
import { rejectOnAbort } from "./abort";

export async function handleDetectVisual(
  ctx: ActionContext,
  action: Extract<Action, { type: "detect_visual" }>,
): Promise<ActionResult> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
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
    let res:
      | { ok?: boolean; count?: number; description?: string; error?: string }
      | undefined
      | null;
 // Race the SW call against the timeout AND the step's abort signal so a user
 // STOP is honored mid-step instead of waiting out the full 30s timeout.
    const abort = rejectOnAbort(ctx.signal);
    try {
      res = (await Promise.race([
        chrome.runtime.sendMessage({
          type: "DETECT_VISUAL",
          query: action.query,
        }),
        new Promise<never>((_, reject) => {
          t = setTimeout(
            () => reject(new Error("detect_visual timed out waiting for the extension")),
            30000,
          );
        }),
        abort.promise,
      ])) as
        | { ok?: boolean; count?: number; description?: string; error?: string }
        | undefined
        | null;
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
    const count = typeof res.count === "number" ? res.count : 0;
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
