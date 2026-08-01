/**
 * Terminal-emission guards:
 *
 * 1. `finish()` must emit the terminal `done` event + `runEnd` dispatch AT MOST
 *    ONCE per run. Multiple call sites can fire in a single run — e.g. a
 *    cost-capped compaction (`checkAndRunCompaction`) calls `finish()` and then
 *    the step CONTINUES, so the navigator's Budget-exceeded catch or the next
 *    step-boundary cost-cap check would emit a SECOND `done` event + a second
 *    `runEnd` dispatch (double finalization for every SSE/dispatcher
 *    subscriber).
 * 2. `costCapExceeded` writes `state.finalResult`; repeated calls must not
 *    clobber an already-set terminal result, and the Budget-exceeded planner
 *    catch must not re-emit / overwrite the final result costCapExceeded
 *    already recorded.
 */
import { describe, test, expect, vi } from "vitest";
import { finish } from "../src/lib/agent/loop/orchestrator-helpers";
import { costCapExceeded } from "../src/lib/agent/loop/helpers/state-helpers";
import { callPlannerAndHandleError } from "../src/lib/agent/loop/phases/planner-phases";
import type { LoopState } from "../src/lib/agent/loop/types";

function mkTerminalState() {
  const events: unknown[] = [];
  const runEnd = vi.fn(async (result: unknown) => { void result; });
  const state = {
    step: 0,
    onEvent: (e: unknown) => events.push(e),
    dispatcher: { runEnd },
    finalResult: undefined as { success: boolean; text: string } | undefined,
  };
  return { events, runEnd, state };
}

function mkCostState(finalResult?: { success: boolean; text: string }) {
  const state: { config: { costCapUsd: number }; totalCostUsd: number; finalResult?: { success: boolean; text: string } } = {
    config: { costCapUsd: 1 },
    totalCostUsd: 2,
  };
  if (finalResult !== undefined) state.finalResult = finalResult;
  return state;
}

describe("finish() terminal emission", () => {
  test("emits exactly one done event + one runEnd dispatch across repeated calls", async () => {
    const { events, runEnd, state } = mkTerminalState();
    await finish(state as unknown as LoopState, false, "first reason");
    await finish(state as unknown as LoopState, false, "second reason");

    const doneEvents = events.filter((e) => (e as { type: string }).type === "done");
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0] as { text: string }).text).toBe("first reason");
    expect(runEnd).toHaveBeenCalledTimes(1);
  });

  test("the runEnd dispatch carries the same text as the done event", async () => {
    const { events, runEnd, state } = mkTerminalState();
    await finish(state as unknown as LoopState, false, "some reason");

    const doneEvent = events.find((e) => (e as { type: string }).type === "done") as { text: string };
    const runEndResult = runEnd.mock.calls[0][0] as { success: boolean; text: string };
    expect(doneEvent.text).toBe(runEndResult.text);
    expect(runEndResult.success).toBe(false);
  });
});

describe("costCapExceeded finalResult writes", () => {
  test("still records a final result when none is set yet", () => {
    const state = mkCostState();
    expect(costCapExceeded(state as never)).toBe(true);
    expect(state.finalResult).toEqual({ success: false, text: "Cost cap of $1.00 reached." });
  });

  test("does NOT overwrite an already-set finalResult (e.g. a judge's success)", () => {
    const state = mkCostState({ success: true, text: "judge verified completion" });
    expect(costCapExceeded(state as never)).toBe(true);
    expect(state.finalResult).toEqual({ success: true, text: "judge verified completion" });
  });

  test("does not touch finalResult when the cap is not exceeded", () => {
    const state = mkCostState();
    state.totalCostUsd = 0.5;
    state.finalResult = { success: true, text: "x" };
    expect(costCapExceeded(state as never)).toBe(false);
    expect(state.finalResult).toEqual({ success: true, text: "x" });
  });
});

describe("planner Budget-exceeded guard", () => {
  test("abort path uses the finalResult text costCapExceeded already recorded (no re-emit, no clobber)", async () => {
    const events: unknown[] = [];
    const state = {
      deps: {
        onEvent: (e: unknown) => events.push(e),
        plannerCall: vi.fn(async () => ({
          raw: JSON.stringify({ thinking: "x", decision: "continue", plan: ["a"], next_goal: "g" }),
          model: "test",
        })),
      },
      task: "t",
      plan: ["a"],
      currentPlanItem: 0,
      step: 3,
      config: { costCapUsd: 0.01, maxFailures: 3 },
      navigatorHistory: [],
      compactedMemory: undefined,
      dispatcher: undefined,
      consecutiveFailures: 0,
      totalCostUsd: 0.02,
      finalResult: undefined as { success: boolean; text: string } | undefined,
      onEvent: (e: unknown) => events.push(e),
    };

    const res = await callPlannerAndHandleError(state as unknown as LoopState, {
      url: "https://example.com",
      tabs: [],
    });

    expect(res.status).toBe("abort");
    const doneEvents = events.filter((e) => (e as { type: string }).type === "done");
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0] as { text: string }).text).toBe("Cost cap of $0.01 reached.");
    expect(state.finalResult).toEqual({ success: false, text: "Cost cap of $0.01 reached." });
  });

  test("fallback: a custom Budget-exceeded throw without a set finalResult still emits done with the raw message", async () => {
    const events: unknown[] = [];
    const state = {
      deps: {
        onEvent: (e: unknown) => events.push(e),
        plannerCall: vi.fn(async () => {
          throw new Error("Budget exceeded: custom budget handler");
        }),
      },
      task: "t",
      plan: ["a"],
      currentPlanItem: 0,
      step: 1,
      config: { costCapUsd: undefined, maxFailures: 3 },
      navigatorHistory: [],
      compactedMemory: undefined,
      dispatcher: undefined,
      consecutiveFailures: 0,
      totalCostUsd: 0,
      finalResult: undefined as { success: boolean; text: string } | undefined,
      onEvent: (e: unknown) => events.push(e),
    };

    const res = await callPlannerAndHandleError(state as unknown as LoopState, {
      url: "https://example.com",
      tabs: [],
    });

    expect(res.status).toBe("abort");
    const doneEvents = events.filter((e) => (e as { type: string }).type === "done");
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0] as { text: string }).text).toBe("Budget exceeded: custom budget handler");
    expect(state.finalResult).toEqual({ success: false, text: "Budget exceeded: custom budget handler" });
  });
});
