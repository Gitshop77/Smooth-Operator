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
import type { ActionContext } from "./types";

export async function handleNavigate(
  _ctx: ActionContext,
  action: Extract<Action, { type: "navigate" }>,
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
 // New-tab navigation needs chrome.tabs.create + currentTabId update —
 // delegate to the SW (which owns handleTabAction). The content script
 // survives new-tab opens (the current tab stays), so the TAB_ACTION
 // response can reach us.
  if (action.new_tab) {
    if (typeof chrome !== "undefined" && chrome.runtime?.id) {
      try {
        const res = (await chrome.runtime.sendMessage({ type: "TAB_ACTION", action })) as {
          ok: boolean;
          success?: boolean;
          message?: string;
          pageChanged?: boolean;
          error?: string;
        };
        if (!res?.ok) {
          return { action, success: false, message: `navigate failed: ${res?.error || "no response"}` };
        }
        return {
          action,
          success: !!res.success,
          message: res.message || "navigated (new tab)",
          pageChanged: !!res.pageChanged,
        };
      } catch (e) {
        return { action, success: false, message: `navigate failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
 // No extension context (demo) — fall back to window.open. The popup may be
 // blocked, but the delegate still happened; report success.
    window.open(action.url, "_blank");
    return { action, success: true, message: "navigated via content script (new tab)", pageChanged: true };
  }
 // Same-tab navigation — location.href works. The content script is
 // destroyed on navigation, so the EXECUTE_ACTIONS sendResponse to the SW
 // will reject (port closed); the orchestrator recovers on the next step
 // (extractState re-injects via ensureContent).
  location.href = action.url;
  return { action, success: true, message: "navigated via content script", pageChanged: true };
}
