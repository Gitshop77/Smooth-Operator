/**
 * Error taxonomy — classifies errors so the agent can respond appropriately.
 *
 * Fatal errors (auth, bad request, max steps) should NOT be retried.
 * Transient errors (429, 5xx, network, parse) should be retried with backoff.
 * Cancelled errors are never retried.
 */

/** Categories an error can be classified into. */
export type ErrorCategory =
  | "auth"          // 401 — API key invalid or expired. FATAL.
  | "forbidden"     // 403 — access denied. FATAL.
  | "bad_request"   // 400 — malformed request. FATAL.
  | "rate_limit"    // 429 — too many requests. TRANSIENT (retry with backoff).
  | "server_error"  // 5xx — server error. TRANSIENT (retry with backoff).
  | "network"       // fetch failed, ECONNRESET, timeout. TRANSIENT.
  | "cancelled"     // AbortError — user stopped. NOT retried.
  | "parse"         // LLM returned unparseable output. TRANSIENT (retry with nudge).
  | "max_steps"     // reached max steps. FATAL.
  | "max_failures"  // too many consecutive failures. FATAL.
  | "programmer_error" // TypeError / ReferenceError / SyntaxError — FATAL (a bug).
  | "unknown";      // anything else. TRANSIENT (retry once).

/** Classified error with category + retry guidance. */
export interface ClassifiedError {
  /** The category that was matched. */
  category: ErrorCategory;
  /** Whether the error is fatal (no retry). */
  fatal: boolean;
  /** Whether the error should be retried with backoff. */
  retryable: boolean;
  /** Original error message. */
  message: string;
  /** Original error object (for re-throwing or inspecting stack). */
  originalError?: unknown;
}

/**
 * Extract a lowercase message string from any thrown value.
 * Falls back to `String(error)` if the value is not an Error.
 */
function toLowerMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.toLowerCase();
}

/** Test whether `haystack` contains any of the substrings (case-insensitive). */
function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/** Test whether `haystack` contains a status code as a standalone token (word boundary). */
function containsStatus(haystack: string, code: string): boolean {
  return new RegExp(`\\b${code}\\b`).test(haystack);
}

/**
 * Classify an error into one of {@link ErrorCategory}.
 *
 * Classification is substring-based on the error message. Categories are
 * checked in priority order: auth → forbidden → bad_request → cancelled →
 * rate_limit → server_error → network → parse → max_steps → max_failures →
 * programmer_error → unknown.
 *
 * Auth/forbidden/bad_request are checked BEFORE cancelled because a 401/403/400
 * response from an aborted fetch is more usefully classified as auth (fatal)
 * than as cancelled (non-retryable but non-fatal). Status-code matching uses
 * word-boundary regexes (e.g. `\b401\b`) so messages like "error 40123" don't
 * false-positive on the 401 check.
 */
export function classifyError(error: unknown): ClassifiedError {
  const originalMessage = error instanceof Error ? error.message : String(error);
  const lower = toLowerMessage(error);

  // Auth errors — fatal, don't retry.
  if (containsStatus(lower, "401") || containsAny(lower, ["unauthorized", "invalid api key"])) {
    return { category: "auth", fatal: true, retryable: false, message: originalMessage, originalError: error };
  }

  // Forbidden — fatal.
  if (containsStatus(lower, "403") || containsAny(lower, ["forbidden", "access denied"])) {
    return { category: "forbidden", fatal: true, retryable: false, message: originalMessage, originalError: error };
  }

  // Bad request — fatal.
  if (containsStatus(lower, "400") || containsAny(lower, ["bad request", "invalid request"])) {
    return { category: "bad_request", fatal: true, retryable: false, message: originalMessage, originalError: error };
  }

  // Cancelled (AbortError) — never retry. Checked AFTER auth/forbidden so an
  // aborted 401 fetch still classifies as auth (which is the more useful label).
  if (containsAny(lower, ["abort", "cancelled", "canceled"])) {
    return { category: "cancelled", fatal: false, retryable: false, message: originalMessage, originalError: error };
  }

  // Rate limit — transient, retry with backoff.
  if (containsStatus(lower, "429") || containsAny(lower, ["too many requests", "rate limit"])) {
    return { category: "rate_limit", fatal: false, retryable: true, message: originalMessage, originalError: error };
  }

  // Server errors (5xx) — transient.
  if (/\b5\d\d\b/.test(lower) || containsAny(lower, ["server error", "internal error", "bad gateway", "service unavailable"])) {
    return { category: "server_error", fatal: false, retryable: true, message: originalMessage, originalError: error };
  }

  // Network errors — transient.
  if (containsAny(lower, ["fetch", "network", "econnreset", "econnrefused", "timeout", "etimedout"])) {
    return { category: "network", fatal: false, retryable: true, message: originalMessage, originalError: error };
  }

  // Structured status code (carried by the HTTP transport on the error object)
  // takes priority over the generic substring matches below. A provider 400
  // whose body merely contains "validation" must NOT be mislabeled as a
  // transient `parse` error (which would trigger needless retries of an
  // unfixable request). 401/403 map to their fatal categories; other 4xx
  // (except 429) → bad_request (fatal); 429 → rate_limit; 5xx → server_error.
  const status = (error as { status?: number }).status;
  if (typeof status === "number") {
    if (status === 401) {
      return { category: "auth", fatal: true, retryable: false, message: originalMessage, originalError: error };
    }
    if (status === 403) {
      return { category: "forbidden", fatal: true, retryable: false, message: originalMessage, originalError: error };
    }
    if (status === 400 || (status >= 400 && status < 500 && status !== 429)) {
      return { category: "bad_request", fatal: true, retryable: false, message: originalMessage, originalError: error };
    }
    if (status === 429) {
      return { category: "rate_limit", fatal: false, retryable: true, message: originalMessage, originalError: error };
    }
    if (status >= 500 && status < 600) {
      return { category: "server_error", fatal: false, retryable: true, message: originalMessage, originalError: error };
    }
  }

  // Parse errors — transient (retry with nudge).
  if (containsAny(lower, ["json", "parse", "schema", "validation"])) {
    return { category: "parse", fatal: false, retryable: true, message: originalMessage, originalError: error };
  }

  // Max steps — fatal.
  if (containsAny(lower, ["max steps", "step budget"])) {
    return { category: "max_steps", fatal: true, retryable: false, message: originalMessage, originalError: error };
  }

  // Max failures — fatal.
  if (containsAny(lower, ["max failures", "consecutive failures"])) {
    return { category: "max_failures", fatal: true, retryable: false, message: originalMessage, originalError: error };
  }

  // Programmer errors (TypeError / ReferenceError / SyntaxError) — fatal, no
  // retry. These are bugs in our code; retrying would just waste budget.
  // (JSON.parse SyntaxError messages (e.g. "Unexpected token") may NOT contain "parse" — they fall through to programmer_error. Protocol step functions catch JSON.parse errors internally, so this is latent.)
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
    return { category: "programmer_error", fatal: true, retryable: false, message: originalMessage, originalError: error };
  }

  // Unknown — retry once.
  return { category: "unknown", fatal: false, retryable: true, message: originalMessage, originalError: error };
}

/**
 * Produce a user-friendly message for a classified error.
 * Falls back to the original message for unknown categories.
 */
export function friendlyErrorMessage(error: ClassifiedError): string {
  switch (error.category) {
    case "auth":
      return "API key is invalid or expired. Check your settings.";
    case "forbidden":
      return "Access denied. Your API key may not have permission for this model.";
    case "bad_request":
      return "The request was malformed. This is likely a bug — please report it.";
    case "rate_limit":
      return "Rate limit hit. The agent will retry automatically.";
    case "server_error":
      return "The LLM server had an error. The agent will retry automatically.";
    case "network":
      return "Network error. Check your internet connection.";
    case "cancelled":
      return "Agent stopped by user.";
    case "parse":
      return "The LLM returned an invalid response. The agent will retry.";
    case "max_steps":
      return "Reached the maximum number of steps.";
    case "max_failures":
      return "Too many consecutive failures. The agent gave up.";
    case "programmer_error":
      return "An internal error occurred (this is likely a bug — please report it).";
    default:
      return error.message;
  }
}

// ─── Typed error hierarchy ───────────────────────────────────────────────────
//
// A coarse ErrorCategory enum is great for retry/fatal decisions, but action
// execution benefits from finer-grained typed errors. The hierarchy below
// mirrors a structured error taxonomy (22 typed subclasses) so the
// executor, history, and recovery logic can branch on a specific failure mode
// (element-not-found vs element-not-interactable vs stale-reference vs …)
// rather than substring-matching messages.
//
// All typed errors extend `AgentError` (the shared base class). The base class
// preserves the original message and stamps a stable `code` string so a single
// `instanceof` check (or a `code` switch) is enough to dispatch recovery
// behaviour. Categories from {@link ErrorCategory} are still derived via
// {@link classifyError} so callers that only need coarse retry guidance don't
// have to learn the typed hierarchy.

/**
 * Base class for every typed agent error. Mirrors the structure of a
 * typed error base class: an `Error` subclass that stamps its own
 * `name` from the constructor and exposes a stable `code` string for
 * switch-style dispatch.
 */
export class AgentError extends Error {
  /** Stable lowercase error code (e.g. `"element_not_found"`). */
  readonly code: string;
  /** Optional remote stack trace (filled when the error crosses a boundary). */
  remoteStacktrace: string;
  constructor(message: string, code: string = "agent_error") {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.remoteStacktrace = "";
  }
}

/** An element could not be found in the DOM (NoSuchElement / ElementNotFound). */
export class NoSuchElementException extends AgentError {
  constructor(message = "no such element") { super(message, "no_such_element"); }
}

/** Alias mirroring the common "ElementNotFound" naming. */
export class ElementNotFoundError extends AgentError {
  constructor(message = "element not found") { super(message, "element_not_found"); }
}

/** An element exists but cannot be interacted with (hidden, disabled, off-screen). */
export class ElementNotInteractableError extends AgentError {
  constructor(message = "element not interactable") { super(message, "element_not_interactable"); }
}

/** A click was blocked by another element on top of the target. */
export class ElementClickInterceptedError extends AgentError {
  constructor(message = "element click intercepted") { super(message, "element_click_intercepted"); }
}

/** An option in a `<select>` cannot be selected because it is disabled. */
export class ElementNotSelectableError extends AgentError {
  constructor(message = "element not selectable") { super(message, "element_not_selectable"); }
}

/**
 * A previously-resolved element is no longer attached to the document. The
 * page mutated between extraction and action execution; the caller should
 * re-extract state and retry.
 */
export class StaleElementReferenceError extends AgentError {
  constructor(message = "stale element reference") { super(message, "stale_element_reference"); }
}

/** A locator/selector string is malformed or unsupported. */
export class InvalidSelectorError extends AgentError {
  constructor(message = "invalid selector") { super(message, "invalid_selector"); }
}

/** A polling condition did not become true within the timeout. */
export class TimeoutError extends AgentError {
  constructor(message = "timeout") { super(message, "timeout"); }
}

/** The page reached a state the agent cannot recover from (e.g. dialog open). */
export class UnexpectedAlertOpenError extends AgentError {
  /** The text of the open dialog, if known. */
  alertText?: string;
  constructor(message = "unexpected alert open", alertText?: string) {
    super(message, "unexpected_alert_open");
    this.alertText = alertText;
  }
}

/** No JavaScript dialog is currently open (alert/confirm/prompt). */
export class NoSuchAlertError extends AgentError {
  constructor(message = "no such alert") { super(message, "no_such_alert"); }
}

/** A coordinate is outside the viewport or the page's scrollable area. */
export class MoveTargetOutOfBoundsError extends AgentError {
  constructor(message = "move target out of bounds") { super(message, "move_target_out_of_bounds"); }
}

/** The argument passed to an action is invalid (wrong type, out of range, …). */
export class InvalidArgumentError extends AgentError {
  constructor(message = "invalid argument") { super(message, "invalid_argument"); }
}

/** The element is in a state that does not permit the requested operation. */
export class InvalidElementStateError extends AgentError {
  constructor(message = "invalid element state") { super(message, "invalid_element_state"); }
}

/** A page-load or script-execution timeout fired. */
export class ScriptTimeoutError extends AgentError {
  constructor(message = "script timeout") { super(message, "script_timeout"); }
}

/** A JavaScript error was thrown by page-side code. */
export class JavascriptError extends AgentError {
  constructor(message = "javascript error") { super(message, "javascript_error"); }
}

/** The operation is not supported in the current context. */
export class UnsupportedOperationError extends AgentError {
  constructor(message = "unsupported operation") { super(message, "unsupported_operation"); }
}

/** A frame switch was requested but the frame does not exist. */
export class NoSuchFrameError extends AgentError {
  constructor(message = "no such frame") { super(message, "no_such_frame"); }
}

/** A window switch was requested but the window does not exist. */
export class NoSuchWindowError extends AgentError {
  constructor(message = "no such window") { super(message, "no_such_window"); }
}

/** A cookie operation was requested for a domain the agent cannot access. */
export class InvalidCookieDomainError extends AgentError {
  constructor(message = "invalid cookie domain") { super(message, "invalid_cookie_domain"); }
}

/** A cookie could not be set (invalid shape, size, or domain). */
export class UnableToSetCookieError extends AgentError {
  constructor(message = "unable to set cookie") { super(message, "unable_to_set_cookie"); }
}

/** A shadow root that was previously resolved has been detached. */
export class DetachedShadowRootError extends AgentError {
  constructor(message = "detached shadow root") { super(message, "detached_shadow_root"); }
}

/** A requested shadow root does not exist on the element. */
export class NoSuchShadowRootError extends AgentError {
  constructor(message = "no such shadow root") { super(message, "no_such_shadow_root"); }
}

/**
 * Map of error `code` strings to their typed classes. Used by
 * {@link decodeAgentError} to rehydrate a serialized error back into the
 * correct subclass (mirrors the ERROR_CODE_TO_TYPE map from the source
 * taxonomy). Keeping it explicit (rather than reflection-based) means
 * tree-shaking can drop unused classes when the consumer only imports a
 * subset.
 *
 * The constructor type is loosened to `new (...args: any[]) => AgentError`
 * so subclasses with extra optional parameters (e.g. `UnexpectedAlertOpenError`
 * takes an optional `alertText`) can sit in the same map.
 */
type AgentErrorCtor = new (...args: any[]) => AgentError;

export const ERROR_CODE_TO_TYPE: ReadonlyMap<string, AgentErrorCtor> = new Map<string, AgentErrorCtor>([
  ["agent_error", AgentError],
  ["no_such_element", NoSuchElementException],
  ["element_not_found", ElementNotFoundError],
  ["element_not_interactable", ElementNotInteractableError],
  ["element_click_intercepted", ElementClickInterceptedError],
  ["element_not_selectable", ElementNotSelectableError],
  ["stale_element_reference", StaleElementReferenceError],
  ["invalid_selector", InvalidSelectorError],
  ["timeout", TimeoutError],
  ["unexpected_alert_open", UnexpectedAlertOpenError],
  ["no_such_alert", NoSuchAlertError],
  ["move_target_out_of_bounds", MoveTargetOutOfBoundsError],
  ["invalid_argument", InvalidArgumentError],
  ["invalid_element_state", InvalidElementStateError],
  ["script_timeout", ScriptTimeoutError],
  ["javascript_error", JavascriptError],
  ["unsupported_operation", UnsupportedOperationError],
  ["no_such_frame", NoSuchFrameError],
  ["no_such_window", NoSuchWindowError],
  ["invalid_cookie_domain", InvalidCookieDomainError],
  ["unable_to_set_cookie", UnableToSetCookieError],
  ["detached_shadow_root", DetachedShadowRootError],
  ["no_such_shadow_root", NoSuchShadowRootError],
]);

/**
 * Serialize an {@link AgentError} (or plain Error) into a plain object that
 * can be logged, sent over a message boundary, or persisted to run history
 * without losing the typed `code`. Mirrors the `encodeError` helper from the
 * source taxonomy.
 */
export function encodeAgentError(err: unknown): { code: string; message: string; name: string } {
  if (err instanceof AgentError) {
    return { code: err.code, message: err.message, name: err.name };
  }
  if (err instanceof Error) {
    return { code: "agent_error", message: err.message, name: err.name };
  }
  return { code: "agent_error", message: String(err), name: "Error" };
}

/**
 * Rehydrate a serialized error object back into the matching typed
 * {@link AgentError} subclass. If the `code` is unknown, falls back to the
 * base {@link AgentError} so callers always get an `instanceof AgentError`.
 */
export function decodeAgentError(data: { code?: string; message?: string }): AgentError {
  const code = typeof data?.code === "string" ? data.code : "agent_error";
  const message = typeof data?.message === "string" ? data.message : "";
  const ctor = ERROR_CODE_TO_TYPE.get(code) ?? AgentError;
  return new ctor(message);
}

/** Type guard: did the thrown value come from the typed hierarchy? */
export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}
