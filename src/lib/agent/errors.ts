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
  | "unknown";      // anything else. Bounded retry (at most once); repeats are fatal.

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
const STATUS_RES = new Map<string, RegExp>();
function containsStatus(haystack: string, code: string): boolean {
  let re = STATUS_RES.get(code);
  if (!re) {
    re = new RegExp(`\\b${code}\\b`);
    STATUS_RES.set(code, re);
  }
  return re.test(haystack);
}

/** Matches a 5xx server-error status code as a standalone token (word boundary). */
const FIVE_XX_RE = /\b5\d\d\b/;

/**
 * Classify an error into one of {@link ErrorCategory}.
 *
 * Classification is substring-based on the error message. Categories are
 * checked in priority order: auth → forbidden → bad_request → cancelled →
 * server_error → rate_limit → network → <structured status> →
 * programmer_error → parse → max_steps → max_failures → unknown.
 *
 * Ordering notes: `server_error` is checked before `rate_limit` so a 5xx
 * response whose body mentions "rate limit" stays a `server_error`. The
 * structured `status` code (when present on the error object) overrides the
 * substring guesses that follow. The `programmer_error` instanceof check sits
 * AFTER `network` but BEFORE `parse`: a real browser `fetch` failure is a
 * `TypeError` ("Failed to fetch") and must remain a retried `network` error,
 * while a `JSON.parse` SyntaxError (message contains "json") must be FATAL.
 *
 * Auth/forbidden/bad_request are checked BEFORE cancelled because a 401/403/400
 * response from an aborted fetch is more usefully classified as auth (fatal)
 * than as cancelled (non-retryable but non-fatal). Status-code matching uses
 * word-boundary regexes (e.g. `\b401\b`) so messages like "error 40123" don't
 * false-positive on the 401 check.
 *
 * The optional `attempt` argument is the number of prior consecutive failures
 * already seen for this run. It is used only to bound "unknown" retries: the
 * first unfamiliar error is retried once, but a repeated one is treated as
 * fatal so a non-transient bug is not retried until `maxFailures` (which would
 * only waste tokens masking the underlying fault).
 */
export function classifyError(error: unknown, attempt = 0): ClassifiedError {
  const originalMessage = error instanceof Error ? error.message : String(error);
  const lower = toLowerMessage(error);

  const mk = (
    category: ErrorCategory,
    fatal: boolean,
    retryable: boolean,
  ): ClassifiedError => ({
    category,
    fatal,
    retryable,
    message: originalMessage,
    originalError: error,
  });

 // Auth errors — fatal, don't retry.
  if (containsStatus(lower, "401") || containsAny(lower, ["unauthorized", "invalid api key"])) {
    return mk("auth", true, false);
  }

 // Forbidden — fatal.
  if (containsStatus(lower, "403") || containsAny(lower, ["forbidden", "access denied"])) {
    return mk("forbidden", true, false);
  }

 // Bad request — fatal.
  if (containsStatus(lower, "400") || containsAny(lower, ["bad request", "invalid request"])) {
    return mk("bad_request", true, false);
  }

 // Cancelled (AbortError) — never retry. Checked AFTER auth/forbidden so an
 // aborted 401 fetch still classifies as auth (which is the more useful label).
  if (containsAny(lower, ["abort", "cancelled", "canceled"])) {
    return mk("cancelled", false, false);
  }

 // Server errors (5xx) — transient. Checked BEFORE rate_limit so that a 5xx
 // response whose body happens to mention "rate limit" is still classified as
 // a server_error (retry with backoff) rather than as rate_limit.
  if (FIVE_XX_RE.test(lower) || containsAny(lower, ["server error", "internal error", "bad gateway", "service unavailable", "gateway timeout"])) {
    return mk("server_error", false, true);
  }

 // Rate limit — transient, retry with backoff.
  if (containsStatus(lower, "429") || containsAny(lower, ["too many requests", "rate limit"])) {
    return mk("rate_limit", false, true);
  }

 // Network errors — transient.
 // A browser `fetch` network failure surfaces as a `TypeError` ("Failed to
 // fetch" / "NetworkError" / "fetch failed"). That case MUST stay a transient
 // `network` error so it is retried — detect it explicitly here, BEFORE the
 // generic `programmer_error` instanceof check near the bottom, so a fetch
 // failure is not mistaken for a code bug.
  if (
    error instanceof TypeError &&
    /(failed to fetch|fetch failed|networkerror|network request failed|load failed)/.test(lower)
  ) {
    return mk("network", false, true);
  }

 // Broad network substring match. This is intentionally restricted to values
 // that are NOT a TypeError/ReferenceError/SyntaxError: a genuine code bug
 // whose message coincidentally mentions a transport word (e.g.
 // `TypeError: Cannot read property 'network' of undefined`, or
 // `Error("fetch() config is invalid")` thrown as a plain Error) must be
 // classified as a FATAL `programmer_error` (below), not retried as if it were
 // a transient network hiccup. Only the fetch-failure TypeError form above is
 // treated as transient network.
 // A truncated/mid-stream stall ("stream stall: no data for 30000ms") is a
 // transient transport interruption, not an unexpected `unknown`. Include
 // `stall` (and the `stream` token it carries) so it classifies as `network`
 // and gets retried with the friendly "Network error" message rather than
 // surfacing the raw, internally-coupled stall string to the user.
  if (
    !(error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) &&
    containsAny(lower, ["fetch failed", "network", "econnreset", "econnrefused", "timeout", "etimedout", "stall", "stream"])
  ) {
    return mk("network", false, true);
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
      return mk("auth", true, false);
    }
    if (status === 403) {
      return mk("forbidden", true, false);
    }
    if (status === 400 || (status >= 400 && status < 500 && status !== 429 && status !== 408 && status !== 425)) {
      return mk("bad_request", true, false);
    }
    if (status === 408 || status === 425) {
      return mk("network", false, true);
    }
    if (status === 429) {
      return mk("rate_limit", false, true);
    }
    if (status >= 500 && status < 600) {
      return mk("server_error", false, true);
    }
  }

 // Programmer errors (TypeError / ReferenceError / SyntaxError) — fatal, no
 // retry. These are bugs in our code; retrying would just waste budget.
 // This check is placed BEFORE the `parse` substring branch so that genuine
 // code bugs — e.g. a `JSON.parse` failure, whose SyntaxError message contains
 // "json" — are treated as FATAL rather than being silently retried as a
 // transient `parse` error. It stays AFTER the `network` branch (above) so a
 // browser `fetch` network failure (a `TypeError: Failed to fetch`) is still
 // classified as a transient `network` error and retried.
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
    return mk("programmer_error", true, false);
  }

 // Request-shape / validation errors — FATAL. A provider SDK may throw a
 // plain `Error("validation failed")` WITHOUT attaching a `status` field, so it
 // never reaches the structured-status block above. Validation/schema problems
 // are non-recoverable (retrying the same request yields the same failure), so
 // such an error must be classified as a FATAL `bad_request` rather than a
 // transient `parse` error (which would be retried indefinitely and burn step
 // budget). This branch only applies when no `status` is present; any error
 // carrying a 4xx status is already handled by the structured-status block.
  if (containsAny(lower, ["validation", "schema"])) {
    return mk("bad_request", true, false);
  }

 // Parse errors — transient (retry with nudge). Only reached for errors that
 // are NOT TypeError/ReferenceError/SyntaxError (e.g. an `Error` thrown when
 // the LLM returns unparseable output) and whose message mentions a genuine
 // decode signal ("json"/"parse"). Request-shape phrasing ("validation"/
 // "schema") is handled above as a FATAL `bad_request`, not retried here.
  if (containsAny(lower, ["json", "parse"])) {
    return mk("parse", false, true);
  }

 // Max steps — fatal.
  if (containsAny(lower, ["max steps", "step budget"])) {
    return mk("max_steps", true, false);
  }

 // Max failures — fatal.
  if (containsAny(lower, ["max failures", "consecutive failures"])) {
    return mk("max_failures", true, false);
  }

 // Unknown — bounded retry. An error that matches no other branch is treated
 // as transient and retried once (attempt 0). A repeat occurrence (attempt >= 1)
 // is fatal: a non-transient fault should not be retried indefinitely and burn
 // tokens while masquerading as "transient". Network/5xx/429/parse keep their
 // dedicated, always-retryable classifications above.
  if (attempt >= 1) {
    return mk("unknown", true, false);
  }
  return mk("unknown", false, true);
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
      return "An unexpected error occurred. The agent will retry.";
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
  constructor(message?: string, code: string = "agent_error") {
    super(message ?? "");
    this.name = new.target.name;
    this.code = code;
    this.remoteStacktrace = "";
  }
}

// ─── Table-driven typed error subclasses ─────────────────────────────────────
//
// The 21 "trivial" subclasses below differ only in their `name`, stable `code`,
// and default message. Rather than repeat ~60 lines of boilerplate that must
// stay in lock-step with the `ERROR_CODE_TO_TYPE` map, they are generated from
// a single `ERROR_SPECS` table via {@link defineError}. The table is the sole
// source of truth: adding a new error type means adding one row here — plus the
// special `UnexpectedAlertOpenError` class below (the only subclass that carries
// extra state). `ERROR_CODE_TO_TYPE` is built from the same table in one pass,
// so the two can never drift apart.
//
// NOTE on the two "element-not-found" codes: `NoSuchElementException`
// (`no_such_element`) and `ElementNotFoundError` (`element_not_found`) are kept
// as distinct exports because an external test pins both `code` strings. They
// are intentionally preserved here so the public API and that test are
// unaffected; unifying them is left for when the test constraint is lifted.

/** Constructor type for every typed error class. */
type AgentErrorCtor = new (message?: string) => AgentError;

interface ErrorSpec {
  /** Export name (also the runtime `name` of thrown instances). */
  name: string;
  /** Stable lowercase `code` used for serialization/dispatch. */
  code: string;
  /** Default message when the constructor is called without one. */
  dflt: string;
}

/**
 * Build a trivial {@link AgentError} subclass from a spec. The subclass stamps
 * its own `name` (so `encodeAgentError` and `instanceof` checks report the
 * expected identity) alongside the stable `code`.
 */
function defineError(name: string, code: string, dflt: string): AgentErrorCtor {
  return class extends AgentError {
    constructor(message: string = dflt) {
      super(message, code);
      this.name = name;
    }
  };
}

const ERROR_SPECS: readonly ErrorSpec[] = [
  { name: "NoSuchElementException", code: "no_such_element", dflt: "no such element" },
  { name: "ElementNotFoundError", code: "element_not_found", dflt: "element not found" },
  { name: "ElementNotInteractableError", code: "element_not_interactable", dflt: "element not interactable" },
  { name: "ElementClickInterceptedError", code: "element_click_intercepted", dflt: "element click intercepted" },
  { name: "ElementNotSelectableError", code: "element_not_selectable", dflt: "element not selectable" },
  { name: "StaleElementReferenceError", code: "stale_element_reference", dflt: "stale element reference" },
  { name: "InvalidSelectorError", code: "invalid_selector", dflt: "invalid selector" },
  { name: "TimeoutError", code: "timeout", dflt: "timeout" },
  { name: "NoSuchAlertError", code: "no_such_alert", dflt: "no such alert" },
  { name: "MoveTargetOutOfBoundsError", code: "move_target_out_of_bounds", dflt: "move target out of bounds" },
  { name: "InvalidArgumentError", code: "invalid_argument", dflt: "invalid argument" },
  { name: "InvalidElementStateError", code: "invalid_element_state", dflt: "invalid element state" },
  { name: "ScriptTimeoutError", code: "script_timeout", dflt: "script timeout" },
  { name: "JavascriptError", code: "javascript_error", dflt: "javascript error" },
  { name: "UnsupportedOperationError", code: "unsupported_operation", dflt: "unsupported operation" },
  { name: "NoSuchFrameError", code: "no_such_frame", dflt: "no such frame" },
  { name: "NoSuchWindowError", code: "no_such_window", dflt: "no such window" },
  { name: "InvalidCookieDomainError", code: "invalid_cookie_domain", dflt: "invalid cookie domain" },
  { name: "UnableToSetCookieError", code: "unable_to_set_cookie", dflt: "unable to set cookie" },
  { name: "DetachedShadowRootError", code: "detached_shadow_root", dflt: "detached shadow root" },
  { name: "NoSuchShadowRootError", code: "no_such_shadow_root", dflt: "no such shadow root" },
];

/** One class instance per spec, built once. */
const ERROR_CLASSES: Record<string, AgentErrorCtor> = {};
for (const spec of ERROR_SPECS) {
  ERROR_CLASSES[spec.name] = defineError(spec.name, spec.code, spec.dflt);
}

// Re-export each generated class under its canonical name so existing importers
// (and their `instanceof` checks) are unaffected.
export const {
  NoSuchElementException,
  ElementNotFoundError,
  ElementNotInteractableError,
  ElementClickInterceptedError,
  ElementNotSelectableError,
  StaleElementReferenceError,
  InvalidSelectorError,
  TimeoutError,
  NoSuchAlertError,
  MoveTargetOutOfBoundsError,
  InvalidArgumentError,
  InvalidElementStateError,
  ScriptTimeoutError,
  JavascriptError,
  UnsupportedOperationError,
  NoSuchFrameError,
  NoSuchWindowError,
  InvalidCookieDomainError,
  UnableToSetCookieError,
  DetachedShadowRootError,
  NoSuchShadowRootError,
} = ERROR_CLASSES;

/** The page reached a state the agent cannot recover from (e.g. dialog open). */
export class UnexpectedAlertOpenError extends AgentError {
  /** The text of the open dialog, if known. */
  alertText?: string;
  constructor(message = "unexpected alert open", alertText?: string) {
    super(message, "unexpected_alert_open");
    this.alertText = alertText;
  }
}

/**
 * Map of error `code` strings to their typed classes. Used by
 * {@link decodeAgentError} to rehydrate a serialized error back into the
 * correct subclass (mirrors the ERROR_CODE_TO_TYPE map from the source
 * taxonomy). Built from the same {@link ERROR_SPECS} table as the exported
 * classes, so the two can never drift apart.
 *
 * Every ctor accepts a single optional `message` (see {@link AgentErrorCtor});
 * `UnexpectedAlertOpenError` additionally takes an optional `alertText`, which is
 * still assignable because that extra parameter is optional.
 */
export const ERROR_CODE_TO_TYPE: ReadonlyMap<string, AgentErrorCtor> = new Map<string, AgentErrorCtor>([
  ["agent_error", AgentError],
  ...ERROR_SPECS.map((s): [string, AgentErrorCtor] => [s.code, ERROR_CLASSES[s.name]]),
  ["unexpected_alert_open", UnexpectedAlertOpenError],
]);

/**
 * Serialize an {@link AgentError} (or plain Error) into a plain object that
 * can be logged, sent over a message boundary, or persisted to run history
 * without losing the typed `code`. Mirrors the `encodeError` helper from the
 * source taxonomy.
 */
export function encodeAgentError(
  err: unknown,
): { code: string; message: string; name: string; alertText?: string; remoteStacktrace?: string } {
  if (err instanceof AgentError) {
    const encoded: {
      code: string;
      message: string;
      name: string;
      alertText?: string;
      remoteStacktrace?: string;
    } = {
      code: err.code,
      message: err.message,
      name: err.name,
      remoteStacktrace: err.remoteStacktrace,
    };
    if (err instanceof UnexpectedAlertOpenError) {
      encoded.alertText = err.alertText;
    }
    return encoded;
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
export function decodeAgentError(
  data: { code?: string; message?: string; alertText?: string; remoteStacktrace?: string } | null | undefined,
): AgentError {
  const code = typeof data?.code === "string" ? data.code : "agent_error";
  const message = typeof data?.message === "string" ? data.message : "";
  let result: AgentError;
  if (code === "unexpected_alert_open") {
 // `UnexpectedAlertOpenError` carries an additional `alertText` field that
 // the generic one-arg constructor would drop on rehydration. Optional
 // chaining keeps a garbled (null/undefined) payload from throwing here.
    result = new UnexpectedAlertOpenError(message, data?.alertText);
  } else {
    const ctor = ERROR_CODE_TO_TYPE.get(code) ?? AgentError;
    result = new ctor(message);
  }
  if (typeof data?.remoteStacktrace === "string") {
    result.remoteStacktrace = data.remoteStacktrace;
  }
  return result;
}

/** Type guard: did the thrown value come from the typed hierarchy? */
export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}
