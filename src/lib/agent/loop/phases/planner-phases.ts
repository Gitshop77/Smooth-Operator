/**
 * Phase: callPlannerAndHandleError + handlePlannerDecision + handleNavigatorDone
 * + runPeriodicPlannerCheck — extracted from orchestrator.ts (Phase 1).
 *
 * These four helpers cover every planner-related phase (initial, verify,
 * periodic). The initial planner call is inlined in the main orchestrator
 * (it has unique error handling); the recurring pattern lives here.
 */

import type {
  AgentAction,
  AgentOutput,
  BrowserState,
  PlannerOutput,
  TabInfo,
} from "../../types";
import type { LoopState, CallPlannerResult, HandlePlannerDecisionResult, HandleNavigatorDoneResult, RunPeriodicPlannerCheckResult } from "../types";
import { runPlanner, maybeJudgeAndFinalize, makeCtx, addCost, addTokens, costCapExceeded } from "../helpers";
import { GOAL_WARN_THRESHOLD } from "../loop-detector";
import { classifyError, friendlyErrorMessage, type ClassifiedError } from "../../errors";

/**
 * Emit a `plannerStep` dispatcher event, swallowing any callback exception so a
 * throwing dispatcher/callback can never abort the whole run (finding:
 * user-provided dispatcher/callback exceptions aborted the whole run). Shared
 * by the navigator-done and periodic-planner paths so the two cannot drift.
 */
async function safeEmitPlannerStep(state: LoopState, plannerResult: PlannerOutput): Promise<void> {
  if (!state.dispatcher) return;
  try {
    await state.dispatcher.plannerStep(
      makeCtx(state), plannerResult.decision, state.currentGoal, state.plan
    );
  } catch (e) {
    console.error("[planner-phases] dispatcher.plannerStep threw (continuing run):", e);
  }
}

/**
 * Wait for the page to settle after an action, honoring `state.signal` so an
 * abort is respected at this step boundary (the previous inline `setTimeout`
 * fallback ignored the signal and always slept the full `settleDelay`).
 * Dedupes the wait logic that was inlined at two call sites in
 * `handleNavigatorDone`; the abort listener is removed on the timer path so it
 * doesn't leak.
 */
async function safeWaitForSettled(state: LoopState): Promise<void> {
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
    onEvent({
      type: "error",
      step,
      message: `waitForSettled failed: ${e instanceof Error ? e.message : String(e)}`,
      recoverable: true,
    });
  }
}

/**
 * Call the planner LLM and handle the error classification + failure-tracking
 * pattern.
 */
export async function callPlannerAndHandleError(
  state: LoopState,
  args: { url: string; tabs: TabInfo[] }
): Promise<CallPlannerResult> {
  const { deps, task, plan, currentPlanItem, step, config, navigatorHistory, onEvent } = state;
  let plannerResult: PlannerOutput;
  try {
    plannerResult = await runPlanner(
      deps,
      {
        task, navigatorHistory, plan, currentPlanItem,
        url: args.url, tabs: args.tabs, step, maxSteps: config.maxSteps,
        onCost: (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
      },
      state.dispatcher,
      makeCtx(state)
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Budget exceeded:/i.test(msg)) {
      onEvent({ type: "done", step, success: false, text: msg });
 // Set finalResult so buildRunResult returns the real reason to the
 // runEnd callback subscribers (otherwise the orchestrator's
 // `buildRunResult(state, false, "")` fallback yields `text: ""` —
 // SSE/UI saw the real reason but dispatcher.runEnd did not).
      state.finalResult = { success: false, text: msg };
      return { status: "abort" };
    }
 // Classify the error for the error event + abort/retry decision. Wrapped
 // in its own try/catch so a failure to load/run the classifier can never
 // swallow the real reason: if classification itself throws (or the module
 // failed to resolve), we fall back to the raw message and treat it as a
 // non-fatal transient error. Without this guard, a throwing classifier
 // would propagate out of `callPlannerAndHandleError` entirely — no `done`
 // event and no `state.finalResult`, which is exactly the lost-reason
 // failure mode the surrounding code is careful to avoid.
    let classified: ClassifiedError;
    let errorMessage: string;
    try {
      classified = classifyError(e);
      errorMessage = friendlyErrorMessage(classified);
    } catch {
      classified = { category: "unknown", fatal: false, retryable: true, message: msg, originalError: e };
      errorMessage = msg;
    }
    onEvent({
      type: "error", step,
      message: errorMessage,
      recoverable: !classified.fatal,
    });
    if (classified.fatal || classified.category === "cancelled") {
      const doneText = `Fatal planner error (${classified.category}): ${classified.message}`;
      onEvent({
        type: "done", step, success: false,
        text: doneText,
      });
      state.finalResult = { success: false, text: doneText };
      return { status: "abort" };
    }
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= config.maxFailures) {
      const doneText = `Agent aborted after ${config.maxFailures} consecutive failures. Last planner error: ${classified.message}`;
      onEvent({
        type: "done", step, success: false,
        text: doneText,
      });
      state.finalResult = { success: false, text: doneText };
      return { status: "abort" };
    }
    return { status: "continue" };
  }
  return { status: "ok", plannerResult };
}

/**
 * Handle the planner's decision (done / web_task / continue).
 */
export async function handlePlannerDecision(
  state: LoopState,
  plannerResultIn: PlannerOutput,
  opts: { doneTextFallback?: string } = {}
): Promise<HandlePlannerDecisionResult> {
  const { config, step, onEvent, navigatorHistory } = state;

  if (costCapExceeded(state)) {
    state.finalResult = { success: false, text: "Cost cap exceeded" };
    return { status: "finalized" };
  }

  let plannerResult = plannerResultIn;
  if (plannerResult.decision === "done") {
    const finalized = await maybeJudgeAndFinalize(
      state.deps,
      config,
      {
        step,
        success: !!plannerResult.success,
        text: plannerResult.text || opts.doneTextFallback || "",
        navigatorHistory,
        onCost: (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
 // This is the planner's in-run "done" attempt, not the run's final
 // completion — skip the LLM judge for free-form tasks (no
 // expectedOutcomes) to avoid an extra full-history completion. The
 // terminal run-end `done` still forces finalAttempt (verified).
        finalAttempt: false,
      },
      state,
      state.dispatcher,
      makeCtx(state)
    );
    if (finalized) {
 // Record the real outcome so `buildRunResult` (which prefers
 // `state.finalResult`) reports the genuine success/text instead of the
 // hardcoded `false`/`""` the orchestrator passes at the finalized-done
 // paths (finding: run result success/text lost on finalized-done paths).
      state.finalResult = { success: !!plannerResult.success, text: plannerResult.text || opts.doneTextFallback || "" };
      return { status: "finalized" };
    }
    plannerResult = { ...plannerResult, decision: "continue" };
    onEvent({
      type: "info",
      message: "Judge disagreed with completion — continuing the run.",
    });
  }
  if (plannerResult.decision === "web_task") {
    onEvent({ type: "done", step, success: true, text: plannerResult.text || "" });
    state.finalResult = { success: true, text: plannerResult.text || "" };
    return { status: "finalized" };
  }
  if (plannerResult.plan) state.plan = plannerResult.plan;
 // Validate + clamp `current_plan_item` against the plan actually in effect.
 // The schema only enforces `z.number().int()`, so runtime JSON could still
 // carry a float or an out-of-range value. We round + clamp explicitly and
 // emit an event whenever the planner's value had to be corrected, so the
 // coercion is observable rather than silently masking a planner/provider bug.
 // When no plan is loaded the index has nothing to point at, so we leave
 // `currentPlanItem` unchanged instead of coercing it to 0 (which would index
 // `state.plan[0] === undefined` downstream — the empty-plan case that the
 // previous `Math.max(0, planLen - 1)` fallback collapsed to 0).
  if (plannerResult.current_plan_item !== undefined) {
    const planLen = state.plan?.length ?? 0;
    const v = plannerResult.current_plan_item;
    if (planLen === 0) {
 // No plan in effect: an index has nothing to reference. Leave the
 // existing currentPlanItem untouched rather than forcing it to 0.
      onEvent({
        type: "info",
        message: `Planner sent current_plan_item=${v} but no plan is loaded; leaving currentPlanItem unchanged (${state.currentPlanItem ?? "none"}).`,
      });
    } else {
 // Truncate floats to their integer part (so 2.5 maps to index 2, not to
 // the last item), then clamp into [0, planLen - 1].
      const truncated = Math.trunc(v);
      const clamped =
        truncated < 0 ? 0 : truncated >= planLen ? planLen - 1 : truncated;
      if (clamped !== v) {
        const reason = Number.isInteger(v)
          ? `out of range [0, ${planLen - 1}]`
          : `not an integer`;
        onEvent({
          type: "info",
          message: `Planner current_plan_item=${v} ${reason}; clamped to ${clamped}.`,
        });
      }
      state.currentPlanItem = clamped;
    }
  }
  state.currentGoal = plannerResult.next_goal || state.currentGoal;
  return { status: "continue", plannerResult };
}

/**
 * Handle the "navigator emitted `done` → ask planner to verify → maybe judge"
 * flow.
 */
export async function handleNavigatorDone(
  state: LoopState,
  doneAction: Extract<AgentAction, { type: "done" }>,
  output: AgentOutput,
  browserState: BrowserState,
  tabs: TabInfo[]
): Promise<HandleNavigatorDoneResult> {
  const { step, onEvent, navigatorHistory } = state;

  navigatorHistory.push({
    step, agent: "navigator",
    evaluation: output.evaluation_previous_goal,
    memory: output.memory, goal: output.next_goal,
    results: [{
      action: doneAction, success: doneAction.success ?? true,
      message: `Navigator requested completion: ${doneAction.text}`,
      isDone: true,
    }],
  });

  const callResult = await callPlannerAndHandleError(state, { url: browserState.url, tabs });
  if (callResult.status === "abort") return { finalized: true };
  if (callResult.status === "continue") {
 // The planner verification call failed transiently (no decision produced).
 // Emit an info event and reset the navigator-since-planner counter for
 // parity with the `decision` branch so the periodic planner check keeps a
 // correct cadence (otherwise it would re-fire immediately on the next step).
    onEvent({
      type: "info",
      message: "Planner verification skipped (transient planner error) — continuing the run.",
    });
    state.navigatorStepsSincePlanner = 0;
    state.step++;
    await safeWaitForSettled(state);
    return { finalized: false };
  }

  const decisionResult = await handlePlannerDecision(state, callResult.plannerResult, {
    doneTextFallback: doneAction.text,
  });
  if (decisionResult.status === "finalized") return { finalized: true };

  onEvent({
    type: "planner-step", step, decision: decisionResult.plannerResult.decision,
    goal: state.currentGoal, plan: state.plan,
  });
  await safeEmitPlannerStep(state, decisionResult.plannerResult);
  state.navigatorStepsSincePlanner = 0;
  state.step++;
  await safeWaitForSettled(state);
  return { finalized: false };
}

/**
 * Wrap the periodic planner re-evaluation.
 */
export async function runPeriodicPlannerCheck(
  state: LoopState,
  browserState: BrowserState
): Promise<RunPeriodicPlannerCheckResult> {
  const { deps, step, onEvent } = state;

  let tabsNow: TabInfo[];
  try {
    tabsNow = await deps.getTabs();
  } catch (e) {
    onEvent({
      type: "error", step,
      message: `getTabs (periodic) failed: ${e instanceof Error ? e.message : String(e)}`,
      recoverable: true,
    });
    state.navigatorStepsSincePlanner = 0;
    return { finalized: false };
  }

  const periodicUrl = tabsNow.find((t) => t.active)?.url || tabsNow[0]?.url || browserState.url || "";

  const callResult = await callPlannerAndHandleError(state, { url: periodicUrl, tabs: tabsNow });
  if (callResult.status === "abort") return { finalized: true };
  if (callResult.status === "continue") {
    state.navigatorStepsSincePlanner = 0;
    return { finalized: false };
  }

  const decisionResult = await handlePlannerDecision(state, callResult.plannerResult);
  if (decisionResult.status === "finalized") return { finalized: true };

  state.navigatorStepsSincePlanner = 0;
  if (state.currentGoal) {
    const goalCount = state.loopDetector.recordGoal(state.currentGoal);
    if (goalCount >= GOAL_WARN_THRESHOLD) {
      onEvent({
        type: "loop-warning", step, count: goalCount,
      });
      onEvent({
        type: "info",
        message: `Goal-level loop detected: "${state.currentGoal.slice(0, 80)}" has been the goal ${goalCount} times. The planner may be stuck.`,
      });
    }
  }
  onEvent({
    type: "planner-step", step, decision: decisionResult.plannerResult.decision,
    goal: state.currentGoal, plan: state.plan,
  });
  await safeEmitPlannerStep(state, decisionResult.plannerResult);
  return { finalized: false };
}
