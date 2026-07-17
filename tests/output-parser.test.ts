/**
 * Regression tests for `src/lib/agent/output-parser.ts`.
 *
 * These guard the adversarial-budget behavior of `extractJson` / `parseAgentOutput`:
 * an all-`{` blob must bail quickly instead of O(n²) scanning, an over-budget raw
 * payload must fail fast with a budget error, and a well-formed nested object
 * preceded by prose must still parse.
 */

import { describe, test, expect } from "vitest";
import { extractJson, parseAgentOutput } from "../src/lib/agent/output-parser";

const VALID_DONE = JSON.stringify({
  thinking: "done",
  evaluation_previous_goal: "Verdict: Success",
  memory: "",
  next_goal: "finished",
  action: [{ type: "done", text: "done", success: true }],
});

describe("output-parser adversarial budget guards", () => {
  test("a 2MB all-'{' payload returns quickly via early bail, not O(n²) scan", () => {
    const big = "{".repeat(2_000_000);
    const start = Date.now();
    const result = parseAgentOutput(big);
    const elapsed = Date.now() - start;
    // The guard runs before any brace scanning, so this must not stall.
    expect(elapsed).toBeLessThan(2000);
    expect(result.ok).toBe(false);
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
});
