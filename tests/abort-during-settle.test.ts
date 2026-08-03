/**
 * Deterministic (no-LLM) regression coverage for stopping the run while the
 * page is settling after an action.
 *
 * When the user stops the run (`deps.signal` aborts) while `waitForSettled`
 * is pending, the run must stop immediately:
 *  - NO "waitForSettled failed" error event (an abort is not a settle failure);
 *  - NO extra navigator step after the abort (the run exits on the aborting
 *    step, not one step later);
 *  - exactly one terminal `done` with the same "Agent stopped by user." text
 *    every other stop-path uses.
 */

import { describe, test, expect, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import { runCompaction } from "../src/lib/agent/loop/helpers/compaction-runner";
import { maybeJudgeAndFinalize } from "../src/lib/agent/loop/helpers/judges";
import { DEFAULT_CONFIG } from "../src/lib/agent/types";
import type { LoopDeps, LoopState } from "../src/lib/agent/loop/types";
import type { AgentAction, ActionResult, LogEvent, AgentOutput, AgentConfig } from "../src/lib/agent/types";
import { makeState, makeHistoryItem } from "./helpers";

// Mirror the locked baseline from orchestrator-logic.test.ts: maxSteps must
// stay below plannerInterval so the periodic planner never re-runs mid-test.
const BASE_CONFIG = {
  maxSteps: 3,
  maxActionsPerStep: 10,
  plannerInterval: 100,
  maxFailures: 5,
  enableLoopDetection: true,
  enableCompaction: false,
  compactionStepInterval: 1000,
  compactionCharThreshold: 1_000_000,
  enableJudge: false,
};

describe("runAgentLoop — abort during the settle wait", () => {
  test("stops immediately: no settle error event, done on the aborting step", async () => {
    const events: LogEvent[] = [];
    const controller = new AbortController();
    let navCalls = 0;

    const deps: LoopDeps = {
      task: "test task",
      signal: controller.signal,
      // Abort mid-settle: waitForSettled is pending when the user stops.
      waitForSettled: vi.fn(() => new Promise<void>((resolve) => {
        controller.abort();
        resolve();
      })),
      navigatorCall: vi.fn(async () => {
        navCalls++;
        return {
          raw: JSON.stringify({
            thinking: "x",
            evaluation_previous_goal: "y",
            memory: "z",
            next_goal: "w",
            action: [{ type: "click", index: 1 } as AgentAction],
          } as AgentOutput),
        };
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
      onEvent: (e: LogEvent) => { events.push(e); },
      settleDelay: 0,
      config: { ...BASE_CONFIG },
    };

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0] as Extract<LogEvent, { type: "done" }>;
    // Stopped on the aborting step immediately — not on a follow-up step.
    expect(done.step).toBe(0);
    expect(done.success).toBe(false);
    expect(done.text).toBe("Agent stopped by user.");
    // The abort must NOT be surfaced as a settle failure.
    const waitForSettledErrors = events.filter(
      (e) => e.type === "error" && typeof e.message === "string" && e.message.includes("waitForSettled"),
    );
    expect(waitForSettledErrors).toHaveLength(0);
    // No post-abort work: the navigator is only ever called for the aborting step.
    expect(navCalls).toBe(1);
  });
});

// ─── Abort during the planner-phase settle wait (navigator emitted done) ────
//
// `safeWaitForSettled` is also used by the planner phase that runs when the
// navigator emits `done` (planner verification settle). A user-supplied
// `waitForSettled` that REJECTS with an AbortError there must stop the run
// like every other stop path — it must NOT be swallowed as a recoverable
// "waitForSettled failed" error that lets the run continue into another step.

describe("runAgentLoop — abort during the planner-phase settle wait", () => {
  test("stops with 'Agent stopped by user.' when waitForSettled rejects on abort", async () => {
    const events: LogEvent[] = [];
    const controller = new AbortController();
    let navCalls = 0;

    const deps: LoopDeps = {
      task: "test task",
      signal: controller.signal,
      // The navigator emits done → the planner verifies (continues) → the
      // settle wait runs. That wait rejects with an AbortError: the user
      // stopped while the page was settling.
      waitForSettled: vi.fn(() => {
        controller.abort();
        return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
      }),
      navigatorCall: vi.fn(async () => {
        navCalls++;
        return {
          raw: JSON.stringify({
            thinking: "x",
            evaluation_previous_goal: "y",
            memory: "z",
            next_goal: "w",
            action: [{ type: "done", text: "nav done", success: true } as AgentAction],
          } as AgentOutput),
        };
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
      onEvent: (e: LogEvent) => { events.push(e); },
      settleDelay: 0,
      config: { ...BASE_CONFIG },
    };

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0] as Extract<LogEvent, { type: "done" }>;
    // The aborting settle wait stops the run with the canonical stop text —
    // not a swallowed settle error and not an "Uncaught error" fallthrough.
    expect(done.success).toBe(false);
    expect(done.text).toBe("Agent stopped by user.");
    // The abort must NOT be surfaced as a settle failure.
    const waitForSettledErrors = events.filter(
      (e) => e.type === "error" && typeof e.message === "string" && e.message.includes("waitForSettled"),
    );
    expect(waitForSettledErrors).toHaveLength(0);
    // No post-abort work: the navigator only ever ran for the done step.
    expect(navCalls).toBe(1);
  });
});

// ─── Abort-signal forwarding into outbound summarizer/judge LLM calls ────────
//
// The summarize/judge LLM calls are outbound provider calls that can run for
// a while. The run's abort signal must reach them (via the request object)
// so a user stop tears the request down mid-flight instead of letting it
// complete and burn tokens after the run ended.

describe("abort-signal forwarding into summarizer/judge LLM calls", () => {
  test("runCompaction forwards the abort signal into deps.summarizeCall", async () => {
    const controller = new AbortController();
    const captured: unknown[] = [];
    const deps = {
      task: "test task",
      onEvent: () => {},
      summarizeCall: vi.fn(async (req: unknown) => {
        captured.push(req);
        return { content: "compacted summary" };
      }),
    } as unknown as LoopDeps;

    const history = Array.from({ length: 8 }, (_, i) => makeHistoryItem(i));
    const result = await runCompaction(
      deps, history, 5, undefined, undefined, undefined, undefined, controller.signal,
    );

    expect(result).not.toBeNull();
    expect(captured).toHaveLength(1);
    expect((captured[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  test("maybeJudgeAndFinalize forwards the abort signal into deps.summarizeCall", async () => {
    const controller = new AbortController();
    const captured: unknown[] = [];
    const deps = {
      task: "test task",
      onEvent: () => {},
      summarizeCall: vi.fn(async (req: unknown) => {
        captured.push(req);
        return {
          content: JSON.stringify({
            reasoning: "x",
            verdict: true,
            failureReason: null,
            impossibleTask: false,
            reachedCaptcha: false,
          }),
        };
      }),
    } as unknown as LoopDeps;
    const config: AgentConfig = { ...DEFAULT_CONFIG, enableJudge: true };
    const state = { signal: controller.signal } as unknown as LoopState;

    const ok = await maybeJudgeAndFinalize(
      deps, config,
      { step: 0, success: true, text: "done", navigatorHistory: [makeHistoryItem(0)], onCost: () => {} },
      state,
    );

    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect((captured[0] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });
});