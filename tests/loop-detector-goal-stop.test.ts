/**
 * Deterministic (no-LLM) coverage for goal-level loop termination.
 *
 * The goal detector used to warn only — a planner stuck re-assigning the same
 * goal would warn forever and burn the full maxSteps budget. These tests pin
 * the termination behavior so any regression (warn-only, or a wrong threshold)
 * is caught without an LLM.
 */
import { describe, test, expect, vi } from "vitest";
import { LoopDetector, GOAL_WARN_THRESHOLD, GOAL_TOP_THRESHOLD } from "../src/lib/agent/loop/loop-detector";
import { runPeriodicPlannerCheck } from "../src/lib/agent/loop/phases/planner-phases";
import type { LoopState, LoopDeps } from "../src/lib/agent/loop/types";
import type { BrowserState } from "../src/lib/agent/types";

const FROZEN_GOAL = "keep clicking the same button";

describe("LoopDetector goal-level termination signal", () => {
  test("recordGoal reaches the warn milestone before the top milestone", () => {
    const det = new LoopDetector();
    for (let i = 0; i < GOAL_WARN_THRESHOLD; i++) {
      det.recordGoal(FROZEN_GOAL);
    }
    const atWarn = det.recordGoal(FROZEN_GOAL);
    expect(atWarn).toBeGreaterThanOrEqual(GOAL_WARN_THRESHOLD);
    expect(atWarn).toBeLessThan(GOAL_TOP_THRESHOLD);
  });

  test("recordGoal returns >= GOAL_TOP_THRESHOLD once the top milestone is hit", () => {
    const det = new LoopDetector();
    let count = 0;
    for (let i = 0; i < GOAL_TOP_THRESHOLD; i++) {
      count = det.recordGoal(FROZEN_GOAL);
    }
    expect(count).toBeGreaterThanOrEqual(GOAL_TOP_THRESHOLD);
  });

  test("different goals do not accumulate toward the threshold", () => {
    const det = new LoopDetector();
    for (let i = 0; i < GOAL_TOP_THRESHOLD + 2; i++) {
      det.recordGoal(`${FROZEN_GOAL} #${i}`);
    }
    expect(det.recordGoal(FROZEN_GOAL)).toBeLessThan(GOAL_TOP_THRESHOLD);
  });
});

describe("runPeriodicPlannerCheck goal-level hard stop", () => {
  function makeBrowserState(): BrowserState {
    return {
      url: "https://example.com",
      title: "Test",
      tabs: [],
      elements: [],
      elementsText: "[empty]",
      pageInfo: "",
      newElementCount: 0,
      scrollTop: 0,
      scrollHeight: 1000,
      viewportHeight: 800,
      selectorMap: {},
    };
  }

  function makeState(events: unknown[]): LoopState {
    const deps: LoopDeps = {
      task: "test task",
      plannerCall: vi.fn(async () => ({
        raw: JSON.stringify({ thinking: "x", decision: "continue", next_goal: FROZEN_GOAL }),
        tokensIn: 0,
        tokensOut: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        model: "test",
        costUsd: 0,
      })),
      navigatorCall: vi.fn(),
      getTabs: vi.fn(async () => [{ active: true, url: "https://example.com" }]),
      extractState: vi.fn(),
      observeState: vi.fn(),
      onEvent: (e: unknown) => events.push(e),
      waitForSettled: vi.fn(),
      signal: undefined,
      settleDelay: 0,
    } as unknown as LoopDeps;

    return {
      deps,
      config: {
        maxSteps: 100,
        plannerInterval: 3,
        maxFailures: 5,
        costCapUsd: 100,
        enableEarlyStop: true,
      } as LoopState["config"],
      task: "test task",
      onEvent: (e: unknown) => events.push(e),
      signal: undefined,
      settleDelay: 0,
      navigatorHistory: [],
      loopDetector: new LoopDetector(),
      plan: undefined,
      currentPlanItem: undefined,
      step: 0,
      navigatorStepsSincePlanner: 0,
      consecutiveFailures: 0,
      consecutiveParseFailures: 0,
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      lastCompactionStep: undefined,
      compactedMemory: undefined,
      pendingLoopWarning: undefined,
      budgetWarningFired: false,
      costBudgetWarningFired: false,
      currentGoal: FROZEN_GOAL,
    } as unknown as LoopState;
  }

  test("finalizes the run as success:false when enableEarlyStop and the goal top threshold is reached", async () => {
    const events: unknown[] = [];
    const state = makeState(events);

    let finalized = false;
    for (let i = 0; i < GOAL_TOP_THRESHOLD + 2; i++) {
      const res = await runPeriodicPlannerCheck(state, makeBrowserState());
      if (res.finalized) {
        finalized = true;
        break;
      }
    }

    expect(finalized).toBe(true);
    expect(state.finalResult).toEqual({
      success: false,
      text: expect.stringContaining(FROZEN_GOAL),
    });
    const done = events.find(
      (e) => (e as { type?: string }).type === "done",
    ) as { type: string; success: boolean } | undefined;
    expect(done).toBeDefined();
    expect(done?.success).toBe(false);
  });

  test("does NOT hard-stop when enableEarlyStop is false (warn only)", async () => {
    const events: unknown[] = [];
    const state = makeState(events);
    (state.config as { enableEarlyStop: boolean }).enableEarlyStop = false;

    for (let i = 0; i < GOAL_TOP_THRESHOLD + 2; i++) {
      const res = await runPeriodicPlannerCheck(state, makeBrowserState());
      expect(res.finalized).toBe(false);
    }
    expect(state.finalResult).toBeUndefined();
  });
});
