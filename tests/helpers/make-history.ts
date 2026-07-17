/**
 * `makeHistoryItem` — build a HistoryItem for orchestrator / judge / message
 * builder tests.
 *
 * Was duplicated across three test files with slightly different signatures:
 * - `integration.test.ts` — `makeHistoryItem(overrides)` (step=0 default)
 * - `judge-retry.test.ts` — `makeHistoryItem(step)` (no overrides)
 * - `orchestrator-logic.test.ts` — `makeHistoryItem(step, overrides)`
 *
 * Unified signature: `makeHistoryItem(step?, overrides?)` — `step` defaults to
 * 0 and `overrides` defaults to `{}`. Passing a single object as the first
 * argument is also supported (treated as `overrides`) via the guard below.
 */
import type { HistoryItem } from "../../src/lib/agent/types";

export function makeHistoryItem(
  step: number | Partial<HistoryItem> = 0,
  overrides: Partial<HistoryItem> = {},
): HistoryItem {
  if (typeof step === "object" && step !== null) {
    overrides = step as Partial<HistoryItem>;
    step = 0;
  }
  const resolvedStep = overrides.step ?? step;
  return {
    step: resolvedStep,
    agent: "navigator",
    evaluation: "Verdict: Success",
    memory: `Step ${resolvedStep} done`,
    goal: `Goal ${resolvedStep}`,
    results: [],
    ...overrides,
  };
}
