/**
 * `save_as_pdf` action handler — render the current page as a PDF via CDP
 * `Page.printToPDF` (background SW has `chrome.debugger`) and download it
 * via `chrome.downloads.download`. In the in-page demo, return an honest
 * error.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

export async function handleSaveAsPdf(
  _ctx: ActionContext,
  action: Extract<Action, { type: "save_as_pdf" }>,
): Promise<ActionResult> {
  // Render the current page as a PDF via CDP `Page.printToPDF` (background
  // SW has `chrome.debugger`; the content script does not) and download
  // it via `chrome.downloads.download`. In the in-page demo (no
  // `chrome.runtime.id`), return an honest error.
  const fileName = action.file_name;
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    return {
      action,
      success: false,
      message: "save_as_pdf is not supported in the current mode",
    };
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "SAVE_AS_PDF", fileName });
    if (res?.ok) {
      return { action, success: true, message: `PDF saved as ${res.filename}` };
    }
    return { action, success: false, message: `save_as_pdf failed: ${res?.error || "unknown error"}` };
  } catch (e) {
    return { action, success: false, message: `save_as_pdf failed: ${(e as Error).message}` };
  }
}
