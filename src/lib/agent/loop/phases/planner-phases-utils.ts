import type { PlannerOutput, LogEvent } from "../../types";
import type { LoopState } from "../types";
import { makeCtx } from "../helpers";
import { classifyError, friendlyErrorMessage, MACHINE_CODES, RECOVERY_HINTS, type ClassifiedError } from "../../errors";
import { redactKeyLeak } from "../../redact-shared";

/**
 * Emit a `plannerStep` dispatcher event, swallowing any callback exception so a
 * throwing dispatcher/callback can never abort the whole run.
 */
export async function safeEmitPlannerStep(state: LoopState, plannerResult: PlannerOutput): Promise<void> {
  if (!state.dispatcher) return;
  try {
    await state.dispatcher.plannerStep(
      makeCtx(state), plannerResult.decision, state.currentGoal, state.plan
    );
  } catch (e) {
    console.error(`[planner-phases] dispatcher.plannerStep threw (continuing run): ${redactKeyLeak(String(e))}`);
  }
}

/**
 * Wait for the page to settle after an action, honoring `state.signal` so an
 * abort is respected at this step boundary.
 */
export async function safeWaitForSettled(state: LoopState): Promise<void> {
  const { deps, step, onEvent, signal } = state;
  try {
    if (deps.waitForSettled) {
      await deps.waitForSettled();
      return;
    }
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, state.settleDelay);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          resolve();
        } else {
          signal.addEventListener("abort", onAbort);
        }
      }
    });
  } catch (e) {
    // An abort is not a settle failure: re-throw so the caller's stop-path
    // handling terminates the run instead of continuing into the next step.
    const isAbort = signal?.aborted === true;
    if (isAbort) throw e;
    onEvent({
      type: "error",
      step,
      message: `waitForSettled failed: ${e instanceof Error ? e.message : String(e)}`,
      recoverable: true,
    });
  }
}

/**
 * Validate and clamp `current_plan_item` against the plan in effect.
 * Emits an info event when coercion is needed, returns the clamped value.
 * Returns `undefined` when no change should be applied (empty plan or no value).
 */
export function clampPlanItem(
  plan: string[] | undefined,
  value: number | undefined,
  onEvent: (e: LogEvent) => void,
): number | undefined {
  if (value === undefined) return undefined;
  const planLen = plan?.length ?? 0;
  if (planLen === 0) {
    onEvent({
      type: "info",
      message: `Planner sent current_plan_item=${value} but no plan is loaded; leaving currentPlanItem unchanged.`,
    });
    return undefined;
  }
  const truncated = Math.trunc(value);
  const clamped = truncated < 0 ? 0 : truncated >= planLen ? planLen - 1 : truncated;
  if (clamped !== value) {
    const reason = Number.isInteger(value)
      ? `out of range [0, ${planLen - 1}]`
      : `not an integer`;
    onEvent({
      type: "info",
      message: `Planner current_plan_item=${value} ${reason}; clamped to ${clamped}.`,
    });
  }
  return clamped;
}

/**
 * Classify a planner error with a fallback for classifier failures.
 */
export function classifyPlannerError(
  e: unknown,
  consecutiveFailures: number,
  msg: string,
): { classified: ClassifiedError; errorMessage: string } {
  try {
    const classified = classifyError(e, consecutiveFailures);
    return { classified, errorMessage: friendlyErrorMessage(classified) };
  } catch {
    return {
      classified: {
        category: "unknown", fatal: false, retryable: true, message: msg,
        machineCode: MACHINE_CODES.unknown, recoveryHint: RECOVERY_HINTS.unknown,
        originalError: e,
      },
      errorMessage: msg,
    };
  }
}
