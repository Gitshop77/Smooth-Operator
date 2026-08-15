/**
 * Deterministic (no-LLM) coverage for the loop detector.
 *
 * Locks the load-bearing invariants so a refactor can't silently weaken
 * loop-safety:
 *  - `normalizeAction` emits a type-specific signature for every action type
 *    and distinguishes actions that differ only in their distinguishing param;
 *  - `shouldWarn` stays silent below the first threshold (5) and then fires
 *    CONTINUOUSLY at the live count (5, 6, 7, …) — the warning must not
 *    disappear between thresholds (no flicker);
 *  - goal-level thresholds (`GOAL_WARN_THRESHOLD` / `GOAL_TOP_THRESHOLD`) are
 *    reached exactly, and distinct goals don't accumulate.
 */
import { describe, test, expect } from "vitest";
import {
  LoopDetector,
  normalizeAction,
  resultClassForResult,
  GOAL_WARN_THRESHOLD,
  GOAL_TOP_THRESHOLD,
  LOOP_TOP_THRESHOLD,
} from "../src/lib/agent/loop/loop-detector";
import { ActionSchema } from "../src/lib/agent/tools/schema";
import type { AgentAction } from "../src/lib/agent/types";

function act(a: Record<string, unknown>): AgentAction {
  return a as unknown as AgentAction;
}

describe("normalizeAction type-specific signatures", () => {
  test("every action type emits a distinct, deterministic signature", () => {
    const cases: Array<[AgentAction, string]> = [
      [act({ type: "click", index: 3 }), "click|idx=3"],
      [act({ type: "hover", index: 4 }), "hover|idx=4"],
      [act({ type: "dropdown_options", index: 2 }), "dropdown_options|idx=2"],
      [act({ type: "upload_file", index: 1 }), "upload_file|idx=1|path="],
      [act({ type: "input", index: 2, text: "hi" }), "input|idx=2|text=hi"],
      [act({ type: "select_dropdown", index: 1, text: "a", option_index: 0 }), "select_dropdown|idx=1|text=a|optidx=0"],
      [act({ type: "press_and_hold", index: 5, hold_ms: 1000 }), "press_and_hold|idx=5|hold=1000"],
      [act({ type: "scroll", down: false }), "scroll|dir=up|pages=1"],
      [act({ type: "scroll" }), "scroll|dir=down|pages=1"],
      [act({ type: "send_keys", keys: "Enter" }), "send_keys|keys=Enter"],
      [act({ type: "navigate", url: "https://x.test" }), "navigate|url=https://x.test"],
      [act({ type: "switch_tab", tab_id: 7 }), "switch_tab|tab=7"],
      [act({ type: "close_tab", tab_id: 8 }), "close_tab|tab=8"],
      [act({ type: "find_text", text: "q" }), "find_text|text=q"],
      [act({ type: "extract", query: "p" }), "extract|query=p"],
      [act({ type: "search", query: "s" }), "search|query=s"],
      [act({ type: "search_page", pattern: "p" }), "search_page|pattern=p"],
      [act({ type: "find_elements", selector: ".x" }), "find_elements|selector=.x"],
      [act({ type: "evaluate", code: "1+1" }), "evaluate|code=1+1"],
      [act({ type: "ask_human", question: "?" }), "ask_human|question=?"],
      [act({ type: "takeover", reason: "r" }), "takeover|reason=r"],
      [act({ type: "verify", expectation: "e" }), "verify|expectation=e"],
      [act({ type: "load_skill", name: "n" }), "load_skill|name=n"],
      [act({ type: "alert_send_keys", text: "ok" }), "alert_send_keys|text=ok"],
      [act({ type: "detect_visual", query: "v" }), "detect_visual|query=v"],
      [act({ type: "screenshot", file_name: "a.png" }), "screenshot|file=a.png"],
      [act({ type: "save_as_pdf", file_name: "b.pdf" }), "save_as_pdf|file=b.pdf"],
      [act({ type: "wait" }), "wait"],
      [act({ type: "go_back" }), "go_back"],
      [act({ type: "done", success: true }), "done"],
      [act({ type: "alert_accept" }), "alert_accept"],
      [act({ type: "alert_dismiss" }), "alert_dismiss"],
      [act({ type: "alert_get_text" }), "alert_get_text"],
    ];
    for (const [a, expected] of cases) {
      expect(normalizeAction(a), `signature for ${a.type}`).toBe(expected);
    }
    // Cross-type uniqueness: no two types (or param variants) may collapse
    // onto one signature — substring containment alone couldn't prove this.
    const sigs = cases.map(([a]) => normalizeAction(a));
    expect(new Set(sigs).size).toBe(sigs.length);
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

  test("schema-parsed screenshot/save_as_pdf actions hash the REAL file name (snake_case field)", () => {
    // The zod schema names the field `file_name` (src/lib/agent/tools/schema.ts).
    // A schema-parsed action lands the name in `file_name`; if the signature
    // reads the camelCase `fileName` it hashes an empty string — collapsing a
    // file action onto the no-file variant and producing false loop hits.
    const screenshot = ActionSchema.safeParse({ type: "screenshot", file_name: "shot-a.png" });
    expect(screenshot.success).toBe(true);
    if (screenshot.success) {
      expect(normalizeAction(screenshot.data as unknown as AgentAction)).toContain("file=shot-a.png");
    }
    const pdf = ActionSchema.safeParse({ type: "save_as_pdf", file_name: "doc-b.pdf" });
    expect(pdf.success).toBe(true);
    if (pdf.success) {
      expect(normalizeAction(pdf.data as unknown as AgentAction)).toContain("file=doc-b.pdf");
    }
    // Two distinct file actions must NOT collapse onto one signature.
    if (screenshot.success && pdf.success) {
      expect(normalizeAction(screenshot.data as unknown as AgentAction)).not.toBe(
        normalizeAction(pdf.data as unknown as AgentAction),
      );
    }
  });
});

describe("LoopDetector action-repetition warnings", () => {
  test("shouldWarn stays silent below 5, then fires continuously at the live count", () => {
    const det = new LoopDetector();
    const action = act({ type: "click", index: 1 });
    for (let i = 1; i <= 12; i++) {
      det.record(action);
      if (i >= 5) {
        expect(det.shouldWarn(), `step ${i}`).toBe(i);
      } else {
        expect(det.shouldWarn(), `step ${i}`).toBe(0);
      }
    }
  });

  test("record count reflects equivalent actions in the rolling window", () => {
    const det = new LoopDetector();
    for (let i = 0; i < 4; i++) det.record(act({ type: "click", index: 1 }));
    // 4 equivalent clicks → count 4, but not a warning milestone yet.
    expect(det.shouldWarn()).toBe(0);
  });

  test("LOOP_TOP_THRESHOLD is the max WARN milestone", () => {
    expect(LOOP_TOP_THRESHOLD).toBe(12);
  });
});

describe("LoopDetector oscillation detection", () => {
  test("period-2 ping-pong (A,B,A,B) is flagged after 2 full cycles", () => {
    const det = new LoopDetector();
    const a = act({ type: "click", index: 1 });
    const b = act({ type: "click", index: 2 });
    for (let i = 0; i < 2; i++) {
      det.record(a);
      det.record(b);
    }
    // 4 records = 2 full cycles — below the 2-cycle floor… wait, exactly 2
    // cycles qualifies (isAlternatingCycle needs 2*period trailing, i.e. 4).
    expect(det.shouldWarnOscillation()).toBe(2);
    expect(LoopDetector.oscillationWarningText(2, 2)).toMatch(/OSCILLATION DETECTED/);
  });

  test("period-3 cycle (A,B,C,A,B,C) is flagged", () => {
    const det = new LoopDetector();
    const a = act({ type: "click", index: 1 });
    const b = act({ type: "click", index: 2 });
    const c = act({ type: "click", index: 3 });
    for (let i = 0; i < 2; i++) {
      det.record(a);
      det.record(b);
      det.record(c);
    }
    expect(det.shouldWarnOscillation()).toBeGreaterThanOrEqual(2);
  });

  test("a plain repeat (A,A,A,A) is NOT oscillation (exact-hash counter owns it)", () => {
    const det = new LoopDetector();
    const a = act({ type: "click", index: 1 });
    for (let i = 0; i < 8; i++) det.record(a);
    expect(det.shouldWarnOscillation()).toBe(0);
    expect(det.shouldWarn()).toBe(8);
  });

  test("a short prefix that only resembles a cycle is not flagged", () => {
    const det = new LoopDetector();
    det.record(act({ type: "click", index: 1 }));
    det.record(act({ type: "click", index: 2 }));
    expect(det.shouldWarnOscillation()).toBe(0);
  });

  test("outcome-aware hashing: same action + same result-head repeats; a different outcome does not inflate the bucket", () => {
    const det = new LoopDetector();
    const click = act({ type: "click", index: 1 });
    for (let i = 0; i < 3; i++) det.record(click, "BLOCKED: captcha");
    // A different outcome for the same action lands in a different bucket.
    det.record(click, "clicked OK");
    const count = det.record(click, "BLOCKED: captcha");
    expect(count).toBe(4); // 3 earlier + this one (the "clicked OK" is separate)
  });

  test("blocked outcomes with DIFFERENT signatures aggregate into one bucket", () => {
    // Regression: the stuck-run transcript tried navigate(URL1/URL2/URL3…) —
    // each blocked. Signature hashing (URL included) never counted them as
    // repeats, so no loop warning ever fired. An outcome-class head must
    // aggregate all blocked navigations regardless of the target URL.
    const det = new LoopDetector();
    det.record(act({ type: "navigate", url: "https://a.example.com/" }), "BLOCKED: URL domain not in allowlist");
    det.record(act({ type: "navigate", url: "https://b.example.com/" }), "BLOCKED: URL domain not in allowlist");
    const count = det.record(act({ type: "navigate", url: "https://c.example.com/" }), "BLOCKED: URL domain not in allowlist");
    expect(count).toBe(3);
  });

  test("a successful outcome does NOT aggregate across signatures (signature hashing preserved)", () => {
    const det = new LoopDetector();
    det.record(act({ type: "navigate", url: "https://a.example.com/" }), undefined);
    det.record(act({ type: "navigate", url: "https://b.example.com/" }), undefined);
    expect(det.record(act({ type: "navigate", url: "https://c.example.com/" }), undefined)).toBe(1);
  });
});

describe("resultClassForResult — loop outcome classification", () => {
  const result = (over: Partial<{ success: boolean; message: string }>) =>
    ({ action: act({ type: "navigate", url: "https://x.test/" }), success: true, message: "ok", ...over });

  test("successful results return undefined (signature hashing)", () => {
    expect(resultClassForResult(result({}))).toBeUndefined();
  });

  test("blocked outcomes normalize URL-independent (same class for different targets)", () => {
    const a = resultClassForResult(result({
      success: false,
      message: "BLOCKED: URL domain not in allowlist (https://a.example.com/x) — configure allowedDomains in options",
    }));
    const b = resultClassForResult(result({
      success: false,
      message: "BLOCKED: URL domain not in allowlist (https://b.example.org/y) — configure allowedDomains in options",
    }));
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toContain("blocked");
    expect(a).not.toMatch(/https?:\/\//);
  });

  test("different blocked causes stay in different buckets", () => {
    const captcha = resultClassForResult(result({ success: false, message: "BLOCKED: captcha required" }));
    const domain = resultClassForResult(result({ success: false, message: "BLOCKED: URL domain is blocked" }));
    expect(captcha).not.toBe(domain);
  });

  test("undefined result (missing alignment) classifies as a failure", () => {
    expect(resultClassForResult(undefined)).toBeDefined();
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
