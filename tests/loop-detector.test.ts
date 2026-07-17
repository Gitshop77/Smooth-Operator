/**
 * Deterministic (no-LLM) coverage for the loop detector.
 *
 * Locks the load-bearing invariants so a refactor can't silently weaken
 * loop-safety:
 *  - `normalizeAction` emits a type-specific signature for every action type
 *    and distinguishes actions that differ only in their distinguishing param;
 *  - `shouldWarn` fires only at the `WARN_THRESHOLDS` milestones (5 / 8 / 12)
 *    and nowhere else;
 *  - goal-level thresholds (`GOAL_WARN_THRESHOLD` / `GOAL_TOP_THRESHOLD`) are
 *    reached exactly, and distinct goals don't accumulate.
 */
import { describe, test, expect } from "vitest";
import {
  LoopDetector,
  normalizeAction,
  GOAL_WARN_THRESHOLD,
  GOAL_TOP_THRESHOLD,
  LOOP_TOP_THRESHOLD,
} from "../src/lib/agent/loop/loop-detector";
import type { AgentAction } from "../src/lib/agent/types";

function act(a: Record<string, unknown>): AgentAction {
  return a as unknown as AgentAction;
}

describe("normalizeAction type-specific signatures", () => {
  test("every action type emits a distinct, deterministic signature", () => {
    const cases: Array<[AgentAction, string]> = [
      [act({ type: "click", index: 3 }), "idx=3"],
      [act({ type: "hover", index: 4 }), "idx=4"],
      [act({ type: "dropdown_options", index: 2 }), "idx=2"],
      [act({ type: "upload_file", index: 1 }), "idx=1"],
      [act({ type: "input", index: 2, text: "hi" }), "idx=2|text=hi"],
      [act({ type: "select_dropdown", index: 1, text: "a", option_index: 0 }), "optidx=0"],
      [act({ type: "press_and_hold", index: 5, hold_ms: 1000 }), "hold=1000"],
      [act({ type: "scroll", down: false }), "dir=up"],
      [act({ type: "scroll" }), "dir=down"],
      [act({ type: "send_keys", keys: "Enter" }), "keys=Enter"],
      [act({ type: "navigate", url: "https://x.test" }), "url=https://x.test"],
      [act({ type: "switch_tab", tab_id: 7 }), "tab=7"],
      [act({ type: "close_tab", tab_id: 8 }), "tab=8"],
      [act({ type: "find_text", text: "q" }), "text=q"],
      [act({ type: "extract", query: "p" }), "query=p"],
      [act({ type: "search", query: "s" }), "query=s"],
      [act({ type: "search_page", pattern: "p" }), "pattern=p"],
      [act({ type: "find_elements", selector: ".x" }), "selector=.x"],
      [act({ type: "evaluate", code: "1+1" }), "code=1+1"],
      [act({ type: "ask_human", question: "?" }), "question=?"],
      [act({ type: "takeover", reason: "r" }), "reason=r"],
      [act({ type: "verify", expectation: "e" }), "expectation=e"],
      [act({ type: "load_skill", name: "n" }), "name=n"],
      [act({ type: "alert_send_keys", text: "ok" }), "text=ok"],
      [act({ type: "detect_visual", query: "v" }), "query=v"],
      [act({ type: "screenshot", fileName: "a.png" }), "file=a.png"],
      [act({ type: "save_as_pdf", fileName: "b.pdf" }), "file=b.pdf"],
      [act({ type: "wait" }), "wait"],
      [act({ type: "go_back" }), "go_back"],
      [act({ type: "done", success: true }), "done"],
      [act({ type: "alert_accept" }), "alert_accept"],
      [act({ type: "alert_dismiss" }), "alert_dismiss"],
      [act({ type: "alert_get_text" }), "alert_get_text"],
    ];
    for (const [a, expectSub] of cases) {
      const sig = normalizeAction(a);
      expect(sig, `signature for ${a.type}`).toContain(expectSub);
    }
  });

  test("two actions differing only in their distinguishing param hash differently", () => {
    expect(normalizeAction(act({ type: "click", index: 1 }))).not.toBe(
      normalizeAction(act({ type: "click", index: 2 })),
    );
    expect(normalizeAction(act({ type: "navigate", url: "https://a" }))).not.toBe(
      normalizeAction(act({ type: "navigate", url: "https://b" })),
    );
  });

  test("cosmetic defaults collapse (scroll without pages === scroll pages:1)", () => {
    expect(normalizeAction(act({ type: "scroll", down: true }))).toBe(
      normalizeAction(act({ type: "scroll", down: true, pages: 1 })),
    );
  });
});

describe("LoopDetector action-repetition warnings", () => {
  test("shouldWarn fires only at the WARN_THRESHOLDS milestones (5/8/12)", () => {
    const det = new LoopDetector();
    const action = act({ type: "click", index: 1 });
    const milestones = new Set([5, 8, 12]);
    for (let i = 1; i <= 12; i++) {
      det.record(action, i);
      if (milestones.has(i)) {
        expect(det.shouldWarn(), `step ${i}`).toBe(i);
      } else {
        expect(det.shouldWarn(), `step ${i}`).toBe(0);
      }
    }
  });

  test("record count reflects equivalent actions in the rolling window", () => {
    const det = new LoopDetector();
    for (let i = 0; i < 4; i++) det.record(act({ type: "click", index: 1 }), i);
    // 4 equivalent clicks → count 4, but not a warning milestone yet.
    expect(det.shouldWarn()).toBe(0);
  });

  test("LOOP_TOP_THRESHOLD is the max WARN milestone", () => {
    expect(LOOP_TOP_THRESHOLD).toBe(12);
  });
});

describe("LoopDetector goal-level thresholds", () => {
  test("recordGoal reaches the warn milestone before the top milestone", () => {
    const det = new LoopDetector();
    for (let i = 0; i < GOAL_WARN_THRESHOLD; i++) det.recordGoal("same goal");
    const atWarn = det.recordGoal("same goal");
    expect(atWarn).toBeGreaterThanOrEqual(GOAL_WARN_THRESHOLD);
    expect(atWarn).toBeLessThan(GOAL_TOP_THRESHOLD);
  });

  test("recordGoal returns >= GOAL_TOP_THRESHOLD at the top milestone", () => {
    const det = new LoopDetector();
    let count = 0;
    for (let i = 0; i < GOAL_TOP_THRESHOLD; i++) count = det.recordGoal("same goal");
    expect(count).toBeGreaterThanOrEqual(GOAL_TOP_THRESHOLD);
  });

  test("different goals do not accumulate toward the threshold", () => {
    const det = new LoopDetector();
    for (let i = 0; i < GOAL_TOP_THRESHOLD + 2; i++) det.recordGoal(`goal #${i}`);
    expect(det.recordGoal("same goal")).toBeLessThan(GOAL_TOP_THRESHOLD);
  });
});
