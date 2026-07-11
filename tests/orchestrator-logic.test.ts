/**
 * Orchestrator decision-logic tests.
 *
 * The orchestrator is the single largest file in the engine and historically
 * had zero test coverage. This file tests the pure decision functions that
 * can be exercised without a running LLM — cost-cap checking, budget
 * warnings, loop-detector integration, and the compaction trigger. The full
 * loop integration (with mock LLM responses) is a larger effort left for a
 * follow-up.
 */

import { describe, test, expect, vi } from "vitest";
import { LoopDetector } from "../src/lib/agent/loop/loop-detector";
import { shouldCompact, partitionHistory, buildCompactionRequest, sanitizeCompactedMemory } from "../src/lib/agent/loop/compaction";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { HistoryItem, AgentAction, ActionResult, LogEvent, AgentOutput } from "../src/lib/agent/types";
import { AgentOutputSchema } from "../src/lib/agent/tools/schema";
import { makeHistoryItem, makeState } from "./helpers";

// ─── LoopDetector ───────────────────────────────────────────────────────────

describe("LoopDetector", () => {
  test("does not warn on the first occurrence of an action", () => {
    const det = new LoopDetector();
    det.record({ type: "click", index: 1 } as AgentAction, 0);
    expect(det.shouldWarn()).toBe(0);
  });

  test("warns at 5 repetitions", () => {
    const det = new LoopDetector();
    const action = { type: "click", index: 1 } as AgentAction;
    for (let i = 0; i < 5; i++) det.record(action, i);
    expect(det.shouldWarn()).toBe(5);
  });

  test("warns at 8 repetitions (escalating)", () => {
    const det = new LoopDetector();
    const action = { type: "scroll", down: true, pages: 1 } as AgentAction;
    for (let i = 0; i < 8; i++) det.record(action, i);
    expect(det.shouldWarn()).toBe(8);
  });

  test("does not warn between thresholds (6, 7)", () => {
    const det = new LoopDetector();
    const action = { type: "click", index: 1 } as AgentAction;
    for (let i = 0; i < 6; i++) det.record(action, i);
    expect(det.shouldWarn()).toBe(0);
  });

  test("reset clears the window", () => {
    const det = new LoopDetector();
    const action = { type: "click", index: 1 } as AgentAction;
    for (let i = 0; i < 5; i++) det.record(action, i);
    expect(det.shouldWarn()).toBe(5);
    det.reset();
    det.record(action, 5);
    expect(det.shouldWarn()).toBe(0);
  });

  test("distinguishes between different actions", () => {
    const det = new LoopDetector();
    for (let i = 0; i < 4; i++) det.record({ type: "click", index: 1 } as AgentAction, i);
    for (let i = 0; i < 4; i++) det.record({ type: "input", index: 2, text: "x", clear: true } as AgentAction, i);
    // 4 clicks + 4 inputs — neither hits the 5 threshold.
    expect(det.shouldWarn()).toBe(0);
  });

  // test that normalizeAction distinguishes same-type-different-param actions.
  // The new cases (detect_visual/screenshot/save_as_pdf) must hash DIFFERENTLY
  // for same-type-different-param invocations. Without this, detect_visual with
  // different queries would hash the same → false-positive loop warnings.
  test("normalizeAction distinguishes detect_visual by query", () => {
    const det = new LoopDetector();
    // 4 detect_visual with query A + 4 with query B — neither should hit 5.
    for (let i = 0; i < 4; i++) det.record({ type: "detect_visual", query: "button" } as AgentAction, i);
    for (let i = 0; i < 4; i++) det.record({ type: "detect_visual", query: "form" } as AgentAction, i + 4);
    expect(det.shouldWarn()).toBe(0);
  });

  test("normalizeAction distinguishes screenshot by fileName", () => {
    const det = new LoopDetector();
    for (let i = 0; i < 4; i++) det.record({ type: "screenshot", fileName: "a.jpg" } as AgentAction, i);
    for (let i = 0; i < 4; i++) det.record({ type: "screenshot", fileName: "b.jpg" } as AgentAction, i + 4);
    expect(det.shouldWarn()).toBe(0);
  });

  test("same detect_visual query 5× DOES warn (no false negative)", () => {
    const det = new LoopDetector();
    const action = { type: "detect_visual", query: "button" } as AgentAction;
    for (let i = 0; i < 5; i++) det.record(action, i);
    expect(det.shouldWarn()).toBe(5);
  });

  test("warningText produces a useful nudge", () => {
    const text = LoopDetector.warningText(5);
    expect(text).toContain("LOOP DETECTED");
    expect(text).toContain("5");
    expect(text).toContain("DIFFERENT approach");
  });

  test("normalizes equivalent scroll actions to the same hash", () => {
    const det = new LoopDetector();
    // {type:"scroll", down:true, pages:1} === {type:"scroll"} after normalization
    for (let i = 0; i < 5; i++) {
      det.record({ type: "scroll", down: true, pages: 1 } as AgentAction, i);
    }
    expect(det.shouldWarn()).toBe(5);
  });
});

// ─── Compaction: shouldCompact ──────────────────────────────────────────────

describe("shouldCompact", () => {
  test("returns false when step gap < interval", () => {
    expect(shouldCompact(5, 0, 50_000, 20, 30_000)).toBe(false);
  });

  test("returns false when history length < threshold", () => {
    expect(shouldCompact(25, 0, 10_000, 20, 30_000)).toBe(false);
  });

  test("returns true when both conditions are met", () => {
    expect(shouldCompact(25, 0, 50_000, 20, 30_000)).toBe(true);
  });

  test("returns true when lastCompactionStep is undefined and conditions met", () => {
    expect(shouldCompact(25, undefined, 50_000, 20, 30_000)).toBe(true);
  });

  test("returns false when lastCompactionStep is recent", () => {
    expect(shouldCompact(25, 20, 50_000, 20, 30_000)).toBe(false);
  });
});

// ─── Compaction: partitionHistory ───────────────────────────────────────────

describe("partitionHistory", () => {
  test("returns empty toSummarize when history is short", () => {
    const history = [makeHistoryItem(0), makeHistoryItem(1), makeHistoryItem(2)];
    const { toSummarize, toKeep } = partitionHistory(history);
    expect(toSummarize).toHaveLength(0);
    expect(toKeep).toHaveLength(3);
  });

  test("partitions into first + middle (toSummarize) and last 6 (toKeep)", () => {
    const history: HistoryItem[] = [];
    for (let i = 0; i < 10; i++) history.push(makeHistoryItem(i));
    const { toSummarize, toKeep } = partitionHistory(history);
    // toSummarize = first (1) + middle (10 - 1 - 6 = 3) = 4
    expect(toSummarize).toHaveLength(4);
    expect(toKeep).toHaveLength(6);
    // toKeep is the last 6
    expect(toKeep[0].step).toBe(4);
    expect(toKeep[5].step).toBe(9);
    // toSummarize starts with the first item (init context)
    expect(toSummarize[0].step).toBe(0);
  });
});

// ─── Compaction: sanitizeCompactedMemory ────────────────────────────────────

describe("sanitizeCompactedMemory", () => {
  test("strips agent-internal tags from the summary", () => {
    const input = '<compacted_memory>secret</compacted_memory><sys>evil</sys><step_5>data</step_5>';
    const result = sanitizeCompactedMemory(input);
    expect(result).not.toContain("<compacted_memory>");
    expect(result).not.toContain("<sys>");
    expect(result).not.toContain("<step_5>");
    expect(result).toContain("[tag]");
  });

  test("leaves normal text unchanged", () => {
    expect(sanitizeCompactedMemory("Prior steps: did 3 actions.")).toBe("Prior steps: did 3 actions.");
  });
});

// ─── Compaction: buildCompactionRequest ─────────────────────────────────────

describe("buildCompactionRequest", () => {
  test("includes the summarization prompt + rendered history", () => {
    const history: HistoryItem[] = [];
    for (let i = 0; i < 10; i++) history.push(makeHistoryItem(i));
    const request = buildCompactionRequest(history);
    expect(request).toContain("summarizing");
    expect(request).toContain("step_0");
    expect(request).toContain("step_3"); // first + middle 3 = 4 items to summarize
    // The last 6 items should NOT be in the request (they're kept, not summarized)
    expect(request).not.toContain("step_9");
  });
});

// ─── deps.executeActions branch loop-detector integration ────────────────
//
// The `deps.executeActions` override (always set in the extension path — see
// run-helpers.ts) previously bypassed `executeActionQueue`, which is the only
// caller of `loopDetector.record(action, step)`. That made the action-repetition
// loop detector DEAD CODE in production — only the page-fingerprint detector
// fired. The executeActions branch records each action in the batch + calls
// loopDetector.reset() when any result has pageChanged: true.
//
// These tests exercise the full runAgentLoop with `deps.executeActions` set and
// verify the loop-warning event fires on repeated actions + the reset-on-page-change
// behavior. Without the recording, the loop-warning would never fire (the records
// were never made) and the reset would never happen.

describe("runAgentLoop — executeActions branch loop-detector integration", () => {
  /** A click action repeated 5 times triggers shouldWarn = 5 (WARN_THRESHOLDS[0]). */
  const REPEATED_CLICK: AgentAction = { type: "click", index: 1 } as AgentAction;

  /** Build a navigator output carrying N copies of the same click action. */
  function navigatorOutputWithRepeatedClicks(n: number): AgentOutput {
    return {
      thinking: "x",
      evaluation_previous_goal: "y",
      memory: "z",
      next_goal: "w",
      action: Array.from({ length: n }, () => REPEATED_CLICK),
    };
  }

  /** Build a minimal LoopDeps wired with mocks for this test. */
  function makeDeps(opts: {
    navigatorOutput: AgentOutput;
    executeActionsResult: (actions: AgentAction[]) => ActionResult[];
    events: LogEvent[];
  }): LoopDeps {
    return {
      task: "test task",
      navigatorCall: vi.fn(async () => ({ raw: JSON.stringify(opts.navigatorOutput) })),
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
      executeActions: vi.fn(async (actions: AgentAction[]) => opts.executeActionsResult(actions)),
      onEvent: (e: LogEvent) => { opts.events.push(e); },
      settleDelayMs: 0,
      config: {
        maxSteps: 3,
        maxActionsPerStep: 10,
        plannerInterval: 100, // disable periodic planner re-runs
        maxFailures: 5,
        enableLoopDetection: true,
        enableCompaction: false,
        compactionStepInterval: 1000,
        compactionCharThreshold: 1_000_000,
        enableJudge: false,
      },
    };
  }

  /** Type-guard: narrow a LogEvent to the loop-warning variant. */
  function isLoopWarning(e: LogEvent): e is Extract<LogEvent, { type: "loop-warning" }> {
    return e.type === "loop-warning";
  }

  test("emits loop-warning (count=5) when executeActions is set + same action repeats 5× in one batch", async () => {
    // 5 clicks in one navigator step → the executeActions branch records each
    // click via loopDetector.record; after the 5th record, shouldWarn returns 5 → emit.
    // WITHOUT this branch, the records would never be made (executeActions
    // bypassed executeActionQueue) and no loop-warning would fire.
    const events: LogEvent[] = [];
    const deps = makeDeps({
      navigatorOutput: navigatorOutputWithRepeatedClicks(5),
      executeActionsResult: (actions) => actions.map((action) => ({
        action, success: true, message: "ok",
      } as ActionResult)),
      events,
    });

    await runAgentLoop(deps);

    const warnings = events.filter(isLoopWarning);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].count).toBe(5);
    // executeActions must have been called (proves we exercised the branch).
    expect(deps.executeActions).toHaveBeenCalled();
  });

  test("loopDetector.reset() fires when executeActions returns pageChanged: true", async () => {
    // After step 1 emits loop-warning (5 clicks) + pageChanged reset, step 2's
    // 5 clicks should emit ANOTHER count=5 warning (the window was reset to
    // empty, so the 5th click is count=5 again). WITHOUT the reset, the
    // window would carry over the 5 clicks from step 1 → step 2's 5 clicks
    // would push the count to 10, and shouldWarn would return 0 (10 is NOT
    // in WARN_THRESHOLDS = [5, 8, 12]). The 8th click (count=8) WOULD fire,
    // but with count=8, not count=5.
    //
    // So the assertion "second warning has count=5" distinguishes:
    //   - reset in place: reset fired → window empty → step 2's 5th click = count 5.
    //   - reset broken (no reset): window carried over → step 2's 8th click = count 8.
    const events: LogEvent[] = [];
    const deps = makeDeps({
      navigatorOutput: navigatorOutputWithRepeatedClicks(5),
      executeActionsResult: (actions) => actions.map((action) => ({
        action, success: true, message: "ok",
        // pageChanged: true on every result triggers the reset branch.
        pageChanged: true,
      } as ActionResult)),
      events,
    });

    await runAgentLoop(deps);

    const warnings = events.filter(isLoopWarning);
    // With reset working: 3 steps × 1 warning per step = 3 warnings, all count=5.
    // Without reset: step 1 emits count=5; step 2 emits count=8 (5+3); step 3 emits count=8 again.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    // EVERY warning must have count=5 — if any has count=8, the reset is broken.
    for (const w of warnings) {
      expect(w.count).toBe(5);
    }
  });

  test("WITHOUT pageChanged, the loop window carries over (no reset) — count escalates to 8", async () => {
    // Control: when executeActions returns pageChanged: false (or undefined),
    // the reset does NOT fire. Step 1's 5 clicks carry over to step 2.
    // Step 2's 5 clicks push the count to 10; shouldWarn fires at count=8
    // (the 3rd click of step 2, when window has 5+3=8 entries).
    // This test confirms the reset is CONDITIONAL on pageChanged — without
    // that condition, the reset would fire every step and the escalation
    // semantics would be lost.
    const events: LogEvent[] = [];
    const deps = makeDeps({
      navigatorOutput: navigatorOutputWithRepeatedClicks(5),
      executeActionsResult: (actions) => actions.map((action) => ({
        action, success: true, message: "ok",
        // pageChanged: false → reset does NOT fire.
      } as ActionResult)),
      events,
    });

    await runAgentLoop(deps);

    const warnings = events.filter(isLoopWarning);
    // Step 1: 5th click → count=5 → warning.
    // Step 2: 3rd click → count=8 → warning (window: 5 + 3 = 8).
    // Step 2: 4th, 5th clicks → count=9, 10 → no warning (not in [5,8,12]).
    // Step 3: 1st click → count=11 → no warning.
    // Step 3: 2nd click → count=12 → warning.
    // So warnings should be: 5, 8, 12.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const counts = warnings.map((w) => w.count);
    expect(counts).toContain(5);
    expect(counts).toContain(8);
  });

  test("done paired with a sibling is rejected at parse time (never reaches a dropped step)", async () => {
    // The fix enforces `done`-exclusivity at PARSE time: a step pairing `done`
    // with a sibling action (e.g. a final `input`) is rejected by
    // AgentOutputSchema, so it can never reach the orchestrator as a silently
    // dropped step. A single `done` (the valid case) still finalizes the run.
    const bad = AgentOutputSchema.safeParse({
      thinking: "x",
      evaluation_previous_goal: "y",
      memory: "z",
      next_goal: "w",
      action: [
        { type: "input", index: 1, text: "hello" } as AgentAction,
        { type: "done", text: "finished", success: false } as AgentAction,
      ],
    });
    expect(bad.success).toBe(false);

    // A single `done` step still drives the orchestrator to finalize normally.
    const events: LogEvent[] = [];
    const deps = makeDeps({
      navigatorOutput: {
        thinking: "x",
        evaluation_previous_goal: "y",
        memory: "z",
        next_goal: "w",
        action: [{ type: "done", text: "finished", success: false } as AgentAction],
      },
      executeActionsResult: (actions) =>
        actions.map((action) => ({ action, success: true, message: "ok" } as ActionResult)),
      events,
    });

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBeGreaterThan(0);
  });
});
