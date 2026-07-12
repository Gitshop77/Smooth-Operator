/**
 * Early-stop detector — kills a run when the agent is clearly stuck.
 *
 * Two stopping conditions (both opt-in via the orchestrator config):
 *
 *   1. **Parse-failure threshold** — N consecutive navigator steps produced
 *      unparseable output. Tracked via a counter the orchestrator passes in
 *      (incremented on parse failure, reset on any successful step).
 *
 *   2. **Repeating-action threshold** — the last N actions are all
 *      {@link isEquivalentAction} to each other (and the last action isn't
 *      `input`/`alert_send_keys` — those are legitimately repeatable *within a
 *      single field*: typing the same text into the same field repeatedly is
 *      fine, sending keys to multiple alert prompts is fine). The per-K
 *      (consecutive) check excludes these types, but the whole-history branch
 *      still flags typing the *same text* into 3+ *different* fields, which is
 *      suspicious.
 *
 * The orchestrator already has a `LoopDetector` that emits escalating
 * warnings at 5 / 8 / 12 repeats. This early-stop is a stricter, opt-in
 * layer on top: when enabled, it STOPS the run at 3+ repeats (instead of
 * just warning). Existing tests / callers that don't enable early-stop see
 * no behavior change.
 */

import type { HistoryItem } from "../types";
import { isEquivalentAction, type Action } from "../tools/schema";

/** Configurable thresholds for the two early-stop conditions. */
export interface EarlyStopThresholds {
  /** Consecutive parse failures before stopping. Default `5`. */
  parsingFailure: number;
  /** Consecutive equivalent actions before stopping. Default `3`. */
  repeatingAction: number;
}

/** Default thresholds (mirrors the canonical benchmark pattern). */
export const DEFAULT_EARLY_STOP_THRESHOLDS: EarlyStopThresholds = {
  parsingFailure: 5,
  repeatingAction: 3,
};

/** Result of an {@link earlyStop} check. */
export interface EarlyStopResult {
  /** True when the run should stop now. */
  stop: boolean;
  /** Human-readable reason (empty when `stop === false`). */
  reason: string;
}

/**
 * Action types that are legitimately repeatable — typing the same text in
 * different fields, sending keys to multiple alert prompts. These are
 * excluded from the repeating-action check (case 2) so the early-stop
 * doesn't fire on normal form-filling flows.
 */
const REPEATABLE_ACTION_TYPES = new Set<string>(["input", "alert_send_keys"]);

/**
 * Clamp a threshold to a positive integer. A non-positive, NaN, or missing
 * value falls back to `fallback` so `earlyStop` can't be trivially disabled
 * (parsingFailure<=0 → stop on the first step) or made degenerate
 * (repeatingAction<=0 → `slice(-0)` returns the whole action array).
 */
function clampThreshold(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Check whether the run should early-stop.
 *
 * The caller passes in:
 *   - `history` — the navigator history (used to extract the last K actions).
 *   - `consecutiveParseFailures` — current counter (incremented on parse
 *     failure, reset on any successful step).
 *   - `thresholds` — the configured thresholds.
 *
 * The function is pure — it doesn't mutate any state. The orchestrator owns
 * the counters and decides what to do with the result (typically: emit a
 * `done(success=false)` event + return).
 */
export function earlyStop(
  history: HistoryItem[],
  consecutiveParseFailures: number,
  thresholds: EarlyStopThresholds = DEFAULT_EARLY_STOP_THRESHOLDS,
): EarlyStopResult {
  // Normalize + clamp the (possibly attacker-influenced / misconfigured)
  // thresholds so a non-positive value can't abort every run instantly or
  // make the repeating-action slice degenerate (e.g. slice(-0) returns the
  // whole array).
  const parsingFailure = clampThreshold(thresholds.parsingFailure, DEFAULT_EARLY_STOP_THRESHOLDS.parsingFailure);
  const repeatingAction = clampThreshold(thresholds.repeatingAction, DEFAULT_EARLY_STOP_THRESHOLDS.repeatingAction);
  const parseFails = Number.isFinite(consecutiveParseFailures) && consecutiveParseFailures > 0
    ? Math.floor(consecutiveParseFailures)
    : 0;

  // Case 1: K consecutive parse failures.
  if (parseFails >= parsingFailure) {
    return {
      stop: true,
      reason: `Failed to parse actions for ${parseFails} consecutive steps`,
    };
  }

  // Case 2: last K actions are all equivalent to the last action (and the
  // last action isn't a legitimately-repeatable TYPE-like action).
  // Filter out any results with no associated action so a malformed/empty
  // history entry can't crash the index into `lastAction.type`.
  const allActions = history
    .flatMap((h) => h.results.map((r) => r.action))
    .filter((a): a is Action => a != null);
  if (allActions.length === 0) return { stop: false, reason: "" };
  const lastAction = allActions[allActions.length - 1];
  if (!lastAction) return { stop: false, reason: "" };
  const k = repeatingAction;
  const lastK = allActions.slice(-k);
  if (lastK.length < k) return { stop: false, reason: "" };

  if (REPEATABLE_ACTION_TYPES.has(lastAction.type)) {
    // For TYPE-like actions, count across the WHOLE history (typing the
    // same text in 3+ different fields IS suspicious).
    const sameCount = allActions.filter((a) => isEquivalentAction(a, lastAction)).length;
    if (sameCount >= k) {
      return {
        stop: true,
        reason: `Same typing action ("${lastAction.type}") for ${sameCount} steps`,
      };
    }
    return { stop: false, reason: "" };
  }

  // For non-TYPE actions: only the last K matter (a few equivalent clicks in
  // a row is suspicious; the same click 3 steps ago + 10 different actions
  // in between is NOT).
  const allEquivalent = lastK.every((a) => isEquivalentAction(a, lastAction));
  if (allEquivalent) {
    return {
      stop: true,
      reason: `Same action ("${lastAction.type}") for ${k} consecutive steps`,
    };
  }
  return { stop: false, reason: "" };
}
