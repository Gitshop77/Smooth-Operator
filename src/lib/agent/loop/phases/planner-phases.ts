/**
 * Phase: callPlannerAndHandleError + handlePlannerDecision + handleNavigatorDone
 * + runPeriodicPlannerCheck — extracted from orchestrator.ts.
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
import { GOAL_WARN_THRESHOLD, GOAL_TOP_THRESHOLD } from "../loop-detector";
import {
  safeEmitPlannerStep,
  safeWaitForSettled,
  clampPlanItem,
  classifyPlannerError,
} from "./planner-phases-utils";

/**
 * Call the planner LLM and handle the error classification + failure-tracking
 * pattern.
 */
export async function callPlannerAndHandleError(
  state: LoopState,
  args: { url: string; tabs: TabInfo[] },
  signal?: AbortSignal
): Promise<CallPlannerResult> {
  const { deps, task, plan, currentPlanItem, step, config, navigatorHistory, onEvent } = state;
  let plannerResult: PlannerOutput;
  try {
    plannerResult = await runPlanner(
      deps,
      {
        task, navigatorHistory, plan, currentPlanItem,
        url: args.url, tabs: args.tabs, step, maxSteps: config.maxSteps,
        compactedMemory: state.compactedMemory,
        onCost: (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
      },
      state.dispatcher,
      makeCtx(state),
      signal,
      config.costCapUsd,
      () => costCapExceeded(state)
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^Budget exceeded:/i.test(msg)) {
      // The throw comes from runPlanner's costCapCheck (wired to
      // costCapExceeded(state)), which already recorded the authoritative
      // final result. Prefer that text and never clobber it — and don't
      // re-emit the terminal event if a prior path already emitted it (e.g.
      // a cost-capped compaction earlier in the same step).
      const text = state.finalResult?.text ?? msg;
      if (!state.terminalEmitted) {
        onEvent({ type: "done", step, success: false, text });
      }
      state.finalResult = { success: false, text };
      return { status: "abort" };
    }
    const { classified, errorMessage } = classifyPlannerError(e, state.consecutiveFailures, msg);
    onEvent({
      type: "error", step,
      message: errorMessage,
      recoverable: !classified.fatal,
      code: classified.machineCode,
      recovery: classified.recoveryHint,
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
    onEvent({ type: "done", step, success: false, text: "Cost cap exceeded" });
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
        finalAttempt: false,
      },
      state,
      state.dispatcher,
      makeCtx(state)
    );
    if (finalized) {
      return { status: "finalized" };
    }
    plannerResult = { ...plannerResult, decision: "continue" };
    onEvent({
      type: "info",
      message: "Judge disagreed with completion — continuing the run.",
    });
  }
  if (plannerResult.decision === "web_task") {
    const finalized = await maybeJudgeAndFinalize(
      state.deps,
      config,
      {
        step,
        success: true,
        text: plannerResult.text || "",
        navigatorHistory,
        onCost: (usd, tokensIn, tokensOut) => {
          addCost(state, usd);
          addTokens(state, tokensIn, tokensOut);
        },
      },
      state,
      state.dispatcher,
      makeCtx(state)
    );
    if (finalized) {
      return { status: "finalized" };
    }
    onEvent({
      type: "info",
      message: "Judge disagreed with web_task result — continuing the run.",
    });
    plannerResult = { ...plannerResult, decision: "continue" };
  }
  if (plannerResult.plan) state.plan = plannerResult.plan;
  const clamped = clampPlanItem(state.plan, plannerResult.current_plan_item, onEvent);
  if (clamped !== undefined) state.currentPlanItem = clamped;
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
      action: doneAction, success: doneAction.success ?? false,
      message: `Navigator requested completion: ${doneAction.text}`,
      isDone: true,
    }],
  });

  const callResult = await callPlannerAndHandleError(state, { url: browserState.url, tabs }, state.signal);
  if (callResult.status === "abort") return { finalized: true };
  if (callResult.status === "continue") {
    onEvent({
      type: "info",
      message: "Planner verification skipped (transient planner error) — continuing the run.",
    });
    state.navigatorStepsSincePlanner = 0;
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

  const callResult = await callPlannerAndHandleError(state, { url: periodicUrl, tabs: tabsNow }, state.signal);
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
      if (state.config.enableEarlyStop && goalCount >= GOAL_TOP_THRESHOLD) {
        const doneText = `Loop detected: planner re-assigned goal "${state.currentGoal.slice(0, 80)}" ${goalCount} times — aborting run.`;
        onEvent({ type: "done", step, success: false, text: doneText });
        state.finalResult = { success: false, text: doneText };
        return { finalized: true };
      }
    }
  }
  onEvent({
    type: "planner-step", step, decision: decisionResult.plannerResult.decision,
    goal: state.currentGoal, plan: state.plan,
  });
  await safeEmitPlannerStep(state, decisionResult.plannerResult);
  return { finalized: false };
}
