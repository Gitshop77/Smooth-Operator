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

import { z } from "zod";
import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { type ActionContext, isExtensionContext } from "./types";
import { rejectOnAbort } from "./abort";

/**
 * Shape the background SW returns for a `TAB_ACTION` message. Validated rather
 * than cast so a contract drift between the content script and the SW is
 * caught explicitly instead of silently defaulting to "no response" /
 * "failed".
 */
const tabActionResponseSchema = z.object({
  ok: z.boolean(),
  success: z.boolean().optional(),
  message: z.string().optional(),
  pageChanged: z.boolean().optional(),
  error: z.string().optional(),
});

/** Give up on an unresponsive SW handler rather than hanging the agent loop. */
const TAB_ACTION_TIMEOUT_MS = 30_000;

/** Build a structured failure result, prefixing the action type. */
function fail(action: Action, msg: string): ActionResult {
  return { action, success: false, message: `${action.type} failed: ${msg}` };
}

/** Delegate a tab-level action to the SW's `handleTabAction` via TAB_ACTION. */
async function delegateTabAction(
  action: Extract<Action, { type: "switch_tab" | "close_tab" }>,
  signal?: AbortSignal,
): Promise<ActionResult> {
  if (!isExtensionContext()) {
    return {
      action,
      success: false,
      message: `${action.type} is not supported in the current mode (no extension tab API)`,
    };
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race the SW call against the timeout AND the step's abort signal so a user
    // STOP is honored mid-step instead of waiting out the full 30s timeout.
    const abort = rejectOnAbort(signal);
    let raw: unknown;
    try {
      raw = await Promise.race([
        chrome.runtime.sendMessage({ type: "TAB_ACTION", action }).finally(() =>
          clearTimeout(timer),
        ),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), TAB_ACTION_TIMEOUT_MS);
        }),
        abort.promise,
      ]);
    } finally {
      // Always clear the 30s fallback timer. When the abort signal wins the
      // race, the sendMessage promise is still pending so its `.finally` (which
      // also clears the timer) has not run — without this the timer leaks until
      // TAB_ACTION_TIMEOUT_MS elapses.
      clearTimeout(timer);
      abort.cleanup();
    }
    // `chrome.runtime.sendMessage` resolves `undefined` (not a rejection) when
    // there is no listener; the timeout above also resolves `undefined`, so
    // distinguish a missing/unresponsive handler from a malformed payload.
    if (typeof raw === "undefined") {
      return fail(action, "no response from extension (timeout or unreachable service worker)");
    }
    const parsed = tabActionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return fail(action, `invalid response from extension (${parsed.error.message})`);
    }
    const res = parsed.data;
    if (!res.ok) {
      // Prefer `message` (a descriptive status the SW may set on failure) then
      // `error`, then a concrete fallback — so a bare `{ ok: false }` no longer
      // degrades to the uninformative "no response".
      return fail(action, res.message ?? res.error ?? "unknown error");
    }
    return {
      action,
      success: res.success ?? res.ok,
      message:
        res.message ??
        `${action.type} ${res.success ?? res.ok ? "ok" : "failed"}`,
      pageChanged: !!res.pageChanged,
    };
  } catch (e) {
    return fail(action, e instanceof Error ? e.message : String(e));
  }
}

export async function handleSwitchTab(
  ctx: ActionContext,
  action: Extract<Action, { type: "switch_tab" }>,
): Promise<ActionResult> {
  return delegateTabAction(action, ctx.signal);
}

export async function handleCloseTab(
  ctx: ActionContext,
  action: Extract<Action, { type: "close_tab" }>,
): Promise<ActionResult> {
  return delegateTabAction(action, ctx.signal);
}
