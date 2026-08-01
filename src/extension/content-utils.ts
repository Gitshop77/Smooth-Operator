import { extractBrowserState, getSelectorMap } from "@/lib/agent/dom/extractor";
import { generateAccessibilityTree } from "@/lib/agent/dom/ax-tree";
import { executeAction } from "@/lib/agent/tools/executor";
import { setSecretsResolvedExternally } from "@/lib/agent/secrets";
import {
  isDomainPolicyEnforced,
  setDomainConfig,
  validateDomainConfig,
} from "@/lib/agent/tools/helpers/domain-config";
import { domFingerprint } from "@/lib/agent/tools/helpers";
import type { AgentAction, ActionResult, BrowserState, TabInfo } from "@/lib/agent/types";

export const log: (...args: unknown[]) => void = console.warn.bind(console, "[content]");

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

// ─── Message handlers ──────────────────────────────────────────────────────

/** Build the canonical failure response from a caught error. */
function errorResponse(e: unknown): ErrorResponse {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/** Clamp a finite numeric message field into `[min, max]`, else `fallback`. */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
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
    const state = extractBrowserState(tabs);
    const depth = clampInt(msg.depth, 15, 1, 50);
    const maxLength = clampInt(msg.maxLength, 50_000, 1, 1_000_000);
    const includeAxTree = msg.includeAxTree ?? true;
    const axTree = includeAxTree
      ? generateAccessibilityTree("all", depth, maxLength)
      : {
          pageContent: "",
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
    if (includeAxTree && axTree.error) {
      log(`AX tree generation warning: ${axTree.error}`);
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
  const safeRespond = (r: Response) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(r);
    } catch {
      /* channel already closed */
    }
  };

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
    try {
      const actions: AgentAction[] = Array.isArray(msg.actions) ? msg.actions : [];
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
            }
          : extractBrowserState([]);
      const results: ActionResult[] = [];
      const policyEnforced = isDomainPolicyEnforced();
      for (const action of actions) {
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
          result = await executeAction(action, state);
        }
        results.push(result);
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
    }
  })();
  return true;
}

export function handleExtractHtml(
  sendResponse: (r: Response) => void,
): void {
  try {
    const html = document.documentElement.outerHTML || "";
    const capped = html.length > 500_000 ? html.slice(0, 500_000) : html;
    sendResponse({ ok: true, html: capped });
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
