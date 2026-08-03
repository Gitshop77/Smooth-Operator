/**
 * MAIN-world console capture — records the page's own
 * `console.log/error/warn/info` calls and bridges them to the isolated world
 * so the content script can forward them to the SW console-log ring
 * (`rate-limit-tracker.ts`).
 *
 * ## Worlds (extension context)
 *
 * The override is installed from `content-main.js`, the MAIN-world entry
 * point declared in the manifest. There `window.console` IS the page's
 * console, so the capture sees the page's real log calls. The captured entry
 * is dispatched as a `CustomEvent` on `window` (event name:
 * {@link CONSOLE_CAPTURE_EVENT}); the isolated-world content script listens
 * for it and relays the entry to the service worker via a
 * `CONSOLE_LOG_ENTRY` runtime message.
 *
 * ## Transparency & safety
 *
 * - Each patched method calls the original implementation with the exact
 *   same arguments, so page behavior is unchanged.
 * - Capture never throws into the page: argument stringification and event
 *   dispatch are both wrapped in `try/catch`.
 * - `Object.defineProperty` is used with `configurable: true, writable: true`
 *   so a page that detects the patch can still override it (capture is
 *   best-effort, not a security boundary).
 * - The ring lives in the service worker, so the agent's `get_console_log`
 *   reads the same entries regardless of which tab produced them.
 *
 * ## Idempotency
 *
 * {@link installConsoleCapture} is idempotent — calling it twice is a no-op.
 * The content script may be re-injected on navigation while a MAIN-world
 * injection persists, and re-running the entry point must not stack
 * wrappers.
 */

/** One captured console call, as stored in the SW ring. */
export interface ConsoleLogEntry {
  /** Pinned mapping: console.log → "log", error → "error", warn → "warning", info → "info". */
  type: "log" | "error" | "warning" | "info";
  /** The call's arguments joined with a single space. */
  message: string;
  /** Epoch ms when the call happened. */
  timestamp: number;
}

/** CustomEvent name the MAIN-world capture uses to hand entries to the content script. */
export const CONSOLE_CAPTURE_EVENT = "open-cowork-console-log";

/** Max chars stored per entry message. The LLM's inline view of an action's
 *  extractedContent is truncated at 2000 chars (loop/messages-utils), so a
 *  longer message is never visible to the agent — storing it would only let a
 *  chatty page balloon the SW ring (500 entries × unbounded messages). */
const MAX_ENTRY_MESSAGE_CHARS = 2000;

const METHODS: ReadonlyArray<[keyof Console, ConsoleLogEntry["type"]]> = [
  ["log", "log"],
  ["error", "error"],
  ["warn", "warning"],
  ["info", "info"],
];

let installed = false;
/** Console implementations captured at install time; restored on reset. */
const savedOriginals: Array<{ method: string; original: (...args: unknown[]) => void }> = [];

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  // Error instances stringify to "{}" via JSON.stringify — keep the useful
  // "Error: message" form. The duck-check covers cross-realm Error objects.
  if (arg instanceof Error) return String(arg);
  if (
    arg !== null &&
    typeof arg === "object" &&
    typeof (arg as { message?: unknown }).message === "string" &&
    typeof (arg as { stack?: unknown }).stack === "string"
  ) {
    return String(arg);
  }
  try {
    const s = JSON.stringify(arg);
    return s === undefined ? String(arg) : s;
  } catch {
    try {
      return String(arg);
    } catch {
      return "[unserializable]";
    }
  }
}

function capture(type: ConsoleLogEntry["type"], args: unknown[]): void {
  try {
    // Cap the stored message (code-point-aware so a surrogate pair is never
    // cut); see MAX_ENTRY_MESSAGE_CHARS.
    const joined = Array.from(args.map(stringifyArg).join(" "));
    const entry: ConsoleLogEntry = {
      type,
      message: joined.length > MAX_ENTRY_MESSAGE_CHARS ? joined.slice(0, MAX_ENTRY_MESSAGE_CHARS).join("") : joined.join(""),
      timestamp: Date.now(),
    };
    window.dispatchEvent(new CustomEvent<{ entry: ConsoleLogEntry }>(CONSOLE_CAPTURE_EVENT, { detail: { entry } }));
  } catch {
    /* capture must never throw into the page */
  }
}

/**
 * Override `console.log/error/warn/info` on the shared `window.console`,
 * dispatching a {@link CONSOLE_CAPTURE_EVENT} per call. Idempotent — the
 * second install is a no-op. Call from the MAIN-world entry point
 * (`content-main.ts`) so the page's real console is wrapped.
 */
export function installConsoleCapture(): void {
  if (installed) return;
  const c = window.console;
  if (!c) return;
  installed = true;
  for (const [method, type] of METHODS) {
    const original = c[method];
    if (typeof original !== "function") continue;
    const originalFn = original as (...args: unknown[]) => void;
    savedOriginals.push({ method, original: originalFn });
    const patched = (...args: unknown[]): void => {
      capture(type, args);
      originalFn(...args);
    };
    try {
      Object.defineProperty(c, method, { configurable: true, writable: true, value: patched });
    } catch {
      /* ignore — a frozen console must not break the install */
    }
  }
}

/**
 * Restore the console implementations captured at install time and allow a
 * fresh install. Exposed for tests that re-install the capture on a fresh
 * document; production code should never call this.
 */
export function _resetConsoleCaptureForTests(): void {
  installed = false;
  if (typeof window === "undefined") {
    savedOriginals.length = 0;
    return;
  }
  const c = window.console;
  for (const saved of savedOriginals.splice(0)) {
    if (typeof c[saved.method as keyof Console] !== "function") continue;
    try {
      Object.defineProperty(c, saved.method, {
        configurable: true,
        writable: true,
        value: saved.original,
      });
    } catch {
      /* ignore */
    }
  }
}
