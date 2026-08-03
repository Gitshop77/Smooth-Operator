/**
 * `done` must be the ONLY action in its step. The actions array on
 * `AgentOutputSchema` enforces done-exclusivity via a superRefine, so a step
 * like [{type:"done"},{type:"input",...}] is rejected at parse time while a
 * single `done` (the valid case) still validates.
 */

import { describe, test, expect } from "vitest";
import { AgentOutputSchema } from "../src/lib/agent/tools/schema";

describe("AgentOutputSchema done-exclusivity", () => {
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

describe("AgentOutputSchema done.success default", () => {
  const doneSuccess = (action: unknown[]): unknown => {
    const item = action[0] as { type?: string; success?: unknown };
    expect(item.type).toBe("done");
    return item.success;
  };

  test("omitted success parses to false (never an undefined verdict)", () => {
    const res = AgentOutputSchema.safeParse({ action: [{ type: "done", text: "done" }] });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(doneSuccess(res.data.action)).toBe(false);
    }
  });

  test("explicit null success parses to false", () => {
    const res = AgentOutputSchema.safeParse({ action: [{ type: "done", text: "done", success: null }] });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(doneSuccess(res.data.action)).toBe(false);
    }
  });

  test("explicit true/false are preserved", () => {
    const yes = AgentOutputSchema.safeParse({ action: [{ type: "done", text: "done", success: true }] });
    expect(yes.success).toBe(true);
    if (yes.success) expect(doneSuccess(yes.data.action)).toBe(true);
    const no = AgentOutputSchema.safeParse({ action: [{ type: "done", text: "done", success: false }] });
    expect(no.success).toBe(true);
    if (no.success) expect(doneSuccess(no.data.action)).toBe(false);
  });
});
