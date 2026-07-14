/**
 * sidepanel/human-interact.ts — HUMAN_INTERACT message handler.
 *
 * Registers a `chrome.runtime.onMessage` listener for the orchestrator's
 * confirmation-gate + ask_human action. Supports three modes:
 * - `confirm` → in-panel confirm dialog (see `./takeover.promptConfirm`) → `{ mode: "confirm", confirmed }`
 * - `input` → in-panel text dialog (see `./takeover.promptText`) → `{ mode: "input", value }` or `{ mode: "cancelled" }`
 * - `password` → masked-input modal (see `./takeover.promptPassword`) →
 * `{ mode: "input", value }` or `{ mode: "cancelled" }`
 *
 * The password branch returns `true` from the listener to keep the
 * sendResponse channel open for the async modal resolution.
 *
 * The payload is never trusted blindly: `request` is runtime-validated before
 * use so a malformed/undefined payload can't throw inside the listener or feed
 * the literal text "undefined" into a native dialog.
 */

import { promptPassword, promptText, promptConfirm } from "./takeover";
import { addLogRow } from "./log-renderer";

/**
 * Runtime guard for the HUMAN_INTERACT request payload.
 *
 * Returns the validated `mode` and a string-safe `message`, or `null` when the
 * payload is unusable (not an object, missing/non-string `mode`, …). On `null`
 * the caller should treat the request as a no-op cancellation rather than
 * throwing.
 */
function parseHumanRequest(msg: unknown): { mode: string; message: string } | null {
  const request = (msg as { request?: unknown } | null)?.request;
  if (!request || typeof request !== "object") return null;
  const mode = (request as { mode?: unknown }).mode;
  if (typeof mode !== "string") return null;
  const rawMessage = (request as { message?: unknown }).message;
 // A non-string `message` (object / array / number) is not a usable dialog
 // prompt. Default to an empty string rather than coercing it to
 // "[object Object]" (which would mislead the operator). `mode` was already
 // validated above, so the dialog still opens — it just shows no text instead
 // of garbage. A fully-malformed payload was already rejected as `null`.
  const message = typeof rawMessage === "string" ? rawMessage : "";
  return { mode, message };
}

/**
 * Run an interactive prompt, mapping any rejection to an error log row +
 * a `cancelled` response, and keeping the sendResponse channel open (returns
 * `true`). Success and explicit-cancel mappings stay in the per-branch
 * `onResolve` callback.
 */
function runInteract<T>(
  promise: Promise<T>,
  label: string,
  onResolve: (v: T) => void,
  sendResponse: (resp: unknown) => void,
): boolean {
  promise
    .then(onResolve)
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      addLogRow(
        { type: "error", step: 0, message: `${label} failed: ${detail}`, recoverable: false },
        ""
      );
      sendResponse({ mode: "cancelled" });
    });
  return true;
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
 // Trust boundary. Messages must originate from THIS extension (a hostile web
 // page can't reach chrome.runtime.onMessage directly). That is necessary but
 // not sufficient: it still admits other same-extension contexts — a content
 // script (carries `sender.tab`), the options page, the popup, or another
 // sidepanel instance (all carry `sender.url`). Only the background service
 // worker (the orchestrator) is allowed to trigger an interactive gate, and a
 // service-worker sender has NEITHER a `tab` NOR a `url`. Reject everything
 // else so a peer page can't impersonate an ask_human request (e.g. phish a
 // credential through the masked-password modal).
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab || sender.url) return false;

 // handle HUMAN_INTERACT requests from the orchestrator's confirmation
 // gate (and from the ask_human action). Shows an in-panel dialog and
 // sends the response back.
  if ((msg as { type?: string } | null)?.type === "HUMAN_INTERACT") {
    const parsed = parseHumanRequest(msg);
    if (!parsed) {
 // Malformed payload — don't throw, just report a cancelled interaction.
      sendResponse({ mode: "cancelled" });
      return false;
    }
    const { mode, message } = parsed;

 // All three modes use an in-panel dialog (rendered in the side panel via
 // takeover.ts) instead of native `window.confirm` / `window.prompt`. Native
 // dialogs can silently fail to display when the panel is backgrounded and
 // would then be auto-dismissed as "declined" with no user-visible prompt —
 // an in-panel modal always renders, so the operator always gets a chance to
 // approve or supply a value. Each branch keeps the sendResponse channel
 // open asynchronously by returning `true`.
    if (mode === "confirm") {
      return runInteract(
        promptConfirm(message),
        "promptConfirm",
        (confirmed) => sendResponse({ mode: "confirm", confirmed }),
        sendResponse,
      );
    } else if (mode === "input") {
      return runInteract(
        promptText(message),
        "promptText",
        (value) =>
          sendResponse(value === null ? { mode: "cancelled" } : { mode: "input", value }),
        sendResponse,
      );
    } else if (mode === "password") {
 // Masked password input — the agent asks for a credential / API key /
 // token. Use a real `<input type="password">` rendered in a modal-like
 // overlay so the user gets masked-input UX (dots, no copy-paste leak
 // via shoulder-surfing). window.prompt can't mask input, so we build
 // a small inline dialog. Resolves with the typed value or cancelled.
      return runInteract(
        promptPassword(message),
        "promptPassword",
        (value) =>
          sendResponse(value === null ? { mode: "cancelled" } : { mode: "input", value }),
        sendResponse,
      );
    } else {
      sendResponse({ mode: "cancelled" });
      return false;
    }
  }
  return false;
});
