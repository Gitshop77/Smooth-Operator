/**
 * Action executor — takes a validated {@link AgentAction} and performs it on
 * the page. Returns an {@link ActionResult} that's surfaced in the agent
 * history and shown to the user.
 *
 * Tab-level actions (`navigate`, `switch_tab`, `close_tab`, `search`) are
 * delegated to the extension's background worker via the `onTabAction` hook
 * when present (they need `chrome.tabs` API access). Everything else is
 * executed directly in the content-script context.
 *
 * This module is now a thin dispatcher: the per-action logic lives in
 * `./handlers/*`, the shared helpers live in `./helpers/*`, the constants
 * live in `./constants.ts`, and the description string lives in
 * `./describe.ts`. The dispatcher:
 *   1. Captures `beforeUrl` + `beforeFingerprint` (used by click /
 *      go_back / press_and_hold for page-change detection).
 *   2. Switches on `action.type` and delegates to the matching handler.
 *   3. Wraps every dispatch in a try/catch that converts thrown errors
 *      into `{ success: false, message: "Error: ..." }` results.
 *
 * Public API (kept stable for backward compatibility):
 *   - {@link executeAction} — the main entry point
 *   - {@link describeAction} — re-exported from `./describe`
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
 * Execute a single content-script-level action.
 *
 * Tab-level actions (`navigate`, `switch_tab`, `close_tab`, `search`) signal
 * intent here; the orchestrator's `onTabAction` hook performs the actual
 * `chrome.tabs` work in extension context.
 *
 * @param action The validated action to execute.
 * @param state  The current browser state (used to resolve `[index]` → element).
 * @returns      An {@link ActionResult} describing what happened.
 */
export async function executeAction(
  action: AgentAction,
  state: BrowserState
): Promise<ActionResult> {
  try {
    // Capture before-state once at the top — used by the click, go_back,
    // and press_and_hold handlers for page-change detection.
    const ctx: ActionContext = {
      state,
      beforeUrl: location.href,
      beforeFingerprint: domFingerprint(),
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
        // without a case here, TypeScript will fail to compile.
        const _exhaustive: never = action;
        throw new Error(`unhandled action: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (e) {
    return {
      action,
      success: false,
      message: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
