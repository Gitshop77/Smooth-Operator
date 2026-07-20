/**
 * `save_as_pdf` action handler — render the current page as a PDF via CDP
 * `Page.printToPDF` (background SW has `chrome.debugger`) and download it
 * via `chrome.downloads.download`. In the in-page demo, return an honest
 * error.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { validateFileName } from "./validate-file-name";
import { swOkResponseSchema as saveAsPdfResponseSchema } from "./sw-response";
import { rejectOnAbort } from "./abort";

/** Give up on an unresponsive SW handler rather than hanging the agent loop. */
const SAVE_AS_PDF_TIMEOUT_MS = 30_000;

export async function handleSaveAsPdf(
  ctx: ActionContext,
  action: Extract<Action, { type: "save_as_pdf" }>,
): Promise<ActionResult> {
 // Render the current page as a PDF via CDP `Page.printToPDF` (background
 // SW has `chrome.debugger`; the content script does not) and download
 // it via `chrome.downloads.download`. In the in-page demo (no
 // `chrome.runtime.id`), return an honest error.
 //
 // The agent schema field is snake_case `action.file_name`; the SW's
 // `SaveAsPdfMessage` reads it off the wire as `fileName`. The wire field is
 // named explicitly below so the mapping is unambiguous at the send site.
  const file_name = action.file_name;
 // Reject path-traversal / separator attempts at the egress boundary before
 // forwarding to the SW (it also re-sanitizes on receipt). Mirrors the
 // `screenshot` path: defense-in-depth that gives the agent a clear error
 // rather than a file silently renamed by the sanitizer.
  const fileNameError = validateFileName(file_name);
  if (fileNameError) {
    return {
      action,
      success: false,
      message: `save_as_pdf failed: invalid file_name — ${fileNameError}`,
    };
  }
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    return {
      action,
      success: false,
      message: "save_as_pdf is not supported in the current mode",
    };
  }
  try {
 // `chrome.runtime.sendMessage` resolves `undefined` (not a rejection) when
 // there is no listener, so distinguish a missing/unreachable SW handler
 // from a malformed payload — both otherwise collapse to the same
 // "invalid response" string and hide the real cause. Race a timeout so a
 // live SW handler that keeps the channel open (async) but never responds
 // cannot hang the orchestrator step indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
 // Race the SW call against the timeout AND the step's abort signal so a user
 // STOP is honored mid-step instead of waiting out the full 30s timeout.
    const abort = rejectOnAbort(ctx.signal);
    let raw: unknown;
    try {
      raw = await Promise.race([
        chrome.runtime
          .sendMessage({ type: "SAVE_AS_PDF", fileName: file_name })
          .finally(() => clearTimeout(timer))
          .catch(() => {}),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), SAVE_AS_PDF_TIMEOUT_MS);
        }),
        abort.promise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      abort.cleanup();
    }
    if (typeof raw === "undefined") {
      return {
        action,
        success: false,
        message: "save_as_pdf failed: no response from extension (timeout or unreachable service worker)",
      };
    }
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
    const m = e instanceof Error ? e.message : String(e);
    return { action, success: false, message: `save_as_pdf failed: ${m}` };
  }
}
