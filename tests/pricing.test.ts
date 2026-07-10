/**
 * Pricing tests — covers the cost-cap bypass fix (F-02): an unknown model must
 * NEVER be billed as free, and the static table rates must be accurate (F-21).
 */

import { describe, test, expect } from "vitest";
import {
  getPricingForModel,
  estimateCost,
  CONSERVATIVE_DEFAULT_PRICING,
} from "../src/lib/agent/llm/pricing";

describe("getPricingForModel — uncatalogued models are never free (F-02)", () => {
  test("returns a non-zero conservative price for an unknown model", () => {
    const rate = getPricingForModel("totally-unknown-model-xyz-123");
    expect(rate.in).toBeGreaterThan(0);
    expect(rate.out).toBeGreaterThan(0);
    // It must equal the conservative default (not the old { in: 0, out: 0 }).
    expect(rate.in).toBe(CONSERVATIVE_DEFAULT_PRICING.in);
    expect(rate.out).toBe(CONSERVATIVE_DEFAULT_PRICING.out);
  });

  test("flags the unknown model as uncatalogued", () => {
    const rate = getPricingForModel("another-unknown-model-abc");
    expect(rate.uncatalogued).toBe(true);
  });

  test("estimateCost for an unknown model is positive (cost cap can still trip)", () => {
    const cost = estimateCost("unknown-model", 1_000_000, 1_000_000);
    expect(cost).toBeGreaterThan(0);
  });
});

describe("getPricingForModel — catalogued models resolve as before", () => {
  test("known OpenAI model resolves via substring match", () => {
    const rate = getPricingForModel("gpt-4o-mini");
    expect(rate.in).toBe(0.15);
    expect(rate.out).toBe(0.6);
    expect(rate.uncatalogued).toBeUndefined();
  });

  test("date-tagged variants resolve via substring match", () => {
    const rate = getPricingForModel("claude-3-5-sonnet-20241022");
    expect(rate.in).toBe(3);
    expect(rate.out).toBe(15);
  });
});

describe("Static pricing table accuracy (F-21)", () => {
  test("gemini-2.5-pro output corrected to ~$10/M", () => {
    const rate = getPricingForModel("gemini-2.5-pro");
    expect(rate.in).toBe(1.25);
    expect(rate.out).toBe(10);
    // reasoning tokens billed at the corrected output rate
    expect(rate.reasoning).toBe(10);
  });

  test("o3 corrected to ~$2 in / $8 out", () => {
    const rate = getPricingForModel("o3");
    expect(rate.in).toBe(2);
    expect(rate.out).toBe(8);
    expect(rate.reasoning).toBe(8);
  });
});
