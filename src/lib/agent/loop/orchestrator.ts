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
  loopProgressStalled,
} from "./orchestrator-helpers";
import { transitionRunPhase } from "./run-state-machine";
import { makeCtx } from "./helpers";
import { redactKeyLeak } from "../redact-shared";

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
    // Only reachable when the failure happens BEFORE a run state exists
    // (config validation / state init) — at that point no terminal event
    // could have been emitted, so a single raw `done` is safe, and the
    // dispatcher never saw `runStart`, so skipping `runEnd` is correct.
    const message = redactKeyLeak(e instanceof Error ? e.message : String(e));
    console.error(`[orchestrator] runAgentLoop failed before the loop started: ${message}`);
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

  try {
    // Phase 9 state machine: init → plan (the initial planner phase begins).
    transitionRunPhase(state, "plan", "initial planner phase begins");
    const initialResult = await runInitialPlannerPhase(state);
    if (initialResult.kind === "exit") return;

    while (state.step < config.maxSteps) {
      // No-progress guard at the loop boundary: every step MUST advance the
      // step counter (or terminate the run). If a regression ever returns
      // "continue" without `step++`, the loop would spin forever burning
      // provider tokens — terminate deterministically instead. The same guard
      // covers the plateau shape: the delta-classifier in the loop detector
      // (oscillation + stagnation warnings) feeds the pre-observe nudge layer,
      // while this edge guard is the machine-enforced floor.
      const before = state.step;
      const stepResult = await runNavigatorStep(state);
      if (stepResult.kind === "exit") return;
      if (loopProgressStalled(state, before)) {
        await finish(state, false, "No progress: the loop did not advance its step counter.");
        return;
      }
    }

    await finish(state, false, `Reached max steps (${config.maxSteps}) without the planner calling done.`);
  } catch (e) {
    // A throw that escapes the per-phase error handling (e.g. a crashing
    // user `onEvent` handler) terminates the run through `finish()` so the
    // terminal `done` is emitted at most once and the `runEnd` dispatcher
    // callback still fires. `finish` itself can throw only if `onEvent`
    // throws on the `done` event — nothing left to surface then.
    const message = redactKeyLeak(e instanceof Error ? e.message : String(e));
    console.error(`[orchestrator] runAgentLoop uncaught error: ${message}`);
    try {
      await finish(state, false, `Uncaught error in agent loop: ${message}`);
    } catch { /* swallow — the terminal event could not be emitted */ }
  }
}
