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
  if (Number.isFinite(usd)) state.totalCostUsd += Math.max(0, usd);
}

/** Add token usage to the running totals (for the `runEnd` callback hook). */
export function addTokens(state: LoopState, tokensIn: number | undefined, tokensOut: number | undefined): void {
  if (typeof tokensIn === "number" && Number.isFinite(tokensIn)) state.totalTokensIn += Math.max(0, tokensIn);
  if (typeof tokensOut === "number" && Number.isFinite(tokensOut)) state.totalTokensOut += Math.max(0, tokensOut);
}

/**
 * Check the cost cap; if exceeded, set the final result and return `true` so
 * the caller can `return` immediately and emit the authoritative terminal
 * `done` event (callers must not double-emit).
 */
export function costCapExceeded(state: LoopState): boolean {
  const { config, totalCostUsd } = state;
  const exceeded =
    Number.isFinite(totalCostUsd) &&
    config.costCapUsd !== undefined &&
    config.costCapUsd > 0 &&
    totalCostUsd >= config.costCapUsd;
  if (exceeded) {
    const cap = config.costCapUsd ?? 0;
    const text = `Cost cap of $${cap.toFixed(2)} reached.`;
    // Set state.finalResult so buildRunResult returns the real text for the
    // runEnd callback (not ""). Idempotent: repeated calls (costCapCheck
    // fires on every overshoot LLM call + step-boundary checks) must never
    // clobber an already-recorded terminal result — e.g. a judge's
    // success:true finalResult, or the text a prior terminal path recorded.
    if (!state.finalResult) {
      state.finalResult = { success: false, text };
    }
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
