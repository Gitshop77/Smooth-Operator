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
 */

import { promptPassword } from "./takeover";

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Trust boundary — only accept messages from this extension. A hostile
  // web page can't send chrome.runtime messages directly, but a compromised
  // extension or a framing attack could try. `sender.id` is the extension ID
  // of the sender; if it doesn't match `chrome.runtime.id` we ignore the
  // message. Same guard pattern as content.ts + background/message-routing.ts.
  if (sender.id !== chrome.runtime.id) return false;
  // handle HUMAN_INTERACT requests from the orchestrator's confirmation
  // gate (and from the ask_human action). Shows a native confirm() dialog and
  // sends the response back.
  if ((msg as { type?: string })?.type === "HUMAN_INTERACT") {
    const req = (msg as { request: { mode: string; message: string } }).request;
    if (req.mode === "confirm") {
      const confirmed = window.confirm(req.message);
      sendResponse({ mode: "confirm", confirmed });
    } else if (req.mode === "input") {
      const value = window.prompt(req.message);
      sendResponse(value === null ? { mode: "cancelled" } : { mode: "input", value });
    } else if (req.mode === "password") {
      // Masked password input — the agent asks for a credential / API key /
      // token. Use a real `<input type="password">` rendered in a modal-like
      // overlay so the user gets masked-input UX (dots, no copy-paste leak
      // via shoulder-surfing). window.prompt can't mask input, so we build
      // a small inline dialog. Resolves with the typed value or cancelled.
      promptPassword(req.message)
        .then((value) => {
          sendResponse(value === null ? { mode: "cancelled" } : { mode: "input", value });
        })
        .catch(() => sendResponse({ mode: "cancelled" }));
      return true; // async response
    } else {
      sendResponse({ mode: "cancelled" });
    }
    return false; // synchronous response
  }
  return false;
});
