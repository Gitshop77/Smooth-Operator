/**
 * F-18: `done` must be the ONLY action in its step. The actions array on
 * `AgentOutputSchema` enforces done-exclusivity via a superRefine, so a step
 * like [{type:"done"},{type:"input",...}] is rejected at parse time while a
 * single `done` (the valid case) still validates.
 */

import { describe, test, expect } from "vitest";
import { AgentOutputSchema } from "../src/lib/agent/tools/schema";

describe("AgentOutputSchema done-exclusivity (F-18)", () => {
  test("a single done action is valid", () => {
    const res = AgentOutputSchema.safeParse({
      action: [{ type: "done", text: "all done", success: true }],
    });
    expect(res.success).toBe(true);
  });

  test("done combined with input is rejected", () => {
    const res = AgentOutputSchema.safeParse({
      action: [
        { type: "done", text: "done", success: true },
        { type: "input", index: 1, text: "typed too late" },
      ],
    });
    expect(res.success).toBe(false);
  });

  test("done combined with click is rejected", () => {
    const res = AgentOutputSchema.safeParse({
      action: [
        { type: "click", index: 3 },
        { type: "done", text: "done", success: false },
      ],
    });
    expect(res.success).toBe(false);
  });

  test("multiple non-done actions are still valid", () => {
    const res = AgentOutputSchema.safeParse({
      action: [
        { type: "click", index: 1 },
        { type: "input", index: 2, text: "hi" },
      ],
    });
    expect(res.success).toBe(true);
  });

  test("empty actions array is rejected (min(1))", () => {
    const res = AgentOutputSchema.safeParse({ action: [] });
    expect(res.success).toBe(false);
  });
});
