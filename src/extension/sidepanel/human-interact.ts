/**
 * sidepanel/human-interact.ts — background-brokered HUMAN_INTERACT handler.
 *
 * Registers a `chrome.runtime.onMessage` listener for the orchestrator's
 * confirmation-gate + ask_human action. Supports three modes:
 * - `confirm` → in-panel confirm dialog (see `./takeover.promptConfirm`)
 * - `input` → in-panel text dialog (see `./takeover.promptText`)
 * - `password` → masked-input modal (see `./takeover.promptPassword`)
 *
 * The background owns admission and settlement. Every open panel may render
 * the prompt, but only its first response is admitted; the resulting dismiss
 * broadcast closes the dialog in every other panel.
 */

import { dismissActiveDialog, promptPassword, promptText, promptConfirm } from "./takeover";
import { addSystemMessage } from "./chat-renderer";

/**
 * Runtime guard for the HUMAN_INTERACT request payload.
 */
interface HumanInteractionToken {
  runId: string;
  dispatchRevision: number;
}

export function parseHumanRequest(msg: unknown): {
  interactionId: string;
  token: HumanInteractionToken;
  mode: string;
  message: string;
  defaultValue?: string;
} | null {
  const interactionId = (msg as { interactionId?: unknown } | null)?.interactionId;
  if (typeof interactionId !== "string" || interactionId.length === 0) return null;
  const token = (msg as { token?: unknown } | null)?.token;
  if (!token || typeof token !== "object" ||
    typeof (token as { runId?: unknown }).runId !== "string" ||
    typeof (token as { dispatchRevision?: unknown }).dispatchRevision !== "number") return null;
  const request = (msg as { request?: unknown } | null)?.request;
  if (!request || typeof request !== "object") return null;
  const mode = (request as { mode?: unknown }).mode;
  if (typeof mode !== "string") return null;
  const rawMessage = (request as { message?: unknown }).message;
  const message = typeof rawMessage === "string" ? rawMessage : "";
  const rawDefault = (request as { defaultValue?: unknown }).defaultValue;
  const defaultValue = typeof rawDefault === "string" ? rawDefault : undefined;
  return {
    interactionId,
    token: {
      runId: (token as { runId: string }).runId,
      dispatchRevision: (token as { dispatchRevision: number }).dispatchRevision,
    },
    mode,
    message,
    defaultValue,
  };
}

let activeInteractionId: string | null = null;
let activeInteractionToken: HumanInteractionToken | null = null;

function dispatchResponse(
  interactionId: string,
  token: HumanInteractionToken,
  response: unknown,
): void {
  try {
    const sent = chrome.runtime.sendMessage({
      type: "HUMAN_INTERACT_RESPONSE",
      interactionId,
      token,
      response,
    });
    if (sent && typeof (sent as Promise<unknown>).catch === "function") {
      void (sent as Promise<unknown>).catch(() => {});
    }
  } catch {
    // The background can disappear during worker teardown; its timeout closes
    // the content-side waiter and this panel's next STATUS reconciliation wins.
  }
}

/**
 * Run an interactive prompt, mapping any rejection to an error log row +
 * a `cancelled` response, and keeping the sendResponse channel open (returns
 * `true`).
 */
function runInteract<T>(
  promise: Promise<T>,
  interactionId: string,
  token: HumanInteractionToken,
  label: string,
  toResponse: (v: T) => unknown,
): void {
  promise
    .then((value) => {
      dispatchResponse(interactionId, token, toResponse(value));
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[sidepanel] ${label} failed:`, detail);
      addSystemMessage("❌", `${label} failed`);
      dispatchResponse(interactionId, token, { mode: "cancelled" });
    });
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  // Trust boundary. Messages must originate from THIS extension.
  if (sender.id !== chrome.runtime.id) return false;
  // The broker is the only authority allowed to ask a panel to open UI. A
  // content script (including one injected into another tab) must never be
  // able to bypass its run-token admission check.
  if (sender.tab || sender.url) return false;

  if ((msg as { type?: string } | null)?.type === "HUMAN_INTERACT_CANCEL" ||
    (msg as { type?: string } | null)?.type === "HUMAN_INTERACT_DISMISS") {
    const interactionId = (msg as { interactionId?: unknown }).interactionId;
    const token = (msg as { token?: unknown }).token;
    const matchesToken = !token || (typeof token === "object" &&
      (token as { runId?: unknown }).runId === activeInteractionToken?.runId &&
      (token as { dispatchRevision?: unknown }).dispatchRevision === activeInteractionToken?.dispatchRevision);
    if (typeof interactionId === "string" && interactionId === activeInteractionId && matchesToken) {
      activeInteractionId = null;
      activeInteractionToken = null;
      dismissActiveDialog();
    }
    return false;
  }

  if ((msg as { type?: string } | null)?.type === "HUMAN_INTERACT_PROMPT") {
    const parsed = parseHumanRequest(msg);
    if (!parsed) {
      return false;
    }
    const { interactionId, token, mode, message } = parsed;
    activeInteractionId = interactionId;
    activeInteractionToken = token;

    if (mode === "confirm") {
      runInteract(
        promptConfirm(message),
        interactionId,
        token,
        "promptConfirm",
        (confirmed) => ({ mode: "confirm", confirmed }),
      );
    } else if (mode === "input") {
      runInteract(
        promptText(message, parsed.defaultValue ?? ""),
        interactionId,
        token,
        "promptText",
        (value) =>
          value === null ? { mode: "cancelled" } : { mode: "input", value },
      );
    } else if (mode === "password") {
      runInteract(
        promptPassword(message),
        interactionId,
        token,
        "promptPassword",
        (value) =>
          value === null ? { mode: "cancelled" } : { mode: "password", value },
      );
    } else {
      addSystemMessage("⚠", `Unsupported interaction mode: ${mode}`);
      dispatchResponse(interactionId, token, { mode: "cancelled" });
      return false;
    }
    return false;
  }
  return false;
});
