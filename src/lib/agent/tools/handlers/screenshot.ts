/**
 * `screenshot` action handler — explicitly save a standalone screenshot file
 * to the user's Downloads folder via the background SW's `SCREENSHOT`
 * message (the content script can't call `chrome.tabs.captureVisibleTab` or
 * `chrome.downloads`). In the in-page demo, capture is unavailable.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

/**
 * Validate the `file_name` the LLM supplied for a `screenshot` action before it
 * is forwarded to the background SW. This is defense-in-depth at the egress
 * boundary: the SW itself re-sanitizes on receipt (coercing to a string,
 * collapsing `..` segments, stripping non-`[\w.-]` characters and truncating to
 * 120 chars — see message-routing.ts). We reject only path-traversal /
 * separator attempts here so the agent receives a clear error rather than a file
 * silently renamed by the sanitizer.
 *
 * Returns `null` when the value is safe to forward (including `undefined`, in
 * which case the SW falls back to a title-derived default name), or a
 * human-readable reason string when it must be rejected.
 */
function validateScreenshotFileName(fileName: unknown): string | null {
  if (fileName === undefined || fileName === null) return null;
  if (typeof fileName !== "string" || fileName.length === 0) {
    return "file_name must be a non-empty string";
  }
  if (/[\\/]/.test(fileName) || fileName.includes("..")) {
    return "file_name must be a bare filename (no path separators or '..')";
  }
  return null;
}

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
  const fileNameError = validateScreenshotFileName(fileName);
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
