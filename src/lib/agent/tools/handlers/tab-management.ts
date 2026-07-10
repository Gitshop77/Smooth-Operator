/**
 * `switch_tab` + `close_tab` action handlers — both need the `chrome.tabs`
 * API, which is only available in the service worker. The content script
 * delegates these to the SW via the `TAB_ACTION` message (which calls
 * `handleTabAction` — owning the chrome.tabs.update/remove + currentTabId
 * update).
 *
 * Without an extension context (in-page demo / tests) the actions can't
 * switch or close tabs, so we return an HONEST failure rather than claiming
 * success with no underlying effect.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";

/** Delegate a tab-level action to the SW's `handleTabAction` via TAB_ACTION. */
async function delegateTabAction(
  action: Extract<Action, { type: "switch_tab" | "close_tab" }>,
): Promise<ActionResult> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    return {
      action,
      success: false,
      message: `${action.type} is not supported in the current mode (no extension tab API)`,
    };
  }
  try {
    const res = (await chrome.runtime.sendMessage({ type: "TAB_ACTION", action })) as {
      ok: boolean;
      success?: boolean;
      message?: string;
      pageChanged?: boolean;
      error?: string;
    };
    if (!res?.ok) {
      return { action, success: false, message: `${action.type} failed: ${res?.error || "no response"}` };
    }
    return {
      action,
      success: !!res.success,
      message: res.message || `${action.type} ${res.success ? "ok" : "failed"}`,
      pageChanged: !!res.pageChanged,
    };
  } catch (e) {
    return { action, success: false, message: `${action.type} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function handleSwitchTab(
  _ctx: ActionContext,
  action: Extract<Action, { type: "switch_tab" }>,
): Promise<ActionResult> {
  return delegateTabAction(action);
}

export async function handleCloseTab(
  _ctx: ActionContext,
  action: Extract<Action, { type: "close_tab" }>,
): Promise<ActionResult> {
  return delegateTabAction(action);
}
