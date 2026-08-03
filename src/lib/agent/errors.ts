/**
 * Typed error hierarchy — AgentError subclasses and classification.
 *
 * Error classification and helper functions live in ./errors-utils.ts and are
 * re-exported here so existing importers are unaffected.
 */

export type { ErrorCategory, ClassifiedError } from "./errors-utils";
export { classifyError, friendlyErrorMessage, classifyActionError, formatErrorSuffix, MACHINE_CODES, RECOVERY_HINTS } from "./errors-utils";

// ─── Typed error hierarchy ───────────────────────────────────────────────────

/**
 * Base class for every typed agent error. Mirrors the structure of a
 * typed error base class: an `Error` subclass that stamps its own
 * `name` from the constructor and exposes a stable `code` string for
 * switch-style dispatch.
 */
class AgentError extends Error {
  /** Stable lowercase error code (e.g. `"timeout"`). */
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
  /** Stable lowercase `code` used for dispatch. */
  code: string;
  /** Default message when the constructor is called without one. */
  dflt: string;
}

/**
 * Build a trivial {@link AgentError} subclass from a spec. The subclass stamps
 * its own `name` (so `instanceof` checks report the expected identity)
 * alongside the stable `code`.
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
  { name: "ElementNotSelectableError", code: "element_not_selectable", dflt: "element not selectable" },
  { name: "TimeoutError", code: "timeout", dflt: "timeout" },
  { name: "UnsupportedOperationError", code: "unsupported_operation", dflt: "unsupported operation" },
];

/** One class instance per spec, built once. */
const ERROR_CLASSES: Record<string, AgentErrorCtor> = {};
for (const spec of ERROR_SPECS) {
  ERROR_CLASSES[spec.name] = defineError(spec.name, spec.code, spec.dflt);
}

export const {
  NoSuchElementException,
  ElementNotSelectableError,
  TimeoutError,
  UnsupportedOperationError,
} = ERROR_CLASSES;

/** Type guard: did the thrown value come from the typed hierarchy? */
export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}
