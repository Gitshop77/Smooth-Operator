/**
 * JS-dialog (`alert`/`confirm`/`prompt`) action handlers. The popup-handler
 * queues every dialog so the agent can explicitly accept/dismiss it after
 * the auto-dismiss override has returned to the page.
 *
 * - `alert_accept` → accept the currently-open dialog
 * - `alert_dismiss` → dismiss the currently-open dialog
 * - `alert_get_text` → read the dialog's text
 * - `alert_send_keys` → type into a `prompt` dialog
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { redactDialogText } from "../../dom/popup-handler";

/** Normalize an unknown thrown value into a human-readable message. */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type PopupHandler = typeof import("../../dom/popup-handler");

// Hoist a single module-level promise for the popup-handler module so the
// repeated dynamic imports across the handlers resolve the same cached module
// instead of re-issuing the import resolution on every call.
const popupHandlerMod = import("../../dom/popup-handler");

/**
 * Shared body for `alert_accept` / `alert_dismiss`. Opens the pending JS
 * dialog, runs `op` (the accept/dismiss call), and returns a redacted
 * success/failure result. Redaction behavior is preserved.
 */
async function acceptOrDismiss(
  action: Action,
  op: (mod: PopupHandler) => void,
  verb: string,
  pastTense: string,
): Promise<ActionResult> {
  try {
    const mod = await popupHandlerMod;
    const text = mod.getPendingAlertText();
    if (text === null) {
      return {
        action,
        success: false,
        message: `No JS dialog open (nothing to ${verb})`,
      };
    }
    op(mod);
    return {
      action,
      success: true,
 // Redact the dialog text — it may contain OTP/2FA codes, PII, or session
 // tokens, and this message is echoed into service-worker / cockpit logs.
      message: `${pastTense} JS dialog: ${redactDialogText(text)}`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `alert_${verb} failed: ${errMsg(e)}`,
    };
  }
}

export async function handleAlertAccept(
  _ctx: ActionContext,
  action: Extract<Action, { type: "alert_accept" }>,
): Promise<ActionResult> {
 // Accept the currently-open JS dialog. The popup-handler queues
 // every dialog so the agent can explicitly accept/dismiss it after
 // the auto-dismiss override has returned to the page. Returns
 // failure if no dialog is open.
  return acceptOrDismiss(action, (mod) => mod.acceptAlert(), "accept", "Accepted");
}

export async function handleAlertDismiss(
  _ctx: ActionContext,
  action: Extract<Action, { type: "alert_dismiss" }>,
): Promise<ActionResult> {
 // Dismiss the currently-open JS dialog. Symmetric with `alert_accept`.
  return acceptOrDismiss(action, (mod) => mod.dismissAlert(), "dismiss", "Dismissed");
}

export async function handleAlertGetText(
  _ctx: ActionContext,
  action: Extract<Action, { type: "alert_get_text" }>,
): Promise<ActionResult> {
 // Get the text of the currently-open JS dialog. Returns empty
 // content (success: true) if no dialog is open — the LLM can branch
 // on the extractedContent length.
  try {
    const mod = await popupHandlerMod;
    const text = mod.getPendingAlertText();
    if (text === null) {
      return {
        action,
        success: true,
        message: "No JS dialog open",
        extractedContent: "",
      };
    }
    return {
      action,
      success: true,
 // Redact the dialog text — it may contain OTP/2FA codes, PII, or session
 // tokens, and `extractedContent` is replayed into subsequent LLM prompts
 // and written to disk via run-history. The length-only message lets the
 // agent branch on presence/size without leaking the value (consistent with
 // `alert_accept` / `alert_dismiss`).
      message: `Got alert text (${text.length} chars)`,
      extractedContent: redactDialogText(text),
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `alert_get_text failed: ${errMsg(e)}`,
    };
  }
}

export async function handleAlertSendKeys(
  _ctx: ActionContext,
  action: Extract<Action, { type: "alert_send_keys" }>,
): Promise<ActionResult> {
 // Stage `text` to be returned by the NEXT `window.prompt()` call.
 // `window.prompt` is synchronous, so once a prompt has fired, the page
 // already received the auto-dismiss override's empty-string return —
 // there's no way to retroactively deliver text to that call. The agent
 // must call `alert_send_keys` BEFORE triggering the action that opens
 // the prompt for the text to reach the page. When no dialog is open the
 // text is staged (success); returns failure for non-prompt dialogs
 // (`alert`/`confirm`).
  try {
    const mod = await popupHandlerMod;
    const kind = mod.getPendingAlertKind();
    if (kind === null) {
 // No dialog currently open — stage the text for the NEXT prompt.
 // The agent may call alert_send_keys before triggering the action
 // that opens the prompt. The text will be returned by the next
 // window.prompt() call.
      mod.stagePromptText(action.text);
      return {
        action,
        success: true,
 // Redact the staged value — it may be a credential typed into a prompt
 // dialog, and the success message is echoed into history / logs. Report
 // only the redacted placeholder + length, consistent with the sibling
 // dialog handlers.
        message: `Staged text for next prompt: ${redactDialogText(action.text)}`,
      };
    }
    if (kind !== "prompt") {
      return {
        action,
        success: false,
        message: `Cannot type into a ${kind} dialog (only prompt accepts text)`,
      };
    }
    mod.sendAlertText(action.text);
    return {
      action,
      success: true,
      message:
        `Queued ${action.text.length} chars for the next window.prompt() call ` +
        `(the current dialog was already auto-dismissed with "")`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `alert_send_keys failed: ${errMsg(e)}`,
    };
  }
}
