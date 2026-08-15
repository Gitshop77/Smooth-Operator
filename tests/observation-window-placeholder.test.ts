/**
 * Observation-window placeholders — stale observations (outside the last 2
 * retention items) render a fixed structural placeholder ("what was called +
 * args") instead of the full message/extracted content, so the context stays
 * bounded without silently dropping the action history.
 */
import { describe, expect, test } from "vitest";
import { renderHistory } from "../src/lib/agent/loop/messages-utils";
import type { HistoryItem } from "../src/lib/agent/types";

function item(step: number, text: string): HistoryItem {
  return {
    step,
    agent: "navigator",
    // Per-item notes so the masking assertions can tell retained from stale.
    evaluation: `eval-${text}`,
    memory: `mem-${text}`,
    goal: `goal-${text}`,
    results: [
      {
        action: { type: "click", index: 7 },
        success: true,
        message: `message-${text}`,
        extractedContent: `extracted-${text}-${"y".repeat(500)}`,
      },
    ],
  };
}

describe("renderHistory — stale observation masking", () => {
  test("the last 2 items keep full content; older items render the structural placeholder", () => {
    const history = [item(0, "a"), item(1, "b"), item(2, "c"), item(3, "d"), item(4, "e")];
    const out = renderHistory(history, 5);

    // Recent items (steps 3,4) keep their full message + extracted content.
    expect(out).toContain("message-d");
    expect(out).toContain("extracted-d");
    expect(out).toContain("message-e");
    expect(out).toContain("extracted-e");
    // Stale items (steps 0,1,2) render "what was called + args" only — no
    // extracted blob, no full message — and keep the FAILED marker semantics.
    expect(out).toContain("- click [index=7]: (details omitted — older step)");
    expect(out).not.toContain("extracted-a");
    expect(out).not.toContain("extracted-b");
    expect(out).not.toContain("extracted-c");
    expect(out).not.toContain("message-a");
  });

  test("stale items ALSO mask the model notes (Evaluation/Memory/Goal)", () => {
    // Regression: the notes rendered unconditionally, so a stale item still
    // shipped up to ~2,800 chars of Evaluation/Memory/Goal per step — the
    // dominant per-step prompt growth over a long run. Stale items must mask
    // the notes too (the retention window already masks messages/extracted).
    const history = [item(0, "a"), item(1, "b"), item(2, "c"), item(3, "d"), item(4, "e")];
    const out = renderHistory(history, 5);

    // Retained items (steps 3,4) keep the notes (wrapped untrusted).
    expect(out).toContain("eval-d");
    expect(out).toContain("mem-d");
    expect(out).toContain("goal-e");
    // Stale items (steps 0,1,2) mask them.
    expect(out).not.toContain("eval-a");
    expect(out).not.toContain("mem-b");
    expect(out).not.toContain("goal-c");
  });

  test("retained result messages are bounded at the render seam", () => {
    // A verbose handler/model can put an unbounded message on a result; the
    // render seam must cap it (extractedContent already has its own 8.5k cap).
    const big = {
      ...item(0, "x"),
      results: [{
        action: { type: "click", index: 1 } as const,
        success: true,
        message: "m".repeat(20_000),
      }],
    };
    const out = renderHistory([big], 1);
    // wrapUntrusted converts the ellipsis to "..." — assert the marker's tail.
    expect(out).toContain("[truncated verbose result message]");
    // The full 20k message must not be shipped.
    expect(out).not.toContain("m".repeat(10_000));
  });

  test("a small history (≤ 2) is never masked", () => {
    const history = [item(0, "a"), item(1, "b")];
    const out = renderHistory(history, 2);
    expect(out).toContain("extracted-a");
    expect(out).toContain("extracted-b");
    expect(out).not.toContain("details omitted");
  });

  test("the omitted-steps marker still renders when the total exceeds the limit", () => {
    const history = [item(0, "a"), item(1, "b"), item(2, "c"), item(3, "d"), item(4, "e")];
    const out = renderHistory(history, 3);
    expect(out).toContain("[2 previous steps omitted]");
  });

  test("masked stale actions still report success/failure", () => {
    const failing = {
      ...item(0, "f"),
      results: [{ action: { type: "click" as const, index: 1 }, success: false, message: "blocked" }],
    } as unknown as HistoryItem;
    const out = renderHistory([failing, item(1, "g"), item(2, "h"), item(3, "i")], 4);
    expect(out).toContain("- click [index=1]: (details omitted — older step) (FAILED)");
  });
});
