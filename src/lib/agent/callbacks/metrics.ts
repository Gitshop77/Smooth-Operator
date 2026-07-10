/**
 * Agent-metrics callback — accumulates a detailed metrics snapshot across a
 * full agent run. Read-only accumulator; call {@link AgentMetricsCallback.getMetrics}
 * at run end for a snapshot object suitable for logging, telemetry, or
 * persistence to run history.
 *
 * This module is additive to the existing `../callbacks.ts` (which stays
 * unchanged). It implements the same `AsyncCallbackHandler` interface.
 *
 * Phase attribution heuristic
 * ---------------------------
 * The `AsyncCallbackHandler` interface does not pass a phase tag to
 * `onLLMEnd`, so the callback uses a small state machine driven by the
 * other hooks to attribute each LLM call to the planner vs the navigator:
 *
 *   - Initially the next LLM call is the planner (the very first call in
 *     a run is the planner establishing the initial plan).
 *   - `onPlannerStep` sets the next phase to "navigator" (the planner just
 *     ran; the navigator runs next).
 *   - `onStepStart` sets the next phase to "navigator" (we're inside a
 *     navigator step).
 *   - `onStepEnd` sets the next phase to "planner" (between steps the
 *     planner MAY run if the interval hits — if it doesn't, the next
 *     `onStepStart` overrides the guess back to "navigator").
 *
 * This is a best-effort heuristic; for exact attribution, the orchestrator
 * would need to pass phase info via the callback context.
 */

import type {
  AsyncCallbackHandler,
  AgentRunResult,
  CallbackContext,
  LLMResponseInfo,
  LLMUsageInfo,
} from "../callbacks";
import type { ActionResult } from "../types";

/** Per-action-type success/failure counts. */
export interface ActionCounts {
  /** Total executions of this action type. */
  total: number;
  /** How many succeeded. */
  successes: number;
  /** How many failed. */
  failures: number;
}

/** Total LLM calls + tokens, broken down by phase (planner vs navigator). */
export interface PhaseLLMMetrics {
  /** Number of LLM calls in this phase. */
  calls: number;
  /** Total input tokens (prompt tokens). */
  tokensIn: number;
  /** Total output tokens (completion tokens). */
  tokensOut: number;
}

/** Errors broken down by recoverability. */
export interface ErrorMetrics {
  /** Total errors reported via `onError`. */
  total: number;
  /** Errors flagged recoverable (transient — agent retried). */
  recoverable: number;
  /** Errors flagged non-recoverable (fatal). */
  fatal: number;
}

/**
 * Snapshot of agent-run metrics (a frozen, serialisable object). Returned
 * by {@link AgentMetricsCallback.getMetrics}.
 */
export interface AgentMetrics {
  /** Total number of navigator steps (`onStepEnd` invocations). */
  totalSteps: number;
  /** Total number of actions executed across all steps. */
  totalActions: number;
  /** Per-action-type success/failure counts (keyed by action.type). */
  actionsByType: Record<string, ActionCounts>;
  /** Per-phase LLM call + token totals. */
  llmByPhase: {
    planner: PhaseLLMMetrics;
    navigator: PhaseLLMMetrics;
  };
  /** Total tokens consumed across all phases (sum of planner + navigator). */
  totalTokensIn: number;
  /** Total tokens produced across all phases (sum of planner + navigator). */
  totalTokensOut: number;
  /** Total USD cost across all phases (sum of every `onCost` call). */
  totalCostUsd: number;
  /** Number of loop-warning events fired by the loop detector. */
  loopWarnings: number;
  /** Number of history-compaction events. */
  compactions: number;
  /** Errors broken down by recoverability. */
  errors: ErrorMetrics;
}

/**
 * Agent-metrics callback — a read-only accumulator that records detailed
 * per-run metrics. Implements the full {@link AsyncCallbackHandler}
 * interface; hooks that don't contribute to a metric are no-ops.
 */
export class AgentMetricsCallback implements AsyncCallbackHandler {
  private totalSteps = 0;
  private totalActions = 0;
  private readonly actionsByType: Record<string, ActionCounts> = {};

  // LLM phase attribution state machine (see file-level docstring).
  private nextPhase: "planner" | "navigator" = "planner";
  private plannerCalls = 0;
  private plannerTokensIn = 0;
  private plannerTokensOut = 0;
  private navigatorCalls = 0;
  private navigatorTokensIn = 0;
  private navigatorTokensOut = 0;

  private totalTokensIn = 0;
  private totalTokensOut = 0;
  private totalCostUsd = 0;
  private loopWarnings = 0;
  private compactions = 0;
  private errorTotal = 0;
  private errorRecoverable = 0;
  private errorFatal = 0;

  /**
   * Reset all accumulators to zero and re-initialise the phase state
   * machine. Useful when reusing one instance across multiple runs.
   */
  reset(): void {
    this.totalSteps = 0;
    this.totalActions = 0;
    for (const k of Object.keys(this.actionsByType)) delete this.actionsByType[k];
    this.nextPhase = "planner";
    this.plannerCalls = 0;
    this.plannerTokensIn = 0;
    this.plannerTokensOut = 0;
    this.navigatorCalls = 0;
    this.navigatorTokensIn = 0;
    this.navigatorTokensOut = 0;
    this.totalTokensIn = 0;
    this.totalTokensOut = 0;
    this.totalCostUsd = 0;
    this.loopWarnings = 0;
    this.compactions = 0;
    this.errorTotal = 0;
    this.errorRecoverable = 0;
    this.errorFatal = 0;
  }

  /**
   * Snapshot the current accumulator state. The returned object is a deep
   * copy — safe to mutate without affecting the callback's internal state.
   */
  getMetrics(): AgentMetrics {
    const actionsByType: Record<string, ActionCounts> = {};
    for (const [k, v] of Object.entries(this.actionsByType)) {
      actionsByType[k] = { ...v };
    }
    return {
      totalSteps: this.totalSteps,
      totalActions: this.totalActions,
      actionsByType,
      llmByPhase: {
        planner: {
          calls: this.plannerCalls,
          tokensIn: this.plannerTokensIn,
          tokensOut: this.plannerTokensOut,
        },
        navigator: {
          calls: this.navigatorCalls,
          tokensIn: this.navigatorTokensIn,
          tokensOut: this.navigatorTokensOut,
        },
      },
      totalTokensIn: this.totalTokensIn,
      totalTokensOut: this.totalTokensOut,
      totalCostUsd: this.totalCostUsd,
      loopWarnings: this.loopWarnings,
      compactions: this.compactions,
      errors: {
        total: this.errorTotal,
        recoverable: this.errorRecoverable,
        fatal: this.errorFatal,
      },
    };
  }

  /** @inheritdoc */
  onPlannerStep(): void {
    // Planner just emitted a decision — the next LLM call is the navigator.
    this.nextPhase = "navigator";
  }

  /** @inheritdoc */
  onStepStart(): void {
    // Inside a navigator step — the next LLM call is the navigator.
    this.nextPhase = "navigator";
  }

  /** @inheritdoc */
  onStepEnd(_ctx: CallbackContext, actions: ActionResult[]): void {
    this.totalSteps += 1;
    this.totalActions += actions.length;
    for (const r of actions) {
      const type = r.action.type;
      const counts = this.actionsByType[type] ?? { total: 0, successes: 0, failures: 0 };
      counts.total += 1;
      if (r.success) counts.successes += 1;
      else counts.failures += 1;
      this.actionsByType[type] = counts;
    }
    // Between steps — the next LLM call COULD be the planner (if the
    // interval hits). Guess "planner"; if the next hook is onStepStart
    // (no planner this round), it will override back to "navigator".
    this.nextPhase = "planner";
  }

  /** @inheritdoc */
  onLLMEnd(_ctx: CallbackContext, response: LLMResponseInfo): void {
    const usage = response.usage;
    if (!usage) return;
    const phase = this.nextPhase;
    if (phase === "planner") {
      this.plannerCalls += 1;
      this.plannerTokensIn += usage.tokensIn;
      this.plannerTokensOut += usage.tokensOut;
    } else {
      this.navigatorCalls += 1;
      this.navigatorTokensIn += usage.tokensIn;
      this.navigatorTokensOut += usage.tokensOut;
    }
    this.totalTokensIn += usage.tokensIn;
    this.totalTokensOut += usage.tokensOut;
  }

  /** @inheritdoc */
  onCost(_ctx: CallbackContext, usage: LLMUsageInfo): void {
    this.totalCostUsd += usage.costUsd;
  }

  /** @inheritdoc */
  onLoopWarning(): void {
    this.loopWarnings += 1;
  }

  /** @inheritdoc */
  onCompaction(): void {
    this.compactions += 1;
  }

  /** @inheritdoc */
  onError(_ctx: CallbackContext, _message: string, recoverable: boolean): void {
    this.errorTotal += 1;
    if (recoverable) this.errorRecoverable += 1;
    else this.errorFatal += 1;
  }

  /** @inheritdoc */
  onRunEnd(result: AgentRunResult): void {
    // Reconcile totals with the authoritative result (the result is built
    // by the orchestrator from its own counters — treat it as ground truth
    // when our accumulators are zero, e.g. when this callback was
    // registered late and missed the onCost / onStepEnd events).
    if (this.totalCostUsd === 0 && result.totalCostUsd > 0) {
      this.totalCostUsd = result.totalCostUsd;
    }
    if (this.totalTokensIn === 0 && result.totalTokensIn > 0) {
      this.totalTokensIn = result.totalTokensIn;
    }
    if (this.totalTokensOut === 0 && result.totalTokensOut > 0) {
      this.totalTokensOut = result.totalTokensOut;
    }
  }
}
