/**
 * Cookie action handlers — get/set/delete cookies.
 *
 * chrome.cookies only exists in the service worker, so the content script
 * delegates these to the SW via the TAB_ACTION message. The SW enforces the
 * domain allow/blocklist on set_cookie's effective URL, so a cookie can never
 * be written to a disallowed host regardless of what the LLM emits.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { delegateTabAction } from "./tab-management";

export async function handleGetCookies(
  ctx: ActionContext,
  action: Extract<Action, { type: "get_cookies" }>,
): Promise<ActionResult> {
  return delegateTabAction(action, ctx.signal, ctx.dispatchToken, ctx.effectCapability);
}

export async function handleSetCookie(
  ctx: ActionContext,
  action: Extract<Action, { type: "set_cookie" }>,
): Promise<ActionResult> {
  return delegateTabAction(action, ctx.signal, ctx.dispatchToken, ctx.effectCapability);
}

export async function handleDeleteCookies(
  ctx: ActionContext,
  action: Extract<Action, { type: "delete_cookies" }>,
): Promise<ActionResult> {
  return delegateTabAction(action, ctx.signal, ctx.dispatchToken, ctx.effectCapability);
}
