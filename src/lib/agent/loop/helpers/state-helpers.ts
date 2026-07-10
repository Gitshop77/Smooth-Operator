/**
 * Loop helper — `LoopState` helper functions.
 *
 * Extracted from the original `loop/helpers.ts` (Phase 10a).
 *
 * The {@link LoopState} holds the agent loop's running totals (step, cost,
 * tokens). These helpers mutate / inspect the state in a small, well-named
 * surface: `makeCtx`, `addCost`, `addTokens`, `costCapExceeded`,
 * `buildRunResult`.
 */

import {
  type CallbackContext,
  type AgentRunResult,
} from "../../callbacks";
import type { LoopState } from "../types";

/** Build a {@link CallbackContext} from the current {@link LoopState}. */
export function makeCtx(state: LoopState): CallbackContext {
  return { task: state.task, step: state.step, history: state.navigatorHistory };
}

/** Add cost (USD) to the running total. */
export function addCost(state: LoopState, usd: number): void {
  state.totalCostUsd += usd;
}

/** Add token usage to the running totals (for the `runEnd` callback hook). */
export function addTokens(state: LoopState, tokensIn: number | undefined, tokensOut: number | undefined): void {
  if (tokensIn !== undefined) state.totalTokensIn += tokensIn;
  if (tokensOut !== undefined) state.totalTokensOut += tokensOut;
}

/**
 * Check the cost cap; if exceeded, emit `done` and return `true` so the caller
 * can `return` immediately.
 */
export function costCapExceeded(state: LoopState): boolean {
  const { config, totalCostUsd, step, onEvent } = state;
  if (config.costCapUsd !== undefined && config.costCapUsd > 0 && totalCostUsd >= config.costCapUsd) {
    const text = `Cost cap of $${config.costCapUsd} reached.`;
    onEvent({ type: "done", step, success: false, text });
    // Set state.finalResult so buildRunResult returns the real text for the
    // runEnd callback (not ""). Without this, dispatcher.runEnd subscribers
    // get an empty string even though the SSE done event has the real text.
    state.finalResult = { success: false, text };
    return true;
  }
  return false;
}

/**
 * Build the {@link AgentRunResult} for the `runEnd` callback hook.
 */
export function buildRunResult(state: LoopState, success: boolean, text: string): AgentRunResult {
  const final = state.finalResult;
  return {
    success: final ? final.success : success,
    text: final ? final.text : text,
    stepCount: state.step,
    totalCostUsd: state.totalCostUsd,
    totalTokensIn: state.totalTokensIn,
    totalTokensOut: state.totalTokensOut,
  };
}
