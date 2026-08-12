/**
 * Loop-edge no-progress guard — the orchestrator's while-loop must NEVER
 * spin: a step that returns "continue" without advancing the step counter
 * (and without a terminal result) is a regression the guard terminates.
 */
import { describe, expect, test } from "vitest";
import { loopProgressStalled } from "../src/lib/agent/loop/orchestrator-helpers";
import type { LoopState } from "../src/lib/agent/loop/types";

function stateWith(step: number, terminalEmitted?: boolean, finalResult?: { success: boolean; text: string }): LoopState {
  return { step, terminalEmitted, finalResult } as unknown as LoopState;
}

describe("loopProgressStalled (loop-edge no-progress guard)", () => {
  test("a step that advanced the counter is NOT stalled", () => {
    expect(loopProgressStalled(stateWith(3), 2)).toBe(false);
  });

  test("a step that returned without advancing AND without a terminal result IS stalled", () => {
    expect(loopProgressStalled(stateWith(2), 2)).toBe(true);
  });

  test("a terminal emission (done or finalResult) clears the stall condition", () => {
    expect(loopProgressStalled(stateWith(2, true), 2)).toBe(false);
    expect(loopProgressStalled(stateWith(2, false, { success: false, text: "x" }), 2)).toBe(false);
  });
});
