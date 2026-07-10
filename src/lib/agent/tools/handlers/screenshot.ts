/**
 * `screenshot` action handler — explicitly save a standalone screenshot file
 * to the user's Downloads folder via the background SW's `SCREENSHOT`
 * message (the content script can't call `chrome.tabs.captureVisibleTab` or
 * `chrome.downloads`). In the in-page demo, capture is unavailable.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

export async function handleScreenshot(
  _ctx: ActionContext,
  action: Extract<Action, { type: "screenshot" }>,
): Promise<ActionResult> {
  // The orchestrator already attaches a fresh screenshot to every
  // `extractState` call so the LLM sees one per step. The `screenshot`
  // ACTION is for explicitly saving a standalone screenshot file to the
  // user's Downloads folder. The content script can't call
  // `chrome.tabs.captureVisibleTab` or `chrome.downloads`, so we route
  // the request to the background SW via the `SCREENSHOT` message. In
  // the in-page demo (no `chrome.runtime.id`), capture is unavailable —
  // return an honest error instead of claiming success.
  const fileName = action.file_name;
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    return {
      action,
      success: false,
      message: "screenshot capture is not supported in the current mode",
    };
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "SCREENSHOT", fileName });
    if (res?.ok) {
      return { action, success: true, message: `Screenshot saved as ${res.filename}` };
    }
    return { action, success: false, message: `screenshot failed: ${res?.error || "unknown error"}` };
  } catch (e) {
    return { action, success: false, message: `screenshot failed: ${(e as Error).message}` };
  }
}
