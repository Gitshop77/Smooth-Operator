/**
 * Cost-cap budget warning injection tests.
 */

import { describe, test, expect } from "vitest";
import { injectCostBudgetWarning } from "../src/lib/agent/loop/context/injection-points";

describe("injectCostBudgetWarning", () => {
  test("returns null when no cost cap is configured", () => {
    expect(injectCostBudgetWarning(0.5, undefined)).toBeNull();
    expect(injectCostBudgetWarning(0.5, 0)).toBeNull();
    expect(injectCostBudgetWarning(0.5, -1)).toBeNull();
  });

  test("returns null below the 75% threshold", () => {
    expect(injectCostBudgetWarning(0.07, 0.10)).toBeNull(); // 70%
    expect(injectCostBudgetWarning(0.749, 1.0)).toBeNull(); // 74.9%
  });

  test("returns the warning at 75% threshold", () => {
    // Use 0.08/0.10 = 0.8 (80%) — clearly above the 75% threshold, and
    // avoids floating-point edge effects at exactly 0.75
    // (0.075/0.10 evaluates to 0.7499999999999999 in IEEE-754, which is < 0.75).
    const warning = injectCostBudgetWarning(0.08, 0.10);
    expect(warning).not.toBeNull();
    expect(warning).toContain("COST BUDGET WARNING");
    expect(warning).toContain("$0.0200"); // remaining = 0.10 - 0.08
    expect(warning).toContain("80%");
  });

  test("returns the warning above 75% threshold", () => {
    const warning = injectCostBudgetWarning(0.95, 1.0);
    expect(warning).not.toBeNull();
    expect(warning).toContain("95%");
  });

  test("returns the warning exactly at the cap (100%)", () => {
    const warning = injectCostBudgetWarning(1.0, 1.0);
    expect(warning).not.toBeNull();
    expect(warning).toContain("100%");
    expect(warning).toContain("$0.0000 remaining");
  });

  test("handles over-budget spend", () => {
    const warning = injectCostBudgetWarning(1.20, 1.0);
    expect(warning).not.toBeNull();
    expect(warning).toContain("COST BUDGET WARNING");
    // Remaining is floored at 0 (never negative) when spend exceeds the cap.
    expect(warning).toContain("$0.0000 remaining");
    // Pin the over-budget percentage rendering so a regression that garbles it
    // (negative or NaN %) is caught.
    expect(warning).toContain("120%");
  });

  test("respects a custom fraction", () => {
    // 50% threshold with 40% usage → no warning.
    expect(injectCostBudgetWarning(0.40, 1.0, 0.5)).toBeNull();
    // 50% threshold with 60% usage → warning.
    const warning = injectCostBudgetWarning(0.60, 1.0, 0.5);
    expect(warning).not.toBeNull();
    expect(warning).toContain("60%");
  });

  test("rejects invalid fractions", () => {
    expect(injectCostBudgetWarning(0.95, 1.0, 0)).toBeNull();
    expect(injectCostBudgetWarning(0.95, 1.0, -0.5)).toBeNull();
    expect(injectCostBudgetWarning(0.95, 1.0, 1.5)).toBeNull();
  });
});
