/**
 * Regression tests for `src/lib/agent/output-parser.ts`.
 *
 * These guard the adversarial-budget behavior of `extractJson` / `parseAgentOutput`:
 * an all-`{` blob must bail quickly instead of O(n²) scanning, an over-budget raw
 * payload must fail fast with a budget error, and a well-formed nested object
 * preceded by prose must still parse.
 */

import { describe, test, expect } from "vitest";
import { z } from "zod";
import {
  extractJson,
  parseAgentOutput,
  parsePlannerOutput,
} from "../src/lib/agent/output-parser";
import { parseOutput } from "../src/lib/agent/output-parser-utils";

const VALID_DONE = JSON.stringify({
  thinking: "done",
  evaluation_previous_goal: "Verdict: Success",
  memory: "",
  next_goal: "finished",
  action: [{ type: "done", text: "done", success: true }],
});

describe("output-parser adversarial budget guards", () => {
  test("a 2MB all-'{' payload bails on the pre-scan length guard, not an O(n²) brace scan", () => {
 // No wall-clock assertions here — elapsed-time checks are flaky on loaded
 // CI runners. The guard is structural: the payload exceeds MAX_JSON_LENGTH
 // (1,000,000), so extractJson MUST reject it with the budget error BEFORE
 // any brace scanning (output-parser-utils.ts:166) — which is precisely why
 // the call stays fast. If the length guard were ever deleted, this test
 // fails (scanner hangs or returns a non-budget error).
    const big = "{".repeat(2_000_000);
    const result = parseAgentOutput(big);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds the .*-character budget/);
  });

  test("raw payload > MAX_JSON_LENGTH returns ok:false with the budget error", () => {
    const over = "x".repeat(1_000_001);
    const result = parseAgentOutput(over);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds the .*-character budget/);
  });

  test("well-formed nested object preceded by leading prose still parses", () => {
    const raw = `Some preamble text before the JSON.
Here is my response:
${VALID_DONE}`;
    expect(extractJson(raw)).toBe(VALID_DONE);
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.output.action[0] as { type: string }).type).toBe("done");
    }
  });

  test("prose with a balanced non-JSON brace before the real JSON parses the JSON", () => {
    const raw = `Let's retry { once }. {"thinking":"...","action":[{"type":"done"}]}`;
    const result = extractJson(raw);
    // The first balanced `{ once }` is NOT valid JSON — the extractor must skip
    // it and return the genuine payload instead of the prose fragment.
    expect(result).toBe(`{"thinking":"...","action":[{"type":"done"}]}`);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// ─── Single-object-array tolerance (parseOutput reverse wrap) ────────────────
//
// Local models (observed live with Qwen) sometimes wrap a single object in a
// 1-element array (`[{...}]`) when the schema expects a single object. The
// parser must unwrap exactly ONE element that is a non-null, non-array object;
// multi-element arrays remain a genuine schema mismatch and must still fail.

describe("output-parser single-object-array tolerance", () => {
  test("agent output: a 1-element array wrapping the object is unwrapped and validates", () => {
    const raw = JSON.stringify([{
      thinking: "done",
      evaluation_previous_goal: "Verdict: Success",
      memory: "",
      next_goal: "finished",
      action: [{ type: "done", text: "done", success: true }],
    }]);
    const result = parseAgentOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.output.action[0] as { type: string }).type).toBe("done");
    }
  });

  test("planner output: a 1-element array wrapping the object is unwrapped and validates", () => {
    const raw = JSON.stringify([{
      thinking: "x",
      decision: "continue",
      plan: ["a", "b"],
      current_plan_item: 0,
      next_goal: "do a",
    }]);
    const result = parsePlannerOutput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.decision).toBe("continue");
      expect(result.output.plan).toEqual(["a", "b"]);
    }
  });

  test("multi-element arrays are NOT unwrapped — the schema error is preserved", () => {
    const raw = JSON.stringify([
      { thinking: "a", decision: "continue", next_goal: "x" },
      { thinking: "b", decision: "continue", next_goal: "y" },
    ]);
    const result = parsePlannerOutput(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expected single object, received array \(2 items\)/);
  });

  test("a 1-element array whose element is itself an array is NOT unwrapped", () => {
    // `[["not-an-object"]]` has length 1, but the sole element is an array —
    // the "non-array object" guard must keep it as a mismatch.
    const schema = z.object({ type: z.string() });
    const result = parseOutput(schema, JSON.stringify([["not-an-object"]]));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expected single object, received array \(1 items\)/);
  });

  test("existing array-schema wrap still works (bare object → 1-element array)", () => {
    const schema = z.array(z.object({ type: z.string() }));
    const result = parseOutput(schema, JSON.stringify({ type: "click" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual([{ type: "click" }]);
    }
  });
});
