/**
 * The loop's abort signal must reach IN-FLIGHT actions.
 *
 * `LoopDeps.signal` was checked only BETWEEN actions (action-queue.ts), so an
 * abort issued while a long-running action (e.g. `wait` for many seconds) was
 * executing was not observed until that action completed — a user STOP could
 * hang the queue for the full action duration. The fix threads `deps.signal`
 * into `executeAction` (which already accepts an optional signal and passes it
 * to the handlers, whose `sleep`/RPC races honor it).
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { executeActionQueue } from "../src/lib/agent/loop/helpers/action-queue";
import { LoopDetector } from "../src/lib/agent/loop/loop-detector";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentAction, AgentConfig } from "../src/lib/agent/types";
import { makeState } from "./helpers";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("executeActionQueue — abort signal threading", () => {
  test("aborting mid-execution stops the queue promptly (in-flight action observes the signal)", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const deps = makeQueueDeps();
    deps.signal = controller.signal;

    // First action waits 30s — long enough that only the abort can end it.
    const actions = [
      { type: "wait", seconds: 30 },
      { type: "scroll", down: true, pages: 1 },
    ] as AgentAction[];

    const queuePromise = executeActionQueue(deps, actions, makeState(), 0, "standard", new LoopDetector(), config);

    // Let the queue reach the `wait` action (microtasks only — no timers fire).
    await vi.advanceTimersByTimeAsync(5);
    controller.abort();

    // Drain whatever the (buggy) unthreaded path would leave pending: if the
    // signal is ignored, the wait runs its full 30s and the queue continues.
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await queuePromise;

    expect(result.aborted).toBe(true);
    // The in-flight action was interrupted rather than completing.
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].message).toContain("Abort");
    // The remaining action was blocked, never executed.
    expect(result.results[1].message).toBe("BLOCKED: prior action in the queue aborted the step");
  });

  test("control: without an abort the same queue executes every action", async () => {
    vi.useFakeTimers();
    const actions = [
      { type: "wait", seconds: 30 },
      { type: "scroll", down: true, pages: 1 },
    ] as AgentAction[];

    const queuePromise = executeActionQueue(makeQueueDeps(), actions, makeState(), 0, "standard", new LoopDetector(), config);
    // 30s wait + the scroll handler's settle sleep (~0.4s) → advance well past both.
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await queuePromise;

    expect(result.aborted).toBe(false);
    expect(result.results.every((r) => r.success)).toBe(true);
  });
});
