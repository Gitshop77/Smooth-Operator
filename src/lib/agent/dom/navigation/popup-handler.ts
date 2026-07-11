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
 */
function redactDialogText(text: string): string {
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
let pendingAlert: { kind: DialogKind; text: string; defaultValue: string } | null = null;

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
 * Overrides `window.alert` (swallow), `window.confirm` (return true), and
 * `window.prompt` (return empty string) so dialogs never block the agent.
 * Each call also records the dialog into {@link pendingAlert} so the
 * `alert_*` actions can inspect / accept / dismiss it after the fact.
 */
export function installPopupHandler(): void {
  if (installed) return;
  installed = true;

  // ── MAIN-world bridge ────────────────────────────────────────────────────
  // The overrides below run in the content script's ISOLATED world, so they
  // only affect the content script's own `window` bindings — NOT the page's
  // native `alert`/`confirm`/`prompt`, which run in the page's MAIN world.
  // A real page dialog therefore still fires and blocks the agent, and the
  // `alert_*` actions would never observe it. To fix that we inject the SAME
  // override into the page's MAIN world (via `chrome.scripting.executeScript`
  // with `world: "MAIN"`), and the MAIN-world override postMessages the
  // dialog metadata back here. We listen for those cross-world messages and
  // record them in `pendingAlert` exactly as before, so `getPendingAlert*`
  // and the `alert_*` actions now observe REAL page dialogs.
  if (typeof window !== "undefined") {
    window.addEventListener("message", onMainWorldDialogMessage);
  }
  installMainWorldDialogOverride();

  // Override window.alert to capture + auto-dismiss (isolated-world bindings).
  window.alert = function (message?: string): void {
    console.debug(`${LOG_PREFIX} Auto-dismissed alert:`, redactDialogText(String(message ?? "")));
    pendingAlert = { kind: "alert", text: String(message ?? ""), defaultValue: "" };
    // Don't call the original — just swallow it.
  };

  // Override window.confirm — auto-accept (return true).
  window.confirm = function (message?: string): boolean {
    console.debug(`${LOG_PREFIX} Auto-accepted confirm:`, redactDialogText(String(message ?? "")));
    pendingAlert = { kind: "confirm", text: String(message ?? ""), defaultValue: "" };
    return true;
  };

  // Override window.prompt — return any agent-queued text (set via
  // sendAlertText), else empty string (treated as dismiss).
  window.prompt = function (message?: string, defaultValue?: string): string | null {
    console.debug(`${LOG_PREFIX} Auto-responded prompt:`, redactDialogText(String(message ?? "")));
    pendingAlert = {
      kind: "prompt",
      text: String(message ?? ""),
      defaultValue: String(defaultValue ?? ""),
    };
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

/** Message tag sent by the MAIN-world override carrying dialog metadata. */
const MAIN_WORLD_DIALOG_MSG = "__openCoworkDialog";
/** Message tag the isolated world sends to stage prompt text in MAIN world. */
const MAIN_WORLD_SET_PROMPT_MSG = "__openCoworkSetPrompt";

/**
 * Receive dialog metadata bridged from the MAIN-world override. Validates that
 * the message originated from this same `window` (cross-world `postMessage`
 * lands here) and carries our tag before trusting it.
 */
function onMainWorldDialogMessage(e: MessageEvent): void {
  if (e.source !== window) return;
  const data = e.data as Record<string, unknown> | null;
  if (!data || data[MAIN_WORLD_DIALOG_MSG] !== true) return;
  pendingAlert = {
    kind: (data.kind as DialogKind) ?? "alert",
    text: String(data.text ?? ""),
    defaultValue: String(data.defaultValue ?? ""),
  };
}

/**
 * Inject the dialog override into the page's MAIN world so real page dialogs
 * are intercepted (the isolated-world override above cannot reach them). The
 * MAIN-world function overrides `alert`/`confirm`/`prompt` and postMessages
 * each invocation back to the isolated world, and listens for staged prompt
 * text posted by {@link stagePromptText}/{@link sendAlertText}.
 *
 * Requires the `scripting` permission + host access; if unavailable the call
 * is a no-op and only the (ineffective-for-page-dialogs) isolated override
 * remains — the same behavior as before this fix.
 */
function installMainWorldDialogOverride(): void {
  try {
    const scripting = (globalThis as { chrome?: typeof chrome }).chrome?.scripting;
    if (typeof scripting?.executeScript !== "function") return;
    chrome.tabs?.getCurrent?.((tab) => {
      if (!tab?.id) return;
      scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: mainWorldDialogOverride,
      });
    });
  } catch {
    /* scripting unavailable — fall back to isolated-world-only behavior */
  }
}

/** Runs in the page's MAIN world. Must be self-contained (no closure capture). */
function mainWorldDialogOverride(): void {
  const RECEIVE = "__openCoworkDialog";
  const SET_PROMPT = "__openCoworkSetPrompt";
  let staged: string | null = null;
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.source !== window) return;
    const d = e.data as Record<string, unknown> | null;
    if (d && d[SET_PROMPT] !== undefined) {
      const v = d[SET_PROMPT];
      staged = v === true || v == null ? null : String(v);
    }
  });
  const post = (kind: string, message: unknown, defaultValue: unknown): void => {
    window.postMessage(
      { __openCoworkDialog: true, kind, text: String(message ?? ""), defaultValue: String(defaultValue ?? "") },
      "*",
    );
  };
  (window as unknown as { alert: typeof window.alert }).alert = (m?: string): void => {
    post("alert", m, "");
  };
  (window as unknown as { confirm: typeof window.confirm }).confirm = (m?: string): boolean => {
    post("confirm", m, "");
    return true;
  };
  (window as unknown as { prompt: typeof window.prompt }).prompt = (
    m?: string,
    def?: string,
  ): string | null => {
    post("prompt", m, def);
    const v = staged;
    staged = null;
    return v != null ? v : "";
  };
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
 */
export function getPendingAlertText(): string | null {
  return pendingAlert?.text ?? null;
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
export function acceptAlert(): boolean {
  if (!pendingAlert) return false;
  pendingAlert = null;
  return true;
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
  if (!pendingAlert) return false;
  pendingAlert = null;
  return true;
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
  // Bridge the staged value into the MAIN world so the MAIN-world prompt
  // override (which is what actually returns to the page) returns it.
  postToMainWorld(MAIN_WORLD_SET_PROMPT_MSG, String(text));
  if (!pendingAlert || pendingAlert.kind !== "prompt") return false;
  nextPromptValue = String(text);
  pendingAlert = null;
  return true;
}

/**
 * Stage text for the next `window.prompt()` call, even if no dialog is
 * currently open. The agent can call this BEFORE triggering the action
 * that opens the prompt — the text will be returned by the next prompt.
 */
export function stagePromptText(text: string): void {
  nextPromptValue = String(text);
  // Bridge the staged value into the MAIN world so the MAIN-world prompt
  // override returns it when the page opens the prompt.
  postToMainWorld(MAIN_WORLD_SET_PROMPT_MSG, String(text));
}

/** Post a bridged message to the page's MAIN world (best-effort). */
function postToMainWorld(tag: string, value: unknown): void {
  try {
    window.postMessage({ [tag]: value }, "*");
  } catch {
    /* postMessage unavailable — isolated-world-only fallback still works */
  }
}
