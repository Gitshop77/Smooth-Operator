/**
 * content.ts — the Chrome extension content script entry point.
 *
 * Bundled via esbuild from the shared TypeScript core in `src/lib/agent/*`.
 * Injected into the target tab by the background service worker.
 *
 * Handles these message types from the background script:
 *   - `PING`                — liveness check (used during injection polling)
 *   - `EXTRACT_STATE`       — collect DOM state + AX-tree (no HTMLElement refs)
 *   - `EXECUTE_ACTIONS`     — run a sequence of AgentActions on the page
 *   - `SET_DEBUG_HIGHLIGHT` — toggle persistent overlay highlight (debug)
 *   - `EXTRACT_HTML`        — return the page's outerHTML for the HTML evaluator
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
import type { AgentAction, ActionResult, BrowserState, TabInfo } from "@/lib/agent/types";

/**
 * Validate that an incoming `domainConfig` payload is a shape-valid URL policy
 * before it is installed as the security policy (used by the EXECUTE_ACTIONS
 * handler). A malformed payload must NOT be installed — doing so could either
 * disable enforcement (empty object treated as "no restrictions") or crash the
 * executor when it reads fields that don't exist.
 *
 * Accepts the canonical policy shape `{ enforced?: boolean, allow?: string[],
 * block?: string[] }` and a relaxed shape where at least one of `allow` /
 * `block` is a string array. Returns false for null, non-objects, or objects
 * whose fields have the wrong types — those are ignored so the last-known-good
 * policy is retained instead of being downgraded.
 */
function isValidDomainConfig(cfg: unknown): cfg is Record<string, unknown> {
  if (!cfg || typeof cfg !== "object") return false;
  const c = cfg as Record<string, unknown>;
  const isStringArray = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if ("enforced" in c && typeof c.enforced !== "boolean") return false;
  if ("allow" in c && !isStringArray(c.allow)) return false;
  if ("block" in c && !isStringArray(c.block)) return false;
  // Require at least one recognized field so a random object can't be
  // mistaken for a policy.
  return "enforced" in c || "allow" in c || "block" in c;
}

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
}
interface SetDebugHighlightMessage {
  type: "SET_DEBUG_HIGHLIGHT";
  enabled?: boolean;
}
interface ExtractHtmlMessage {
  type: "EXTRACT_HTML";
}

type IncomingMessage =
  | PingMessage
  | ExtractStateMessage
  | ExecuteActionsMessage
  | SetDebugHighlightMessage
  | ExtractHtmlMessage;

interface OkResponse<T = unknown> {
  ok: true;
  state?: T;
  results?: T;
  /** Set by the EXTRACT_HTML handler (raw page HTML, capped). */
  html?: string;
}
interface ErrorResponse {
  ok: false;
  error: string;
}
type Response<T = unknown> = OkResponse<T> | ErrorResponse;

/** Entry point. Idempotent — re-injection is a no-op. */
(() => {
  if ((window as unknown as { __openCoworkInjected?: boolean }).__openCoworkInjected) return;
  (window as unknown as { __openCoworkInjected?: boolean }).__openCoworkInjected = true;

  // Last-known-good URL policy (allow/blocklist). Retained across messages so a
  // single EXECUTE_ACTIONS that omits `domainConfig` cannot silently downgrade
  // enforcement to "no restrictions" (which would let the autonomous agent be
  // steered to attacker sites). Reset only when a new policy is explicitly
  // provided.
  let lastDomainConfig: unknown = undefined;

  // Initialize the AX-tree element map on injection. Wrap in try/catch so a
  // failure here doesn't block the rest of the content script (e.g. some
  // sandboxed pages throw on `window` access).
  try {
    initElementMap();
  } catch (e) {
    console.warn("[content] initElementMap failed:", e);
  }
  // Auto-dismiss alert/confirm/prompt dialogs so the agent can't hang.
  try {
    installPopupHandler();
  } catch (e) {
    console.warn("[content] installPopupHandler failed:", e);
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
            const rawDepth = (msg as { depth?: number }).depth;
            const depth = Number.isFinite(rawDepth)
              ? Math.min(Math.max(1, Math.floor(rawDepth as number)), 50)
              : 15;
            const rawMaxLength = (msg as { maxLength?: number }).maxLength;
            const maxLength = Number.isFinite(rawMaxLength)
              ? Math.min(Math.max(1, Math.floor(rawMaxLength as number)), 1_000_000)
              : 50_000;
            // AX tree generation walks the full DOM a second time. Make
            // it opt-in via the `includeAxTree` flag (default true for backward
            // compatibility). Set to false to halve DOM-walk cost on pages
            // where the semantic view isn't needed.
            const includeAxTree = (msg as { includeAxTree?: boolean }).includeAxTree ?? true;
            const axTree = includeAxTree
              ? generateAccessibilityTree("all", depth, maxLength)
              : { pageContent: "", viewport: { width: window.innerWidth, height: window.innerHeight } };
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
            const devicePixelRatio =
              (typeof window !== "undefined" && window.devicePixelRatio) || 1;

            sendResponse({
              ok: true,
              state: {
                ...serializable,
                elementRects,
                devicePixelRatio,
                axTree: axTree.pageContent,
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
          (async () => {
            try {
              const actions: AgentAction[] = msg.actions || [];
              // The service worker ships the domain allow/blocklist with the
              // actions (the content script's isolated world has its own
              // globalThis, so the SW-side `__openCoworkDomainConfig` global
              // is invisible here). Install it before executing actions so
              // `getDomainConfig()` — called synchronously by the `navigate` /
              // `evaluate` / `search` handlers — enforces the user's URL
              // policy.
              //
              // SECURITY: never silently downgrade the policy to "no
              // restrictions". If this message omits `domainConfig`, KEEP the
              // last-known-good policy rather than overwriting with `undefined`
              // (which `getDomainConfig` would treat as `{}` → unrestricted).
              // Only replace the policy when a REAL, shape-valid policy object
              // is supplied, so a malformed/absent payload cannot disable
              // enforcement.
              const incomingDomainConfig = msg.domainConfig;
              if (incomingDomainConfig !== undefined) {
                if (isValidDomainConfig(incomingDomainConfig)) {
                  lastDomainConfig = incomingDomainConfig;
                }
                // A null, non-object, or shape-invalid payload is ignored
                // (retains last good).
              }
              // SECURITY: only publish the policy once a REAL, shape-valid one
              // has been received. Writing `undefined` here would make
              // `getDomainConfig()` treat it as `{}` → unrestricted navigation,
              // silently downgrading enforcement before the first valid policy
              // arrives. If we never got a policy, leave the global unset.
              if (lastDomainConfig !== undefined) {
                (
                  globalThis as { __openCoworkDomainConfig?: unknown }
                ).__openCoworkDomainConfig = lastDomainConfig;
              }
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
              for (const action of actions) {
                const result = await executeAction(action, state);
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
          // toggle persistent highlight mode
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

        default:
          // Unknown message type — silently ignore (return false synchronously).
          return false;
      }
    }
  );
})();
