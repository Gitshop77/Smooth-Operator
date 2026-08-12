/** `navigate` action handler — gated by the domain allowlist/blocklist.
 *
 * Same-tab navigation uses `location.href` (the content script can do this
 * directly). New-tab navigation needs `chrome.tabs.create` + a
 * `runState.currentTabId` update (so the agent follows into the new tab),
 * which only the service worker can do — so `new_tab: true` delegates to the
 * SW via the `TAB_ACTION` message. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { checkUrlAllowedWithDomainConfig } from "../helpers/domain-config";
import { SW_RPC_TIMEOUT_MS } from "../constants";
import { type ActionContext, type LoaderRunner, isExtensionContext } from "./types";
import { rejectOnAbort } from "./abort";
import type { LoaderRunResult } from "../../dom/navigation/url-loaders";

/** Response shape the SW's `TAB_ACTION` handler returns for a new-tab navigate. */
type TabActionResult = {
  ok: boolean;
  success?: boolean;
  message?: string;
  pageChanged?: boolean;
  error?: string;
};

export async function handleNavigate(
  ctx: ActionContext,
  action: Extract<Action, { type: "navigate" }>,
  runLoaderSteps?: LoaderRunner,
): Promise<ActionResult> {
  // Enforce domain restrictions before navigating.
  const urlCheck = checkUrlAllowedWithDomainConfig(action.url);
  if (!urlCheck.allowed) {
    return {
      action,
      success: false,
      message: `BLOCKED: ${urlCheck.reason} (${action.url})`,
    };
  }
  // URL loaders: after a SUCCESSFUL navigation, run the loader steps
  // matching the destination URL. The runner is wired by the executor
  // (loader-originated navigations carry `ctx.fromLoader` and skip the hook,
  // so a loader never re-triggers itself). Note that loader steps execute in
  // the content-script window right after navigation commits — for
  // cross-document navigations that window is the old document being torn
  // down, so the steps are best used for quick same-document work; running
  // them against the freshly-loaded page requires the agent-loop integration
  // (future wave, see CONCERNS).
  const loaderHook = async (message: string): Promise<string> => {
    if (ctx.fromLoader || !runLoaderSteps) return message;
    try {
      const report: LoaderRunResult = await runLoaderSteps(action.url);
      return report.matched ? `${message} [${report.message}]` : message;
    } catch {
      // The navigation itself succeeded — don't fail the action because the
      // loader hook errored; the engine reports its own failures in-message.
      return message;
    }
  };
  // New-tab navigation needs chrome.tabs.create + currentTabId update —
  // delegate to the SW (which owns handleTabAction). The content script
  // survives new-tab opens (the current tab stays), so the TAB_ACTION
  // response can reach us.
  if (action.new_tab) {
    if (isExtensionContext()) {
      try {
        // Race against a timeout AND the step's abort signal so a user STOP
        // is honored mid-step instead of waiting out the full 15s timeout (a
        // SW that receives the message but never calls sendResponse — throws /
        // is hung — can't block the agent loop forever, and neither can a
        // stuck navigation while the user cancelled).
        let t: ReturnType<typeof setTimeout> | undefined;
        let res: TabActionResult | undefined | null;
        const abort = rejectOnAbort(ctx.signal);
        try {
          res = (await Promise.race([
            chrome.runtime.sendMessage({ type: "TAB_ACTION", action, ...(ctx.dispatchToken ? { token: ctx.dispatchToken } : {}), ...(ctx.effectCapability ? { effectCapability: ctx.effectCapability } : {}) }),
            new Promise<never>((_, reject) => {
              t = setTimeout(() => reject(new Error("TAB_ACTION timeout")), SW_RPC_TIMEOUT_MS);
            }),
            abort.promise,
          ])) as TabActionResult;
        } finally {
          if (t) clearTimeout(t);
          abort.cleanup();
        }
        if (!res?.ok) {
          return { action, success: false, message: `navigate failed: ${res?.error || "no response"}` };
        }
        return {
          action,
          success: !!res.success,
          message: await loaderHook(res.message || "navigated (new tab)"),
          pageChanged: !!res.pageChanged,
        };
      } catch (e) {
        return { action, success: false, message: `navigate failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    // No extension context (demo) — fall back to window.open. If the popup is
    // blocked by the browser, window.open returns null and no navigation occurs;
    // report that honestly instead of a false success (which could make the agent
    // loop proceed against a stale page).
    const w = window.open(action.url, "_blank");
    if (!w) {
      return { action, success: false, message: "navigate failed: popup blocked (demo)" };
    }
    return { action, success: true, message: await loaderHook("navigated via content script (new tab)"), pageChanged: true };
  }
  // Same-tab navigation — location.href works. The content script is
  // destroyed on navigation, so the EXECUTE_ACTIONS sendResponse to the SW
  // will reject (port closed); the orchestrator recovers on the next step
  // (extractState re-injects via ensureContent).
  location.href = action.url;
  return { action, success: true, message: await loaderHook("navigated via content script"), pageChanged: true };
}
