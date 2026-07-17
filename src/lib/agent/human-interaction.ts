/**
 * Human-interaction tool — lets the agent ask the user for help.
 *
 * Modes:
 * confirm — yes/no question (e.g. "Submit this form?")
 * input — ask for text input (e.g. "What's your email?")
 * password — ask for a masked secret (e.g. "Enter your API key")
 * select — ask user to pick from options (e.g. "Which shipping method?")
 * request_help — open-ended request for help (e.g. "I'm stuck, what should I do?")
 *
 * In the extension, this opens a modal in the side panel. In the demo, it
 * uses window.prompt/confirm. The agent PAUSES until the user responds.
 */

import { requiresConfirmation, type AgentMode } from "./modes";

/** The 5 supported interaction modes. */
export type HumanInteractionMode = "confirm" | "input" | "password" | "select" | "request_help";

/** Request payload sent by the agent to the user. */
export interface HumanInteractionRequest {
  /** Which kind of prompt to display. */
  mode: HumanInteractionMode;
  /** Question or instruction to show the user. */
  message: string;
  /** For `select` mode: the options the user can choose from. */
  options?: string[];
  /** For `input` mode: pre-filled default value. */
  defaultValue?: string;
  /**
 * Optional timeout (ms) for the extension prompt. When set, the extension
 * path enforces it (overriding the 5-min default). Ignored in the
 * non-extension fallback. Must be a positive, finite number; invalid values
 * fall back to {@link DEFAULT_ASK_HUMAN_TIMEOUT_MS}.
 */
  timeoutMs?: number;
}

/** Tagged-union response from the user. */
export type HumanInteractionResponse =
  | { mode: "confirm"; confirmed: boolean }
  | { mode: "input"; value: string }
  | { mode: "select"; value: string }
  | { mode: "request_help"; value: string }
  | { mode: "cancelled" } // user dismissed the prompt (or no response within timeout)
  | { mode: "error"; reason: string }; // transport/messaging failure — distinct from a user dismissal

/**
 * Check if an action type requires human confirmation before executing.
 *
 * This delegates to {@link requiresConfirmation} from `./modes` — the
 * single source of truth for which actions need confirmation per mode.
 */
export function shouldAskForConfirmation(actionType: string, mode: AgentMode): boolean {
  return requiresConfirmation(actionType, mode);
}

/** Default response timeout for the extension prompt (5 min). */
const DEFAULT_ASK_HUMAN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Resolve the effective timeout for the extension prompt.
 *
 * A caller may set `req.timeoutMs` to override the default. We only accept a
 * positive, finite number; anything else (undefined, 0, negative, NaN,
 * Infinity) falls back to {@link DEFAULT_ASK_HUMAN_TIMEOUT_MS}. This prevents a
 * malformed value from disabling the timeout (0/negative) or producing a
 * nonsensical timer.
 */
function resolveTimeoutMs(timeoutMs?: number): number {
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : DEFAULT_ASK_HUMAN_TIMEOUT_MS;
}

/** The known tagged-union response `mode` values. */
const KNOWN_RESPONSE_MODES = new Set<HumanInteractionResponse["mode"]>([
  "confirm",
  "input",
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
 // The `mode` is known, but a payload that crossed the chrome.runtime boundary
 // may still be missing the fields required by that mode. Validate the
 // mode-specific shape so the agent loop never receives a malformed union
 // member (e.g. a `confirm` without `confirmed`, or an `input` without a
 // string `value`).
  const r = response as Record<string, unknown>;
  switch (mode) {
    case "confirm":
      return typeof r.confirmed === "boolean"
        ? { mode: "confirm", confirmed: r.confirmed }
        : invalid;
    case "input":
      return typeof r.value === "string" ? { mode: "input", value: r.value } : invalid;
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

/**
 * In the extension, send a message to the side panel and wait for its
 * `sendResponse` payload. Resolves when the side panel responds, or after the
 * timeout elapses (whichever comes first).
 *
 * Robustness:
 * - `sendMessage`'s callback receives the side panel's `sendResponse` payload
 * directly — each call's callback is scoped to that call, so a stale
 * response from an earlier prompt can't resolve the current promise.
 * - `lastError` is checked — fire-and-forget silently drops send failures
 * (e.g. side panel not yet open).
 * - A 5-min timeout guarantees the agent eventually unblocks even if the
 * user walks away. The timer is always cleared in `finish`.
 */
export async function askHumanExtension(
  req: HumanInteractionRequest,
  timeoutMs: number
): Promise<HumanInteractionResponse> {
  return new Promise<HumanInteractionResponse>((resolve) => {
    let settled = false;
    const finish = (resp: HumanInteractionResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(resp);
    };

    const timer = setTimeout(() => finish({ mode: "cancelled" }), timeoutMs);

 // The side panel's onMessage listener for HUMAN_INTERACT calls
 // `sendResponse(...)` synchronously, so the response arrives via this
 // callback. Check lastError so a missing receiver doesn't leave the agent
 // hanging until the timeout fires.
    try {
      void chrome.runtime.sendMessage(
        { type: "HUMAN_INTERACT", request: req },
        (response: HumanInteractionResponse | undefined) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
 // Receiver missing (side panel closed, etc.) — this is a transport
 // failure, NOT a user dismissal. Report it distinctly so the agent
 // can tell "prompt failed to deliver" apart from "user declined".
            finish({
              mode: "error",
              reason: lastError.message || "chrome.runtime.lastError (no receiver)",
            });
            return;
          }
 // A defined response (including `{ mode: "cancelled" }`) came back
 // from the side panel — the prompt was delivered and the user acted
 // (or dismissed) it. Validate it against the expected shape before
 // trusting it, since it crossed a chrome.runtime message boundary.
          finish(sanitizeResponse(response));
        }
      );
    } catch (err) {
 // An exception while dispatching the message is a transport failure,
 // distinct from a user cancellation. Surface it as an error so the agent
 // can decide whether to retry, abort, or ask again.
      finish({
        mode: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Unified `askHuman` — dispatches to {@link askHumanExtension} when running
 * inside a Chrome extension context. Falls back to `window.confirm`/`window.prompt`
 * for test/non-extension contexts.
 */
export async function askHuman(req: HumanInteractionRequest): Promise<HumanInteractionResponse> {
  const isExtension = typeof chrome !== "undefined" && !!chrome.runtime?.id;
  if (isExtension) {
    return askHumanExtension(req, resolveTimeoutMs(req.timeoutMs));
  }
 // Non-extension fallback (tests, non-Chrome contexts).
  if (req.mode === "confirm") {
    return { mode: "confirm", confirmed: window.confirm(req.message) };
  }
  if (req.mode === "input" || req.mode === "password") {
 // For non-extension password prompts, fall back to window.prompt (jsdom
 // and tests don't have a native password input). The value still flows
 // through `substituteSecrets` at the executor when the agent used a
 // `%secret_name%` placeholder, so the cleartext never reaches the LLM.
 // The extension side-panel path (askHumanExtension) uses a real masked
 // <input type="password"> for genuine password UX.
 //
 // Never pre-fill a secret: for `password` mode we pass no default so the
 // cleartext isn't surfaced in the prompt UI. Only plain `input` mode uses
 // `defaultValue`.
    const isSecret = req.mode === "password";
    const def = isSecret ? "" : (req.defaultValue ?? "");
    const value = window.prompt(req.message, def);
    return value === null ? { mode: "cancelled" } : { mode: "input", value };
  }
  if (req.mode === "select") {
 // List the options so the user can pick by number. A cancelled prompt
 // (null) or an out-of-range/invalid pick returns `cancelled` rather than
 // silently swallowing the choice.
    const options = req.options ?? [];
    if (options.length === 0) {
 // No options to choose from — there is nothing meaningful to select.
      return { mode: "cancelled" };
    }
    const list = options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    const raw = window.prompt(`${req.message}\n\n${list}`, "1");
    if (raw === null) return { mode: "cancelled" };
    const idx = Number.parseInt(raw.trim(), 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= options.length) {
      return { mode: "cancelled" };
    }
    return { mode: "select", value: options[idx] };
  }
  if (req.mode === "request_help") {
 // Free-text help request — capture whatever the user types. A cancelled
 // prompt returns `cancelled` instead of inventing a value.
    const value = window.prompt(req.message);
    return value === null ? { mode: "cancelled" } : { mode: "request_help", value };
  }
  return { mode: "cancelled" };
}
