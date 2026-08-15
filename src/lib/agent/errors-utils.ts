/**
 * Error classification helpers — extracted from errors.ts for clarity.
 *
 * Fatal errors (auth, bad request, max steps) should NOT be retried.
 * Transient errors (429, 5xx, network, parse) should be retried with backoff.
 * Cancelled errors are never retried.
 */

/** Categories an error can be classified into. */
import { redactKeyLeak } from "./redact-shared";

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
  | "model_output"  // empty/reasoning-only/incomplete provider completion. FATAL for this run.
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
  /** Stable machine code, shared with the UI transcript vocabulary. */
  machineCode: string;
  /** Actionable guidance for the user/agent. */
  recoveryHint: string;
  /** Original error object (for re-throwing or inspecting stack). */
  originalError?: unknown;
}

/**
 * Recognize a run-stopping budget/cost-cap error. Matches both the legacy
 * cost-cap message (`Budget exceeded: …`) and the typed
 * `PromptBudgetExceededError` (`Prompt budget exceeded …` or its
 * `budgetExceeded === true` flag). All callers that finalize a run on a
 * budget stop must use this so no budget class is silently misclassified.
 */
export function isBudgetExceededError(error: unknown): boolean {
  if (error != null && (error as { budgetExceeded?: unknown }).budgetExceeded === true) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^Budget exceeded:/i.test(message) || /^Prompt budget exceeded/i.test(message);
}

/** Stable machine code per category (shown in the UI transcript). */
export const MACHINE_CODES: Record<ErrorCategory, string> = {
  auth: "auth_failed",
  forbidden: "access_forbidden",
  bad_request: "invalid_request",
  rate_limit: "rate_limited",
  server_error: "server_error",
  network: "network_error",
  cancelled: "cancelled",
  parse: "parse_error",
  max_steps: "max_steps_reached",
  max_failures: "max_failures_reached",
  programmer_error: "internal_error",
  model_output: "model_output_unusable",
  unknown: "unknown_error",
};

/** Actionable recovery guidance per category (shown in the UI transcript). */
export const RECOVERY_HINTS: Record<ErrorCategory, string> = {
  auth: "Check that the API key is valid and not expired.",
  forbidden: "The API key may not have permission for this model or endpoint.",
  bad_request: "This is likely a bug in the agent — report it.",
  rate_limit: "Wait a few seconds; the agent will retry automatically.",
  server_error: "The LLM server is having issues; the agent will retry automatically.",
  network: "Check your internet connection and try again.",
  cancelled: "No action needed — the agent was stopped by the user.",
  parse: "The LLM response was malformed; the agent will retry with a corrected prompt.",
  max_steps: "Reached the step budget. Increase maxSteps or split the task.",
  max_failures: "Too many consecutive failures. Simplify the task or fix the blocker.",
  programmer_error: "An internal error occurred — report it.",
  model_output: "Retry with a different provider/model or adjust the model output budget.",
  unknown: "The agent will retry; if it keeps failing, simplify the task.",
};

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
    re = new RegExp(`(?<![\\d.])${code}\\b`);
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
 * checked in priority order: auth → forbidden → bad_request → <structured
 * status> → server_error → rate_limit → network → programmer_error → parse →
 * max_steps → max_failures → cancelled → unknown.
 *
 * The cancelled check runs LAST on purpose: a message containing "abort" is
 * not by itself proof the user pressed Stop — transient transport failures
 * ("The request was aborted", ECONNABORTED-class) carry the same wording.
 * Only messages that survive every other branch (genuine user-cancel phrasing
 * like "cancelled by user", or a plain AbortError with no transport markers)
 * classify as cancelled.
 */
export function classifyError(error: unknown, attempt = 0): ClassifiedError {
  const originalMessage = redactKeyLeak(error instanceof Error ? error.message : String(error));
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
    machineCode: MACHINE_CODES[category],
    recoveryHint: RECOVERY_HINTS[category],
    originalError: error,
  });

  const typedCode = (error as { code?: unknown }).code;
  if (
    typedCode === "EMPTY_MODEL_OUTPUT" ||
    typedCode === "REASONING_ONLY_OUTPUT" ||
    typedCode === "PROTOCOL_STREAM_ERROR"
  ) {
    const classified = mk("model_output", true, false);
    return {
      ...classified,
      machineCode: typedCode,
      recoveryHint:
        typeof (error as { recovery?: unknown }).recovery === "string"
          ? (error as { recovery: string }).recovery
          : RECOVERY_HINTS.model_output,
    };
  }

  if (containsStatus(lower, "401") || containsAny(lower, ["unauthorized", "invalid api key"])) {
    return mk("auth", true, false);
  }

  if (containsStatus(lower, "403") || containsAny(lower, ["forbidden", "access denied"])) {
    return mk("forbidden", true, false);
  }

  if (containsStatus(lower, "400") || containsAny(lower, ["bad request", "invalid request"])) {
    return mk("bad_request", true, false);
  }

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

  if (FIVE_XX_RE.test(lower) || containsAny(lower, ["server error", "internal error", "bad gateway", "service unavailable", "gateway timeout"])) {
    return mk("server_error", false, true);
  }

  if (containsStatus(lower, "429") || containsAny(lower, ["too many requests", "rate limit"])) {
    return mk("rate_limit", false, true);
  }

  if (
    error instanceof TypeError &&
    /(failed to fetch|fetch failed|networkerror|network request failed|load failed)/.test(lower)
  ) {
    return mk("network", false, true);
  }

  // Transport-level aborts ("The request was aborted", "fetch aborted",
  // ECONNABORTED-class) are transient network failures — NOT user
  // cancellation. They must be caught here, BEFORE the generic
  // abort/cancelled substring check at the end of the chain, so a server that
  // kills the connection mid-request retries instead of terminating the run.
  if (
    !(error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) &&
    containsAny(lower, ["fetch failed", "econnreset", "econnrefused", "etimedout", "econnaborted", "request was aborted", "request aborted", "fetch aborted"])
  ) {
    return mk("network", false, true);
  }

  if (error instanceof SyntaxError && containsAny(lower, ["json", "parse"])) {
    return mk("parse", false, true);
  }

  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
    return mk("programmer_error", true, false);
  }

  if (containsAny(lower, ["validation", "schema"])) {
    return mk("bad_request", true, false);
  }

  if (containsAny(lower, ["json", "parse"])) {
    return mk("parse", false, true);
  }

  if (containsAny(lower, ["max steps", "step budget"])) {
    return mk("max_steps", true, false);
  }

  if (containsAny(lower, ["max failures", "consecutive failures"])) {
    return mk("max_failures", true, false);
  }

  // Deliberately LAST: "abort" wording alone is not user authority — the
  // network branches above already claimed the transport-abort phrasings
  // ("request aborted", "fetch aborted", ECONNABORTED-class). Whatever
  // survives here is genuine user-cancel wording ("cancelled by user") or a
  // bare AbortError with no transport markers.
  if (containsAny(lower, ["abort", "cancelled", "canceled"])) {
    return mk("cancelled", false, false);
  }

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
    case "model_output":
      return error.message;
    default:
      return "An unexpected error occurred. The agent will retry.";
  }
}

// ─── Action-level error taxonomy ────────────────────────────────────────────

/** Classification of a failed action, consumed by the loop/LLM error output. */
export interface ActionErrorClassification {
  /** Stable machine code (shared with the UI error vocabulary). */
  machineCode: string;
  /** Whether the failure is transient and worth retrying. */
  retryable: boolean;
  /** Actionable guidance for the agent/user. */
  recoveryHint: string;
}

/** Build a classification result. */
function mkAction(code: string, retryable: boolean, recoveryHint: string): ActionErrorClassification {
  return { machineCode: code, retryable, recoveryHint };
}

/**
 * Classify a thrown action error into the retryable/recovery vocabulary.
 * Transient failures (timeout, stale element ref, navigation-in-flight) are
 * retryable; permanent failures (invalid action, forbidden) are not.
 * Message-based, mirroring the camofox `browserErrorCode`/`browserErrorRecovery`
 * pair, with a non-retryable default so an unclassified failure is never
 * blindly retried.
 */
export function classifyActionError(error: unknown): ActionErrorClassification {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (/(timed out|timeout)/.test(lower)) {
    return mkAction(
      "action_timeout",
      true,
      "The action timed out. Wait for the page to settle, then try again.",
    );
  }

  if (/(stale element|element is not attached|element not attached|no longer attached|detached|no such element|no longer present|strict mode violation|resolved to)/.test(lower)) {
    return mkAction(
      "element_state_changed",
      true,
      "The page state changed mid-action. Re-read the page snapshot, then try the action again.",
    );
  }

  if (/(execution context was destroyed|cannot find context|frame was detached|navigation failed|navigation interrupted|err_aborted|ns_error_abort|ns_error_net_interrupt|ns_binding_aborted)/.test(lower)) {
    return mkAction(
      "navigation_race",
      true,
      "The page navigated mid-action. Wait for the page to settle, then try again.",
    );
  }

  if (/(access denied|blocked|not allowed|not permitted|forbidden)/.test(lower)) {
    return mkAction(
      "action_forbidden",
      false,
      "This action is not permitted on this page. Re-read the page state and choose a different action.",
    );
  }

  return mkAction(
    "action_failed",
    false,
    "The action failed. Re-read the page snapshot and choose a different action.",
  );
}

/**
 * Format the error vocabulary as a parseable suffix appended to a failure
 * message the loop shows the LLM: `[code: X; retryable: yes/no] (recovery: Y)`.
 */
export function formatErrorSuffix(
  machineCode: string,
  retryable: boolean,
  recoveryHint: string,
): string {
  return `[code: ${machineCode}; retryable: ${retryable ? "yes" : "no"}] (recovery: ${recoveryHint})`;
}
