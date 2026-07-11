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
    // `chrome.runtime.sendMessage` resolves `undefined` (not a rejection) when
    // no listener is present, so read the response through a typed shape and
    // guard each field before formatting the success message.
    const res = (await chrome.runtime.sendMessage({ type: "SCREENSHOT", fileName })) as
      | { ok?: boolean; filename?: string; error?: string }
      | undefined
      | null;
    if (res?.ok) {
      const filename = typeof res.filename === "string" && res.filename ? res.filename : undefined;
      return {
        action,
        success: true,
        message: filename ? `Screenshot saved as ${filename}` : "Screenshot saved",
      };
    }
    const err = res && typeof res.error === "string" && res.error ? res.error : "no response from extension";
    return { action, success: false, message: `screenshot failed: ${err}` };
  } catch (e) {
    return { action, success: false, message: `screenshot failed: ${(e as Error).message}` };
  }
}
