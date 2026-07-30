/**
 * sidepanel/human-interact.ts — HUMAN_INTERACT message handler.
 *
 * Registers a `chrome.runtime.onMessage` listener for the orchestrator's
 * confirmation-gate + ask_human action. Supports three modes:
 * - `confirm` → in-panel confirm dialog (see `./takeover.promptConfirm`)
 * - `input` → in-panel text dialog (see `./takeover.promptText`)
 * - `password` → masked-input modal (see `./takeover.promptPassword`)
 *
 * The password branch returns `true` from the listener to keep the
 * sendResponse channel open for the async modal resolution.
 */

import { promptPassword, promptText, promptConfirm } from "./takeover";
import { addSystemMessage } from "./chat-renderer";

/**
 * Runtime guard for the HUMAN_INTERACT request payload.
 */
export function parseHumanRequest(msg: unknown): { mode: string; message: string; defaultValue?: string } | null {
  const request = (msg as { request?: unknown } | null)?.request;
  if (!request || typeof request !== "object") return null;
  const mode = (request as { mode?: unknown }).mode;
  if (typeof mode !== "string") return null;
  const rawMessage = (request as { message?: unknown }).message;
  const message = typeof rawMessage === "string" ? rawMessage : "";
  const rawDefault = (request as { defaultValue?: unknown }).defaultValue;
  const defaultValue = typeof rawDefault === "string" ? rawDefault : undefined;
  return { mode, message, defaultValue };
}

/**
 * Run an interactive prompt, mapping any rejection to an error log row +
 * a `cancelled` response, and keeping the sendResponse channel open (returns
 * `true`).
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
      console.warn(`[sidepanel] ${label} failed:`, detail);
      addSystemMessage("❌", `${label} failed`);
      sendResponse({ mode: "cancelled" });
    });
  return true;
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Trust boundary. Messages must originate from THIS extension.
  if (sender.id !== chrome.runtime.id) return false;
  if (sender.tab || sender.url) return false;

  if ((msg as { type?: string } | null)?.type === "HUMAN_INTERACT") {
    const parsed = parseHumanRequest(msg);
    if (!parsed) {
      sendResponse({ mode: "cancelled" });
      return false;
    }
    const { mode, message } = parsed;

    if (mode === "confirm") {
      return runInteract(
        promptConfirm(message),
        "promptConfirm",
        (confirmed) => sendResponse({ mode: "confirm", confirmed }),
        sendResponse,
      );
    } else if (mode === "input") {
      return runInteract(
        promptText(message, parsed.defaultValue ?? ""),
        "promptText",
        (value) =>
          sendResponse(value === null ? { mode: "cancelled" } : { mode: "input", value }),
        sendResponse,
      );
    } else if (mode === "password") {
      return runInteract(
        promptPassword(message),
        "promptPassword",
        (value) =>
          sendResponse(value === null ? { mode: "cancelled" } : { mode: "input", value }),
        sendResponse,
      );
    } else {
      addSystemMessage("⚠", `Unsupported interaction mode: ${mode}`);
      sendResponse({ mode: "cancelled" });
      return false;
    }
  }
  return false;
});
