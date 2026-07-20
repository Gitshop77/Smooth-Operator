/**
 * background/tab-manager.ts — chrome.tabs queries, content-script injection,
 * tab-level action execution (switch/close/navigate/search).
 *
 * The orchestrator (running in the service worker) can't touch the DOM, so
 * every observe/execute call is shipped to the content script via
 * `chrome.tabs.sendMessage`. Tab-level actions that the content script can't
 * perform (switching/closing/navigating tabs) are handled here.
 */

import { injectAntiDetection, isStealthEnabled } from "@/lib/agent/anti-detection";
import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import { SEARCH_ENGINE_URLS, getSearchEngineUrl } from "@/lib/agent/tools/constants";
import { substituteSecrets, redactSecrets } from "@/lib/agent/secrets";
import type { ActionResult, AgentAction, BrowserState, LogEvent, TabInfo } from "@/lib/agent/types";
import { getDomainConfig, saveRunState, type RunState } from "./state-store";

/**
 * Cached `screenshotQuality` setting.
 *
 * Previously, `extractStateFromTab` called `chrome.storage.local.get("screenshotQuality")`
 * on EVERY agent step (extractState is called once per navigator step). Each
 * storage read is 1-3ms — small per call, but unnecessary work in the hot
 * path. The value is now cached in a module-level variable, lazily initialized
 * on first use, and invalidated when `chrome.storage.onChanged` fires for the
 * `screenshotQuality` key (the user can change it from the Options page).
 */
let cachedScreenshotQuality: number | null = null;

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.screenshotQuality) {
      cachedScreenshotQuality = null;
    }
  });
}

/**
 * Per-tab debugger session refcount.
 *
 * `Page.captureScreenshot` needs a debugger attached to the agent tab, but the
 * orchestrator can issue multiple concurrent `extractStateFromTab` calls for the
 * SAME tab (e.g. parallel observers, or a retry that overlaps the in-flight
 * one). Each call previously did its own `attach`/`detach`, so one call's
 * `detach` could tear down a session another call was actively using — leaving
 * the second call without a debugger and dropping its screenshot . We refcount per tab: the session is attached on the first
 * acquirer and detached only when the last user releases it.
 */
const debuggerRefCounts = new Map<number, number>();

/**
 * Clear a tab's refcount when something other than our own `releasePageDebugger`
 * tears the session down: the agent tab is closed, or Chrome auto-detaches the
 * debugger (target crash, tab backgrounded, SW teardown). Without this, a stale
 * >0 entry lingers for a dead tab and a later `acquirePageDebugger` hits the
 * "already attached" swallow — proceeding as if a live CDP session existed while
 * in reality none does, so every subsequent screenshot / CDP click for that tab
 * silently fails.
 */
if (typeof chrome !== "undefined") {
  chrome.debugger?.onDetach?.addListener((source) => {
    const tabId = (source as { tabId?: number }).tabId;
    if (typeof tabId === "number") debuggerRefCounts.delete(tabId);
  });
  chrome.tabs?.onRemoved?.addListener((tabId: number) => {
    debuggerRefCounts.delete(tabId);
  });
}

export async function acquirePageDebugger<T>(
  tabId: number,
  attach: (id: number) => Promise<T>,
): Promise<void> {
  const n = (debuggerRefCounts.get(tabId) ?? 0) + 1;
 // Bump the refcount synchronously BEFORE awaiting `attach` so two concurrent
 // acquirers both observe the incremented count. This closes the TOCTOU race
 // where two concurrent callers could each read get()===0, both attach, and
 // then a premature release from one detach the session the other is
 // mid-capture on.
  debuggerRefCounts.set(tabId, n);
  try {
 // Every acquirer attempts to attach. The first holder creates the session;
 // a concurrent (n>1) holder that finds the session already attached (e.g.
 // because the original attacher is mid-flow, or a prior attacher failed and
 // this one is retrying) receives an "already attached" error, which we
 // swallow — the session is live and we hold a valid ref.
    await attach(tabId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already attached/i.test(msg)) return;
 // Genuine attach failure: roll back only our own contribution (decrement
 // rather than delete) so a concurrent holder's refcount is preserved and
 // its pending screenshot isn't silently dropped.
    const m = (debuggerRefCounts.get(tabId) ?? 1) - 1;
    if (m <= 0) debuggerRefCounts.delete(tabId);
    else debuggerRefCounts.set(tabId, m);
    throw e;
  }
}

export async function releasePageDebugger<T>(
  tabId: number,
  detach: (id: number) => Promise<T>,
): Promise<void> {
 // Never detach a session we don't own. After a genuine (non-"already
 // attached") attach failure, the caller's finally still calls this with no
 // tracked entry — without this guard we'd issue a detach that could tear down
 // a concurrent legitimate holder's CDP session .
  if ((debuggerRefCounts.get(tabId) ?? 0) <= 0) return;
  const n = (debuggerRefCounts.get(tabId) ?? 0) - 1;
  if (n <= 0) {
    debuggerRefCounts.delete(tabId);
    await detach(tabId).catch(() => {
      /* tab may have closed */
    });
  } else {
    debuggerRefCounts.set(tabId, n);
  }
}

/**
 * Run `fn` with a refcounted page debugger attached for the duration of the
 * call, guaranteeing a symmetric `releasePageDebugger` in a `finally` even if
 * `fn` throws or returns early. Centralizes the acquire/release boilerplate so
 * a forgotten detach can't leave a debugger session attached across CDP paths.
 */
export async function withPageDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const { attachDebugger, detachDebugger } = await import("@/lib/agent/cdp-controller");
  await acquirePageDebugger(tabId, attachDebugger);
  try {
    return await fn();
  } finally {
    await releasePageDebugger(tabId, detachDebugger);
  }
}

/** Read the user-configured screenshot JPEG quality (0-100). Cached. */
export async function getScreenshotQuality(): Promise<number> {
  if (cachedScreenshotQuality !== null) return cachedScreenshotQuality;
  const { screenshotQuality } = await chrome.storage.local.get("screenshotQuality");
  cachedScreenshotQuality =
    typeof screenshotQuality === "number" ? Math.min(100, Math.max(0, screenshotQuality)) : 80;
  return cachedScreenshotQuality;
}

/**
 * List the user's open tabs in the current window, skipping chrome:// and
 * chrome-extension:// URLs. Each tab gets a collision-free label (last 4
 * digits of its id, with a `#N` suffix on collisions).
 */
export async function listTabs(): Promise<TabInfo[]> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const labels = new Map<string, number>();
  const result: TabInfo[] = [];
  for (const t of tabs) {
    if (!t.url || t.url.startsWith("chrome://") || t.url.startsWith("chrome-extension://")) continue;
    const label = String(t.id).slice(-4);
    const count = labels.get(label) || 0;
    labels.set(label, count + 1);
    const finalLabel = count === 0 ? label : `${label}#${count}`;
    result.push({
      id: t.id!,
      label: finalLabel,
      url: t.url,
      title: t.title || "",
      active: !!t.active,
    });
  }
  return result;
}

/**
 * Bounded timeout (ms) for a content-script round-trip. A wedged content script
 * would otherwise make `chrome.tabs.sendMessage` never resolve and deadlock the
 * orchestrator's observe/act step until the service worker is killed.
 */
const CONTENT_SCRIPT_TIMEOUT_MS = 20_000;

/**
 * Timeout for the initial `PING` readiness check in {@link ensureContent}. A
 * wedged-but-present content script would otherwise make the raw
 * `chrome.tabs.sendMessage` never resolve and stall injection (and every
 * subsequent observe/act step) until the service worker is killed.
 */
const PING_TIMEOUT_MS = 1_500;

/**
 * Per-attempt timeout for the post-injection readiness poll in
 * {@link ensureContent}. Kept short so a wedged content script surfaces as a
 * re-injection / failure quickly rather than hanging the poll loop.
 */
const PING_POLL_TIMEOUT_MS = 500;

/**
 * Send `message` to the content script in `tabId`, rejecting after
 * `timeoutMs` if the content script never responds (renderer crash, a
 * navigation racing the message, a tab frozen under memory pressure). This
 * keeps the orchestrator's observe/act step retrying or failing cleanly
 * instead of hanging. The timer is always cleared (no leak), and the
 * underlying send's late rejection is swallowed so it never surfaces as an
 * unhandled rejection after we've already moved on.
 */
export async function sendMessageWithTimeout<R = unknown>(
  tabId: number,
  message: unknown,
  timeoutMs: number = CONTENT_SCRIPT_TIMEOUT_MS,
): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = chrome.tabs.sendMessage<R>(tabId, message as never);
  send.catch(() => {});
  try {
    return await Promise.race([
      send,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("content script did not respond")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read the page's structural DOM fingerprint (see `domFingerprint` in the
 * content script) for `tabId`. Used by the vision-cache staleness guard to
 * detect an SPA re-render at the same URL between `detect_visual` and the
 * click. Returns `""` on any failure (uninjected tab, timeout, closed tab) so
 * callers treat "no fingerprint" as "can't confirm freshness" rather than
 * throwing on the click path.
 */
export async function getPageFingerprint(tabId: number): Promise<string> {
  try {
    await ensureContent(tabId);
    const res = await sendMessageWithTimeout<{ ok: boolean; fingerprint?: string }>(
      tabId,
      { type: "GET_DOM_FINGERPRINT" },
    );
    return res?.ok ? res.fingerprint ?? "" : "";
  } catch {
    return "";
  }
}

/**
 * Ensure the content script is injected into the given tab. Pings first; if no
 * response, injects anti-detection scripts, then the content script, and polls
 * for readiness (replaces a fixed 150 ms sleep).
 */
export async function ensureContent(tabId: number): Promise<void> {
  try {
    const res = await sendMessageWithTimeout<{ ok: boolean } | undefined>(
      tabId,
      { type: "PING" },
      PING_TIMEOUT_MS,
    );
    if (res?.ok) return;
  } catch {
    /* not injected yet — fall through to injection */
  }
  try {
 // Inject anti-detection scripts FIRST (before the content script) so they
 // apply to the page before any agent interaction. The MAIN-world stealth
 // patches are OPT-IN and OFF by default (ToS/bot-detection-circumvention
 // risk) — only inject when the user has explicitly enabled them.
    if (await isStealthEnabled()) {
      try {
        await injectAntiDetection(tabId);
      } catch (e) {
        console.warn(
          `[tab-manager] stealth injection failed; continuing with content script only: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      console.debug("[tab-manager] stealth patches skipped (stealthEnabled is off)");
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    for (let i = 0; i < 10; i++) {
      try {
        const res = await sendMessageWithTimeout<{ ok: boolean } | undefined>(
          tabId,
          { type: "PING" },
          PING_POLL_TIMEOUT_MS,
        );
        if (res?.ok) return;
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("content script did not become ready after injection");
  } catch (e) {
    throw new Error(`Cannot inject into tab ${tabId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Send EXTRACT_STATE to the content script in `tabId` and optionally attach a
 * screenshot of the visible tab (for vision-capable LLM providers). When the
 * content script returns `elementRects` + `devicePixelRatio`, the screenshot
 * is annotated with numbered Set-of-Marks bounding boxes (see
 * `screenshot-annotator.ts`) so vision models can match each `[index]` in the
 * elements tree to a visible box on the screenshot.
 */
export async function extractStateFromTab(
  tabId: number,
  tabs: TabInfo[],
  includeScreenshot = true
): Promise<BrowserState> {
 // Ensure the content script is present before messaging it. The manifest
 // declares no `content_scripts`, so injection is purely programmatic —
 // without this call, the first EXTRACT_STATE on a freshly loaded tab
 // rejects and the agent loop aborts after `maxFailures` consecutive
 // observe errors. `ensureContent` pings first and is a no-op when the
 // content script is already injected, so the per-step cost is one
 // round-trip only on the first observe of a new tab.
  await ensureContent(tabId);
  const res = await sendMessageWithTimeout<{ ok: boolean; error?: string; state?: BrowserState }>(
    tabId,
    { type: "EXTRACT_STATE", tabs },
  );
  if (!res?.ok) throw new Error(`extract failed: ${res?.error || "no response"}`);
 // The content script may respond `{ ok: true }` with no `state` (or a
 // non-object). Without this check, line below would throw inside the
 // screenshot try (swallowed) and we'd return `undefined` state, causing a
 // downstream crash in the orchestrator instead of a clean observe error
 // (finding: extractStateFromTab returns res.state without validating it).
  if (typeof res.state !== "object" || res.state === null) {
    throw new Error("extract failed: content script returned no state object");
  }
  if (includeScreenshot) {
    try {
 // default to JPEG quality 80 — 3-5x smaller than PNG for
 // complex/photographic pages, cutting vision-token cost per step.
 // Chrome's captureVisibleTab only supports {format: "jpeg", quality: N}.
 // quality is cached module-level + invalidated on storage
 // change — avoids a `chrome.storage.local.get` per agent step.
      const screenshotFormat = await getScreenshotQuality();
 // Capture the AGENT's tab (tabId) via CDP `Page.captureScreenshot` rather
 // than `chrome.tabs.captureVisibleTab(WINDOW_ID_CURRENT)`. captureVisibleTab
 // grabs whichever tab the USER is currently viewing — if they switched
 // windows/tabs mid-run, the vision LLM receives a screenshot of the wrong
 // page (a correctness + privacy bug). CDP targets the exact agent tab,
 // mirroring the SCREENSHOT handler in message-routing.ts
 // (finding: per-step screenshot captures the user's visible tab).
 // Route through the refcounted debugger helper so a concurrent screenshot for
 // the same tab can't detach ours mid-capture , and the
 // symmetric detach is guaranteed even on error.
      const dataUrl = await withPageDebugger(tabId, async () => {
        const result = await new Promise<{ data?: string }>((resolve, reject) => {
          let settled = false;
          const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error("captureScreenshot timed out after 10s"));
          }, 10_000);
          (chrome.debugger.sendCommand(
            { tabId },
            "Page.captureScreenshot",
            { format: "jpeg", quality: screenshotFormat, captureBeyondViewport: false },
          ) as Promise<{ data?: string }>).then(
            (r) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(r);
            },
            (e) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(e);
            },
          );
        });
        if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
        return `data:image/jpeg;base64,${result.data}`;
      });
      res.state.screenshot = dataUrl;

 // Annotate the screenshot with numbered Set-of-Marks bounding boxes
 // when the content script provided element rects. This is the single
 // highest-impact accuracy improvement for vision-capable LLM models —
 // it creates a direct visual-structural link between the `[index]`
 // numbers in the elements tree and the pixel regions on the screenshot.
      const elementRects = (res.state as { elementRects?: unknown }).elementRects;
      if (Array.isArray(elementRects) && elementRects.length > 0) {
        try {
          const {
            annotateScreenshot,
            DEFAULT_ANNOTATE_PALETTE,
          } = await import("@/lib/agent/dom/screenshot-annotator");
          const dpr = (res.state as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
 // Wire the refPrefix + multi-color palette so each annotated box
 // gets a stable "e<index>" ref label and neighbouring elements are
 // visually distinguishable on dense pages. Matches the contract
 // documented on `annotateScreenshot` (refPrefix="e" → "e3" labels
 // that line up with the `[3]<...>` entries in the elements tree).
          res.state.screenshot = await annotateScreenshot(dataUrl, elementRects as never, {
            scaleFactor: dpr,
            refPrefix: "e",
            boxColors: [...DEFAULT_ANNOTATE_PALETTE],
          });
        } catch {
 // Annotation failed (Canvas unavailable, decode error, …).
 // Non-fatal — keep the raw, unannotated screenshot.
        }
      }
    } catch (e) {
 // Screenshot capture (CDP Page.captureScreenshot) can fail if the tab
 // isn't visible or permissions are missing. Non-fatal — the agent falls
 // back to DOM-only state. Log at debug level for field diagnostics
 // (e.g. "why is the model blind?") without leaking data.
      console.debug(
        "[tab-manager] screenshot capture failed, using DOM-only state:",
        e instanceof Error ? e.message : "",
      );
    }
  }
  return res.state;
}

/**
 * Send EXECUTE_ACTIONS to the content script in `tabId`. Returns the list of
 * ActionResult objects produced by executing each action in sequence.
 */
export async function executeActionsInTab(
  tabId: number,
  actions: AgentAction[]
): Promise<unknown> {
 // Ensure the content script is present (see extractStateFromTab). Also ship
 // the domain allow/blocklist so the content script can enforce `navigate` /
 // `evaluate` / `search` URL gates — the content script lives in an isolated
 // world with its own globalThis, so the SW-side `__openCoworkDomainConfig`
 // global is invisible to it. Without this, `checkUrlAllowed` in the content
 // script always returns `{ allowed: true }` and the user's domain
 // allow/blocklist is silently bypassed.
  await ensureContent(tabId);

  // F-1: resolve `%placeholder%` substitution in the SERVICE WORKER — the only
  // context that can read `chrome.storage.session` (content scripts cannot; the
  // extension never grants them session access, which would arm the
  // `evaluate()` secret-exfil path). Substituting here means the content script
  // receives the already-resolved text (no placeholder), so its own
  // `substituteSecrets` call short-circuits without touching the store. Only
  // `input` actions carry a `%placeholder%` payload; everything else is passed
  // through untouched.
  const inputResolvedText = new Map<number, string>();
  const resolvedActions = await Promise.all(
    actions.map(async (a, idx) => {
      if (a.type === "input") {
        const text = await substituteSecrets(a.text ?? "", { trusted: true });
        inputResolvedText.set(idx, text);
        return { ...a, text };
      }
      return a;
    }),
  );

  const res = await sendMessageWithTimeout<{ ok: boolean; error?: string; results?: unknown }>(
    tabId,
    {
      type: "EXECUTE_ACTIONS",
      actions: resolvedActions,
      domainConfig: getDomainConfig(),
      // Tell the content script secrets are already resolved so its
      // `substituteSecrets`/`redactSecrets` calls short-circuit (no store read).
      secretsResolved: true,
    },
  );
  if (!res?.ok) throw new Error(`execute failed: ${res?.error || "no response"}`);
 // The content script may respond `{ ok: true }` without a `results` field (or
 // with a non-array) — without this check the spread in run-helpers.ts
 // (`[...execResults]`) throws and aborts the run with an unhelpful error.
 // Mirror the `state` validation already done in `extractStateFromTab`.
  if (!Array.isArray(res.results)) {
    throw new Error("execute failed: content script returned no results array");
  }
  const results = res.results as ActionResult[];

  // Post-process the returned results in the SW so the REAL secret value never
  // reaches the LLM provider or the persisted run history:
  //  1. input: the content script typed the resolved (real) value but must NOT
  //     echo it. Restore the original `%placeholder%` text and a redacted
  //     message so history only ever holds the placeholder.
  //  2. extract / find_elements / dropdown_options: the content script could
  //     not redact (it can't read the store), so it shipped RAW extracted text.
  //     Redact it here, in the trusted SW, before it reaches the LLM.
  // The result array is positionally aligned with `actions` (the content script
  // returns one result per input action, possibly plus one extra trailing
  // `wait` marker on early break — that trailing element has no matching
  // original action and is passed through unchanged, preserving existing
  // run-helpers alignment semantics).
  return Promise.all(
    results.map(async (r, i) => {
      const orig = actions[i];
      if (!orig) return r;
      if (
        orig.type === "input" &&
        inputResolvedText.has(i) &&
        (orig.text ?? "") !== inputResolvedText.get(i)
      ) {
        return {
          ...r,
          action: { ...r.action, text: orig.text },
          message: `Typed [REDACTED — secret substituted] into [${orig.index}]`,
        };
      }
      const readActionTypes = new Set([
        "extract",
        "find_elements",
        "dropdown_options",
        "find_text",
        "evaluate",
        "search_page",
      ]);
      if (readActionTypes.has(orig.type)) {
        const patch: Record<string, unknown> = {};
        if (typeof r.extractedContent === "string") {
          patch.extractedContent = await redactSecrets(r.extractedContent);
        }
        const rAny = r as unknown as Record<string, unknown>;
        if (typeof rAny.value === "string") {
          patch.value = await redactSecrets(rAny.value);
        }
        if (typeof rAny.text === "string") {
          patch.text = await redactSecrets(rAny.text);
        }
        return { ...r, ...patch };
      }
      return r;
    }),
  );
}

/**
 * Resolve when `tabId` reaches status="complete", or after `timeoutMs`.
 * Checks the current status first to avoid a race condition where the tab
 * finished loading before this function was called.
 */
export function waitForTabLoad(tabId: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
 // `finish` only ever runs asynchronously (via the onUpdated listener, the
 // `chrome.tabs.get` promise, or the timeout), never synchronously during this
 // setup block, so referencing these `const`s from the closure is TDZ-safe.
    const finish = () => {
      if (!done) {
        done = true;
 // Release the timer handle so it doesn't linger for up to `timeoutMs`
 // after resolution (finding: waitForTabLoad setTimeout is never cleared).
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === "complete") finish();
      })
      .catch(finish);
    const timeoutId = setTimeout(finish, timeoutMs);
  });
}

// ─── Tab-level action execution (switch/close/navigate) ─────────────────────

/**
 * Handle a tab-level action that requires the chrome.tabs API (the content
 * script cannot switch/close/navigate tabs). Updates `runState.currentTabId`
 * and persists it.
 *
 * @returns `{ handled: true, pageChanged }` if the action was consumed.
 */
export interface TabActionResult {
  /** True if this function consumed the action (caller shouldn't fall back). */
  handled: boolean;
  /** True if the page/tab changed (orchestrator aborts the remaining queue). */
  pageChanged: boolean;
  /** True if the action succeeded; false if blocked or the tab wasn't found. */
  success: boolean;
  /** Human-readable result message (surfaced to the LLM via ActionResult). */
  message: string;
}

export async function handleTabAction(
  action: AgentAction,
  runState: RunState,
  notify?: (event: LogEvent) => void
): Promise<TabActionResult> {
  try {
    switch (action.type) {
    case "switch_tab": {
      const tabs = await listTabs();
      const tab = tabs.find((t) => t.id === action.tab_id);
      if (!tab) return { handled: false, pageChanged: false, success: false, message: `tab ${action.tab_id} not found` };
      await chrome.tabs.update(tab.id, { active: true });
      await waitForTabLoad(tab.id, 3000);
      runState.currentTabId = tab.id;
      await saveRunState({ currentTabId: tab.id });
      return { handled: true, pageChanged: true, success: true, message: `Switched to tab ${action.tab_id}` };
    }
    case "close_tab": {
      const tabs = await listTabs();
      const tab = tabs.find((t) => t.id === action.tab_id);
      if (!tab) return { handled: false, pageChanged: false, success: false, message: `tab ${action.tab_id} not found` };
      await chrome.tabs.remove(tab.id);
      if (tab.id === runState.currentTabId) {
        const remaining = await listTabs();
        if (remaining[0]) {
          runState.currentTabId = remaining[0].id;
          await chrome.tabs.update(runState.currentTabId, { active: true });
          await saveRunState({ currentTabId: remaining[0].id });
        } else {
 // The closed tab was the last one — clear the pointer so we don't keep
 // referencing a now-closed tab (which would make the next navigate/
 // search act on a dead tab id). A 0 sentinel means "no active tab".
 // runState.currentTabId = 0;
          await saveRunState({ currentTabId: 0 });
        }
      }
      return { handled: true, pageChanged: true, success: true, message: `Closed tab ${action.tab_id}` };
    }
    case "navigate": {
 // Reject dangerous / non-navigable schemes (`javascript:`, `data:`,
 // `file:`, `about:`, …) BEFORE the domain-policy check. `checkUrlAllowed`
 // only inspects hostnames, so without this gate a `javascript:` URL would
 // slip through the allow/blocklist and execute in the page. The domain
 // policy alone cannot gate scheme .
      if (!/^https?:\/\//i.test(String(action.url ?? ""))) {
        return {
          handled: true,
          pageChanged: false,
          success: false,
          message: `BLOCKED: unsupported URL scheme in navigate: ${action.url}`,
        };
      }
 // Enforce the domain allow/blocklist BEFORE calling chrome.tabs.update/
 // create. The content-script `handleNavigate` also checks, but this SW
 // path is the authoritative gate for new-tab navigation (which the
 // content script can't perform).
      const urlCheck = checkUrlAllowedWithDomainConfig(action.url);
      if (!urlCheck.allowed) {
        notify?.({
          type: "error",
          step: runState.step,
          message: `BLOCKED navigation: ${urlCheck.reason} (${action.url})`,
          recoverable: false,
        });
        return { handled: true, pageChanged: false, success: false, message: `BLOCKED: ${urlCheck.reason} (${action.url})` };
      }
      if (action.new_tab) {
        const newTab = await chrome.tabs.create({ url: action.url, active: true });
        runState.currentTabId = newTab.id!;
        await saveRunState({ currentTabId: newTab.id! });
        await waitForTabLoad(newTab.id!);
        await ensureContent(newTab.id!);
      } else {
        if (!runState.currentTabId) {
          return { handled: true, pageChanged: false, success: false, message: "BLOCKED: no active tab — set new_tab:true to open one" };
        }
        await chrome.tabs.update(runState.currentTabId, { url: action.url });
        await waitForTabLoad(runState.currentTabId);
        await ensureContent(runState.currentTabId);
      }
      return { handled: true, pageChanged: true, success: true, message: `navigated to ${action.url}` };
    }
    case "search": {
      const engine = (action as { engine?: string }).engine ?? "duckduckgo";
      const resolvedEngine =
        SEARCH_ENGINE_URLS[engine as keyof typeof SEARCH_ENGINE_URLS]
          ? String(engine)
          : "duckduckgo";
      const query = (action as { query?: string }).query;
 // A missing/undefined query would serialize to the literal "undefined"
 // (encodeURIComponent(undefined) → "undefined"), making the agent silently
 // search for "undefined". Reject it cleanly instead of building a bogus URL.
      if (typeof query !== "string" || query.length === 0) {
        return { handled: true, pageChanged: false, success: false, message: "BLOCKED: missing query" };
      }
 // Validate the engine is a known key; otherwise fall back to the default.
 // (`SEARCH_ENGINE_URLS[engine]` is only consulted when `engine` is a real
 // key — the `|| duckduckgo` covers a malformed/unknown engine.)
      const baseUrl = getSearchEngineUrl(resolvedEngine) ?? SEARCH_ENGINE_URLS.duckduckgo;
      const searchUrl = baseUrl + encodeURIComponent(query);
 // Apply the same domain policy + scheme gate as navigate. The engine base
 // URLs are constant http(s), but guard anyway .
      if (!/^https?:\/\//i.test(searchUrl)) {
        return {
          handled: true,
          pageChanged: false,
          success: false,
          message: `BLOCKED: unsupported search URL scheme`,
        };
      }
 // Apply the same domain policy as navigate.
      const searchUrlCheck = checkUrlAllowedWithDomainConfig(searchUrl);
      if (!searchUrlCheck.allowed) {
        notify?.({
          type: "error",
          step: runState.step,
          message: `BLOCKED search: ${searchUrlCheck.reason}`,
          recoverable: false,
        });
        return { handled: true, pageChanged: false, success: false, message: `BLOCKED: ${searchUrlCheck.reason}` };
      }
      if (!runState.currentTabId) {
        return { handled: true, pageChanged: false, success: false, message: "BLOCKED: no active tab — set new_tab:true to open one" };
      }
      await chrome.tabs.update(runState.currentTabId, { url: searchUrl });
      await waitForTabLoad(runState.currentTabId);
      await ensureContent(runState.currentTabId);
      return { handled: true, pageChanged: true, success: true, message: `Searching on ${resolvedEngine}` };
    }
    default:
      return { handled: false, pageChanged: false, success: false, message: "" };
    }
  } catch (e) {
    return {
      handled: true,
      pageChanged: false,
      success: false,
      message: `tab action failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
