import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import { SEARCH_ENGINE_URLS, getSearchEngineUrl, tryExpandSearchMacro } from "@/lib/agent/tools/constants";
import type { AgentAction, LogEvent, TabInfo } from "@/lib/agent/types";
import { runResearch, ResearchError } from "./lightpanda/research-service";
import type { RunState } from "./state-store";
import type { RunDispatchToken } from "./run-controller";
import type { RunSessionStateService } from "./run-session-state";
import {
  ensureContent,
  throwIfAborted,
  withPageDebugger,
} from "./tab-manager-utils";

export interface TabActionServiceDependencies {
  listTabs(): Promise<TabInfo[]>;
  waitForTabLoad(tabId: number, timeoutMs?: number, signal?: AbortSignal): Promise<void>;
  sessionState: Pick<RunSessionStateService, "patch">;
}

export interface TabActionResult {
  handled: boolean;
  pageChanged: boolean;
  success: boolean;
  message: string;
  /** Optional structured payload (tab listings, cookies, storage reads). */
  data?: unknown;
}

export interface TabActionService {
  handleTabAction(
    action: AgentAction,
    runState: RunState,
    notify?: (event: LogEvent) => void,
    signal?: AbortSignal,
    isAuthorized?: () => boolean,
    token?: Pick<RunDispatchToken, "runId">,
  ): Promise<TabActionResult>;
}

export function createTabActionService(
  dependencies: TabActionServiceDependencies,
): TabActionService {
  const { listTabs, waitForTabLoad } = dependencies;

  async function handleTabAction(
    action: AgentAction,
    runState: RunState,
    notify?: (event: LogEvent) => void,
    signal?: AbortSignal,
    isAuthorized?: () => boolean,
    token?: Pick<RunDispatchToken, "runId">,
  ): Promise<TabActionResult> {
    const assertAuthorized = (): void => {
      throwIfAborted(signal);
      if (isAuthorized && !isAuthorized()) {
        throw new DOMException("Run dispatch authority expired", "AbortError");
      }
    };
    const patchCurrentTab = async (currentTabId: number): Promise<void> => {
      if (!token) throw new DOMException("Run state authority expired", "AbortError");
      await dependencies.sessionState.patch(token, { currentTabId });
      assertAuthorized();
      runState.currentTabId = currentTabId;
    };
    try {
      assertAuthorized();
      switch (action.type) {
      case "switch_tab": {
        const tabs = await listTabs();
        assertAuthorized();
        const tab = tabs.find((t) => t.id === action.tab_id);
        if (!tab) return { handled: false, pageChanged: false, success: false, message: `tab ${action.tab_id} not found` };
        await chrome.tabs.update(tab.id, { active: true });
        await waitForTabLoad(tab.id, 3000, signal);
        assertAuthorized();
        await patchCurrentTab(tab.id);
        return { handled: true, pageChanged: true, success: true, message: `Switched to tab ${action.tab_id}` };
      }
      case "close_tab": {
        const tabs = await listTabs();
        assertAuthorized();
        const tab = tabs.find((t) => t.id === action.tab_id);
        if (!tab) return { handled: false, pageChanged: false, success: false, message: `tab ${action.tab_id} not found` };
        await chrome.tabs.remove(tab.id);
        assertAuthorized();
        if (tab.id === runState.currentTabId) {
          const remaining = await listTabs();
          assertAuthorized();
          // Prefer Chrome's own last-active choice after the close (respecting
          // the `active` flag semantics); fall back to the first remaining tab
          // and only force-activate when Chrome did not already pick one.
          const nextActive = remaining.find((t) => t.active) ?? remaining[0];
          if (nextActive) {
            if (!nextActive.active) {
              await chrome.tabs.update(nextActive.id!, { active: true });
              assertAuthorized();
            }
            await patchCurrentTab(nextActive.id!);
          } else {
            await patchCurrentTab(0);
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
          assertAuthorized();
          const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
          assertAuthorized();
          await patchCurrentTab(newTab.id!);
          await waitForTabLoad(newTab.id!, 8_000, signal);
          assertAuthorized();
          await ensureContent(newTab.id!, signal);
          assertAuthorized();
        } else {
          if (!runState.currentTabId) {
            return { handled: true, pageChanged: false, success: false, message: "BLOCKED: no active tab — set new_tab:true to open one" };
          }
          assertAuthorized();
          await chrome.tabs.update(runState.currentTabId, { url: targetUrl });
          assertAuthorized();
          await waitForTabLoad(runState.currentTabId, 8_000, signal);
          assertAuthorized();
          await ensureContent(runState.currentTabId, signal);
          assertAuthorized();
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
        assertAuthorized();
        await chrome.tabs.update(runState.currentTabId, { url: searchUrl });
        assertAuthorized();
        await waitForTabLoad(runState.currentTabId, 8_000, signal);
        assertAuthorized();
        await ensureContent(runState.currentTabId, signal);
        assertAuthorized();
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
        assertAuthorized();
        await withPageDebugger(runState.currentTabId, () => cdpTypeText(runState.currentTabId, text, { signal }));
        assertAuthorized();
        return {
          handled: true,
          pageChanged: false,
          success: true,
          message: `typed ${Array.from(text).length} chars via CDP`,
        };
      }
      case "list_tabs": {
        const tabs = await listTabs();
        assertAuthorized();
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
        assertAuthorized();
        return {
          handled: true,
          pageChanged: false,
          success: true,
          message: `read ${cookies.length} cookies`,
          data: {
            // Cookie VALUES are session credentials and must never enter the
            // model transcript (agent history + any downstream surface).
            cookies: cookies.map((c) => ({
              name: c.name,
              value: "[REDACTED]",
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
        assertAuthorized();
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
        assertAuthorized();
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
        assertAuthorized();
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
        // Removal keys are URL-based; reconstruct from each cookie's own fields
        // (secure → https, host-only domain, its path). Deletions are
        // independent IPC round-trips — parallelize after the domain-config
        // gates above already authorized the whole set.
        await Promise.allSettled(
          all.map((cookie) => {
            assertAuthorized();
            return chrome.cookies.remove({
              url: `http${cookie.secure ? "s" : ""}://${cookie.domain.replace(/^\./, "")}${cookie.path}`,
              name: cookie.name,
            });
          }),
        );
        assertAuthorized();
        return { handled: true, pageChanged: false, success: true, message: `deleted ${all.length} cookies`, data: { deleted: all.length } };
      }
      case "get_storage":
      case "set_storage":
      case "clear_storage": {
        const storageType = (action as { storage_type?: string }).storage_type === "session" ? "session" : "local";
        const area = storageType === "session" ? chrome.storage.session : chrome.storage.local;
        if (action.type === "get_storage") {
          const items = await area.get(null);
          assertAuthorized();
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
          assertAuthorized();
          await area.set({ [key]: serializable });
          assertAuthorized();
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
            assertAuthorized();
            await area.clear();
            assertAuthorized();
            return { handled: true, pageChanged: false, success: true, message: `cleared storage (${storageType})`, data: { cleared: storageType } };
          }
          assertAuthorized();
          await area.remove(keys!);
          assertAuthorized();
          return { handled: true, pageChanged: false, success: true, message: `cleared ${keys!.length} keys (${storageType})`, data: { removed: keys!.length, type: storageType } };
        }
        throw new Error("unreachable: storage action type");
      }
      case "research": {
        try {
          const result = await runResearch(action.query, { signal });
          return {
            handled: true,
            pageChanged: false,
            success: true,
            message: `Research complete${result.timedOut ? " (timed out)" : ""}`,
            data: {
              answer: result.answer,
              tokensIn: result.usage?.tokensIn ?? 0,
              tokensOut: result.usage?.tokensOut ?? 0,
            },
          };
        } catch (e) {
          // Realm-agnostic AbortError check (name-based) — rethrow so the loop
          // cancels instead of treating the abort as an action failure.
          if (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError") throw e;
          const message = e instanceof ResearchError ? e.message : `research failed: ${e instanceof Error ? e.message : String(e)}`;
          notify?.({ type: "error", step: runState.step, message, recoverable: false });
          return { handled: true, pageChanged: false, success: false, message };
        }
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


  return { handleTabAction };
}
