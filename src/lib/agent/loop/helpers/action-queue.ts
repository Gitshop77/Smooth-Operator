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
  ActionResult,
  AgentAction,
  BrowserState,
} from "../../types";
import { executeAction, describeAction } from "../../tools/executor";
import { resetDomBaseline } from "../../dom/extractor";
import { checkActionAllowed, requiresConfirmation, type AgentMode } from "../../modes";
import {
  CallbackDispatcher,
  type CallbackContext,
} from "../../callbacks";
import type { LoopDeps, ActionQueueResult } from "../types";
import type { LoopDetector } from "../loop-detector";
import { TAB_LEVEL_ACTIONS } from "../constants";

export async function executeActionQueue(
  deps: LoopDeps,
  actions: AgentAction[],
  state: BrowserState,
  step: number,
  agentMode: AgentMode,
  loopDetector: LoopDetector,
  config: import("../../types").AgentConfig,
  dispatcher?: CallbackDispatcher,
  ctx?: CallbackContext
): Promise<ActionQueueResult> {
  const results: ActionResult[] = [];
  let aborted = false;

  for (let i = 0; i < actions.length; i++) {
    if (deps.signal?.aborted) { aborted = true; break; }
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
      if (dispatcher && ctx) await dispatcher.actionEnd(ctx, action, blockedResult);
      results.push(blockedResult);
      aborted = true;
      break;
    }

    if (deps.requestConfirmation && requiresConfirmation(action.type, agentMode)) {
      let confirmed = false;
      try {
        confirmed = await deps.requestConfirmation(action);
      } catch (e) {
        deps.onEvent({
          type: "error", step,
          message: `Confirmation request failed: ${e instanceof Error ? e.message : String(e)}`,
          recoverable: true,
        });
      }
      if (!confirmed) {
        const blockedResult: ActionResult = {
          action,
          success: false,
          message: `BLOCKED: user declined confirmation for ${action.type}`,
        };
        deps.onEvent({
          type: "action-result", step, name: action.type,
          success: false, message: blockedResult.message,
        });
        if (dispatcher && ctx) await dispatcher.actionEnd(ctx, action, blockedResult);
        results.push(blockedResult);
        aborted = true;
        break;
      }
    }

    deps.onEvent({
      type: "action", step, index: i + 1, total: actions.length,
      name: action.type, description: describeAction(action),
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

    let result: ActionResult;
    if (deps.onTabAction && TAB_LEVEL_ACTIONS.has(action.type)) {
      try {
        const handled = await deps.onTabAction(action);
        if (handled.handled) {
          // Use the SW's success/message so a blocked navigation (success:
          // false, message: "BLOCKED: ...") surfaces correctly instead of a
          // misleading hardcoded success:true.
          result = {
            action,
            success: handled.success ?? true,
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
          }
        } else {
          try {
            result = await executeAction(action, state);
          } catch (e) {
            result = { action, success: false, message: `Error: ${e instanceof Error ? e.message : String(e)}` };
          }
        }
      } catch (e) {
        result = { action, success: false, message: `Error: ${e instanceof Error ? e.message : String(e)}` };
      }
    } else {
      try {
        result = await executeAction(action, state);
      } catch (e) {
        result = { action, success: false, message: `Error: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    if (result.pageChanged) {
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
      aborted = true;
      break;
    }
  }

  return { results, aborted };
}
