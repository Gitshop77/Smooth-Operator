/**
 * Regression guard — a mid-stream "stream stall" thrown by the LLM transport
 * (`httpJson.frames` in transport-http.ts) must not be silently executed as
 * truncated content. `withLLMRetry` only wraps the INITIAL fetch, so a
 * mid-stream stall is re-thrown by the transport and must surface as a FAILED
 * navigator step: the orchestrator re-drives the navigator on the next loop
 * iteration and never hands partial/truncated frames to the action executor.
 */

import { describe, test, expect, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentAction, ActionResult, LogEvent } from "../src/lib/agent/types";
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
  // Keep the early-stop / loop-detector halt layers off so the stall is the
  // only thing terminating the run.
  enableEarlyStop: false,
};

describe("runAgentLoop — mid-stream stream stall is not executed as truncated content", () => {
  test("a stream stall re-drives the navigator and never executes partial frames", async () => {
    const events: LogEvent[] = [];
    const deps: LoopDeps = {
      task: "test task",
      // Simulate the transport (httpJson.frames) throwing a mid-stream stall.
      navigatorCall: vi.fn(async () => {
        throw new Error("stream stall: no data for 30000ms");
      }),
      plannerCall: vi.fn(async () => ({
        raw: JSON.stringify({
          thinking: "x",
          decision: "continue",
          plan: ["a"],
          next_goal: "g",
        }),
      })),
      getTabs: vi.fn(async () => [
        { id: 1, label: "1", url: "https://example.com", title: "t", active: true },
      ]),
      extractState: vi.fn(async () => makeState()),
      executeActions: vi.fn(async (actions: AgentAction[]) =>
        actions.map((action) => ({ action, success: true, message: "ok" } as ActionResult)),
      ),
      onEvent: (e: LogEvent) => {
        events.push(e);
      },
      settleDelay: 0,
      config: { ...BASE_CONFIG },
    };

    await runAgentLoop(deps);

    // A mid-stream stall is surfaced as a failed navigator step. Because the
    // stall error is an unrecognized `unknown` category, the orchestrator's
    // bounded retry retries it once and then treats the repeat as fatal, so the
    // navigator is re-driven (called a second time) before the run aborts.
    expect(deps.navigatorCall).toHaveBeenCalledTimes(2);
    // Critical safety property: truncated stream content is NEVER executed.
    expect(deps.executeActions).not.toHaveBeenCalled();
    // The run ends in failure rather than continuing with partial output.
    const doneEvent = events.find((e) => e.type === "done") as
      | Extract<LogEvent, { type: "done" }>
      | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.success).toBe(false);
  });
});
