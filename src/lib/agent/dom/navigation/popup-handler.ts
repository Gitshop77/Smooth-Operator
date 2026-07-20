/**
 * Popup watchdog — auto-dismisses JavaScript `alert`/`confirm`/`prompt`
 * dialogs that would otherwise hang the agent indefinitely. The watchdog
 * overrides the global dialog functions once per content-script injection
 * and records dismissed messages.
 *
 * Dialogs are also queued so the agent can explicitly accept/dismiss/
 * send-keys via {@link acceptAlert}/{@link dismissAlert}/
 * {@link sendAlertText}. The queue is bounded (only the most recent dialog
 * is kept — dialogs are inherently modal, so only one can be open at a
 * time). {@link getPendingAlertText} returns the queued dialog's text (or
 * `null` if no dialog is currently open) — used by the `until.alertIsPresent`
 * expected condition and the `alert_*` actions.
 *
 * Extracted from the historical `dom/popup-handler.ts`. The legacy
 * `@/lib/agent/dom/popup-handler` import path stays working via a re-export
 * shim in `dom/popup-handler.ts`.
 */

/** Console prefix for watchdog log lines. */
const LOG_PREFIX = "[Open Cowork]";

/**
 * Redact page-supplied dialog text before logging. Dialog text can contain
 * OTP/2FA codes, PII, or session tokens, so we never log it verbatim — we
 * surface only its length as a metadata hint for debugging.
 *
 * Exported so the `alert_*` handlers can redact dialog text in their result
 * messages (which otherwise end up in cockpit / service-worker logs).
 */
export function redactDialogText(text: string): string {
  return `${text.length} char(s) (redacted)`;
}

let installed = false;

/** Describes which kind of native dialog was triggered. */
export type DialogKind = "alert" | "confirm" | "prompt";

/**
 * The most recently-triggered dialog that hasn't been explicitly accepted or
 * dismissed via the alert_* actions. `null` when no dialog is open.
 *
 * The auto-dismiss override still fires for every `window.alert` /
 * `window.confirm` / `window.prompt` call (so the page never blocks), but
 * we capture the dialog metadata here first so the agent can inspect it
 * after the fact.
 */
let pendingAlert: { kind: DialogKind; text: string } | null = null;

/**
 * Text the agent has queued for the NEXT `window.prompt()` call.
 *
 * `window.prompt` is synchronous — once it returns, the page already has
 * its value and we can't retroactively change it. So {@link sendAlertText}
 * stages text here, and the next time the page calls `prompt()` the override
 * returns the staged value (and clears the slot). Callers wanting to deliver
 * text to a specific prompt must call `alert_send_keys` BEFORE triggering the
 * action that opens the prompt.
 */
let nextPromptValue: string | null = null;

/**
 * Install the popup handler. Call once per content script injection — safe to
 * call multiple times (subsequent calls are no-ops).
 *
 * Overrides `window.alert` (swallow), `window.confirm` (return false —
 * fail-closed), and `window.prompt` (return empty string) so dialogs never
 * block the agent.
 * Each call also records the dialog into {@link pendingAlert} so the
 * `alert_*` actions can inspect / accept / dismiss it after the fact.
 *
 * SCOPE: these overrides run in the content script's ISOLATED world, so they
 * only replace the content script's own `window.alert`/`confirm`/`prompt`
 * bindings — they do NOT intercept dialogs the page raises from its MAIN
 * world. Intercepting real page dialogs would require a MAIN-world override
 * bridged over a channel a page script cannot read or forge; because the only
 * cross-world transport available here (`window.postMessage`) is observable
 * to page scripts (any broadcast secret can be sniffed and replayed to forge
 * dialog metadata), no such bridge is installed. Do not document
 * or rely on real page-dialog interception from this handler.
 */
/** Capture a dismissed dialog's metadata (and log its text redacted). */
function captureDialog(kind: DialogKind, message?: string): void {
  const text = String(message ?? "");
  console.debug(`${LOG_PREFIX} Auto-handled ${kind}:`, redactDialogText(text));
  pendingAlert = { kind, text };
}

export function installPopupHandler(): void {
  if (installed) return;
  installed = true;

 // Override window.alert to capture + auto-dismiss (isolated-world bindings).
  window.alert = function (message?: string): void {
    captureDialog("alert", message);
 // Don't call the original — just swallow it.
  };

 // Override window.confirm — fail-closed (return false).
 // `window.confirm` is synchronous: the page receives the return value before
 // the agent can inspect `pendingAlert`, so auto-accepting would silently
 // approve destructive/sensitive confirms ("Delete account?", "Submit payment?")
 // with no chance for the agent or user to veto. Defaulting to false blocks
 // those by default; `captureDialog` still records the text so the agent can
 // observe what was asked.
  window.confirm = function (message?: string): boolean {
    captureDialog("confirm", message);
    return false;
  };

 // Override window.prompt — return any agent-queued text (set via
 // sendAlertText), else empty string (treated as dismiss).
  window.prompt = function (message?: string, defaultValue?: string): string {
    captureDialog("prompt", message);
    if (nextPromptValue !== null) {
      const v = nextPromptValue;
      nextPromptValue = null;
      return v;
    }
    return "";
  };

 // Note: we intentionally do NOT add a beforeunload listener. Calling
 // preventDefault() on beforeunload actually ACTIVATES the "Leave site?"
 // prompt (the opposite of suppression). JS cannot remove the page's own
 // beforeunload listeners, so we leave this alone — the agent's actions
 // proceed regardless of beforeunload prompts.
}

// ─── Explicit alert API ──────────────────────────────────────────────────────
//
// The auto-dismiss override above ensures the page never blocks on a dialog.
// In addition, these functions let the agent explicitly accept / dismiss /
// inspect the most-recent dialog (mirroring the `Alert` class from the
// source taxonomy, adapted to the content-script context where the dialog
// has already been auto-handled).
//
// Calling `acceptAlert` / `dismissAlert` clears {@link pendingAlert} so the
// next `alert_*` action against the same dialog correctly reports "no such
// alert" rather than re-accepting a stale entry.

/**
 * Get the text of the currently-open dialog, or `null` if none is open.
 *
 * "Open" here means "the page called `alert`/`confirm`/`prompt` since the
 * last `acceptAlert`/`dismissAlert`" — the auto-dismiss override already
 * returned to the caller, but the dialog's text is preserved for the agent
 * to inspect.
 *
 * NOTE: this returns the RAW dialog text (which may contain OTP/2FA, PII, or
 * session tokens). Do NOT log or serialize it without redaction — use
 * {@link getPendingAlertTextRedacted} for any channel that leaves the page.
 */
export function getPendingAlertText(): string | null {
  return pendingAlert?.text ?? null;
}

/**
 * Get the redacted text of the currently-open dialog, or `null` if none is
 * open. The raw dialog text (OTP/2FA/PII/tokens) is replaced by a length-only
 * hint so it is safe to log or forward to a cockpit/LLM channel. Use this
 * instead of {@link getPendingAlertText} whenever the value leaves the page.
 */
export function getPendingAlertTextRedacted(): string | null {
  return pendingAlert ? redactDialogText(pendingAlert.text) : null;
}

/**
 * Get the kind of the currently-open dialog, or `null` if none is open.
 * Useful when the agent needs to know whether to call `sendAlertText`
 * (only valid for `prompt`).
 */
export function getPendingAlertKind(): DialogKind | null {
  return pendingAlert?.kind ?? null;
}

/**
 * Accept the currently-open dialog (alert / confirm / prompt).
 *
 * Returns `true` if a dialog was open and is now accepted; `false` if no
 * dialog was open. The accept is a no-op on the page side (the auto-dismiss
 * override already returned to the page) — this function only clears the
 * pending entry so subsequent `alert_*` actions report "no such alert".
 */
/** Clear the most-recently-recorded dialog from the pending queue. */
function clearMostRecentAlert(): boolean {
  if (!pendingAlert) return false;
  pendingAlert = null;
  return true;
}

export function acceptAlert(): boolean {
  return clearMostRecentAlert();
}

/**
 * Dismiss the currently-open dialog (alert / confirm / prompt).
 *
 * Returns `true` if a dialog was open and is now dismissed; `false` if no
 * dialog was open. As with {@link acceptAlert}, this is a bookkeeping
 * operation on the pending queue — the page already saw the auto-dismiss
 * override's return value.
 */
export function dismissAlert(): boolean {
  return clearMostRecentAlert();
}

/**
 * Stage text for the NEXT window.prompt() call. The currently-open prompt already received the auto-dismiss override empty-string return — this only affects the next prompt.. Only valid when the pending
 * dialog is a `prompt`; for `alert`/`confirm`, returns `false` without
 * modifying the pending entry.
 *
 * Because `window.prompt` is synchronous, the page already received the
 * auto-dismiss override's return value by the time this is called. To
 * actually deliver text to a prompt, the agent must call `alert_send_keys`
 * BEFORE the action that opens the prompt — the text is staged in
 * {@link nextPromptValue} and returned by the next `window.prompt()` call.
 *
 * Returns `true` if the text was staged, `false` if no prompt was open.
 */
export function sendAlertText(text: string): boolean {
  // When a dialog is already open, only stage if it's a prompt — staging for a
  // pending alert/confirm would contaminate the next real prompt. When no
  // dialog is open (or the pending one is a prompt) we stage the text so it is
  // returned by the next window.prompt() call, matching the documented
  // "alert_send_keys before opening prompt" contract (the old guard returned
  // false whenever no dialog was open, defeating pre-staging).
  if (pendingAlert && pendingAlert.kind !== "prompt") return false;
  stagePromptText(text);
  return true;
}

/**
 * Stage text for the next `window.prompt()` call, even if no dialog is
 * currently open. The agent can call this BEFORE triggering the action
 * that opens the prompt — the text will be returned by the next prompt.
 */
export function stagePromptText(text: string): void {
  nextPromptValue = String(text);
}

