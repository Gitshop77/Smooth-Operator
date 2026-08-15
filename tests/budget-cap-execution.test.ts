/**
 * Post-execution budget-cap termination.
 *
 * The loop must stop cleanly when the budget cap is exceeded DURING action
 * execution, ending in the terminal state EXACTLY ONCE with the recorded
 * finalResult — no double terminal emit, no clobber, no retry-as-recoverable.
 *
 * Covered here:
 * 1. Built-in path (no `deps.executeActions` override): a Budget-exceeded
 *    error surfacing from the action queue finalizes the run with the budget
 *    message as the recorded finalResult (mirrors the navigator/planner
 *    catches) — done event + runEnd dispatch both fire exactly once and agree.
 * 2. The queue itself stops cleanly when the cap trips mid-queue: the current
 *    action's result carries the blocked marker, remaining actions are padded,
 *    and no later action executes.
 */

import { describe, test, expect, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import { executeActionQueue } from "../src/lib/agent/loop/helpers/action-queue";
import { LoopDetector } from "../src/lib/agent/loop/loop-detector";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { CallbackDispatcher, CallbackContext } from "../src/lib/agent/callbacks";
import type { AgentAction, AgentConfig, ActionResult } from "../src/lib/agent/types";
import { makeState } from "./helpers";

const BASE_CONFIG = {
  maxSteps: 10,
  maxActionsPerStep: 10,
  plannerInterval: 100,
  maxFailures: 3,
  enableLoopDetection: false,
  enableCompaction: false,
  compactionStepInterval: 1000,
  compactionCharThreshold: 1_000_000,
  enableJudge: false,
  enableEarlyStop: false,
  costCapUsd: undefined,
};

describe("budget cap exceeded during execution — built-in queue path", () => {
  test("a Budget-exceeded error from the queue finalizes the run once with the budget message recorded", async () => {
    const events: unknown[] = [];
    const onRunEnd = vi.fn(async (_result: unknown) => {});
    const deps: LoopDeps = {
      task: "test task",
      // No `executeActions` override → built-in executeActionQueue path.
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
          action: [{ type: "scroll", down: true, pages: 1 }],
        }),
        model: "test",
      })),
      getTabs: vi.fn(async () => [
        { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
      ]),
      extractState: vi.fn(async () => makeState()),
      onEvent: (e: unknown) => {
        events.push(e);
        // Simulate a budget-enforcing handler inside the queue throwing on
        // the first action execution.
        if ((e as { type: string }).type === "action") {
          throw new Error("Budget exceeded: cost cap reached");
        }
      },
      callbacks: [{ onRunEnd }],
      settleDelay: 0,
      config: { ...BASE_CONFIG },
    };

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => (e as { type: string }).type === "done");
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0] as { success: boolean; text: string }).success).toBe(false);
    expect((doneEvents[0] as { success: boolean; text: string }).text).toBe(
      "Budget exceeded: cost cap reached",
    );
    // The runEnd dispatch agrees with the done event (recorded finalResult,
    // no clobber) and fires exactly once (no double terminal emit).
    expect(onRunEnd).toHaveBeenCalledTimes(1);
    const runEndResult = onRunEnd.mock.calls[0][0] as { success: boolean; text: string };
    expect(runEndResult.success).toBe(false);
    expect(runEndResult.text).toBe("Budget exceeded: cost cap reached");
    // The budget stop must not have been retried as a recoverable failure.
    expect(deps.navigatorCall).toHaveBeenCalledTimes(1);
  });
});

describe("executeActionQueue — clean stop when the cap trips mid-queue", () => {
  const config = { maxActionsPerStep: 10, enableLoopDetection: false } as unknown as AgentConfig;

  function makeQueueDeps(): LoopDeps {
    return {
      onEvent: vi.fn(),
      signal: undefined,
      requestConfirmation: undefined,
      onTabAction: undefined,
      waitForNavigation: undefined,
    } as unknown as LoopDeps;
  }

  function makeDispatcher() {
    return {
      actionStart: vi.fn(async () => {}),
      actionEnd: vi.fn(async () => {}),
      loopWarning: vi.fn(async () => {}),
    } as unknown as CallbackDispatcher;
  }

  const scrollActions = [
    { type: "scroll", down: true, pages: 1 },
    { type: "scroll", down: true, pages: 1 },
    { type: "scroll", down: true, pages: 1 },
  ] as AgentAction[];

  test("cap trip mid-queue blocks the current action, pads the rest, and executes nothing further", async () => {
    let checks = 0;
    // First action: cap not exceeded → executes. Second action: cap trips.
    const costCapExceeded = () => ++checks > 1;
    const dispatcher = makeDispatcher();

    const queueResult = await executeActionQueue(
      makeQueueDeps(),
      scrollActions,
      makeState(),
      0,
      "standard",
      new LoopDetector(),
      config,
      dispatcher,
      { task: "t", step: 0, history: [] } as CallbackContext,
      costCapExceeded,
    );

    expect(queueResult.aborted).toBe(true);
    expect(queueResult.results).toHaveLength(3);
    // The action interrupted mid-queue carries the budget-blocked marker…
    expect(queueResult.results[1].message).toBe("BLOCKED: cost cap exceeded");
    // …and the remaining actions are padded, never executed.
    expect(queueResult.results[2].message).toBe("BLOCKED: prior action in the queue aborted the step");
    // Only the first action completed (actionEnd once) — the blocked and
    // padded actions never ran.
    expect(dispatcher.actionEnd).toHaveBeenCalledTimes(1);
  });

  test("control: with the cap never tripping, all actions execute to completion", async () => {
    const dispatcher = makeDispatcher();

    const queueResult = await executeActionQueue(
      makeQueueDeps(),
      scrollActions,
      makeState(),
      0,
      "standard",
      new LoopDetector(),
      config,
      dispatcher,
      { task: "t", step: 0, history: [] } as CallbackContext,
      () => false,
    );

    expect(queueResult.aborted).toBe(false);
    expect(queueResult.results).toHaveLength(3);
    expect(queueResult.results.every((r) => r.success)).toBe(true);
    expect(dispatcher.actionEnd).toHaveBeenCalledTimes(3);
  });
});

describe("budget-warning event — suppressed on the final step", () => {
  // the budget-warning event fired at step === floor(maxSteps*0.75)
  // even when that step is the LAST step (tiny runs), emitting a "75%" UI
  // warning with zero steps remaining while the matching prompt nudge
  // (injection-points.ts) is suppressed. The event must reuse the nudge's
  // is-last-step condition.
  function makeRunDeps(maxSteps: number, events: unknown[]) {
    return {
      task: "test task",
      config: { ...BASE_CONFIG, maxSteps },
      plannerCall: vi.fn(async () => ({
        raw: JSON.stringify({ thinking: "x", decision: "continue", plan: ["a"], next_goal: "g" }),
      })),
      navigatorCall: vi.fn(async () => ({
        raw: JSON.stringify({
          thinking: "x",
          evaluation_previous_goal: "",
          memory: "",
          next_goal: "g",
          action: [{ type: "scroll", down: true, pages: 1 }],
        }),
      })),
      getTabs: vi.fn(async () => [
        { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
      ]),
      extractState: vi.fn(async () => makeState()),
      executeActions: vi.fn(async (actions: AgentAction[]) =>
        actions.map((action) => ({ action, success: true, message: "ok" } as ActionResult)),
      ),
      onEvent: (e: unknown) => { events.push(e); },
      settleDelay: 0,
    } as LoopDeps;
  }

  test("maxSteps=4: no budget-warning event (the 75% step IS the final step)", async () => {
    const events: unknown[] = [];
    await runAgentLoop(makeRunDeps(4, events));
    expect(events.filter((e) => (e as { type: string }).type === "budget-warning")).toHaveLength(0);
  });

  test("maxSteps=8: budget-warning event fires exactly once at step 6", async () => {
    const events: unknown[] = [];
    await runAgentLoop(makeRunDeps(8, events));
    const warnings = events.filter((e) => (e as { type: string }).type === "budget-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: "budget-warning", step: 6, pct: 75 });
  });
});
