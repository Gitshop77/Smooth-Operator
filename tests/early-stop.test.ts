/**
 * Deterministic (no-LLM) coverage for the early-stop guards.
 *
 * `earlyStop` enforces two opt-in stopping conditions. These tests lock the
 * load-bearing branches so a refactor can't silently weaken loop safety:
 *  - threshold clamping (a non-positive/NaN threshold must fall back to the
 *    default, never disable the gate or make the repeat-slice degenerate);
 *  - one-shot alert UI actions must NEVER halt on a repeat;
 *  - typing the SAME text into 3+ DIFFERENT fields is suspicious, but the same
 *    field typed 3x is legitimate;
 *  - fewer than K actions can't trigger the repeat stop (slice(-K) guard).
 */
import { describe, test, expect } from "vitest";
import { earlyStop, DEFAULT_EARLY_STOP_THRESHOLDS } from "../src/lib/agent/loop/early-stop";
import type { HistoryItem } from "../src/lib/agent/types";
import type { AgentAction } from "../src/lib/agent/types";

function act(a: Record<string, unknown>): AgentAction {
  return a as unknown as AgentAction;
}

function step(actions: AgentAction[]): HistoryItem[] {
  return [
    {
      step: 0,
      agent: "navigator",
      evaluation: "",
      memory: "",
      goal: "",
      results: actions.map((action) => ({ action, success: true, message: "" })),
    },
  ];
}

describe("earlyStop threshold clamping", () => {
  test("non-positive repeatingAction threshold is clamped to default (3), not disabled", () => {
    // 2 identical clicks < clamped-3 → no stop. If unclamped (0 → slice(-0)
    // returns the whole array) the gate would behave wildly differently.
    const history = step([act({ type: "click", index: 1 }), act({ type: "click", index: 1 })]);
    const res = earlyStop(history, 0, { parsingFailure: 5, repeatingAction: 0 });
    expect(res.stop).toBe(false);
  });

  test("valid repeatingAction threshold is honored below the default", () => {
    const history = step([act({ type: "click", index: 1 }), act({ type: "click", index: 1 })]);
    const res = earlyStop(history, 0, { parsingFailure: 5, repeatingAction: 2 });
    expect(res.stop).toBe(true);
  });

  test("non-positive parsingFailure threshold is clamped to default (5)", () => {
    const res = earlyStop([], 1, { parsingFailure: 0, repeatingAction: 3 });
    expect(res.stop).toBe(false); // 1 consecutive failure < 5
  });

  test("NaN thresholds clamp to default", () => {
    const res = earlyStop([], 2, { parsingFailure: NaN, repeatingAction: NaN });
    expect(res.stop).toBe(false);
  });

  test("K consecutive parse failures stops the run at the default", () => {
    const res = earlyStop([], DEFAULT_EARLY_STOP_THRESHOLDS.parsingFailure, DEFAULT_EARLY_STOP_THRESHOLDS);
    expect(res.stop).toBe(true);
    expect(res.reason).toContain("parse");
  });
});

describe("earlyStop repeat guards", () => {
  test("alert_accept / alert_dismiss / alert_get_text never trigger a repeat stop", () => {
    for (const t of ["alert_accept", "alert_dismiss", "alert_get_text"]) {
      const history = step([
        act({ type: t }),
        act({ type: t }),
        act({ type: t }),
        act({ type: t }),
        act({ type: t }),
      ]);
      const res = earlyStop(history, 0, { parsingFailure: 5, repeatingAction: 3 });
      expect(res.stop).toBe(false);
    }
  });

  test("3 identical non-type actions in a row triggers stop", () => {
    const history = step([
      act({ type: "click", index: 9 }),
      act({ type: "click", index: 9 }),
      act({ type: "click", index: 9 }),
    ]);
    const res = earlyStop(history, 0, { parsingFailure: 5, repeatingAction: 3 });
    expect(res.stop).toBe(true);
  });

  test("fewer than K actions never triggers a repeat stop (slice(-K) guard)", () => {
    const history = step([act({ type: "click", index: 5 })]);
    const res = earlyStop(history, 0, { parsingFailure: 5, repeatingAction: 3 });
    expect(res.stop).toBe(false);
  });

  test("typing the same text into 3+ distinct fields triggers stop", () => {
    const history = step([
      act({ type: "input", index: 1, text: "x" }),
      act({ type: "input", index: 2, text: "x" }),
      act({ type: "input", index: 3, text: "x" }),
    ]);
    const res = earlyStop(history, 0, { parsingFailure: 5, repeatingAction: 3 });
    expect(res.stop).toBe(true);
  });

  test("typing the same text into the same field 3x does NOT trigger stop", () => {
    const history = step([
      act({ type: "input", index: 1, text: "x" }),
      act({ type: "input", index: 1, text: "x" }),
      act({ type: "input", index: 1, text: "x" }),
    ]);
    const res = earlyStop(history, 0, { parsingFailure: 5, repeatingAction: 3 });
    expect(res.stop).toBe(false);
  });

  test("alert_send_keys (multiple prompts, same text) never stops on the whole-history count", () => {
    const history = step([
      act({ type: "alert_send_keys", text: "ok" }),
      act({ type: "alert_send_keys", text: "ok" }),
      act({ type: "alert_send_keys", text: "ok" }),
      act({ type: "alert_send_keys", text: "ok" }),
    ]);
    const res = earlyStop(history, 0, { parsingFailure: 5, repeatingAction: 3 });
    expect(res.stop).toBe(false);
  });
});
