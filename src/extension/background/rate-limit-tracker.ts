/**
 * background/rate-limit-tracker.ts — network-authoritative 429/503 signal.
 *
 * The MAIN-world DOM challenge detector in `@/lib/agent/anti-bot` deliberately
 * refuses to derive a "rate-limited" state from page content: the document
 * title, body text, and CSS classes are all attacker-settable, so a hostile
 * page could otherwise force a false rate-limit and stall the agent. The
 * authoritative signal for a genuine throttle is the real HTTP response status,
 * which is only visible at the network layer.
 *
 * This module listens for top-level (main-frame) 429/503 responses per tab via
 * `chrome.webRequest` and records the most recent one so the anti-bot hooks can
 * surface a `rate-limited` challenge kind instead of blindly acting on (and
 * burning steps/LLM calls against) a throttled endpoint.
 *
 * It also hosts the agent-facing NETWORK LOG ring: request/response entries are
 * captured from `chrome.webRequest` into a bounded ring (oldest dropped) while
 * enabled, and exposed to the agent via a `NETWORK_LOG` runtime message. The
 * CONSOLE LOG ring lives here too: entries relayed from the MAIN-world console
 * capture (`@/lib/agent/dom/console-capture`) via `CONSOLE_LOG_ENTRY` messages
 * are stored in a bounded ring while enabled and exposed via a `CONSOLE_LOG`
 * runtime message. All listeners are registered idempotently (see
 * {@link registerRateLimitListener}) so repeated service-worker wakes never
 * double-register.
 */

import type { AgentAction } from "@/lib/agent/types";
import type { ConsoleLogEntry, NetworkLogEntry, PrivilegedDispatchToken } from "./message-types";
import { authorizeRunScopedDispatch } from "./run-dispatch-authorization";
import { consumeEffectCapability } from "./privileged-action-policy";
import { redactUrlTokens } from "@/lib/agent/dom/extraction/element-info-utils";
import { CONSOLE_LOG_ENABLED_KEY } from "@/lib/agent/dom/console-capture";

/**
 * Sanitize a captured request/response URL BEFORE it enters the agent-facing
 * ring. URLs routinely embed signed query strings (`?X-Amz-Signature=…`,
 * `?token=…`), OAuth `state`/`code`, and session ids (blob/CDN/signed paths) —
 * and `get_network_log` hands every entry to the LLM provider. The redaction
 * discipline that protects every other egress (snapshots, events, history)
 * must cover this channel too: `redactUrlTokens` strips the query/fragment,
 * userinfo, secret-shaped path segments, and secret host labels.
 */
function sanitizeNetworkUrl(url: string): string {
  try {
    return redactUrlTokens(url);
  } catch {
    // Never let a redaction failure leak the raw URL — fail to a marker.
    return "[url redaction failed]";
  }
}

/** HTTP statuses that represent a network-layer throttle / back-off signal. */
const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set<number>([429, 503]);

/** How long a recorded rate-limit stays "fresh" (ms). */
const RATE_LIMIT_TTL_MS = 30_000;

/** tabId → timestamp (ms) of the most recent 429/503 main-frame response. */
const recentByTab = new Map<number, number>();

let registered = false;

const NETWORK_LOG_ACTIONS = {
  enable: { type: "enable_network_log" },
  disable: { type: "disable_network_log" },
  get: { type: "get_network_log" },
  clear: { type: "clear_network_log" },
  getclear: { type: "getclear_network_log" },
} as const satisfies Record<string, AgentAction>;

const CONSOLE_LOG_ACTIONS = {
  enable: { type: "enable_console_log" },
  disable: { type: "disable_console_log" },
  get: { type: "get_console_log" },
  clear: { type: "clear_console_log" },
  getclear: { type: "getclear_console_log" },
} as const satisfies Record<string, AgentAction>;

function canonicalLogAction(type: "NETWORK_LOG" | "CONSOLE_LOG", verb: unknown): AgentAction | null {
  if (typeof verb !== "string") return null;
  const actions = type === "NETWORK_LOG" ? NETWORK_LOG_ACTIONS : CONSOLE_LOG_ACTIONS;
  return actions[verb as keyof typeof actions] ?? null;
}

// ─── Network log (agent-facing ring buffer) ─────────────────────────────────

/** Max entries kept in the network log ring (oldest dropped first). */
export const NETWORK_LOG_CAP = 500;

let networkLogEnabled = false;
const networkLogEntries: NetworkLogEntry[] = [];

/** Whether network logging is currently capturing entries. */
export function isNetworkLogEnabled(): boolean {
  return networkLogEnabled;
}

/** Start capturing network activity. Existing entries are retained. */
export function enableNetworkLog(): void {
  networkLogEnabled = true;
}

/** Stop capturing network activity. Existing entries are retained. */
export function disableNetworkLog(): void {
  networkLogEnabled = false;
}

/** Snapshot the captured entries + the enabled flag (does NOT clear). */
export function getNetworkLog(): { enabled: boolean; entries: NetworkLogEntry[] } {
  return { enabled: networkLogEnabled, entries: networkLogEntries.slice() };
}

/** Empty the ring. */
export function clearNetworkLog(): void {
  networkLogEntries.length = 0;
}

/** Snapshot AND empty the ring in one synchronous step (atomic — no entry can
 *  land between the read and the clear). */
export function getclearNetworkLog(): { enabled: boolean; entries: NetworkLogEntry[] } {
  const entries = networkLogEntries.slice();
  networkLogEntries.length = 0;
  return { enabled: networkLogEnabled, entries };
}

function pushNetworkLogEntry(entry: NetworkLogEntry): void {
  if (networkLogEntries.length >= NETWORK_LOG_CAP) networkLogEntries.shift();
  networkLogEntries.push(entry);
}

// ─── Console log (agent-facing ring buffer) ────────────────────────────────

/** Max entries kept in the console log ring (oldest dropped first). */
export const CONSOLE_LOG_CAP = 500;

let consoleLogEnabled = false;
const consoleLogEntries: ConsoleLogEntry[] = [];

/** Whether console logging is currently capturing entries. */
export function isConsoleLogEnabled(): boolean {
  return consoleLogEnabled;
}

/**
 * Start capturing console calls. Existing entries are retained. Also persists
 * the flag to `chrome.storage.local` so the content script's forward gate
 * (`content.ts`, CONSOLE_LOG_ENABLED_KEY) learns the ring is on without
 * re-reading storage on every console call — best-effort / fire-and-forget.
 */
export function enableConsoleLog(): void {
  consoleLogEnabled = true;
  void persistConsoleLogEnabled(true);
}

/** Stop capturing console calls. Existing entries are retained. */
export function disableConsoleLog(): void {
  consoleLogEnabled = false;
  void persistConsoleLogEnabled(false);
}

/** Snapshot the captured entries + the enabled flag (does NOT clear). */
export function getConsoleLog(): { enabled: boolean; entries: ConsoleLogEntry[] } {
  return { enabled: consoleLogEnabled, entries: consoleLogEntries.slice() };
}

/** Empty the ring. */
export function clearConsoleLog(): void {
  consoleLogEntries.length = 0;
}

/** Snapshot AND empty the ring in one synchronous step (atomic — no entry can
 *  land between the read and the clear). */
export function getclearConsoleLog(): { enabled: boolean; entries: ConsoleLogEntry[] } {
  const entries = consoleLogEntries.slice();
  consoleLogEntries.length = 0;
  return { enabled: consoleLogEnabled, entries };
}

function pushConsoleLogEntry(entry: ConsoleLogEntry): void {
  if (consoleLogEntries.length >= CONSOLE_LOG_CAP) consoleLogEntries.shift();
  consoleLogEntries.push(entry);
}

/**
 * Persist the console-log enabled flag to `chrome.storage.local` so the
 * content script's forward gate learns the ring state without a storage read
 * on every page console call. Best-effort / fire-and-forget: a rejected write
 * or a missing `chrome.storage` (tests, restricted contexts) must never throw.
 */
async function persistConsoleLogEnabled(enabled: boolean): Promise<void> {
  try {
    await chrome.storage.local.set({ [CONSOLE_LOG_ENABLED_KEY]: enabled });
  } catch {
    /* best-effort — the in-memory ring still works for this wake */
  }
}

/**
 * Dispatch one NETWORK_LOG / CONSOLE_LOG / CONSOLE_LOG_ENTRY runtime message.
 *
 * Exported so `message-routing.ts` owns the single `chrome.runtime.onMessage`
 * dispatch path; this module keeps only the ring-buffer state and the
 * webRequest/tab listeners. Returns `true` when the message is consumed
 * asynchronously, `false` otherwise (so other listeners may run).
 */
export function handleLogRingMessage(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const m = msg as {
    type?: string;
    verb?: string;
    entry?: ConsoleLogEntry;
    token?: PrivilegedDispatchToken;
    effectCapability?: string;
  } | null;
  if (!m) return false;
  if (m.type === "CONSOLE_LOG_ENTRY") {
    if (consoleLogEnabled) pushConsoleLogEntry(m.entry as ConsoleLogEntry);
    return false; // fire-and-forget push, no response
  }
  const logType = m.type;
  if (logType !== "NETWORK_LOG" && logType !== "CONSOLE_LOG") return false;
  // Ring-log commands mutate/read run-scoped diagnostic state. A delayed
  // command from a predecessor must not affect or observe its successor.
  void authorizeRunScopedDispatch(m.token).then((authorization) => {
    if (!authorization.ok) {
      sendResponse({ ok: false, error: authorization.error });
      return;
    }
    const action = canonicalLogAction(logType, m.verb);
    if (!action) {
      sendResponse({ ok: false, error: `unknown ${logType === "CONSOLE_LOG" ? "console" : "network"} log verb: ${String(m.verb)}` });
      return;
    }
    if (!consumeEffectCapability(m.effectCapability, m.token!, action)) {
      sendResponse({ ok: false, error: "BLOCKED: missing or invalid action effect capability" });
      return;
    }
    if (m.type === "CONSOLE_LOG") {
      switch (m.verb) {
        case "enable":
          enableConsoleLog();
          sendResponse({ ok: true, message: "console log enabled" });
          break;
        case "disable":
          disableConsoleLog();
          sendResponse({ ok: true, message: "console log disabled" });
          break;
        case "get": {
          const { enabled, entries } = getConsoleLog();
          sendResponse({ ok: true, enabled, entries });
          break;
        }
        case "clear":
          clearConsoleLog();
          sendResponse({ ok: true, message: "console log cleared" });
          break;
        case "getclear": {
          const { enabled, entries } = getclearConsoleLog();
          sendResponse({ ok: true, enabled, entries });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown console log verb: ${String(m.verb)}` });
      }
      return;
    }
    switch (m.verb) {
      case "enable":
        enableNetworkLog();
        sendResponse({ ok: true, message: "network log enabled" });
        break;
      case "disable":
        disableNetworkLog();
        sendResponse({ ok: true, message: "network log disabled" });
        break;
      case "get": {
        const { enabled, entries } = getNetworkLog();
        sendResponse({ ok: true, enabled, entries });
        break;
      }
      case "clear":
        clearNetworkLog();
        sendResponse({ ok: true, message: "network log cleared" });
        break;
      case "getclear": {
        const { enabled, entries } = getclearNetworkLog();
        sendResponse({ ok: true, enabled, entries });
        break;
      }
      default:
        sendResponse({ ok: false, error: `unknown network log verb: ${String(m?.verb)}` });
    }
  });
  return true;
}

/**
 * Register the `chrome.webRequest.onCompleted` listener (idempotent). Records
 * main-frame 429/503 responses per tab; a subsequent successful main-frame load
 * clears any stale record for that tab. Also registers the network-log capture
 * listeners. No-op when the API is unavailable.
 */
export function registerRateLimitListener(): void {
  if (registered) return;
  registered = true;
  if (!chrome.webRequest?.onCompleted) return;
  // Only the top-level document matters for "the page the agent acts on".
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.type !== "main_frame") return;
      if (details.tabId < 0) return;
      if (RATE_LIMIT_STATUSES.has(details.statusCode)) {
        recentByTab.set(details.tabId, Date.now());
      } else {
        recentByTab.delete(details.tabId);
      }
    },
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  );
  // Network-log capture. Registered unconditionally; each event early-returns
  // when logging is disabled so a disabled log costs nothing.
  if (chrome.webRequest?.onBeforeRequest) {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (!networkLogEnabled) return undefined;
        pushNetworkLogEntry({
          type: "request",
          url: sanitizeNetworkUrl(details.url),
          method: details.method,
          resource_type: details.type,
          timestamp: Date.now(),
        });
        return undefined;
      },
      { urls: ["http://*/*", "https://*/*"] },
    );
  }
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (!networkLogEnabled) return;
      pushNetworkLogEntry({
        type: "response",
        url: sanitizeNetworkUrl(details.url),
        status: details.statusCode,
        timestamp: Date.now(),
      });
    },
    { urls: ["http://*/*", "https://*/*"] },
  );
  // Without this, a tab that received a 429/503 and is closed without an
  // active run consuming the record leaks a `recentByTab` entry for the
  // service-worker lifetime. Mirror the `tab-manager` cleanup on tab close.
  if (chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId: number) => {
      recentByTab.delete(tabId);
    });
  }
}

/**
 * Return `true` (and clear the record) when the tab had a fresh 429/503
 * main-frame response within {@link RATE_LIMIT_TTL_MS}. Consuming the record
 * avoids re-reporting the same rate-limit on every subsequent navigator step.
 */
export function consumeRecentRateLimit(tabId: number): boolean {
  const at = recentByTab.get(tabId);
  if (at === undefined) return false;
  recentByTab.delete(tabId);
  return Date.now() - at <= RATE_LIMIT_TTL_MS;
}
