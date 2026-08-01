/**
 * background/tab-manager.ts — chrome.tabs queries, content-script injection,
 * tab-level action execution (switch/close/navigate/search).
 *
 * Low-level helpers (CDP debugger, screenshot quality, messaging, injection)
 * live in tab-manager-utils.ts and are re-exported here for backwards compat.
 */

import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import { SEARCH_ENGINE_URLS, getSearchEngineUrl } from "@/lib/agent/tools/constants";
import { substituteSecrets, redactSecrets } from "@/lib/agent/secrets";
import type { ActionResult, AgentAction, BrowserState, LogEvent, TabInfo } from "@/lib/agent/types";
import { getDomainConfig, saveRunState, type RunState } from "./state-store";
import {
  ensureContent,
  sendMessageWithTimeout,
  getScreenshotQuality,
  withPageDebugger,
  sendDebuggerCommandWithTimeout,
} from "./tab-manager-utils";

export {
  acquirePageDebugger,
  releasePageDebugger,
  withPageDebugger,
  getScreenshotQuality,
  sendMessageWithTimeout,
  getPageFingerprint,
  ensureContent,
} from "./tab-manager-utils";

/** Action types whose result payloads may embed untrusted page content and need redaction. */
const READ_ACTION_TYPES: ReadonlySet<string> = new Set([
  "extract",
  "find_elements",
  "dropdown_options",
  "find_text",
  "evaluate",
  "search_page",
]);

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

export async function extractStateFromTab(
  tabId: number,
  tabs: TabInfo[],
  includeScreenshot = true
): Promise<BrowserState> {
  await ensureContent(tabId);
  const res = await sendMessageWithTimeout<{ ok: boolean; error?: string; state?: BrowserState }>(
    tabId,
    { type: "EXTRACT_STATE", tabs },
  );
  if (!res?.ok) throw new Error(`extract failed: ${res?.error || "no response"}`);
  if (typeof res.state !== "object" || res.state === null) {
    throw new Error("extract failed: content script returned no state object");
  }
  if (includeScreenshot) {
    try {
      const screenshotFormat = await getScreenshotQuality();
      const dataUrl = await withPageDebugger(tabId, async () => {
        const result = await sendDebuggerCommandWithTimeout<{ data?: string }>(
          tabId,
          "Page.captureScreenshot",
          { format: "jpeg", quality: screenshotFormat, captureBeyondViewport: false },
        );
        if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
        return `data:image/jpeg;base64,${result.data}`;
      });
      res.state.screenshot = dataUrl;

      const elementRects = (res.state as { elementRects?: unknown }).elementRects;
      if (Array.isArray(elementRects) && elementRects.length > 0) {
        try {
          const {
            annotateScreenshot,
            DEFAULT_ANNOTATE_PALETTE,
          } = await import("@/lib/agent/dom/screenshot-annotator");
          const dpr = (res.state as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
          res.state.screenshot = await annotateScreenshot(dataUrl, elementRects as never, {
            scaleFactor: dpr,
            refPrefix: "e",
            boxColors: [...DEFAULT_ANNOTATE_PALETTE],
          });
        } catch {
          /* Annotation failed — keep the raw screenshot */
        }
      }
    } catch (e) {
      console.debug(
        "[tab-manager] screenshot capture failed, using DOM-only state:",
        e instanceof Error ? e.message : "",
      );
    }
  }
  return res.state;
}

export async function executeActionsInTab(
  tabId: number,
  actions: AgentAction[]
): Promise<unknown> {
  await ensureContent(tabId);

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
      secretsResolved: true,
    },
  );
  if (!res?.ok) throw new Error(`execute failed: ${res?.error || "no response"}`);
  if (!Array.isArray(res.results)) {
    throw new Error("execute failed: content script returned no results array");
  }
  const results = res.results as ActionResult[];

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
      if (READ_ACTION_TYPES.has(orig.type)) {
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
        if (typeof r.message === "string") {
          patch.message = await redactSecrets(r.message);
        }
        return { ...r, ...patch };
      }
      return r;
    }),
  );
}

export function waitForTabLoad(tabId: number, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
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

interface TabActionResult {
  handled: boolean;
  pageChanged: boolean;
  success: boolean;
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
          await chrome.tabs.update(remaining[0].id!, { active: true });
          runState.currentTabId = remaining[0].id!;
          await saveRunState({ currentTabId: remaining[0].id! });
        } else {
          runState.currentTabId = 0;
          await saveRunState({ currentTabId: 0 });
        }
      }
      return { handled: true, pageChanged: true, success: true, message: `Closed tab ${action.tab_id}` };
    }
    case "navigate": {
      if (!/^https?:\/\//i.test(String(action.url ?? ""))) {
        return {
          handled: true,
          pageChanged: false,
          success: false,
          message: `BLOCKED: unsupported URL scheme in navigate: ${action.url}`,
        };
      }
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
      if (typeof query !== "string" || query.length === 0) {
        return { handled: true, pageChanged: false, success: false, message: "BLOCKED: missing query" };
      }
      const baseUrl = getSearchEngineUrl(resolvedEngine) ?? SEARCH_ENGINE_URLS.duckduckgo;
      const searchUrl = baseUrl + encodeURIComponent(query);
      if (!/^https?:\/\//i.test(searchUrl)) {
        return {
          handled: true,
          pageChanged: false,
          success: false,
          message: `BLOCKED: unsupported search URL scheme`,
        };
      }
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
