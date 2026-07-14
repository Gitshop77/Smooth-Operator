/**
 * `screenshot` action handler — explicitly save a standalone screenshot file
 * to the user's Downloads folder via the background SW's `SCREENSHOT`
 * message (the content script can't call `chrome.tabs.captureVisibleTab` or
 * `chrome.downloads`). In the in-page demo, capture is unavailable.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { validateFileName } from "./validate-file-name";
import { swOkResponseSchema as screenshotResponseSchema } from "./sw-response";

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
 // Reject path-traversal / separator attempts at the egress boundary before
 // forwarding to the SW. The SW also re-sanitizes on receipt, so benign
 // characters (spaces, etc.) are still neutralized downstream; we just give
 // the agent an explicit error for genuinely abusive filenames.
  const fileNameError = validateFileName(fileName);
  if (fileNameError) {
    return {
      action,
      success: false,
      message: `screenshot failed: invalid file_name — ${fileNameError}`,
    };
  }
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    return {
      action,
      success: false,
      message: "screenshot capture is not supported in the current mode",
    };
  }
  try {
 // `chrome.runtime.sendMessage` resolves `undefined` (not a rejection) when
 // no listener is present, so read the response and validate each field
 // before formatting the success message.
    const raw = await chrome.runtime.sendMessage({ type: "SCREENSHOT", fileName });
    if (typeof raw === "undefined") {
      return {
        action,
        success: false,
        message: "screenshot failed: no response from extension (background service worker unreachable)",
      };
    }
    const parsed = screenshotResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        action,
        success: false,
        message: `screenshot failed: invalid response from extension (${parsed.error.message})`,
      };
    }
    const res = parsed.data;
    if (res.ok) {
      const filename = typeof res.filename === "string" && res.filename ? res.filename : undefined;
      return {
        action,
        success: true,
        message: filename ? `Screenshot saved as ${filename}` : "Screenshot saved",
      };
    }
    const err = typeof res.error === "string" && res.error ? res.error : "unknown error";
    return { action, success: false, message: `screenshot failed: ${err}` };
  } catch (e) {
    return { action, success: false, message: `screenshot failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
