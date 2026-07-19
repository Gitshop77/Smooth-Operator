/**
 * Action executor — takes a validated {@link AgentAction} and performs it on
 * the page. Returns an {@link ActionResult} that's surfaced in the agent
 * history and shown to the user.
 *
 * Tab-level actions (`navigate`, `switch_tab`, `close_tab`, `search`) need
 * `chrome.tabs` API access, which is only available in the extension's
 * background/service worker — not in the content-script context where this
 * dispatcher runs. The *handlers* for those actions (`./handlers/navigate.ts`,
 * `./handlers/tab-management.ts`) delegate by sending
 * `chrome.runtime.sendMessage({ type: "TAB_ACTION", action })` to the service
 * worker, which performs the real `chrome.tabs` work.
 *
 * Separately, the agent loop's action-queue layer
 * (`../loop/helpers/action-queue.ts`) *optionally* wraps `executeAction` and
 * offers an `onTabAction` hook that can intercept tab-level actions before they
 * reach the handlers. Note that `executeAction` itself receives **no hook** —
 * any tab delegation is done inside the handlers via message passing, or by the
 * action-queue layer above it.
 *
 * This module is now a thin dispatcher: the per-action logic lives in
 * `./handlers/*`, the shared helpers live in `./helpers/*`, the constants
 * live in `./constants.ts`, and the description string lives in
 * `./describe.ts`. The dispatcher:
 * 1. Captures `beforeUrl` + `beforeFingerprint` (used by click /
 * go_back / press_and_hold for page-change detection).
 * 2. Switches on `action.type` and delegates to the matching handler.
 * 3. Wraps handler dispatch in a try/catch that converts *runtime* handler
 * errors into `{ success: false, message: "..." }` results. The
 * exhaustiveness guard is a programming error and is re-thrown (see
 * {@link UnhandledActionError}) rather than downgraded to a soft failure.
 *
 * Public API (kept stable for backward compatibility):
 * - {@link executeAction} — the main entry point
 * - {@link describeAction} — re-exported from `./describe`
 */

import type { ActionResult, AgentAction, BrowserState } from "../types";

import { describeAction } from "./describe";
import { domFingerprint } from "./helpers";
import {
  handleAlertAccept,
  handleAlertDismiss,
  handleAlertGetText,
  handleAlertSendKeys,
  handleAskHuman,
  handleCloseTab,
  handleClick,
  handleDetectVisual,
  handleDone,
  handleDropdownOptions,
  handleEvaluate,
  handleExtract,
  handleFindElements,
  handleFindText,
  handleGoBack,
  handleHover,
  handleInput,
  handleLoadSkill,
  handleNavigate,
  handlePressAndHold,
  handleSaveAsPdf,
  handleScreenshot,
  handleScroll,
  handleSearch,
  handleSearchPage,
  handleSelectDropdown,
  handleSendKeys,
  handleSwitchTab,
  handleTakeover,
  handleUploadFile,
  handleVerify,
  handleWait,
  type ActionContext,
} from "./handlers";

export { describeAction };

/**
 * Thrown by the switch `default` branch when an {@link AgentAction} variant
 * reaches `executeAction` without a matching handler. This indicates a
 * programming error (a new action type added to the union but not cased here),
 * not a recoverable runtime failure of an otherwise-valid action. `executeAction`
 * therefore re-throws it instead of downgrading it to a soft `{ success: false }`
 * result, so the defect surfaces loudly rather than being silently swallowed.
 */
class UnhandledActionError extends Error {
  constructor(action: { type: string }) {
    super(`unhandled action type: ${action.type}`);
    this.name = "UnhandledActionError";
  }
}

/**
 * Execute a single content-script-level action.
 *
 * Tab-level actions (`navigate`, `switch_tab`, `close_tab`, `search`) are
 * dispatched to their handlers like any other action; those handlers
 * themselves delegate to the service worker via
 * `chrome.runtime.sendMessage({ type: "TAB_ACTION", action })`. This function
 * receives no `onTabAction` hook — any such interception happens in the
 * action-queue layer above it.
 *
 * @param action The validated action to execute.
 * @param state The current browser state (used to resolve `[index]` → element).
 * @returns An {@link ActionResult} describing what happened.
 */
export async function executeAction(
  action: AgentAction,
  state: BrowserState,
  signal?: AbortSignal,
): Promise<ActionResult> {
  try {
 // Capture before-state once at the top — used by the click, go_back,
 // and press_and_hold handlers for page-change detection.
    const ctx: ActionContext = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: domFingerprint(),
      signal,
    };

    switch (action.type) {
      case "click":           return await handleClick(ctx, action);
      case "input":           return await handleInput(ctx, action);
      case "select_dropdown": return await handleSelectDropdown(ctx, action);
      case "scroll":          return await handleScroll(ctx, action);
      case "send_keys":       return await handleSendKeys(ctx, action);
      case "navigate":        return await handleNavigate(ctx, action);
      case "switch_tab":      return await handleSwitchTab(ctx, action);
      case "close_tab":       return await handleCloseTab(ctx, action);
      case "go_back":         return await handleGoBack(ctx, action);
      case "wait":            return await handleWait(ctx, action);
      case "find_text":       return await handleFindText(ctx, action);
      case "extract":         return await handleExtract(ctx, action);
      case "search":          return await handleSearch(ctx, action);
      case "upload_file":     return await handleUploadFile(ctx, action);
      case "screenshot":      return await handleScreenshot(ctx, action);
      case "save_as_pdf":     return await handleSaveAsPdf(ctx, action);
      case "dropdown_options":return await handleDropdownOptions(ctx, action);
      case "search_page":     return await handleSearchPage(ctx, action);
      case "find_elements":   return await handleFindElements(ctx, action);
      case "evaluate":        return await handleEvaluate(ctx, action);
      case "hover":           return await handleHover(ctx, action);
      case "press_and_hold":  return await handlePressAndHold(ctx, action);
      case "ask_human":       return await handleAskHuman(ctx, action);
      case "takeover":        return await handleTakeover(ctx, action);
      case "verify":          return await handleVerify(ctx, action);
      case "load_skill":      return await handleLoadSkill(ctx, action);
      case "alert_accept":    return await handleAlertAccept(ctx, action);
      case "alert_dismiss":   return await handleAlertDismiss(ctx, action);
      case "alert_get_text":  return await handleAlertGetText(ctx, action);
      case "alert_send_keys": return await handleAlertSendKeys(ctx, action);
      case "detect_visual":  return await handleDetectVisual(ctx, action);
      case "done":            return await handleDone(ctx, action);

      default: {
 // Exhaustiveness check: if a new action type is added to the union
 // without a case here, TypeScript will fail to compile. At runtime this
 // is a programming error, so we throw a dedicated error that the catch
 // below re-throws (it must not be downgraded to a soft failure).
        const _exhaustive: never = action;
        throw new UnhandledActionError(_exhaustive);
      }
    }
  } catch (e) {
 // A programming error (the exhaustiveness guard) must surface as a hard
 // throw, not as a routine failed action.
    if (e instanceof UnhandledActionError) throw e;

 // Runtime handler errors are recoverable: report them as a failed result.
 // Preserve the error's constructor name so the type (e.g. "TypeError")
 // isn't flattened away, aiding debugging without leaking the full stack to
 // the user-facing message.
    const err = e instanceof Error ? e : new Error(String(e));
    return {
      action,
      success: false,
      message: `${action.type} failed: ${err.name}: ${err.message}`,
    };
  }
}
