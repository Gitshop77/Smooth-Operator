/**
 * Pricing tests — covers the cost-cap bypass fix and catalog-driven
 * rate resolution. Pricing is now sourced from the LIVE models.dev catalog
 * (hydrated via `refreshPricingFromCatalog`); there is no static table. These
 * tests stub `fetch` so they run without network.
 */

import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import {
  getPricingForModel,
  estimateCost,
  CONSERVATIVE_DEFAULT_PRICING,
  DEFAULT_UNKNOWN_MODEL_PRICE,
  refreshPricingFromCatalog,
} from "../src/lib/agent/llm/pricing";
import type { Catalog } from "../src/lib/agent/llm/catalog";

describe("getPricingForModel — uncatalogued models are never free", () => {
  // Stub fetch to a benign empty catalog so the fire-and-forget catalog load
  // triggered here is a no-op (deterministic, no network).
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

// A small models.dev-shaped catalog used by the catalog-driven describe blocks
// below. Values match the live catalog (so the assertions are meaningful).
const SAMPLE_CATALOG: Catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        release_date: "2024-07-18",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: { input: 0.15, output: 0.6 },
      },
      o3: {
        id: "o3",
        name: "o3",
        release_date: "2025-04-16",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: { input: 2, output: 8 },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-3-5-sonnet": {
        id: "claude-3-5-sonnet",
        name: "Claude 3.5 Sonnet",
        release_date: "2024-10-22",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    models: {
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        release_date: "2025-03-25",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        cost: { input: 1.25, output: 10 },
      },
    },
  },
};

describe("getPricingForModel — catalogued models resolve via the live catalog (substring/variant)", () => {
  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => SAMPLE_CATALOG }))
    );
    await refreshPricingFromCatalog();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("known model resolves from the catalogued rates", () => {
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

  test("all sample models resolve at their catalogued rates", () => {
    expect(getPricingForModel("gemini-2.5-pro").out).toBe(10);
    expect(getPricingForModel("o3").in).toBe(2);
    expect(getPricingForModel("o3").out).toBe(8);
  });
});

describe("Catalog-driven pricing accuracy (replaces static-table)", () => {
  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => SAMPLE_CATALOG }))
    );
    await refreshPricingFromCatalog();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("gemini-2.5-pro output resolved from catalog", () => {
    const rate = getPricingForModel("gemini-2.5-pro");
    expect(rate.in).toBe(1.25);
    expect(rate.out).toBe(10);
  });

  test("o3 resolved from catalog", () => {
    const rate = getPricingForModel("o3");
    expect(rate.in).toBe(2);
    expect(rate.out).toBe(8);
  });

  test("catalog does NOT set a reasoning rate (falls back to out)", () => {
    // models.dev has no reasoning-cost field, so reasoning tokens fall back to
    // the output rate in estimateCost.
    // 1M in + 1M out (all reasoning) -> 2 + 8 = 10 (reasoning at output rate).
    expect(estimateCost("o3", 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(10, 6);
  });
});

describe("cache_write is mapped and billed (cache_creation fix)", () => {
  // A synthetic provider/model whose cache_write rate is LOWER than its input
  // rate, so billing the write tokens at the cacheWrite rate is provably less
  // than billing them at the full input rate.
  const CACHE_WRITE_CATALOG: Catalog = {
    testprovider: {
      id: "testprovider",
      name: "Test",
      models: {
        "cw-model": {
          id: "cw-model",
          name: "Cache Write Model",
          release_date: "2025-01-01",
          attachment: false,
          reasoning: false,
          temperature: true,
          tool_call: true,
          cost: { input: 10, output: 20, cache_write: 2 },
        },
      },
    },
  };

  beforeEach(async () => {
    // Use the COWORK_MODEL_CATALOG_URL path so refreshPricingFromCatalog parses
    // THIS catalog directly (bypassing fetchCatalog's cross-test in-memory cache,
    // which would otherwise serve a stale catalog from an earlier test).
    process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/cw.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => CACHE_WRITE_CATALOG }))
    );
    await refreshPricingFromCatalog();
  });
  afterEach(() => {
    delete process.env.COWORK_MODEL_CATALOG_URL;
    vi.restoreAllMocks();
  });

  test("cache_write tokens are billed at the cacheWrite rate (not the full input rate)", () => {
    // All 1M input tokens are cache-writes. Billed at cacheWrite (2) => 2.
    const cost = estimateCost("cw-model", 1_000_000, 0, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(2, 6);
    // 2 < billing those tokens at the full input rate of 10.
    expect(cost).toBeLessThan((1_000_000 / 1_000_000) * 10);
    // With no cache-write tokens, the 1M fresh input is billed at the full
    // input rate (10), NOT zero — cache-write absence doesn't void the input.
    expect(estimateCost("cw-model", 1_000_000, 0, 0, 0, 0)).toBeCloseTo(10, 6);
    // Supplying cache-write tokens makes the cost strictly less than billing
    // all 1M input fresh at the full input rate (the cache_creation discount).
    expect(estimateCost("cw-model", 1_000_000, 0, 0, 0, 1_000_000)).toBeLessThan(
      estimateCost("cw-model", 1_000_000, 0, 0, 0, 0),
    );
  });
});
