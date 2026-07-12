/**
 * sidepanel/human-interact.ts — HUMAN_INTERACT message handler.
 *
 * Registers a `chrome.runtime.onMessage` listener for the orchestrator's
 * confirmation-gate + ask_human action. Supports three modes:
 *   - `confirm`  → `window.confirm()` → `{ mode: "confirm", confirmed }`
 *   - `input`    → `window.prompt()`  → `{ mode: "input", value }` or `{ mode: "cancelled" }`
 *   - `password` → masked-input modal (see `./takeover.promptPassword`) →
 *                  `{ mode: "input", value }` or `{ mode: "cancelled" }`
 *
 * The password branch returns `true` from the listener to keep the
 * sendResponse channel open for the async modal resolution.
 *
 * The payload is never trusted blindly: `request` is runtime-validated before
 * use so a malformed/undefined payload can't throw inside the listener or feed
 * the literal text "undefined" into a native dialog.
 */

import { promptPassword } from "./takeover";
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
  // gate (and from the ask_human action). Shows a native confirm() dialog and
  // sends the response back.
  if ((msg as { type?: string } | null)?.type === "HUMAN_INTERACT") {
    const parsed = parseHumanRequest(msg);
    if (!parsed) {
      // Malformed payload — don't throw, just report a cancelled interaction.
      sendResponse({ mode: "cancelled" });
      return false;
    }
    const { mode, message } = parsed;

    if (mode === "confirm") {
      const confirmed = window.confirm(message);
      sendResponse({ mode: "confirm", confirmed });
    } else if (mode === "input") {
      const value = window.prompt(message);
      sendResponse(value === null ? { mode: "cancelled" } : { mode: "input", value });
    } else if (mode === "password") {
      // Masked password input — the agent asks for a credential / API key /
      // token. Use a real `<input type="password">` rendered in a modal-like
      // overlay so the user gets masked-input UX (dots, no copy-paste leak
      // via shoulder-surfing). window.prompt can't mask input, so we build
      // a small inline dialog. Resolves with the typed value or cancelled.
      promptPassword(message)
        .then((value) => {
          sendResponse(value === null ? { mode: "cancelled" } : { mode: "input", value });
        })
        .catch((err: unknown) => {
          // A failure here is NOT a user cancellation — surface it so the
          // operator can tell a real error apart from the user clicking
          // Cancel, rather than silently collapsing both into "cancelled".
          const detail = err instanceof Error ? err.message : String(err);
          addLogRow(
            { type: "error", step: 0, message: "promptPassword failed: " + detail, recoverable: false },
            ""
          );
          sendResponse({ mode: "cancelled" });
        });
      return true; // async response
    } else {
      sendResponse({ mode: "cancelled" });
    }
    return false; // synchronous response
  }
  return false;
});
