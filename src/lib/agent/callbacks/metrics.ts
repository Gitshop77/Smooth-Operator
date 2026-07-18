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
 * - Initially the next LLM call is the planner (the very first call in
 * a run is the planner establishing the initial plan).
 * - `onPlannerStep` sets the next phase to "navigator" (the planner just
 * ran; the navigator runs next).
 * - `onStepStart` sets the next phase to "navigator" (we're inside a
 * navigator step).
 * - `onStepEnd` sets the next phase to "planner" (between steps the
 * planner MAY run if the interval hits — if it doesn't, the next
 * `onStepStart` overrides the guess back to "navigator").
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
    /**
 * Tokens that could not be attributed to a phase (e.g. recovered during
 * `onRunEnd` reconciliation when this callback was registered late and
 * missed the per-call `onLLMEnd` events). Always part of the
 * `totalTokensIn/Out` sum, but not double-counted in planner/navigator.
 *
 * NOTE: `unattributed.calls` is NOT a true missed-call count — the
 * callback cannot recover how many calls it missed, only the token
 * deltas. It is a boolean-ish "had-gap" indicator: `1` when any
 * unattributed tokens exist, `0` otherwise (see `onRunEnd`). Only
 * `unattributed.tokensIn/Out` are accurate.
 */
    unattributed: PhaseLLMMetrics;
  };
  /** Total tokens consumed across all phases (sum of planner + navigator + unattributed). */
  totalTokensIn: number;
  /** Total tokens produced across all phases (sum of planner + navigator + unattributed). */
  totalTokensOut: number;
  /**
 * Total USD cost across all phases. Sourced from the authoritative
 * `AgentRunResult.totalCostUsd` in `onRunEnd` (which OVERWRITES any value
 * accumulated by `onCost`) — the orchestrator's own counters are ground
 * truth, so per-call `onCost` accumulation is discarded when the run ends.
 */
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
  private totalSteps = AgentMetricsCallback.ZERO.totalSteps;
  private totalActions = AgentMetricsCallback.ZERO.totalActions;
  private readonly actionsByType: Record<string, ActionCounts> = {};

 // LLM phase attribution state machine (see file-level docstring).
  private nextPhase: "planner" | "navigator" = "planner";
  private plannerCalls = AgentMetricsCallback.ZERO.plannerCalls;
  private plannerTokensIn = AgentMetricsCallback.ZERO.plannerTokensIn;
  private plannerTokensOut = AgentMetricsCallback.ZERO.plannerTokensOut;
  private navigatorCalls = AgentMetricsCallback.ZERO.navigatorCalls;
  private navigatorTokensIn = AgentMetricsCallback.ZERO.navigatorTokensIn;
  private navigatorTokensOut = AgentMetricsCallback.ZERO.navigatorTokensOut;
 // Tokens recovered during onRunEnd reconciliation (late registration) that
 // could not be attributed to a specific phase.
  private unattributedCalls = AgentMetricsCallback.ZERO.unattributedCalls;
  private unattributedTokensIn = AgentMetricsCallback.ZERO.unattributedTokensIn;
  private unattributedTokensOut = AgentMetricsCallback.ZERO.unattributedTokensOut;

  private totalTokensIn = AgentMetricsCallback.ZERO.totalTokensIn;
  private totalTokensOut = AgentMetricsCallback.ZERO.totalTokensOut;
  private totalCostUsd = AgentMetricsCallback.ZERO.totalCostUsd;
  private loopWarnings = AgentMetricsCallback.ZERO.loopWarnings;
  private compactions = AgentMetricsCallback.ZERO.compactions;
  private errorTotal = AgentMetricsCallback.ZERO.errorTotal;
  private errorRecoverable = AgentMetricsCallback.ZERO.errorRecoverable;
  private errorFatal = AgentMetricsCallback.ZERO.errorFatal;

  private static readonly ZERO = {
    totalSteps: 0,
    totalActions: 0,
    plannerCalls: 0,
    plannerTokensIn: 0,
    plannerTokensOut: 0,
    navigatorCalls: 0,
    navigatorTokensIn: 0,
    navigatorTokensOut: 0,
    unattributedCalls: 0,
    unattributedTokensIn: 0,
    unattributedTokensOut: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCostUsd: 0,
    loopWarnings: 0,
    compactions: 0,
    errorTotal: 0,
    errorRecoverable: 0,
    errorFatal: 0,
  };

  /**
 * Reset all accumulators to zero and re-initialise the phase state
 * machine. Useful when reusing one instance across multiple runs.
 */
  reset(): void {
    Object.assign(this, AgentMetricsCallback.ZERO);
    for (const k of Object.keys(this.actionsByType)) delete this.actionsByType[k];
    this.nextPhase = "planner";
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
        unattributed: {
          calls: this.unattributedCalls,
          tokensIn: this.unattributedTokensIn,
          tokensOut: this.unattributedTokensOut,
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
 // Guard against malformed/missing `usage` (a provider contract regression
 // can emit non-numeric or absent fields). Without this, a single `NaN`
 // poisons every accumulator total AND permanently disables the
 // `onRunEnd` late-registration recovery (since `totalTokensIn === 0`
 // then evaluates false). Warn once and skip rather than silently corrupt.
    const tIn = typeof usage.tokensIn === "number" && Number.isFinite(usage.tokensIn) ? usage.tokensIn : undefined;
    const tOut = typeof usage.tokensOut === "number" && Number.isFinite(usage.tokensOut) ? usage.tokensOut : undefined;
    if (tIn === undefined || tOut === undefined) {
      console.warn("[metrics] onLLMEnd: usage has non-numeric tokensIn/tokensOut; skipping token accounting");
      return;
    }
    const phase = this.nextPhase;
    if (phase === "planner") {
      this.plannerCalls += 1;
      this.plannerTokensIn += tIn;
      this.plannerTokensOut += tOut;
    } else {
      this.navigatorCalls += 1;
      this.navigatorTokensIn += tIn;
      this.navigatorTokensOut += tOut;
    }
    this.totalTokensIn += tIn;
    this.totalTokensOut += tOut;
  }

  /** @inheritdoc */
  onCost(_ctx: CallbackContext, usage: LLMUsageInfo): void {
    const cost = typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : undefined;
    if (cost === undefined) {
      console.warn("[metrics] onCost: costUsd is non-numeric; skipping cost accounting");
      return;
    }
    this.totalCostUsd += cost;
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
 // Reconcile with the authoritative result. The orchestrator builds the
 // result from its own counters, so treat its totals as ground truth even
 // when this callback was registered late and only partially captured the
 // per-event hooks (onCost / onStepEnd / onLLMEnd). We keep whatever
 // per-phase attribution we *did* capture and drop the remainder into the
 // `unattributed` bucket so the `total == sum(llmByPhase.*)` invariant
 // always holds — neither silently undercounting nor corrupting attribution.
    if (this.totalSteps === 0 && result.stepCount > 0) {
      this.totalSteps = result.stepCount;
    }
 // `totalActions` is intentionally NOT reconciled here: `AgentRunResult`
 // exposes no authoritative action count, so there is no source to recover
 // missed `onStepEnd` action tallies from. `totalActions` therefore reflects
 // only the steps this callback captured (it equals the sum of
 // `actionsByType[*].total`). This avoids the overstatement in the earlier
 // "recovers when registered late" comment — step count IS recoverable,
 // action count is not .
 // Cost has no per-phase split — the result is authoritative, overwrite.
    this.totalCostUsd = result.totalCostUsd;
 // Tokens: set the totals from the authoritative result, then attribute the
 // gap (anything we missed) to `unattributed` so the phase sums still add up.
    this.totalTokensIn = result.totalTokensIn;
    this.totalTokensOut = result.totalTokensOut;
    const gapIn = result.totalTokensIn - this.plannerTokensIn - this.navigatorTokensIn;
    const gapOut = result.totalTokensOut - this.plannerTokensOut - this.navigatorTokensOut;
 // Positive gap: tokens we missed (late registration) — attribute the
 // remainder to `unattributed` so `total == sum(llmByPhase.*)` holds.
    if (gapIn > 0 || gapOut > 0) {
      this.unattributedCalls += 1;
      this.unattributedTokensIn += Math.max(0, gapIn);
      this.unattributedTokensOut += Math.max(0, gapOut);
    }
 // Negative gap: the per-phase tokens we accumulated EXCEED the
 // authoritative total. This should not happen (double counting, a
 // provider usage regression, or the result being built from stale/partial
 // counters), and the `total == sum(llmByPhase.*)` invariant CANNOT be
 // preserved by pushing into `unattributed` (that would only widen the
 // overshoot). Do not silently drop it: warn explicitly, and record the
 // overshoot magnitude on the `unattributed` bucket as a negative delta so
 // the reconciliation invariant is restored (planner + navigator +
 // unattributed == authoritative total) rather than left broken.
    if (gapIn < 0 || gapOut < 0) {
      console.warn(
        `[metrics] onRunEnd: accumulated phase tokens exceed authoritative total ` +
          `(gapIn=${gapIn}, gapOut=${gapOut}); reconciling invariant against ground-truth total.`,
      );
 // Mirror the positive-gap branch: a negative reconciliation is also a gap,
 // so flag `unattributedCalls` (the boolean-ish "had-gap" indicator) so the
 // field is consistent whether the phase sums over- or under-shot the total.
      this.unattributedCalls = 1;
      if (gapIn < 0) this.unattributedTokensIn += gapIn;
      if (gapOut < 0) this.unattributedTokensOut += gapOut;
    }
  }
}
