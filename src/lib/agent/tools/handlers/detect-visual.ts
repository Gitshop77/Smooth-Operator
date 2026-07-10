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

export async function handleDetectVisual(
  _ctx: ActionContext,
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
    const res = (await chrome.runtime.sendMessage({
      type: "DETECT_VISUAL",
      query: action.query,
    })) as {
      ok: boolean;
      count?: number;
      description?: string;
      error?: string;
    };
    if (!res?.ok) {
      return {
        action,
        success: false,
        message: `detect_visual failed: ${res?.error || "no response"}`,
      };
    }
    return {
      action,
      success: true,
      message: `Detected ${res.count ?? 0} visual element(s)`,
      extractedContent: res.description ?? `Detected ${res.count ?? 0} visual element(s). Use [v1], [v2] etc. to click them on the next step.`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `detect_visual failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
