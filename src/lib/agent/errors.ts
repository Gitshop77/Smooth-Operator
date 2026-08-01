/**
 * Typed error hierarchy — AgentError subclasses, serialization, and rehydration.
 *
 * Error classification and helper functions live in ./errors-utils.ts and are
 * re-exported here so existing importers are unaffected.
 */

export type { ErrorCategory, ClassifiedError } from "./errors-utils";
export { classifyError, friendlyErrorMessage } from "./errors-utils";

// ─── Typed error hierarchy ───────────────────────────────────────────────────

/**
 * Base class for every typed agent error. Mirrors the structure of a
 * typed error base class: an `Error` subclass that stamps its own
 * `name` from the constructor and exposes a stable `code` string for
 * switch-style dispatch.
 */
class AgentError extends Error {
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
  { name: "UnsupportedOperationError", code: "unsupported_operation", dflt: "unsupported operation" },
];

/** One class instance per spec, built once. */
const ERROR_CLASSES: Record<string, AgentErrorCtor> = {};
for (const spec of ERROR_SPECS) {
  ERROR_CLASSES[spec.name] = defineError(spec.name, spec.code, spec.dflt);
}

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
  UnsupportedOperationError,
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
 * correct subclass. Built from the same {@link ERROR_SPECS} table as the
 * exported classes, so the two can never drift apart.
 */
const ERROR_CODE_TO_TYPE: ReadonlyMap<string, AgentErrorCtor> = new Map<string, AgentErrorCtor>([
  ["agent_error", AgentError],
  ...ERROR_SPECS.map((s): [string, AgentErrorCtor] => [s.code, ERROR_CLASSES[s.name]]),
  ["unexpected_alert_open", UnexpectedAlertOpenError],
]);

/**
 * Serialize an {@link AgentError} (or plain Error) into a plain object that
 * can be logged, sent over a message boundary, or persisted to run history
 * without losing the typed `code`.
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
