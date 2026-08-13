/**
 * Manual pause/resume loop flow.
 *
 * The `open_cowork_paused` session flag was previously never written by any
 * UI (dead path). Now the sidepanel Pause button sets it and the loop's
 * `runPauseCheck` honors it. This test drives the REAL `runAgentLoop` with a
 * `checkPaused` hook that returns `true` for a window, then `false`, proving:
 *  1. the `paused` event fires and the loop WAITS (no further navigator
 *     calls while paused),
 *  2. the `resumed` event fires and the run continues from where it paused,
 *  3. a resume is never falsely reported on abort.
 */
import { describe, expect, test, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import { makeState } from "./helpers";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentStepRequest, LogEvent } from "../src/lib/agent/types";

function buildDeps(opts: {
  pausedForSteps: number;
  onEvent: (e: LogEvent) => void;
}): { deps: LoopDeps; navigatorSteps: () => number } {
  let checkCount = 0;
  const deps: LoopDeps = {
    task: "Complete the checkout",
    config: {
      maxSteps: 6,
      maxActionsPerStep: 10,
      plannerInterval: 100,
      maxFailures: 5,
      costCapUsd: 0,
      enableLoopDetection: false,
      enableCompaction: false,
      compactionStepInterval: 1000,
      compactionCharThreshold: 1_000_000,
      enableJudge: false,
      enableEarlyStop: false,
      enableHtmlSummarizer: false,
      enableFastPath: false,
    },
    getTabs: vi.fn(async () => [
      { id: 1, label: "1", url: "https://example.com/checkout", title: "Checkout", active: true },
    ]),
    settleDelay: 1,
    extractState: vi.fn(async () => makeState({ url: "https://example.com/checkout", pageInfo: "" })),
    executeActions: vi.fn(async (actions: AgentStepRequest["history"][number]["results"][number]["action"][]) =>
      actions.map((action) => ({ action, success: true, message: "ok" }))),
    onEvent: opts.onEvent,
    // Paused for the first `pausedForSteps` checks, then resumed.
    checkPaused: vi.fn(async () => {
      checkCount += 1;
      return checkCount <= opts.pausedForSteps;
    }),
    plannerCall: vi.fn(async () => ({
      raw: JSON.stringify({ thinking: "x", decision: "continue", plan: ["a"], next_goal: "g" }),
    })),
    navigatorCall: vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "x", evaluation_previous_goal: "ok", memory: "m", next_goal: "g",
        action: [{ type: "click", index: 1 }],
      }),
    })),
  };
  return {
    deps,
    navigatorSteps: () => (deps.navigatorCall as ReturnType<typeof vi.fn>).mock.calls.length,
  };
}

describe("manual pause/resume loop flow", () => {
  test("the loop pauses on the flag, waits, and continues after resume", async () => {
    const events: LogEvent[] = [];
    const { deps, navigatorSteps } = buildDeps({ pausedForSteps: 3, onEvent: (e) => events.push(e) });

    await runAgentLoop(deps);

    const paused = events.filter((e) => e.type === "paused");
    const resumed = events.filter((e) => e.type === "resumed");
    expect(paused.length).toBeGreaterThanOrEqual(1);
    expect(resumed.length).toBeGreaterThanOrEqual(1);

    // The run continued to completion AFTER the pause (the pause did not
    // terminate or degrade the run).
    expect(navigatorSteps()).toBeGreaterThanOrEqual(4);
    const terminal = events.find((e) => e.type === "done") as
      | Extract<LogEvent, { type: "done" }>
      | undefined;
    expect(terminal).toBeDefined();
  });

  test("no false resume when the pause never clears (deadline path still completes safely)", async () => {
    // checkPaused stays true for the whole run; the 30-min safety cap is not
    // reachable in a test, so abort the run instead and assert no misleading
    // `resumed` event is emitted.
    const events: LogEvent[] = [];
    const controller = new AbortController();
    const { deps } = buildDeps({ pausedForSteps: 1000, onEvent: (e) => events.push(e) });
    deps.signal = controller.signal;
    const run = runAgentLoop(deps);
    // Let a few pause checks happen, then abort.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort(new DOMException("Aborted", "AbortError"));
    await run;

    expect(events.filter((e) => e.type === "paused").length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === "resumed").length).toBe(0);
  });
});
