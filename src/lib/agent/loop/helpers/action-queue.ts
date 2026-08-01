/**
 * Loop helper — `executeActionQueue`.
 *
 * Extracted from the original `loop/helpers.ts` (Phase 10a).
 *
 * Execute a step's action queue. Enforces mode checks, loop detection, and
 * page-change guards. Tab-level actions are delegated to `deps.onTabAction`
 * when present.
 */

import type {
  AgentAction,
  AgentConfig,
  ActionResult,
  BrowserState,
} from "../../types";
import { executeAction, describeAction } from "../../tools/executor";
import { resetDomBaseline } from "../../dom/extractor";
import { checkActionAllowed, requiresConfirmation, type AgentMode } from "../../modes";
import type { CallbackDispatcher, CallbackContext } from "../../callbacks";
import type { LoopDeps, ActionQueueResult } from "../types";
import type { LoopDetector } from "../loop-detector";
import { TAB_LEVEL_ACTIONS } from "../constants";

/** Build a uniform failure {@link ActionResult} for an exception. */
const toActionError = (a: AgentAction, e: unknown): ActionResult => ({
  action: a,
  success: false,
  message: `Error: ${e instanceof Error ? e.message : String(e)}`,
});

export async function executeActionQueue(
  deps: LoopDeps,
  actions: AgentAction[],
  state: BrowserState,
  step: number,
  agentMode: AgentMode,
  loopDetector: LoopDetector,
  config: AgentConfig,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext,
  costCapExceeded?: () => boolean
): Promise<ActionQueueResult> {
  const results: ActionResult[] = [];
  let aborted = false;

 // Pad `results` so its length always equals `actions.length`, even when the
 // loop breaks early (mode-blocked, confirmation declined/failed, page-change,
 // or failed action). This keeps per-action history/storage entries aligned
 // and makes the success-rate tally denominator correct — mirroring the
 // extension `executeActions` override.
  const padRemaining = (fromIdx: number): void => {
    for (let j = fromIdx + 1; j < actions.length; j++) {
      results.push({
        action: actions[j],
        success: false,
        message: "BLOCKED: prior action in the queue aborted the step",
      });
    }
  };

  const failQueue = (fromIdx: number): void => {
    aborted = true;
    padRemaining(fromIdx);
  };

  for (let i = 0; i < actions.length; i++) {
    if (deps.signal?.aborted) {
 // Push an explicit result for `i` before padding so that
 // `results.length === actions.length` and per-action entries stay aligned
 // — mirroring every other break site (push-then-pad).
      results.push({
        action: actions[i],
        success: false,
        message: "BLOCKED: step aborted before this action ran",
      });
      failQueue(i);
      break;
    }
    const action = actions[i];

    const allowed = checkActionAllowed(action.type, agentMode);
    if (!allowed.allowed) {
      const blockedResult: ActionResult = {
        action,
        success: false,
        message: `BLOCKED: ${allowed.reason}`,
      };
      deps.onEvent({
        type: "action-result", step, name: action.type,
        success: false, message: blockedResult.message,
      });
 // Note: no `dispatcher.actionStart` was emitted for this action, so we
 // must NOT emit `actionEnd` here — that would unbalance the callback
 // pair. The success-rate tally still sees a non-success entry.
      results.push(blockedResult);
      failQueue(i);
      break;
    }

    if (deps.requestConfirmation && requiresConfirmation(action.type, agentMode)) {
      let confirmed = false;
 // Distinguish a genuine infrastructure failure from a deliberate decline.
 // A thrown error is treated as a *failed request*, never as "user said no".
      let confirmationError: unknown = null;
      try {
        confirmed = await deps.requestConfirmation(action);
      } catch (e) {
        confirmationError = e;
        deps.onEvent({
          type: "error", step,
          message: `Confirmation request failed: ${e instanceof Error ? e.message : String(e)}`,
          recoverable: true,
        });
      }
      if (!confirmed) {
        const message = confirmationError !== null
          ? `BLOCKED: confirmation request failed for ${action.type}`
          : `BLOCKED: user declined confirmation for ${action.type}`;
        const blockedResult: ActionResult = {
          action,
          success: false,
          message,
        };
        deps.onEvent({
          type: "action-result", step, name: action.type,
          success: false, message: blockedResult.message,
        });
 // No matching `actionStart` was emitted, so no balanced `actionEnd`.
        results.push(blockedResult);
        failQueue(i);
        break;
      }
    }

    const description = (() => {
      try { return describeAction(action); } catch { return action.type; }
    })();
    deps.onEvent({
      type: "action", step, index: i + 1, total: actions.length,
      name: action.type, description,
    });
    if (dispatcher && ctx) await dispatcher.actionStart(ctx, action);

    if (config.enableLoopDetection) {
      loopDetector.record(action, step);
      const warnCount = loopDetector.shouldWarn();
      if (warnCount > 0) {
        deps.onEvent({ type: "loop-warning", step, count: warnCount });
        if (dispatcher && ctx) await dispatcher.loopWarning(ctx, warnCount);
      }
    }

    if (costCapExceeded?.()) {
      deps.onEvent({ type: "info", message: "Cost cap exceeded mid-step. Stopping." });
      results.push({
        action,
        success: false,
        message: "BLOCKED: cost cap exceeded",
      });
      failQueue(i);
      break;
    }

    let result: ActionResult;
    let pageChangedHandled = false;
    const runLocalAction = async (): Promise<ActionResult> => {
      // Thread the step's abort signal into the action so an in-flight
      // handler (wait sleeps, SW-RPC races) observes a user STOP instead of
      // running to completion.
      try { return await executeAction(action, state, deps.signal); }
      catch (e) { return toActionError(action, e); }
    };
    if (deps.onTabAction && TAB_LEVEL_ACTIONS.has(action.type)) {
      try {
        const handled = await deps.onTabAction(action);
        if (handled.handled) {
 // Use the SW's success/message so a blocked navigation (success:
 // false, message: "BLOCKED: ...") surfaces correctly instead of a
 // misleading hardcoded success:true. Default an unspecified success
 // to `false` so a handler that omits it can't mask a failure.
          result = {
            action,
            success: handled.success ?? false,
            message: handled.message ?? `${action.type} handled by extension`,
            pageChanged: handled.pageChanged,
          };
          if (handled.pageChanged) {
            if (deps.waitForNavigation) {
              try { await deps.waitForNavigation(); }
              catch (e) {
                deps.onEvent({
                  type: "error", step,
                  message: `waitForNavigation failed: ${e instanceof Error ? e.message : String(e)}`,
                  recoverable: true,
                });
              }
            }
            resetDomBaseline();
            loopDetector.reset();
            pageChangedHandled = true;
          }
        } else {
          result = await runLocalAction();
        }
      } catch (e) {
        result = toActionError(action, e);
      }
    } else {
      result = await runLocalAction();
    }

 // Only reset here if the tab-action branch above didn't already do it —
 // otherwise a single page-change would reset the DOM baseline / loop
 // detector twice.
    if (result.pageChanged && !pageChangedHandled) {
      resetDomBaseline();
      loopDetector.reset();
    }

    deps.onEvent({
      type: "action-result", step, name: action.type,
      success: result.success, message: result.message,
    });
    if (dispatcher && ctx) await dispatcher.actionEnd(ctx, action, result);
    results.push(result);

    if (result.isDone || !result.success || result.pageChanged) {
      failQueue(i);
      break;
    }
  }

  return { results, aborted };
}
