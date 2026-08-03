/**
 * background/tab-manager.ts — chrome.tabs queries, content-script injection,
 * tab-level action execution (switch/close/navigate/search).
 *
 * Low-level helpers (CDP debugger, screenshot quality, messaging, injection)
 * live in tab-manager-utils.ts and are re-exported here for backwards compat.
 */

import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import { SEARCH_ENGINE_URLS, getSearchEngineUrl, tryExpandSearchMacro } from "@/lib/agent/tools/constants";
import { substituteSecrets, redactSecrets } from "@/lib/agent/secrets";
import type { ActionResult, AgentAction, BrowserState, LogEvent, TabInfo } from "@/lib/agent/types";
import type { AgentMode } from "@/lib/agent/modes";
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
  actions: AgentAction[],
  agentMode?: AgentMode
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
      agentMode,
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
        r.success === true &&
        inputResolvedText.has(i) &&
        (orig.text ?? "") !== inputResolvedText.get(i)
      ) {
        // Patch the message only on SUCCESS: a failed input action must keep
        // its honest error message — claiming "Typed …" over a failure is
        // misleading to the user and to the loop's outcome tracking.
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
  /** Optional structured payload (tab listings, cookies, storage reads). */
  data?: unknown;
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
      const targetUrl = tryExpandSearchMacro(String(action.url ?? ""))?.url ?? String(action.url ?? "");
      if (!/^https?:\/\//i.test(targetUrl)) {
        return {
          handled: true,
          pageChanged: false,
          success: false,
          message: `BLOCKED: unsupported URL scheme in navigate: ${targetUrl}`,
        };
      }
      const urlCheck = checkUrlAllowedWithDomainConfig(targetUrl);
      if (!urlCheck.allowed) {
        notify?.({
          type: "error",
          step: runState.step,
          message: `BLOCKED navigation: ${urlCheck.reason} (${targetUrl})`,
          recoverable: false,
        });
        return { handled: true, pageChanged: false, success: false, message: `BLOCKED: ${urlCheck.reason} (${targetUrl})` };
      }
      if (action.new_tab) {
        const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
        runState.currentTabId = newTab.id!;
        await saveRunState({ currentTabId: newTab.id! });
        await waitForTabLoad(newTab.id!);
        await ensureContent(newTab.id!);
      } else {
        if (!runState.currentTabId) {
          return { handled: true, pageChanged: false, success: false, message: "BLOCKED: no active tab — set new_tab:true to open one" };
        }
        await chrome.tabs.update(runState.currentTabId, { url: targetUrl });
        await waitForTabLoad(runState.currentTabId);
        await ensureContent(runState.currentTabId);
      }
      return { handled: true, pageChanged: true, success: true, message: `navigated to ${targetUrl}` };
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
      const macro = tryExpandSearchMacro(query);
      const searchUrl = macro?.url ??
        (getSearchEngineUrl(resolvedEngine) ?? SEARCH_ENGINE_URLS.duckduckgo) + encodeURIComponent(query);
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
      const label = macro?.name ?? resolvedEngine;
      return { handled: true, pageChanged: true, success: true, message: `Searching on ${label}` };
    }
    case "input": {
      // Only humanized typing is routed through the SW: plain input is owned
      // by the content script's instant value-set path. Humanized input needs
      // the CDP debugger attached, which only the SW can do.
      const humanized = (action as { humanized?: boolean }).humanized;
      if (humanized !== true) return { handled: false, pageChanged: false, success: false, message: "" };
      const text = (action as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) {
        return { handled: true, pageChanged: false, success: false, message: "BLOCKED: missing text" };
      }
      if (!runState.currentTabId) {
        return { handled: true, pageChanged: false, success: false, message: "BLOCKED: no active tab" };
      }
      const { cdpTypeText } = await import("@/lib/agent/cdp-controller");
      await withPageDebugger(runState.currentTabId, () => cdpTypeText(runState.currentTabId, text));
      return {
        handled: true,
        pageChanged: false,
        success: true,
        message: `typed ${Array.from(text).length} chars via CDP`,
      };
    }
    case "list_tabs": {
      const tabs = await listTabs();
      return {
        handled: true,
        pageChanged: false,
        success: true,
        message: `listed ${tabs.length} tabs`,
        data: {
          tabs: tabs.map((t) => ({ index: t.id, url: t.url, active: t.active })),
          count: tabs.length,
        },
      };
    }
    case "get_cookies": {
      const urls = (action as { urls?: unknown }).urls;
      const urlList = Array.isArray(urls)
        ? urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
        : undefined;
      const cookies = urlList && urlList.length > 0
        ? (await Promise.all(urlList.map((url) => chrome.cookies.getAll({ url })))).flat()
        : await chrome.cookies.getAll({});
      return {
        handled: true,
        pageChanged: false,
        success: true,
        message: `read ${cookies.length} cookies`,
        data: {
          cookies: cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expirationDate: c.expirationDate,
            session: c.session,
            hostOnly: c.hostOnly,
          })),
          count: cookies.length,
        },
      };
    }
    case "set_cookie": {
      const sc = action as {
        url?: string;
        domain?: string;
        name?: string;
        value?: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
        sameSite?: string;
        expirationDate?: number;
      };
      if (!sc.url && !sc.domain) {
        return { handled: true, pageChanged: false, success: false, message: "BLOCKED: set_cookie requires url or domain" };
      }
      // The effective URL is the cookie's write target — gate it exactly like
      // navigate/search so a disallowed host can never be written to.
      const gateUrl = sc.url ?? `https://${sc.domain!.replace(/^\./, "")}`;
      const urlCheck = checkUrlAllowedWithDomainConfig(gateUrl);
      if (!urlCheck.allowed) {
        notify?.({
          type: "error",
          step: runState.step,
          message: `BLOCKED cookie write: ${urlCheck.reason} (${gateUrl})`,
          recoverable: false,
        });
        return { handled: true, pageChanged: false, success: false, message: `BLOCKED: ${urlCheck.reason} (${gateUrl})` };
      }
      await chrome.cookies.set({
        url: gateUrl,
        name: sc.name ?? "",
        value: sc.value ?? "",
        domain: sc.domain,
        path: sc.path,
        secure: sc.secure,
        httpOnly: sc.httpOnly,
        sameSite: sc.sameSite as chrome.cookies.SameSiteStatus,
        expirationDate: sc.expirationDate,
      });
      return { handled: true, pageChanged: false, success: true, message: `set cookie ${sc.name}`, data: { set: sc.name } };
    }
    case "delete_cookies": {
      const dc = action as { urls?: unknown; all?: unknown };
      const explicitAll = dc.all === true;
      const urlList = Array.isArray(dc.urls)
        ? dc.urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
        : undefined;
      const hasUrls = !!urlList && urlList.length > 0;
      // Deleting every cookie is destructive: require the explicit all:true
      // opt-in. A bare delete_cookies (or an empty urls list) must never wipe
      // the whole jar — the schema refine is the first gate, this is the
      // second (defense in depth against a malformed/forged message).
      if (!explicitAll && !hasUrls) {
        return {
          handled: true,
          pageChanged: false,
          success: false,
          message: "BLOCKED: delete_cookies requires at least one url or explicit all:true",
        };
      }
      // Same domain gate as set_cookie: a cookie can only be deleted for a
      // host the domain policy allows. Every URL is checked so a mixed list
      // fails closed on the first disallowed host.
      if (!explicitAll && hasUrls) {
        for (const url of urlList!) {
          const urlCheck = checkUrlAllowedWithDomainConfig(url);
          if (!urlCheck.allowed) {
            notify?.({
              type: "error",
              step: runState.step,
              message: `BLOCKED cookie delete: ${urlCheck.reason} (${url})`,
              recoverable: false,
            });
            return { handled: true, pageChanged: false, success: false, message: `BLOCKED: ${urlCheck.reason} (${url})` };
          }
        }
      }
      const all = explicitAll
        ? await chrome.cookies.getAll({})
        : (await Promise.all(urlList!.map((url) => chrome.cookies.getAll({ url })))).flat();
      // The all:true wipe enumerates the ENTIRE cookie jar — a domain-agnostic
      // deletion. It must go through the same domain gate as the urls path
      // (and set_cookie): a cookie whose domain the policy disallows aborts the
      // whole wipe. Fail closed BEFORE any removal so a blocked host in the jar
      // cannot be wiped by routing through all:true instead of a url list.
      if (explicitAll) {
        for (const c of all) {
          const url = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
          const urlCheck = checkUrlAllowedWithDomainConfig(url);
          if (!urlCheck.allowed) {
            notify?.({
              type: "error",
              step: runState.step,
              message: `BLOCKED cookie delete: ${urlCheck.reason} (${url})`,
              recoverable: false,
            });
            return { handled: true, pageChanged: false, success: false, message: `BLOCKED: ${urlCheck.reason} (${url})` };
          }
        }
      }
      for (const c of all) {
        // Removal keys are URL-based; reconstruct from the cookie's own fields
        // (secure → https, host-only domain, its path).
        const url = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
        await chrome.cookies.remove({ url, name: c.name });
      }
      return { handled: true, pageChanged: false, success: true, message: `deleted ${all.length} cookies`, data: { deleted: all.length } };
    }
    case "get_storage":
    case "set_storage":
    case "clear_storage": {
      const storageType = (action as { storage_type?: string }).storage_type === "session" ? "session" : "local";
      const area = storageType === "session" ? chrome.storage.session : chrome.storage.local;
      if (action.type === "get_storage") {
        const items = await area.get(null);
        return { handled: true, pageChanged: false, success: true, message: `read storage (${storageType})`, data: { items, type: storageType } };
      }
      if (action.type === "set_storage") {
        const key = (action as { key?: unknown }).key;
        const value = (action as { value?: unknown }).value;
        if (typeof key !== "string" || key.length === 0) {
          return { handled: true, pageChanged: false, success: false, message: "BLOCKED: set_storage requires a key" };
        }
        // JSON round-trip: the stored value must survive serialization, and
        // what's stored is exactly what a later get_storage returns.
        let serializable: unknown;
        try {
          serializable = JSON.parse(JSON.stringify(value));
        } catch {
          return { handled: true, pageChanged: false, success: false, message: "BLOCKED: set_storage value is not JSON-serializable" };
        }
        await area.set({ [key]: serializable });
        return { handled: true, pageChanged: false, success: true, message: `set storage ${key} (${storageType})`, data: { set: key, type: storageType } };
      }
      if (action.type === "clear_storage") {
        const cs = action as { keys?: unknown; all?: unknown };
        const explicitAll = cs.all === true;
        const keys = Array.isArray(cs.keys)
          ? cs.keys.filter((k): k is string => typeof k === "string" && k.length > 0)
          : undefined;
        const hasKeys = !!keys && keys.length > 0;
        // A whole-area wipe destroys API keys / settings / the domain config:
        // require explicit all:true OR a concrete keys list — never infer a
        // wipe from an empty/absent keys list (schema refine + this guard).
        if (!explicitAll && !hasKeys) {
          return {
            handled: true,
            pageChanged: false,
            success: false,
            message: "BLOCKED: clear_storage requires at least one key or explicit all:true",
          };
        }
        if (explicitAll) {
          await area.clear();
          return { handled: true, pageChanged: false, success: true, message: `cleared storage (${storageType})`, data: { cleared: storageType } };
        }
        await area.remove(keys!);
        return { handled: true, pageChanged: false, success: true, message: `cleared ${keys!.length} keys (${storageType})`, data: { removed: keys!.length, type: storageType } };
      }
      throw new Error("unreachable: storage action type");
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
