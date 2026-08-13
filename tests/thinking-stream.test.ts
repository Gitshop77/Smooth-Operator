/**
 * Thinking streaming — the panel must see the model's real (redacted)
 * chain-of-thought, not a fixed placeholder.
 *
 * Regression: the loop previously replaced the navigator's `thinking` with a
 * hardcoded "Choosing the next action." before emitting the event, so the side
 * panel never showed the reasoning. The event now carries the redacted real
 * thinking (defense-in-depth at the loop; the extension boundary re-redacts
 * live secrets before broadcast/persistence).
 */
import { describe, expect, test, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import { makeState } from "./helpers";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentStepRequest, LogEvent } from "../src/lib/agent/types";

function buildDeps(onEvent: (e: LogEvent) => void): LoopDeps {
  return {
    task: "Compare the plans",
    config: {
      maxSteps: 3,
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
      { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
    ]),
    settleDelay: 1,
    extractState: vi.fn(async () => makeState({ pageInfo: "" })),
    executeActions: vi.fn(async (actions: AgentStepRequest["history"][number]["results"][number]["action"][]) =>
      actions.map((action) => ({ action, success: true, message: "ok" }))),
    onEvent,
    plannerCall: vi.fn(async () => ({
      raw: JSON.stringify({ thinking: "x", decision: "continue", plan: ["a"], next_goal: "g" }),
    })),
    navigatorCall: vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "The pricing table shows Enterprise at $9,999/year. I will click compare.",
        evaluation_previous_goal: "Page loaded. Verdict: Success",
        memory: "Found the pricing table",
        next_goal: "Click Compare plans",
        action: [{ type: "click", index: 1 }],
      }),
    })),
  };
}

describe("thinking streaming", () => {
  test("the thinking event carries the real redacted chain-of-thought, not a placeholder", async () => {
    const events: LogEvent[] = [];
    await runAgentLoop(buildDeps((e) => events.push(e)));

    const thinking = events.find((e) => e.type === "thinking") as
      | Extract<LogEvent, { type: "thinking" }>
      | undefined;
    expect(thinking).toBeDefined();
    // The model's actual reasoning is surfaced, not "Choosing the next action."
    expect(thinking!.text).toContain("pricing table shows Enterprise");
    expect(thinking!.text).not.toBe("Choosing the next action.");
    // The next goal and memory ride along (redacted).
    expect(thinking!.nextGoal).toContain("Click Compare plans");
    expect(thinking!.memory).toContain("Found the pricing table");
  });

  test("falls back to a bounded status when the model emits no thinking", async () => {
    const events: LogEvent[] = [];
    const deps = buildDeps((e) => events.push(e));
    const nav = deps.navigatorCall as ReturnType<typeof vi.fn>;
    nav.mockResolvedValue({
      raw: JSON.stringify({
        thinking: "",
        evaluation_previous_goal: "",
        memory: "",
        next_goal: "",
        action: [{ type: "click", index: 1 }],
      }),
    });
    await runAgentLoop(deps);
    const thinking = events.find((e) => e.type === "thinking") as
      | Extract<LogEvent, { type: "thinking" }>
      | undefined;
    expect(thinking).toBeDefined();
    expect(thinking!.text).toBe("Choosing the next action.");
  });
});
