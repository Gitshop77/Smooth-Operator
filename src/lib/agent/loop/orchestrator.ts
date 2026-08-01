/**
 * The agentic loop orchestrator — Planner + Navigator duo.
 *
 * Architecture:
 * 1. PLANNER runs first (and every N navigator steps) to decompose the
 * task into a plan and give the navigator a concrete `next_goal`.
 * 2. NAVIGATOR runs for up to N steps, executing actions toward `next_goal`.
 * 3. After N navigator steps (or when the navigator emits `done`), PLANNER
 * runs again to evaluate progress, update the plan, or call done.
 * 4. ONLY the planner can call `done(success=true)`. The navigator's `done`
 * is treated as "I think I'm done, planner please verify".
 */

import type { LoopDeps } from "./types";
import {
  validateAndBuildConfig,
  initState,
  runInitialPlannerPhase,
  runNavigatorStep,
  finish,
  safeDispatch,
} from "./orchestrator-helpers";
import { makeCtx } from "./helpers";

/**
 * Run the full Planner + Navigator agent loop until the task completes, the
 * step budget is exhausted, the cost cap is reached, the user aborts, or a
 * fatal error occurs. All progress is streamed via `deps.onEvent`.
 *
 * The function NEVER throws — all errors are classified and surfaced as
 * `done` or `error` events.
 */
export async function runAgentLoop(deps: LoopDeps): Promise<void> {
  try {
    await runAgentLoopInner(deps);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[orchestrator] runAgentLoop uncaught error:", e);
    try {
      deps.onEvent({
        type: "done",
        step: 0,
        success: false,
        text: `Uncaught error in agent loop: ${message}`,
      });
    } catch { /* swallow — nothing we can do if onEvent itself throws */ }
  }
}

async function runAgentLoopInner(deps: LoopDeps): Promise<void> {
  const config = await validateAndBuildConfig(deps);
  const state = initState(deps, config);

  state.onEvent({ type: "run-start", task: state.task, maxSteps: config.maxSteps });
  if (state.dispatcher) {
    await safeDispatch(state, "runStart", () => state.dispatcher!.runStart(makeCtx(state)));
  }

  const initialResult = await runInitialPlannerPhase(state);
  if (initialResult.kind === "exit") return;

  while (state.step < config.maxSteps) {
    const stepResult = await runNavigatorStep(state);
    if (stepResult.kind === "exit") return;
  }

  await finish(state, false, `Reached max steps (${config.maxSteps}) without the planner calling done.`);
}
