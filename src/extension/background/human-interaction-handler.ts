/** Background message handlers for the authoritative human-prompt broker. */

import { sanitizeResponse } from "@/lib/agent/human-interaction-utils";
import type {
  HumanInteractCancelMessage,
  HumanInteractRequestMessage,
  HumanInteractResponseMessage,
} from "./message-types";
import { canCurrentRunDispatch } from "./run-controller";
import { HumanInteractionAuthority, type HumanInteractionToken } from "./human-interaction-authority";

const MAX_HUMAN_INTERACT_TIMEOUT_MS = 5 * 60 * 1000;

function broadcast(message: unknown): void {
  try {
    const sent = chrome.runtime.sendMessage(message);
    if (sent && typeof (sent as Promise<unknown>).catch === "function") {
      void (sent as Promise<unknown>).catch(() => {
        // It is valid to have no panel open; the content caller's own timeout
        // still settles the agent action.
      });
    }
  } catch {
    // The service worker may be terminating after a run cancellation.
  }
}

export const humanInteractionAuthority = new HumanInteractionAuthority({
  canDispatch: (token) => canCurrentRunDispatch(token),
  broadcast,
});

function isAgentSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  // `ask_human` runs in the isolated content script, while confirmation gates
  // run in the authoritative service worker.  A worker sender has neither a
  // tab nor a document URL; extension pages always carry their own URL and
  // cannot originate prompt requests.
  return !!sender.tab || !sender.url;
}

function validToken(token: unknown): token is HumanInteractionToken {
  return !!token && typeof token === "object" &&
    typeof (token as { runId?: unknown }).runId === "string" &&
    (token as { runId: string }).runId.length > 0 &&
    typeof (token as { dispatchRevision?: unknown }).dispatchRevision === "number" &&
    Number.isSafeInteger((token as { dispatchRevision: number }).dispatchRevision) &&
    (token as { dispatchRevision: number }).dispatchRevision > 0;
}

function validRequest(msg: HumanInteractRequestMessage): boolean {
  const { interactionId, request, timeoutMs } = msg;
  return typeof interactionId === "string" && interactionId.length > 0 && interactionId.length <= 200 &&
    validToken(msg.token) && !!request && typeof request === "object" &&
    (request.mode === "confirm" || request.mode === "input" || request.mode === "password" ||
      request.mode === "select" || request.mode === "request_help") &&
    typeof request.message === "string" &&
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) &&
    timeoutMs > 0 && timeoutMs <= MAX_HUMAN_INTERACT_TIMEOUT_MS;
}

/** Admit a content-originated prompt only for the current controller revision. */
export function handleHumanInteractRequest(
  msg: HumanInteractRequestMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (!isAgentSender(sender)) {
    sendResponse({ mode: "error", reason: "unauthorized HUMAN_INTERACT sender" });
    return false;
  }
  if (!validRequest(msg)) {
    sendResponse({ mode: "error", reason: "invalid HUMAN_INTERACT request" });
    return false;
  }
  return humanInteractionAuthority.admit(msg, (response) => sendResponse(response));
}

/** Accept only the first valid side-panel response for the admitted prompt. */
export function handleHumanInteractResponse(
  msg: HumanInteractResponseMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  const isExtensionPage = sender.id === chrome.runtime.id &&
    !!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (!isExtensionPage || !validToken(msg.token) || typeof msg.interactionId !== "string") {
    sendResponse({ ok: false, error: "unauthorized HUMAN_INTERACT response" });
    return false;
  }
  const accepted = humanInteractionAuthority.respond(
    msg.interactionId,
    msg.token,
    sanitizeResponse(msg.response),
  );
  sendResponse({ ok: accepted });
  return false;
}

/** Abort/timeout races tombstone the interaction before a delayed request opens it. */
export function handleHumanInteractCancel(
  msg: HumanInteractCancelMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (!isAgentSender(sender) || !validToken(msg.token) || typeof msg.interactionId !== "string") {
    sendResponse({ ok: false, error: "unauthorized HUMAN_INTERACT cancellation" });
    return false;
  }
  sendResponse({ ok: true, settled: humanInteractionAuthority.cancel(msg.interactionId, msg.token) });
  return false;
}
