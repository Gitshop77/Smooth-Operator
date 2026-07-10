/**
 * `makeHistoryItem` — build a HistoryItem for orchestrator / judge / message
 * builder tests.
 *
 * Was duplicated across three test files with slightly different signatures:
 *   - `integration.test.ts`        — `makeHistoryItem(overrides)` (step=0 default)
 *   - `judge-retry.test.ts`        — `makeHistoryItem(step)` (no overrides)
 *   - `orchestrator-logic.test.ts` — `makeHistoryItem(step, overrides)`
 *
 * Unified signature: `makeHistoryItem(step?, overrides?)` — `step` defaults to
 * 0 and `overrides` defaults to `{}`. Both old call patterns work.
 */
import type { HistoryItem } from "../../src/lib/agent/types";

export function makeHistoryItem(
  step: number = 0,
  overrides: Partial<HistoryItem> = {},
): HistoryItem {
  return {
    step,
    agent: "navigator",
    evaluation: "Verdict: Success",
    memory: `Step ${step} done`,
    goal: `Goal ${step}`,
    results: [],
    ...overrides,
  };
}
