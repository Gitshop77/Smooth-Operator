/**
 * background/tab-manager.ts — chrome.tabs queries, content-script injection,
 * tab-level action execution (switch/close/navigate/search).
 *
 * The orchestrator (running in the service worker) can't touch the DOM, so
 * every observe/execute call is shipped to the content script via
 * `chrome.tabs.sendMessage`. Tab-level actions that the content script can't
 * perform (switching/closing/navigating tabs) are handled here.
 */

import { injectAntiDetection } from "@/lib/agent/anti-detection";
import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import { SEARCH_ENGINE_URLS } from "@/lib/agent/tools/constants";
import type { AgentAction, BrowserState, LogEvent, TabInfo } from "@/lib/agent/types";
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

/** Read the user-configured screenshot JPEG quality (0-100). Cached. */
export async function getScreenshotQuality(): Promise<number> {
  if (cachedScreenshotQuality !== null) return cachedScreenshotQuality;
  const { screenshotQuality } = await chrome.storage.local.get("screenshotQuality");
  cachedScreenshotQuality = typeof screenshotQuality === "number" ? screenshotQuality : 80;
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
 * Ensure the content script is injected into the given tab. Pings first; if no
 * response, injects anti-detection scripts, then the content script, and polls
 * for readiness (replaces a fixed 150 ms sleep).
 */
export async function ensureContent(tabId: number): Promise<void> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (res?.ok) return;
  } catch {
    /* not injected yet — fall through to injection */
  }
  try {
    // Inject anti-detection scripts FIRST (before the content script) so they
    // apply to the page before any agent interaction.
    await injectAntiDetection(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    for (let i = 0; i < 20; i++) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
        if (res?.ok) return;
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("content script did not become ready after 1s");
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
  const res = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_STATE", tabs });
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
      const { attachDebugger, detachDebugger } = await import("@/lib/agent/cdp-controller");
      await attachDebugger(tabId);
      let dataUrl: string;
      try {
        const result = (await chrome.debugger.sendCommand(
          { tabId },
          "Page.captureScreenshot",
          { format: "jpeg", quality: screenshotFormat, captureBeyondViewport: false },
        )) as { data?: string };
        if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
        dataUrl = `data:image/jpeg;base64,${result.data}`;
      } finally {
        await detachDebugger(tabId).catch(() => { /* tab may have closed */ });
      }
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
    } catch {
      // Screenshot capture (CDP Page.captureScreenshot) can fail if the tab
      // isn't visible or permissions are missing. Non-fatal — the agent falls
      // back to DOM-only state.
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
  const res = await chrome.tabs.sendMessage(tabId, {
    type: "EXECUTE_ACTIONS",
    actions,
    domainConfig: getDomainConfig(),
  });
  if (!res?.ok) throw new Error(`execute failed: ${res?.error || "no response"}`);
  // The content script may respond `{ ok: true }` without a `results` field (or
  // with a non-array) — without this check the spread in run-helpers.ts
  // (`[...execResults]`) throws and aborts the run with an unhelpful error.
  // Mirror the `state` validation already done in `extractStateFromTab`.
  if (!Array.isArray(res.results)) {
    throw new Error("execute failed: content script returned no results array");
  }
  return res.results;
}

/**
 * Resolve when `tabId` reaches status="complete", or after `timeoutMs`.
 * Checks the current status first to avoid a race condition where the tab
 * finished loading before this function was called.
 */
export function waitForTabLoad(tabId: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        // Release the timer handle so it doesn't linger for up to `timeoutMs`
        // after resolution (finding: waitForTabLoad setTimeout is never cleared).
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
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
  const tabs = await listTabs();
  switch (action.type) {
    case "switch_tab": {
      const tab = tabs.find((t) => t.id === action.tab_id);
      if (!tab) return { handled: false, pageChanged: false, success: false, message: `tab ${action.tab_id} not found` };
      await chrome.tabs.update(tab.id, { active: true });
      await waitForTabLoad(tab.id, 3000);
      runState.currentTabId = tab.id;
      await saveRunState(runState);
      return { handled: true, pageChanged: true, success: true, message: `Switched to tab ${action.tab_id}` };
    }
    case "close_tab": {
      const tab = tabs.find((t) => t.id === action.tab_id);
      if (!tab) return { handled: false, pageChanged: false, success: false, message: `tab ${action.tab_id} not found` };
      await chrome.tabs.remove(tab.id);
      if (tab.id === runState.currentTabId) {
        const remaining = await listTabs();
        if (remaining[0]) {
          runState.currentTabId = remaining[0].id;
          await chrome.tabs.update(runState.currentTabId, { active: true });
          await saveRunState(runState);
        }
      }
      return { handled: true, pageChanged: true, success: true, message: `Closed tab ${action.tab_id}` };
    }
    case "navigate": {
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
        await saveRunState(runState);
        await waitForTabLoad(newTab.id!);
        await ensureContent(newTab.id!);
      } else {
        await chrome.tabs.update(runState.currentTabId, { url: action.url });
        await waitForTabLoad(runState.currentTabId);
        await ensureContent(runState.currentTabId);
      }
      return { handled: true, pageChanged: true, success: true, message: `navigated to ${action.url}` };
    }
    case "search": {
      const engine = (action as { engine?: string }).engine ?? "duckduckgo";
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
      const baseUrl = SEARCH_ENGINE_URLS[engine] || SEARCH_ENGINE_URLS.duckduckgo;
      const searchUrl = baseUrl + encodeURIComponent(query);
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
      await chrome.tabs.update(runState.currentTabId, { url: searchUrl });
      await waitForTabLoad(runState.currentTabId);
      await ensureContent(runState.currentTabId);
      return { handled: true, pageChanged: true, success: true, message: `Searching on ${engine}` };
    }
    default:
      return { handled: false, pageChanged: false, success: false, message: "" };
  }
}
