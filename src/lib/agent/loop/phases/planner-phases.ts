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
    const classified = (await import("../../errors")).classifyError(e);
    onEvent({
      type: "error", step,
      message: (await import("../../errors")).friendlyErrorMessage(classified),
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

  if (costCapExceeded(state)) return { status: "finalized" };

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
  // Clamp `current_plan_item` to a valid plan index (finding: current_plan_item
  // is accepted without bounds validation). Schema only checks `z.number().int()`,
  // so a negative or out-of-range value must be coerced rather than trusted.
  // Use the EXISTING plan (state.plan, which was just updated above) for the
  // bound — if we only looked at `plannerResult.plan`, a planner response that
  // omits `plan` would be bounds-checked against 0 and every index would
  // collapse to 0, even though a real plan is already loaded.
  if (plannerResult.current_plan_item !== undefined) {
    const v = plannerResult.current_plan_item;
    const planLen = state.plan?.length ?? 0;
    state.currentPlanItem = Number.isInteger(v) && v >= 0 && v < planLen
      ? v
      : (v < 0 ? 0 : Math.max(0, planLen - 1));
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
  const { deps, step, onEvent, settleDelay, navigatorHistory } = state;

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
    try {
      await (deps.waitForSettled?.() ?? new Promise<void>((r) => setTimeout(r, settleDelay)));
    } catch (e) {
      onEvent({
        type: "error", step,
        message: `waitForSettled failed: ${e instanceof Error ? e.message : String(e)}`,
        recoverable: true,
      });
    }
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
  if (state.dispatcher) {
    // A throwing dispatcher/callback must not abort the whole run (finding:
    // user-provided dispatcher/callback exceptions abort the whole run).
    try {
      await state.dispatcher.plannerStep(
        makeCtx(state), decisionResult.plannerResult.decision, state.currentGoal, state.plan
      );
    } catch (e) {
      console.error("[planner-phases] dispatcher.plannerStep threw (continuing run):", e);
    }
  }
  state.navigatorStepsSincePlanner = 0;
  state.step++;
  try {
    await (deps.waitForSettled?.() ?? new Promise<void>((r) => setTimeout(r, settleDelay)));
  } catch (e) {
    onEvent({
      type: "error", step,
      message: `waitForSettled failed: ${e instanceof Error ? e.message : String(e)}`,
      recoverable: true,
    });
  }
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
  if (state.dispatcher) {
    // A throwing dispatcher/callback must not abort the whole run (finding:
    // user-provided dispatcher/callback exceptions abort the whole run).
    try {
      await state.dispatcher.plannerStep(
        makeCtx(state), decisionResult.plannerResult.decision, state.currentGoal, state.plan
      );
    } catch (e) {
      console.error("[planner-phases] dispatcher.plannerStep threw (continuing run):", e);
    }
  }
  return { finalized: false };
}
