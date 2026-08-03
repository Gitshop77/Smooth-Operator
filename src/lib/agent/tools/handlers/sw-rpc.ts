/**
 * Shared SW-RPC plumbing for the ring-log handlers.
 *
 * `swRpc` races a `chrome.runtime.sendMessage` round-trip against a 15s
 * timeout AND the step's abort signal (a hung SW must not block the agent
 * loop forever, and a user STOP must interrupt the wait immediately). Rejects
 * on timeout / abort; the timer and abort listener are always cleaned up.
 *
 * `makeRingLogHandler` is the parameterized core behind the console-log and
 * network-log action handlers: both capture page events into the SW-side ring
 * (rate-limit-tracker.ts) and delegate the enable/disable/get/clear/getclear
 * verbs over the same `{ type, verb }` runtime message, differing only in the
 * message type, the action-name literals, and the noun used in success
 * messages. Each thin handler module re-exports five handlers built from this
 * factory.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { SW_RPC_TIMEOUT_MS } from "../constants";
import { type ActionContext, isExtensionContext } from "./types";
import { rejectOnAbort } from "./abort";

/** Response shape the SW's ring-log listener returns. */
export type RingLogRpcResponse = {
  ok: boolean;
  message?: string;
  error?: string;
  enabled?: boolean;
  entries?: unknown[];
};

/**
 * Send one runtime message to the SW, racing the round-trip against
 * `SW_RPC_TIMEOUT_MS` AND the caller's abort signal. Rejects on timeout /
 * abort; the timer and abort listener are always cleaned up.
 */
export async function swRpc<T>(
  message: unknown,
  timeoutLabel: string,
  signal?: AbortSignal,
): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const abort = rejectOnAbort(signal);
  try {
    return (await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error(`${timeoutLabel} timeout`)), SW_RPC_TIMEOUT_MS);
      }),
      abort.promise,
    ])) as T;
  } finally {
    if (t) clearTimeout(t);
    abort.cleanup();
  }
}

/** The verbs the SW's ring-log listener understands. */
type RingLogVerb = "enable" | "disable" | "get" | "clear" | "getclear";

/**
 * Build one ring-log action handler. `actionType` is the action-name literal
 * the dispatcher switches on (e.g. "enable_console_log"); it names the error
 * messages, while `noun` (e.g. "console log") names the success messages.
 */
export function makeRingLogHandler<T extends Action["type"]>(config: {
  messageType: string;
  noun: string;
  actionType: T;
  verb: RingLogVerb;
}): (ctx: ActionContext, action: Extract<Action, { type: T }>) => Promise<ActionResult> {
  const { messageType, noun, actionType, verb } = config;

  return async (ctx, action) => {
    if (!isExtensionContext()) {
      return { action, success: false, message: `${actionType} requires the extension context` };
    }
    try {
      const res = await swRpc<RingLogRpcResponse>({ type: messageType, verb }, messageType, ctx.signal);
      if (!res.ok) {
        return { action, success: false, message: `${actionType} failed: ${res.error ?? "no response"}` };
      }
      switch (verb) {
        case "enable":
          return { action, success: true, message: `${noun} enabled` };
        case "disable":
          return { action, success: true, message: `${noun} disabled` };
        case "clear":
          return { action, success: true, message: `${noun} cleared` };
        case "get": {
          const entries = res.entries ?? [];
          return {
            action,
            success: true,
            message: `${noun}: ${entries.length} entries (${res.enabled ? "enabled" : "disabled"})`,
            // Newest-first: the loop's inline view of extractedContent is
            // head-truncated, so the most recent output must land first (the
            // ring itself stays append-ordered, as pinned by the tracker tests).
            extractedContent: JSON.stringify(entries.slice().reverse()),
          };
        }
        case "getclear": {
          const entries = res.entries ?? [];
          return {
            action,
            success: true,
            message: `${noun}: ${entries.length} entries (cleared)`,
            // Newest-first, same as `get` — the cleared snapshot must show the
            // most recent output first for the same head-truncation reason.
            extractedContent: JSON.stringify(entries.slice().reverse()),
          };
        }
      }
    } catch (e) {
      return {
        action,
        success: false,
        message: `${actionType} failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };
}
