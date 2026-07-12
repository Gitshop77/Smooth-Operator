/**
 * JS-dialog (`alert`/`confirm`/`prompt`) action handlers. The popup-handler
 * queues every dialog so the agent can explicitly accept/dismiss it after
 * the auto-dismiss override has returned to the page.
 *
 *   - `alert_accept`     → accept the currently-open dialog
 *   - `alert_dismiss`    → dismiss the currently-open dialog
 *   - `alert_get_text`   → read the dialog's text
 *   - `alert_send_keys`  → type into a `prompt` dialog
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { redactDialogText } from "../../dom/popup-handler";

export async function handleAlertAccept(
  _ctx: ActionContext,
  action: Extract<Action, { type: "alert_accept" }>,
): Promise<ActionResult> {
  // Accept the currently-open JS dialog. The popup-handler queues
  // every dialog so the agent can explicitly accept/dismiss it after
  // the auto-dismiss override has returned to the page. Returns
  // failure if no dialog is open.
  try {
    const mod = await import("../../dom/popup-handler");
    const text = mod.getPendingAlertText();
    if (text === null) {
      return {
        action,
        success: false,
        message: "No JS dialog open (nothing to accept)",
      };
    }
    mod.acceptAlert();
    return {
      action,
      success: true,
      // Redact the dialog text — it may contain OTP/2FA codes, PII, or session
      // tokens, and this message is echoed into service-worker / cockpit logs.
      message: `Accepted JS dialog: ${redactDialogText(text)}`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `alert_accept failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function handleAlertDismiss(
  _ctx: ActionContext,
  action: Extract<Action, { type: "alert_dismiss" }>,
): Promise<ActionResult> {
  // Dismiss the currently-open JS dialog. Symmetric with `alert_accept`.
  try {
    const mod = await import("../../dom/popup-handler");
    const text = mod.getPendingAlertText();
    if (text === null) {
      return {
        action,
        success: false,
        message: "No JS dialog open (nothing to dismiss)",
      };
    }
    mod.dismissAlert();
    return {
      action,
      success: true,
      // Redact the dialog text — it may contain OTP/2FA codes, PII, or session
      // tokens, and this message is echoed into service-worker / cockpit logs.
      message: `Dismissed JS dialog: ${redactDialogText(text)}`,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `alert_dismiss failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function handleAlertGetText(
  _ctx: ActionContext,
  action: Extract<Action, { type: "alert_get_text" }>,
): Promise<ActionResult> {
  // Get the text of the currently-open JS dialog. Returns empty
  // content (success: true) if no dialog is open — the LLM can branch
  // on the extractedContent length.
  try {
    const mod = await import("../../dom/popup-handler");
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
      message: `Got alert text (${text.length} chars)`,
      extractedContent: text,
    };
  } catch (e) {
    return {
      action,
      success: false,
      message: `alert_get_text failed: ${e instanceof Error ? e.message : String(e)}`,
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
    const mod = await import("../../dom/popup-handler");
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
        message: `Staged text for next prompt: "${action.text}"`,
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
      message: `alert_send_keys failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
