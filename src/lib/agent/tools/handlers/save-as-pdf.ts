/**
 * `save_as_pdf` action handler — render the current page as a PDF via CDP
 * `Page.printToPDF` (background SW has `chrome.debugger`) and download it
 * via `chrome.downloads.download`. In the in-page demo, return an honest
 * error.
 */

import { z } from "zod";
import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

/**
 * Shape the background SW returns for a `SAVE_AS_PDF` message. Both endpoints
 * are same-extension, but we validate the payload instead of blindly casting
 * it, so a contract drift between the content script and the SW is surfaced
 * as an explicit error rather than a misleading "PDF saved as undefined" /
 * "failed: unknown error" message.
 */
const saveAsPdfResponseSchema = z.object({
  ok: z.boolean(),
  filename: z.string().optional(),
  error: z.string().optional(),
});
type SaveAsPdfResponse = z.infer<typeof saveAsPdfResponseSchema>;

export async function handleSaveAsPdf(
  _ctx: ActionContext,
  action: Extract<Action, { type: "save_as_pdf" }>,
): Promise<ActionResult> {
  // Render the current page as a PDF via CDP `Page.printToPDF` (background
  // SW has `chrome.debugger`; the content script does not) and download
  // it via `chrome.downloads.download`. In the in-page demo (no
  // `chrome.runtime.id`), return an honest error.
  //
  // NB: the wire field is `fileName` (read by the SW's `SaveAsPdfMessage`),
  // mapped from the agent schema's snake_case `action.file_name`.
  const fileName = action.file_name;
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    return {
      action,
      success: false,
      message: "save_as_pdf is not supported in the current mode",
    };
  }
  try {
    const raw = await chrome.runtime.sendMessage({ type: "SAVE_AS_PDF", fileName });
    const parsed = saveAsPdfResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        action,
        success: false,
        message: `save_as_pdf failed: invalid response from extension (${parsed.error.message})`,
      };
    }
    const res = parsed.data;
    if (res.ok) {
      // Guard against a drifted SW payload that omits `filename` while still
      // reporting success — never emit the literal "PDF saved as undefined".
      const filename = res.filename ?? "(unknown file)";
      return { action, success: true, message: `PDF saved as ${filename}` };
    }
    return {
      action,
      success: false,
      message: `save_as_pdf failed: ${res.error ?? "unknown error"}`,
    };
  } catch (e) {
    return { action, success: false, message: `save_as_pdf failed: ${(e as Error).message}` };
  }
}
