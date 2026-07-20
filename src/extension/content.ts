/**
 * content.ts — the Chrome extension content script entry point.
 *
 * Bundled via esbuild from the shared TypeScript core in `src/lib/agent/*`.
 * Injected into the target tab by the background service worker.
 *
 * Handles these message types from the background script:
 * - `PING` — liveness check (used during injection polling)
 * - `EXTRACT_STATE` — collect DOM state + AX-tree (no HTMLElement refs)
 * - `EXECUTE_ACTIONS` — run a sequence of AgentActions on the page
 * - `SET_DEBUG_HIGHLIGHT` — toggle persistent overlay highlight (debug)
 * - `EXTRACT_HTML` — return the page's outerHTML for the HTML evaluator
 *
 * The selectorMap (index → HTMLElement) is kept in the extractor module's
 * closure so EXECUTE_ACTIONS can resolve indexes returned by the LLM without
 * sending HTMLElement refs across the message channel.
 */

import { extractBrowserState, getSelectorMap } from "@/lib/agent/dom/extractor";
import { generateAccessibilityTree, initElementMap } from "@/lib/agent/dom/ax-tree";
import { executeAction } from "@/lib/agent/tools/executor";
import { setPersistentHighlight } from "@/lib/agent/dom/overlay";
import { installPopupHandler } from "@/lib/agent/dom/popup-handler";
import { setSecretsResolvedExternally } from "@/lib/agent/secrets";
import {
  isDomainPolicyEnforced,
  setDomainConfig,
  validateDomainConfig,
} from "@/lib/agent/tools/helpers/domain-config";
import { domFingerprint } from "@/lib/agent/tools/helpers";
import type { AgentAction, ActionResult, BrowserState, TabInfo } from "@/lib/agent/types";

// ─── Message contracts ─────────────────────────────────────────────────────

interface PingMessage {
  type: "PING";
}
interface ExtractStateMessage {
  type: "EXTRACT_STATE";
  tabs?: TabInfo[];
  /** Optional overrides for AX tree generation. */
  depth?: number;
  maxLength?: number;
  /** When false, skips AX tree generation (halves DOM-walk cost). Default: true. */
  includeAxTree?: boolean;
}
interface ExecuteActionsMessage {
  type: "EXECUTE_ACTIONS";
  actions?: AgentAction[];
  /**
 * Optional URL allow/blocklist policy shipped by the service worker. The
 * handler reads this (see the EXECUTE_ACTIONS case) and installs it before
 * executing actions. Declared explicitly here so the contract is type-checked
 * on both ends instead of being read through an untyped cast.
 */
  domainConfig?: unknown;
  /**
 * True when the service worker has already resolved `%placeholder%`
 * substitution + performed redaction on the shipped actions/results (the SW
 * can read `chrome.storage.session`; the content script cannot). When set, the
 * content-side `substituteSecrets`/`redactSecrets` calls short-circuit without
 * touching the (unreadable-from-content-script) secret store. See finding F-1.
 */
  secretsResolved?: boolean;
}
interface SetDebugHighlightMessage {
  type: "SET_DEBUG_HIGHLIGHT";
  enabled?: boolean;
}
interface ExtractHtmlMessage {
  type: "EXTRACT_HTML";
}
interface GetDomFingerprintMessage {
  type: "GET_DOM_FINGERPRINT";
}

type IncomingMessage =
  | PingMessage
  | ExtractStateMessage
  | ExecuteActionsMessage
  | SetDebugHighlightMessage
  | ExtractHtmlMessage
  | GetDomFingerprintMessage;

interface OkResponse<T = unknown> {
  ok: true;
  state?: T;
  results?: T;
  /** Set by the EXTRACT_HTML handler (raw page HTML, capped). */
  html?: string;
  /** Set by the GET_DOM_FINGERPRINT handler (structural page signature). */
  fingerprint?: string;
}
interface ErrorResponse {
  ok: false;
  error: string;
}
type Response<T = unknown> = OkResponse<T> | ErrorResponse;

/**
 * The persistent-debug-highlight overlay is a debug aid (shows every clicked
 * element's box + the Set-of-Marks labels). It is gated behind an explicit
 * opt-in: the side panel's debug toggle sends a `SET_DEBUG_HIGHLIGHT` message
 * to this content script, and the handler below applies it on receipt — the
 * overlay is never registered/run unconditionally.
 */
// Diagnostic logger for content-script init failures.
const log: (...args: unknown[]) => void = console.warn.bind(console, "[content]");

/** Entry point. Idempotent — re-injection is a no-op. */
(() => {
  if ((window as unknown as { __openCoworkInjected?: boolean }).__openCoworkInjected) return;
  Object.defineProperty(window, "__openCoworkInjected", { value: true, enumerable: false, configurable: true });

 // Initialize the AX-tree element map on injection. Wrap in try/catch so a
 // failure here doesn't block the rest of the content script (e.g. some
 // sandboxed pages throw on `window` access).
  try {
    initElementMap();
  } catch (e) {
    log("initElementMap failed:", e);
  }
 // Auto-dismiss alert/confirm/prompt dialogs so the agent can't hang.
  try {
    installPopupHandler();
  } catch (e) {
    log("installPopupHandler failed:", e);
  }

  chrome.runtime.onMessage.addListener(
    (msg: IncomingMessage, sender, sendResponse: (r: Response) => void) => {
 // Only accept messages from our own extension.
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: "unauthorized sender" });
        return false;
      }
      switch (msg?.type) {
        case "PING": {
          sendResponse({ ok: true });
          return false; // synchronous response
        }

        case "EXTRACT_STATE": {
          try {
            const tabs: TabInfo[] = msg.tabs || [];
            const state = extractBrowserState(tabs);
 // Accept depth / maxLength overrides from the message (defaults
 // match the prior constants so the LLM gets the same view). Clamp
 // to sane bounds (finding: numeric message overrides in EXTRACT_STATE
 // are not validated) — a malformed/buggy negative or absurd value
 // could trigger a degenerate/expensive DOM walk.
            const rawDepth = msg.depth;
            const depth = rawDepth !== undefined && Number.isFinite(rawDepth)
              ? Math.min(Math.max(1, Math.floor(rawDepth)), 50)
              : 15;
            const rawMaxLength = msg.maxLength;
            const maxLength = rawMaxLength !== undefined && Number.isFinite(rawMaxLength)
              ? Math.min(Math.max(1, Math.floor(rawMaxLength)), 1_000_000)
              : 50_000;
 // AX tree generation walks the full DOM a second time. Make
 // it opt-in via the `includeAxTree` flag (default true for backward
 // compatibility). Set to false to halve DOM-walk cost on pages
 // where the semantic view isn't needed.
            const includeAxTree = msg.includeAxTree ?? true;
            const axTree = includeAxTree
              ? generateAccessibilityTree("all", depth, maxLength)
              : { pageContent: "", viewport: { width: window.innerWidth, height: window.innerHeight } };
 // L9: the AX-tree builder exposes an `error` field when generation
 // degraded (unknown ref, output truncated, page too large). Surface it
 // instead of silently forwarding an empty `axTree` block to the LLM so
 // the operator can see why page state came back empty. We keep
 // `axTree: axTree.pageContent` working below.
            if (includeAxTree && axTree.error) {
              console.warn(`[content] AX tree generation warning: ${axTree.error}`);
            }
 // Don't send the selectorMap (HTMLElement refs) over the wire.
            const { selectorMap: _sm, ...serializable } = state;
            void _sm; // selectorMap is intentionally dropped

 // Project the elements array into a compact {index, rect} list
 // for the Set-of-Marks screenshot annotator (see
 // `screenshot-annotator.ts`). Only visible interactive elements
 // are present in `state.elements` (extractor already filtered),
 // so we just project the index + rect fields. We also pass the
 // tab's `devicePixelRatio` so the annotator can scale CSS-pixel
 // rects up to the device-pixel resolution of the captured PNG.
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
 // Structural signature of the interactive DOM. The service worker caches
 // this alongside the vision-element rects so it can detect an SPA
 // re-render at the SAME url between detect_visual and the click (which
 // would otherwise leave the cached pixel rects pointing at the OLD
 // element). Folding it into extractState's per-step payload avoids an
 // extra round-trip in the always-on vision path.
                fingerprint: domFingerprint(),
              },
            });
          } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return false;
        }

        case "EXECUTE_ACTIONS": {
          let responded = false;
          const safeRespond = (r: Response) => {
            if (responded) return;
            responded = true;
            try {
              sendResponse(r);
            } catch {
              /* channel already closed — nothing more to do */
            }
          };
 // INVARIANT (documented — / 67): enforcement is
 // UNSET until the FIRST valid `domainConfig` arrives. The service
 // worker is responsible for shipping a shape-valid policy on the first
 // `EXECUTE_ACTIONS` of every run; until then `getDomainConfig()`
 // returns `{}` → unrestricted navigation. We deliberately do NOT
 // fail closed here because the orchestrator/background always provides
 // a policy on the first action-bearing message, and hard-failing would
 // break legitimate runs where a message legitimately omits the policy
 // (relying on the retained last-good). This assumption is load-bearing;
 // if the SW ever dispatches `EXECUTE_ACTIONS` before establishing a
 // policy, the autonomous agent would navigate with no URL restrictions.
 //
 // The domain-policy update is performed SYNCHRONOUSLY here (outside the
 // async body) so a concurrent `EXECUTE_ACTIONS` message cannot race the
 // async mutation of `lastDomainConfig` / the global . The async closure below only reads the already-published
 // policy.
          try {
            const incomingDomainConfig = msg.domainConfig;
            if (incomingDomainConfig !== undefined) {
 // SECURITY: only install a REAL, shape-valid policy. The shared
 // `validateDomainConfig` recognizes the canonical
 // { allowedDomains, blockedDomains } shape shipped by the service
 // worker (the previous ad-hoc validator only knew allow/block and
 // therefore never set the global — leaving the content-script URL
 // gate dead). `setDomainConfig` retains the last-known-good policy
 // when the payload is absent or malformed, so we never silently
 // downgrade to allow-all, and sets the `__openCoworkDomainConfigEnforced`
 // flag only when a list is actually configured.
              const v = validateDomainConfig(incomingDomainConfig);
              if (v) {
                setDomainConfig(
                  v,
                  Boolean(v.allowedDomains?.length || v.blockedDomains?.length),
                );
              }
            }
            if (!isDomainPolicyEnforced()) {
              console.warn("[content] executing actions with NO URL policy enforced");
            }
            // F-1: when the SW resolved secrets on our behalf, mark the shared
            // handlers so their `substituteSecrets`/`redactSecrets` calls
            // short-circuit instead of reading the (unreadable-from-content-script)
            // `chrome.storage.session`. Set synchronously, before the async action
            // loop runs, so the handlers see it.
            if (msg.secretsResolved !== undefined) setSecretsResolvedExternally(Boolean(msg.secretsResolved));
          } catch (e) {
            // A throw in the synchronous prelude must not strand the sender:
            // respond once and stop here so the async IIFE below never runs.
            safeRespond({ ok: false, error: e instanceof Error ? e.message : String(e) });
            return false;
          }
          (async () => {
            try {
              const actions: AgentAction[] = Array.isArray(msg.actions) ? msg.actions : [];
 // avoid a redundant full DOM walk just to rebuild the
 // selectorMap. `EXTRACT_STATE` already walked the DOM this step
 // (the orchestrator always calls EXTRACT_STATE before
 // EXECUTE_ACTIONS), so `getSelectorMap()` returns the cached map
 // from that walk. We build a minimal BrowserState shell around
 // it — the executor only reads `selectorMap`, `url`, and `title`
 // (and only the first two for action resolution).
 //
 // Fall back to a full `extractBrowserState([])` only when the
 // cache is empty (no prior extraction this tab session — e.g.
 // the content script was re-injected mid-run, or EXECUTE_ACTIONS
 // arrived without a preceding EXTRACT_STATE).
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
 // Fail-closed URL allowlist: when NO domain policy is
 // enforced (the SW did not ship an allow/blocklist on the first
 // action), refuse cross-origin `navigate`/`search` actions unless the
 // target is SAME-ORIGIN with the current task page. This closes the
 // "fails open" gap without breaking the documented invariant that the
 // SW always ships a policy on the first action of a run — when a policy
 // IS enforced, the executor's own domain checks govern navigation, so
 // we don't double-gate here.
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
                  // `search` always targets a cross-origin engine, so sameOrigin
                  // stays false and it is refused under the no-policy fail-closed gate.
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
 // Page changes and done are expected, not failures — mark
 // success: true so the orchestrator doesn't increment
 // consecutiveFailures on legitimate page-changing steps.
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
 // Route the success reply through `safeRespond` too, so a closed
 // channel (tab navigated away mid-execution) doesn't throw here
 // and can't mask the already-computed `results` as a failure.
              safeRespond({ ok: true, results });
            } catch (e) {
 // The tab may have navigated away / port closed mid-execution;
 // `sendResponse` can then throw. Use `safeRespond` (idempotent,
 // guarded) so we don't produce an unhandled rejection that hides
 // the real failure, and so we never double-respond.
              safeRespond({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
          })();
          return true; // async response — keep the channel open
        }

        case "SET_DEBUG_HIGHLIGHT": {
 // toggle persistent highlight mode. The message itself is the explicit
 // opt-in (sent by the side panel's debug toggle), so the overlay is only
 // registered when the operator enables it — never unconditionally.
          setPersistentHighlight((msg as { enabled?: boolean }).enabled ?? false);
          sendResponse({ ok: true });
          return false;
        }

        case "EXTRACT_HTML": {
 // return the current page's outerHTML so the
 // HTML-content evaluator (in the orchestrator's judge fast-path)
 // can match `required_contents` against it. Caps the response at
 // 500K chars to avoid blowing the message channel on giant pages.
          try {
            const html = document.documentElement.outerHTML || "";
            const capped = html.length > 500_000 ? html.slice(0, 500_000) : html;
            sendResponse({ ok: true, html: capped });
          } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return false;
        }

        case "GET_DOM_FINGERPRINT": {
          try {
            sendResponse({ ok: true, fingerprint: domFingerprint() });
          } catch (e) {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return false;
        }

        default:
 // Unknown message type — silently ignore (return false synchronously).
          return false;
      }
    }
  );
})();
