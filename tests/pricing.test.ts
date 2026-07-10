/**
 * Pricing tests — covers the cost-cap bypass fix (F-02): an unknown model must
 * NEVER be billed as free, and the static table rates must be accurate (F-21).
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import {
  getPricingForModel,
  estimateCost,
  CONSERVATIVE_DEFAULT_PRICING,
  DEFAULT_UNKNOWN_MODEL_PRICE,
  refreshPricingFromCatalog,
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

describe("getPricingForModel — DEFAULT_UNKNOWN_MODEL_PRICE constant (F-02a)", () => {
  test("DEFAULT_UNKNOWN_MODEL_PRICE is non-zero and flagged uncatalogued", () => {
    expect(DEFAULT_UNKNOWN_MODEL_PRICE.in).toBeGreaterThan(0);
    expect(DEFAULT_UNKNOWN_MODEL_PRICE.out).toBeGreaterThan(0);
    expect(DEFAULT_UNKNOWN_MODEL_PRICE.uncatalogued).toBe(true);
  });

  test("CONSERVATIVE_DEFAULT_PRICING aliases DEFAULT_UNKNOWN_MODEL_PRICE", () => {
    expect(CONSERVATIVE_DEFAULT_PRICING).toBe(DEFAULT_UNKNOWN_MODEL_PRICE);
  });

  test("emits a console.warn when falling back to the unknown-model default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getPricingForModel("definitely-unpriced-model-xyz-999");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/DEFAULT_UNKNOWN_MODEL_PRICE|No catalogued price|unpriced/i);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("refreshPricingFromCatalog — COWORK_MODEL_CATALOG_URL override (F-02b)", () => {
  const ORIGINAL = process.env.COWORK_MODEL_CATALOG_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.COWORK_MODEL_CATALOG_URL;
    else process.env.COWORK_MODEL_CATALOG_URL = ORIGINAL;
    vi.restoreAllMocks();
  });

  test("merges a COWORK_MODEL_CATALOG_URL catalog into pricing (override wins)", async () => {
    process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/catalog.json";
    const catalog = {
      acme: {
        id: "acme",
        name: "Acme",
        models: {
          "acme-ultra": {
            id: "acme-ultra",
            name: "Acme Ultra",
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            cost: { input: 1, output: 2 },
          },
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => catalog }))
    );
    await refreshPricingFromCatalog();
    const rate = getPricingForModel("acme-ultra");
    expect(rate.in).toBe(1);
    expect(rate.out).toBe(2);
    // Catalog-sourced rates are NOT flagged uncatalogued.
    expect(rate.uncatalogued).toBeUndefined();
  });

  test("unknown model is still billed (never free) even when the catalog fetch fails", async () => {
    process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/broken.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    await refreshPricingFromCatalog();
    const rate = getPricingForModel("still-unknown-model");
    expect(rate.in).toBeGreaterThan(0);
    expect(rate.out).toBeGreaterThan(0);
    expect(rate.uncatalogued).toBe(true);
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
