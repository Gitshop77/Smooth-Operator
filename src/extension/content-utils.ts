import { extractBrowserState, getSelectorMap, getElementIdentities } from "@/lib/agent/dom/extractor";
import { cachedExtractBrowserState, setCachedAxTree } from "@/lib/agent/dom/extraction/state-cache";
import { generateAccessibilityTree } from "@/lib/agent/dom/ax-tree";
import type { AXTreeResult } from "@/lib/agent/dom/ax-tree";
import { executeAction } from "@/lib/agent/tools/executor";
import { setSecretsResolvedExternally } from "@/lib/agent/secrets";
import { redactKeyShapes } from "@/lib/agent/key-shape-redact";
import {
  isDomainPolicyEnforced,
  setDomainConfig,
  validateDomainConfig,
} from "@/lib/agent/tools/helpers/domain-config";
import { domFingerprint } from "@/lib/agent/tools/helpers";
import type { AgentAction, ActionResult, BrowserState, TabInfo } from "@/lib/agent/types";
import type { AgentMode } from "@/lib/agent/modes";
import { MAX_ENTRY_MESSAGE_CHARS, type ConsoleLogEntry } from "@/lib/agent/dom/console-capture";

const AGENT_MODES: readonly AgentMode[] = ["restricted", "standard", "full_agentic"];
function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}

export const log: (...args: unknown[]) => void = console.warn.bind(console, "[content]");

// ─── Console-bridge admission (trust boundary) ──────────────────────────────

/**
 * Validate a value as a {@link ConsoleLogEntry} at the content-script bridge.
 *
 * The MAIN-world console capture dispatches entries via a `CustomEvent` on the
 * page's shared `window` — and ANY page script can dispatch the same event
 * with a forged `detail.entry`. The content script must therefore treat every
 * bridge payload as untrusted and admit only entries that (a) have the exact
 * shape the capture produces (known console level, string message, finite
 * epoch-ms timestamp) and (b) fit the capture's own byte bound
 * ({@link MAX_ENTRY_MESSAGE_CHARS}). A malformed or oversized entry is
 * dropped BEFORE it crosses into the extension's isolated world, so a page can
 * neither inject arbitrary shapes into the SW ring (type confusion in
 * `rate-limit-tracker`) nor balloon the ring with a giant forged message.
 */
export function isValidConsoleBridgeEntry(value: unknown): value is ConsoleLogEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<ConsoleLogEntry>;
  if (entry.type !== "log" && entry.type !== "error" && entry.type !== "warning" && entry.type !== "info") {
    return false;
  }
  if (typeof entry.message !== "string") return false;
  // Code-point-aware bound: a surrogate pair must never be split, and the
  // bridge must never forward more chars than the capture itself would store.
  if (Array.from(entry.message).length > MAX_ENTRY_MESSAGE_CHARS) return false;
  if (typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp)) return false;
  return true;
}

// ─── Message contracts ─────────────────────────────────────────────────────

interface PingMessage {
  type: "PING";
}
interface ExtractStateMessage {
  type: "EXTRACT_STATE";
  tabs?: TabInfo[];
  depth?: number;
  maxLength?: number;
  includeAxTree?: boolean;
}
interface ExecuteActionsMessage {
  type: "EXECUTE_ACTIONS";
  actions?: AgentAction[];
  domainConfig?: unknown;
  secretsResolved?: boolean;
  agentMode?: string;
  /** Authoritative background dispatch generation. */
  token: DispatchToken;
}
interface CancelRunMessage {
  type: "CANCEL_RUN";
  /** The first dispatch revision that must no longer be accepted. */
  token?: DispatchToken;
}
interface ExtractHtmlMessage {
  type: "EXTRACT_HTML";
}
interface GetDomFingerprintMessage {
  type: "GET_DOM_FINGERPRINT";
}

export type IncomingMessage =
  | PingMessage
  | ExtractStateMessage
  | ExecuteActionsMessage
  | CancelRunMessage
  | ExtractHtmlMessage
  | GetDomFingerprintMessage;

interface OkResponse<T = unknown> {
  ok: true;
  state?: T;
  results?: T;
  html?: string;
  fingerprint?: string;
}
interface ErrorResponse {
  ok: false;
  error: string;
}
export type Response<T = unknown> = OkResponse<T> | ErrorResponse;

/** Kept structurally identical to the background RunDispatchToken without a runtime dependency. */
export interface DispatchToken {
  runId: string;
  dispatchRevision: number;
}

interface ActiveExecution {
  token: DispatchToken;
  controller: AbortController;
}

// Content scripts can outlive a service-worker run. Remember a small, bounded
// set of cancellation cutoffs so a delayed EXECUTE_ACTIONS message cannot
// resurrect a dispatch after STOP. A runId is never reused by the controller.
const MAX_CANCELLATION_CUTOFFS = 64;
const cancellationCutoffs = new Map<string, number>();
const activeExecutions = new Map<string, Set<ActiveExecution>>();

function isDispatchToken(value: unknown): value is DispatchToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<DispatchToken>;
  return (
    typeof token.runId === "string" &&
    token.runId.length > 0 &&
    typeof token.dispatchRevision === "number" &&
    Number.isSafeInteger(token.dispatchRevision) &&
    token.dispatchRevision > 0
  );
}

function tokenKey(token: DispatchToken): string {
  return `${token.runId}:${token.dispatchRevision}`;
}

function cancellationReason(token: DispatchToken): string {
  return `BLOCKED: dispatch cancelled or stale for run ${token.runId}`;
}

function isCancelledDispatch(token: DispatchToken): boolean {
  const cutoff = cancellationCutoffs.get(token.runId);
  return cutoff !== undefined && token.dispatchRevision <= cutoff;
}

function rememberCancellation(token: DispatchToken): void {
  const existing = cancellationCutoffs.get(token.runId);
  if (existing === undefined || token.dispatchRevision > existing) {
    cancellationCutoffs.delete(token.runId);
    cancellationCutoffs.set(token.runId, token.dispatchRevision);
  }
  while (cancellationCutoffs.size > MAX_CANCELLATION_CUTOFFS) {
    const oldest = cancellationCutoffs.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cancellationCutoffs.delete(oldest);
  }
}

function registerExecution(execution: ActiveExecution): void {
  const key = tokenKey(execution.token);
  const executions = activeExecutions.get(key) ?? new Set<ActiveExecution>();
  executions.add(execution);
  activeExecutions.set(key, executions);
}

function unregisterExecution(execution: ActiveExecution): void {
  const key = tokenKey(execution.token);
  const executions = activeExecutions.get(key);
  if (!executions) return;
  executions.delete(execution);
  if (executions.size === 0) activeExecutions.delete(key);
}

function blockRemainingActions(
  actions: AgentAction[],
  fromIndex: number,
  reason: string,
): ActionResult[] {
  return actions.slice(fromIndex).map((action) => ({ action, success: false, message: reason }));
}

async function authorizeActionEffect(token: DispatchToken, action: AgentAction): Promise<string> {
  const response = await chrome.runtime.sendMessage({ type: "AUTHORIZE_ACTION_EFFECT", token, action }) as {
    ok?: boolean;
    error?: string;
    effectCapability?: string;
  };
  if (!response?.ok || typeof response.effectCapability !== "string") {
    throw new Error(response?.error ?? "BLOCKED: action effect authorization failed");
  }
  return response.effectCapability;
}

// ─── Message handlers ──────────────────────────────────────────────────────

/** Build the canonical failure response from a caught error. */
function errorResponse(e: unknown): ErrorResponse {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/** Clamp a finite numeric message field into `[min, max]`, else `fallback`. */
export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(Math.max(min, Math.floor(value)), max)
    : fallback;
}

export function handleExtractState(
  msg: ExtractStateMessage,
  sendResponse: (r: Response) => void,
): void {
  try {
    const tabs: TabInfo[] = msg.tabs || [];
    // Skip-if-unchanged extraction: on a page the mutation signal AND the
    // fingerprint (plus tabs/url/title/scroll) prove unchanged since the last
    // extract, the deep-frozen cached snapshot is served WITHOUT a DOM walk
    // AND without rebuilding the AX tree (the stashed tree is served with
    // it) — stale observation is deliberate only for style-only/selection/
    // hover/input-value changes, see `extraction/state-cache.ts`.
    const state = cachedExtractBrowserState(tabs);
    const depth = clampInt(msg.depth, 15, 1, 50);
    const maxLength = clampInt(msg.maxLength, 50_000, 1, 1_000_000);
    const includeAxTree = msg.includeAxTree ?? true;
    let axTree: AXTreeResult;
    if (includeAxTree && state.axTree !== undefined) {
      // Cache hit: the gate proved the DOM unchanged since the stashed tree
      // was built (same synchronous flow that populated the snapshot), so
      // this page's accessibility tree already exists — no walk at all.
      axTree = {
        pageContent: state.axTree,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    } else {
      axTree = includeAxTree
        ? generateAccessibilityTree("all", depth, maxLength)
        : {
            pageContent: "",
            viewport: { width: window.innerWidth, height: window.innerHeight },
          };
      if (axTree.error) {
        log(`AX tree generation warning: ${axTree.error}`);
      }
      // Stash the serialized tree with the snapshot so subsequent cache hits
      // skip the accessibility walk too. A no-tree extract (includeAxTree
      // false) leaves the stash cleared (a fresh extract cleared it, and a
      // tree from an older snapshot must never be served for this one).
      if (includeAxTree) {
        setCachedAxTree(axTree.pageContent);
      }
    }
    const { selectorMap: _sm, ...serializable } = state;
    void _sm;
    const elementRects = serializable.elements.map((el) => ({
      index: el.index,
      rect: el.rect,
    }));
    const devicePixelRatio = window.devicePixelRatio || 1;
    sendResponse({
      ok: true,
      state: {
        ...serializable,
        elementRects,
        devicePixelRatio,
        axTree: axTree.pageContent,
        fingerprint: domFingerprint(),
      },
    });
  } catch (e) {
    sendResponse(errorResponse(e));
  }
}

export function handleExecuteActions(
  msg: ExecuteActionsMessage,
  sendResponse: (r: Response) => void,
): boolean {
  let responded = false;
  // The background threads the active agent mode through the message so
  // URL-loader steps spawned by a content-script navigate are mode-gated
  // (user-authored loaders cannot bypass the capability boundary). Absent
  // mode keeps the direct content-script path unchanged.
  const agentMode = isAgentMode(msg.agentMode) ? msg.agentMode : undefined;
  const token = msg.token;
  const safeRespond = (r: Response) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(r);
    } catch {
      /* channel already closed */
    }
  };

  // EXECUTE_ACTIONS is a run-scoped mutation. Never preserve a tokenless
  // compatibility path: a delayed first-party message after Stop/restart must
  // fail before it can change policy or secret state in this content world.
  if (!isDispatchToken(token)) {
    safeRespond({ ok: false, error: "invalid dispatch token" });
    return false;
  }
  if (token && isCancelledDispatch(token)) {
    safeRespond({ ok: false, error: cancellationReason(token) });
    return false;
  }

  try {
    const incomingDomainConfig = msg.domainConfig;
    if (incomingDomainConfig !== undefined) {
      const v = validateDomainConfig(incomingDomainConfig);
      if (v) {
        setDomainConfig(
          v,
          Boolean(v.allowedDomains?.length || v.blockedDomains?.length),
        );
      }
    }
    if (!isDomainPolicyEnforced()) {
      log("executing actions with NO URL policy enforced");
    }
    if (msg.secretsResolved !== undefined)
      setSecretsResolvedExternally(Boolean(msg.secretsResolved));
  } catch (e) {
    safeRespond(errorResponse(e));
    return false;
  }

  (async () => {
    const execution = { token, controller: new AbortController() };
    try {
      const actions: AgentAction[] = Array.isArray(msg.actions) ? msg.actions : [];
      registerExecution(execution);
      // A CANCEL_RUN can arrive between the preflight check and registration.
      if (isCancelledDispatch(execution.token)) {
        execution.controller.abort(new DOMException(cancellationReason(execution.token), "AbortError"));
        safeRespond({ ok: false, error: cancellationReason(execution.token) });
        return;
      }
      const cachedMap = getSelectorMap();
      const state: BrowserState =
        Object.keys(cachedMap).length > 0
          ? {
              url: location.href,
              title: document.title,
              tabs: [],
              elements: [],
              elementsText: "",
              pageInfo: "",
              newElementCount: 0,
              scrollTop: window.scrollY || 0,
              scrollHeight: document.documentElement.scrollHeight,
              viewportHeight: window.innerHeight,
              selectorMap: cachedMap,
              // The execution state reuses the OBSERVATION snapshot's element
              // identities so `resolveElement` can reject actions whose target
              // changed since extraction (stale-element guard).
              elementIdentities: getElementIdentities(),
            }
          : extractBrowserState([]);
      const results: ActionResult[] = [];
      const policyEnforced = isDomainPolicyEnforced();
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        if (execution.controller.signal.aborted || isCancelledDispatch(execution.token)) {
          results.push(...blockRemainingActions(actions, index, cancellationReason(execution.token)));
          break;
        }
        let result: ActionResult | undefined;
        if (!policyEnforced && (action.type === "navigate" || action.type === "search")) {
          let sameOrigin = false;
          if (action.type === "navigate") {
            try {
              sameOrigin = new URL(action.url, location.href).origin === location.origin;
            } catch {
              sameOrigin = false;
            }
          }
          if (!sameOrigin) {
            result = {
              action,
              success: false,
              message:
                "BLOCKED: no domain policy enforced — only same-origin navigation is permitted",
            };
          }
        }
        if (!result) {
          // The immediate pre-dispatch check plus passing the signal makes an
          // already-delivered CANCEL_RUN prevent this action and interrupts
          // abort-aware handlers that are currently running.
          if (execution.controller.signal.aborted || isCancelledDispatch(execution.token)) {
            results.push(...blockRemainingActions(actions, index, cancellationReason(execution.token)));
            break;
          }
          try {
            result = await executeAction(
              action, state, execution.controller.signal, undefined, agentMode, execution.token, undefined,
              (candidate) => authorizeActionEffect(execution.token, candidate),
            );
          } catch (e) {
            if (execution.controller.signal.aborted || isCancelledDispatch(execution.token)) {
              result = { action, success: false, message: cancellationReason(execution.token) };
            } else {
              throw e;
            }
          }
        }
        results.push(result);
        if (execution.controller.signal.aborted || isCancelledDispatch(execution.token)) {
          results.push(...blockRemainingActions(actions, index + 1, cancellationReason(execution.token)));
          break;
        }
        if (!result.success || result.pageChanged || result.isDone) {
          const skipped = actions.length - results.length;
          if (skipped > 0) {
            const isExpected = Boolean(result.pageChanged || result.isDone);
            results.push({
              action: { type: "wait" } as AgentAction,
              success: isExpected,
              message: `${skipped} remaining action(s) skipped after ${result.isDone ? "done" : result.pageChanged ? "page change" : "failure"}`,
            });
          }
          break;
        }
      }
      safeRespond({ ok: true, results });
    } catch (e) {
      safeRespond(errorResponse(e));
    } finally {
      unregisterExecution(execution);
    }
  })();
  return true;
}

/** Record cancellation before replying so delayed dispatches are rejected. */
export function handleCancelRun(
  msg: CancelRunMessage,
  sendResponse: (r: Response) => void,
): void {
  if (!isDispatchToken(msg.token)) {
    sendResponse({ ok: false, error: "invalid cancellation token" });
    return;
  }
  const cutoff = msg.token;
  rememberCancellation(cutoff);
  for (const executions of activeExecutions.values()) {
    for (const execution of executions) {
      if (
        execution.token.runId === cutoff.runId &&
        execution.token.dispatchRevision <= cutoff.dispatchRevision
      ) {
        execution.controller.abort(new DOMException(cancellationReason(execution.token), "AbortError"));
      }
    }
  }
  sendResponse({ ok: true });
}

export function handleExtractHtml(
  sendResponse: (r: Response) => void,
): void {
  try {
    const html = document.documentElement.outerHTML || "";
    const capped = html.length > 500_000 ? html.slice(0, 500_000) : html;
    // The HTML flows to the evaluator (possibly a remote judge model), so
    // mask well-known credential shapes — secrets the extension substituted
    // into forms serialize back into the HTML, and pages can embed real keys.
    // Shape-based redaction only (no secret-store reads): the content world
    // must never pull key VALUES across the session-storage boundary.
    sendResponse({ ok: true, html: redactKeyShapes(capped) });
  } catch (e) {
    sendResponse(errorResponse(e));
  }
}

export function handleGetDomFingerprint(
  sendResponse: (r: Response) => void,
): void {
  try {
    sendResponse({ ok: true, fingerprint: domFingerprint() });
  } catch (e) {
    sendResponse(errorResponse(e));
  }
}
