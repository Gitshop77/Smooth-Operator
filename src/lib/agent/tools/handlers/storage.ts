/**
 * Storage action handlers — get/set/clear the extension's key/value storage.
 *
 * chrome.storage is reachable from the content script, but keeping the
 * handlers aligned with the other tab-level actions (single TAB_ACTION
 * delegation path, SW-side policy enforcement, consistent response schema)
 * avoids a second execution surface and keeps storage reads/writes out of
 * page-visible state.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import type { ActionContext } from "./types";
import { delegateTabAction } from "./tab-management";

export async function handleGetStorage(
  ctx: ActionContext,
  action: Extract<Action, { type: "get_storage" }>,
): Promise<ActionResult> {
  return delegateTabAction(action, ctx.signal);
}

export async function handleSetStorage(
  ctx: ActionContext,
  action: Extract<Action, { type: "set_storage" }>,
): Promise<ActionResult> {
  return delegateTabAction(action, ctx.signal);
}

export async function handleClearStorage(
  ctx: ActionContext,
  action: Extract<Action, { type: "clear_storage" }>,
): Promise<ActionResult> {
  return delegateTabAction(action, ctx.signal);
}
