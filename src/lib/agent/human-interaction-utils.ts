/**
 * Shared helpers for human-interaction prompt handling.
 *
 * Extracted so that timeout resolution and response sanitization can be
 * tested and reused independently of the main askHuman flow.
 */

import type { HumanInteractionResponse } from "./human-interaction";

/** Default response timeout for the extension prompt (5 min). */
const DEFAULT_ASK_HUMAN_TIMEOUT_MS = 5 * 60 * 1000;
/** Hard ceiling for a prompt wait (24 h) — `setTimeout` clamps values over
 *  2^31-1 ms (~24.8 d) to ~1 ms, so an oversized override would cancel the
 *  prompt almost instantly instead of granting a long wait. */
const MAX_ASK_HUMAN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the effective timeout for the extension prompt.
 *
 * A caller may set `req.timeoutMs` to override the default. We only accept a
 * positive, finite number; anything else (undefined, 0, negative, NaN,
 * Infinity) falls back to {@link DEFAULT_ASK_HUMAN_TIMEOUT_MS}. An accepted
 * value is clamped to {@link MAX_ASK_HUMAN_TIMEOUT_MS} so `setTimeout`'s
 * 2^31-1 ms clamp can never turn a long wait into an instant cancel.
 */
export function resolveTimeoutMs(timeoutMs?: number): number {
  const base = typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : DEFAULT_ASK_HUMAN_TIMEOUT_MS;
  return Math.min(base, MAX_ASK_HUMAN_TIMEOUT_MS);
}

/** The known tagged-union response `mode` values. */
const KNOWN_RESPONSE_MODES = new Set<HumanInteractionResponse["mode"]>([
  "confirm",
  "input",
  "password",
  "select",
  "request_help",
  "cancelled",
  "error",
]);

/**
 * Validate a `chrome.runtime` callback payload before trusting it.
 *
 * The `HUMAN_INTERACT` response crosses a `chrome.runtime` message boundary,
 * so we don't assume the listener returned a well-formed
 * {@link HumanInteractionResponse}. An undefined/null payload means the
 * listener never called `sendResponse` — treat that as `cancelled`. A defined
 * payload with an unknown `mode` is a malformed/cross-talk response — treat it
 * as a transport `error` rather than handing the agent loop an unexpected
 * shape.
 */
export function sanitizeResponse(
  response: HumanInteractionResponse | undefined | null
): HumanInteractionResponse {
  if (response === undefined || response === null) {
    return { mode: "cancelled" };
  }
  const invalid: HumanInteractionResponse = {
    mode: "error",
    reason: "invalid HUMAN_INTERACT response shape",
  };
  if (typeof response !== "object" || !("mode" in response)) {
    return invalid;
  }
  const mode = (response as { mode: unknown }).mode;
  if (!KNOWN_RESPONSE_MODES.has(mode as HumanInteractionResponse["mode"])) {
    return invalid;
  }
  const r = response as Record<string, unknown>;
  switch (mode) {
    case "confirm":
      return typeof r.confirmed === "boolean"
        ? { mode: "confirm", confirmed: r.confirmed }
        : invalid;
    case "input":
      return typeof r.value === "string" ? { mode: "input", value: r.value } : invalid;
    case "password":
      // Passwords are secrets: the tagged member must be a string, and the
      // consumer decides redaction/refusal based on the `password` tag.
      return typeof r.value === "string" ? { mode: "password", value: r.value } : invalid;
    case "select":
      return typeof r.value === "string" ? { mode: "select", value: r.value } : invalid;
    case "request_help":
      return typeof r.value === "string"
        ? { mode: "request_help", value: r.value }
        : invalid;
    case "cancelled":
      return { mode: "cancelled" };
    case "error":
      return typeof r.reason === "string"
        ? { mode: "error", reason: r.reason }
        : invalid;
    default:
      return invalid;
  }
}
