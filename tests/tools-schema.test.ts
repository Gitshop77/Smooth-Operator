/**
 * null/'' tolerance for the LLM-visible numeric fields of
 * WaitSchema / FindElementsSchema / PressAndHoldSchema.
 *
 * The LLM can emit `null` or `""` for optional numeric fields. Documented
 * behavior: those inputs must be tolerated (coerced like `pages`, or mapped
 * to the field default) instead of failing the whole action parse — a parse
 * failure costs a retry nudge, and in llm-direct structured mode it is a
 * hard failure. Other invalid types (non-numeric strings, objects) must
 * still be rejected.
 */

import { describe, test, expect } from "vitest";
import { WaitSchema, FindElementsSchema, PressAndHoldSchema } from "../src/lib/agent/tools/schema";

describe("WaitSchema.seconds", () => {
  test("accepts null and '' like `pages` (coerced to 0), undefined → default 3", () => {
    expect(WaitSchema.shape.seconds.safeParse(null).success).toBe(true);
    expect(WaitSchema.shape.seconds.safeParse("").success).toBe(true);
    expect(WaitSchema.parse({ type: "wait" }).seconds).toBe(3);
  });

  test("rejects other invalid types", () => {
    expect(WaitSchema.shape.seconds.safeParse("abc").success).toBe(false);
    expect(WaitSchema.shape.seconds.safeParse({}).success).toBe(false);
  });
});

describe("FindElementsSchema.max_results", () => {
  test("accepts null and '' mapped to the default 50, undefined → default 50", () => {
    expect(FindElementsSchema.shape.max_results.safeParse(null).success).toBe(true);
    expect(FindElementsSchema.shape.max_results.safeParse(null).data).toBe(50);
    expect(FindElementsSchema.shape.max_results.safeParse("").success).toBe(true);
    expect(FindElementsSchema.shape.max_results.safeParse("").data).toBe(50);
    expect(FindElementsSchema.parse({ type: "find_elements", selector: ".x" }).max_results).toBe(50);
  });

  test("rejects other invalid types", () => {
    expect(FindElementsSchema.shape.max_results.safeParse("abc").success).toBe(false);
    expect(FindElementsSchema.shape.max_results.safeParse({}).success).toBe(false);
  });
});

describe("PressAndHoldSchema.hold_ms", () => {
  test("accepts null and '' like `pages` (coerced to 0), undefined → default 1500", () => {
    expect(PressAndHoldSchema.shape.hold_ms.safeParse(null).success).toBe(true);
    expect(PressAndHoldSchema.shape.hold_ms.safeParse("").success).toBe(true);
    expect(PressAndHoldSchema.parse({ type: "press_and_hold", index: 1 }).hold_ms).toBe(1500);
  });

  test("rejects other invalid types", () => {
    expect(PressAndHoldSchema.shape.hold_ms.safeParse("abc").success).toBe(false);
    expect(PressAndHoldSchema.shape.hold_ms.safeParse({}).success).toBe(false);
  });
});
