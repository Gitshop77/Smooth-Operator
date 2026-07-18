/**
 * Cost-cap enforcement when the LLM provider omits token usage.
 *
 * `accountUsage` returns a small provider-independent floor (MISSING_USAGE_FLOOR_USD)
 * when usage is omitted while a cost cap is active, so `costCapExceeded` can still
 * trip (the cap must not go inert just because the provider didn't report tokens).
 *
 * `costCapExceeded` truth table: exceeded / not-exceeded / cap undefined|0 /
 * NaN. The orchestrator finalizes `success:false` with a "Cost cap … reached"
 * reason when spend crosses the cap on an unmeasured (no-usage) call.
 */

import { describe, test, expect, vi } from "vitest";
import { costCapExceeded } from "../src/lib/agent/loop/helpers/state-helpers";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import { makeState } from "./helpers";

// Minimal LoopState-shaped object — costCapExceeded only reads config.costCapUsd
// and totalCostUsd.
function mkState(costCapUsd: number | undefined, totalCostUsd: number): unknown {
  return { config: { costCapUsd }, totalCostUsd };
}

describe("costCapExceeded", () => {
  test("exceeded when spend >= cap", () => {
    expect(costCapExceeded(mkState(1, 1.5) as never)).toBe(true);
  });
  test("not-exceeded when spend < cap", () => {
    expect(costCapExceeded(mkState(1, 0.5) as never)).toBe(false);
  });
  test("undefined cap => no cap (opt-out)", () => {
    expect(costCapExceeded(mkState(undefined, 9999) as never)).toBe(false);
  });
  test("zero cap => no cap (opt-out)", () => {
    expect(costCapExceeded(mkState(0, 9999) as never)).toBe(false);
  });
  test("NaN cap => treated as opt-out (not exceeded)", () => {
    expect(costCapExceeded(mkState(NaN, 9999) as never)).toBe(false);
  });
  test("NaN total with a set cap => not exceeded (no false positive)", () => {
    expect(costCapExceeded(mkState(1, NaN) as never)).toBe(false);
  });
});

const BASE_CONFIG = {
  maxSteps: 10,
  maxActionsPerStep: 10,
  plannerInterval: 100,
  maxFailures: 3,
  enableLoopDetection: true,
  enableCompaction: false,
  compactionStepInterval: 1000,
  compactionCharThreshold: 1_000_000,
  enableJudge: false,
  enableEarlyStop: false,
  // A cap far below the per-omitted-call floor (0.01) so the FIRST unmeasured
  // LLM call trips it.
  costCapUsd: 0.005,
};

describe("orchestrator finalizes on cost cap when usage is omitted", () => {
  test("run ends success:false with a Cost-cap reason after an unmeasured call", async () => {
    const events: unknown[] = [];
    const deps: LoopDeps = {
      task: "test task",
      // Planner + navigator return VALID output but OMIT tokensIn/tokensOut, so
      // the missing-usage floor is accrued while the cap is active.
      plannerCall: vi.fn(async () => ({
        raw: JSON.stringify({ thinking: "x", decision: "continue", plan: ["a"], next_goal: "g" }),
        model: "test",
      })),
      navigatorCall: vi.fn(async () => ({
        raw: JSON.stringify({
          thinking: "x",
          evaluation_previous_goal: "",
          memory: "",
          next_goal: "g",
          action: [{ type: "done", success: true, text: "done" }],
        }),
        model: "test",
      })),
      getTabs: vi.fn(async () => [
        { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
      ]),
      extractState: vi.fn(async () => makeState()),
      executeActions: vi.fn(async (actions) =>
        (actions as unknown[]).map((action) => ({ action, success: true, message: "ok" })),
      ),
      onEvent: (e: unknown) => events.push(e),
      settleDelay: 0,
      config: { ...BASE_CONFIG },
    };

    await runAgentLoop(deps);

    const doneEvent = events.find(
      (e) => (e as { type: string }).type === "done",
    ) as { type: string; success: boolean; text: string } | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.success).toBe(false);
    // Either the in-helper "Budget exceeded" throw or the step-boundary
    // "Cost cap … reached" check — both signal the cap stopped the run.
    expect(doneEvent!.text).toMatch(/cost cap|Budget exceeded/i);
  });
});
