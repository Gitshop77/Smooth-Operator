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
  getLastPricingError,
  __resetPricingForTests,
} from "../src/lib/agent/llm/pricing";
import { convertCatalog, fetchCustomCatalog } from "../src/lib/agent/llm/pricing-utils";
import type { Catalog } from "../src/lib/agent/llm/catalog";

// Reset all mutable pricing module state before each test so stubbed catalog
// loads / memo / warned-set don't leak across tests (the live catalog is
// hydrated into a module singleton).
beforeEach(() => {
  __resetPricingForTests();
});

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
    vi.unstubAllGlobals();
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

describe("getPricingForModel — DEFAULT_UNKNOWN_MODEL_PRICE constant", () => {
  // Stub fetch to a benign empty catalog so the fire-and-forget catalog load
  // triggered by getPricingForModel is a no-op (deterministic, no network).
  // Once the prior block's fetch stub no longer leaks in (after the
  // unstubAllGlobals fix), this block needs its own stub to stay network-free.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

describe("refreshPricingFromCatalog — COWORK_MODEL_CATALOG_URL override", () => {
  const ORIGINAL = process.env.COWORK_MODEL_CATALOG_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.COWORK_MODEL_CATALOG_URL;
    else process.env.COWORK_MODEL_CATALOG_URL = ORIGINAL;
    vi.unstubAllGlobals();
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

/** Load SAMPLE_CATALOG into the pricing override via a stubbed fetch (shared by the catalog describe blocks). */
async function loadSampleCatalog(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => SAMPLE_CATALOG }))
  );
  await refreshPricingFromCatalog();
}

describe("getPricingForModel — catalogued models resolve via the live catalog (substring/variant)", () => {
  beforeEach(async () => {
    await loadSampleCatalog();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
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
    await loadSampleCatalog();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
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

  test("catalog sets reasoning rate from the catalog (falls back to out when absent)", () => {
 // 1M in + 1M out (all reasoning) -> 2 + 8 = 10 (o3 has no reasoning rate in the
 // catalog, so reasoning tokens fall back to the output rate in estimateCost).
    expect(estimateCost("o3", 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(10, 6);
  });
});

describe("getLastPricingError getter (R2 §6, non-mutating observability)", () => {
  const ORIGINAL = process.env.COWORK_MODEL_CATALOG_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.COWORK_MODEL_CATALOG_URL;
    else process.env.COWORK_MODEL_CATALOG_URL = ORIGINAL;
    vi.unstubAllGlobals();
  });

  test("returns null after a successful refresh", async () => {
    process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/ok.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    );
    await refreshPricingFromCatalog();
    expect(getLastPricingError()).toBeNull();
  });

  test("exposes the last error without resetting module state", async () => {
    process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/broken.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    await refreshPricingFromCatalog();
    const err1 = getLastPricingError();
    const err2 = getLastPricingError();
    // It is a real Error and the getter is non-mutating (repeated reads agree
    // and never clear the captured error).
    expect(err1).toBeInstanceOf(Error);
    expect(err1).toBe(err2);
    expect((err1 as Error).message).toMatch(/network down/);
  });
});

describe("convertCatalog — zero rates are honored (free-tier models)", () => {
  const FREE_CATALOG: Catalog = {
    testprovider: {
      id: "testprovider",
      name: "Test",
      models: {
        "free-model": {
          id: "free-model",
          name: "Free Model",
          release_date: "2025-01-01",
          attachment: false,
          reasoning: false,
          temperature: true,
          tool_call: true,
          cost: { input: 0, output: 0 },
        },
      },
    },
  };

  test("convertCatalog keeps zero-cost models instead of skipping them", () => {
    // The validation layer explicitly permits zero rates ("reprice to free"),
    // so convertCatalog must agree — a skipped zero-cost model would fall to
    // DEFAULT_UNKNOWN_MODEL_PRICE ($10/$30) and trip the cost cap on genuinely
    // free models.
    const table = convertCatalog(FREE_CATALOG);
    expect(table["free-model"].in).toBe(0);
    expect(table["free-model"].out).toBe(0);
    expect(table["free-model"].uncatalogued).toBeUndefined();
  });

  test("a zero-cost model is billed at zero after refresh (not the unknown-model default)", async () => {
    const ORIGINAL = process.env.COWORK_MODEL_CATALOG_URL;
    try {
      process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/free.json";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, status: 200, json: async () => FREE_CATALOG }))
      );
      await refreshPricingFromCatalog();
      const rate = getPricingForModel("free-model");
      expect(rate.in).toBe(0);
      expect(rate.out).toBe(0);
      expect(rate.uncatalogued).toBeUndefined();
      expect(estimateCost("free-model", 1_000_000, 1_000_000)).toBe(0);
    } finally {
      if (ORIGINAL === undefined) delete process.env.COWORK_MODEL_CATALOG_URL;
      else process.env.COWORK_MODEL_CATALOG_URL = ORIGINAL;
      vi.unstubAllGlobals();
    }
  });
});

describe("refreshPricingFromCatalog — bundled path must detect a failed live fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a failed bundled-path fetch leaves the lazy refresh armed", async () => {
    // fetchCatalog never throws (it falls back to the bundled snapshot), so
    // the bundled path used to set pricingLoaded = true unconditionally — the
    // lazy refresh (guarded on `!pricingLoaded`) then never re-fired for the
    // rest of the session after a transient startup network failure. The
    // refresh must surface the failure (lastPricingError) instead.
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls++;
        throw new Error("network down");
      })
    );
    await refreshPricingFromCatalog();
    expect(fetchCalls).toBeGreaterThanOrEqual(1);
    expect(getLastPricingError()).not.toBeNull();
  });

  test("a successful bundled-path fetch clears the error state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    );
    await refreshPricingFromCatalog();
    expect(getLastPricingError()).toBeNull();
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
        // Anthropic-style premium: cache_write (12) is HIGHER than input (10),
        // so the "premium disappears" assertion below is meaningful — billing
        // write tokens at the cacheWrite rate is provably MORE expensive.
        "cw-premium-model": {
          id: "cw-premium-model",
          name: "Cache Write Premium Model",
          release_date: "2025-01-01",
          attachment: false,
          reasoning: false,
          temperature: true,
          tool_call: true,
          cost: { input: 10, output: 20, cache_write: 12 },
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
    vi.unstubAllGlobals();
  });

  test("cache_write tokens are billed at the cacheWrite rate (not the full input rate)", () => {
 // All 1M input tokens are cache-writes. Billed at cacheWrite (2) => 2.
    const cost = estimateCost("cw-model", 1_000_000, 0, 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(2, 6);
 // 2 < billing those tokens at the full input rate of 10.
    expect(cost).toBeLessThan(10);
 // With no cache-write tokens, the 1M fresh input is billed at the full
 // input rate (10), NOT zero — cache-write absence doesn't void the input.
    expect(estimateCost("cw-model", 1_000_000, 0, 0, 0, 0)).toBeCloseTo(10, 6);
 // Supplying cache-write tokens makes the cost strictly less than billing
 // all 1M input fresh at the full input rate (the cache_creation discount).
    expect(estimateCost("cw-model", 1_000_000, 0, 0, 0, 1_000_000)).toBeLessThan(
      estimateCost("cw-model", 1_000_000, 0, 0, 0, 0),
    );
  });

  test("cache-write premium disappears from cost when no write tokens are reported", () => {
 // Premium model (cache_write 12 > input 10): a stateless one-shot call that
 // omits cache markers reports zero write tokens, so the step is billed at
 // the plain input rate — no premium is paid.
    expect(estimateCost("cw-premium-model", 1_000_000, 0, 0, 0, 1_000_000)).toBeCloseTo(12, 6);
    expect(estimateCost("cw-premium-model", 1_000_000, 0, 0, 0, 0)).toBeCloseTo(10, 6);
 // tokensIn INCLUDES the write tokens (Anthropic's input_tokens covers
 // cache_creation_input_tokens): 500K total, all writes → 0 fresh @ 10
 // + 500K write @ 12 = 6. Dropping the write tokens is strictly cheaper.
    expect(estimateCost("cw-premium-model", 500_000, 0, 0, 0, 500_000)).toBeCloseTo(6, 6);
  });
});

// A gpt-5.4-STYLE tiered model: base 2.5/15 + 272k context tier 3/18 +
// over-200k block 5/22.5 (mirrors the bundled gpt-5.4 shape, with distinct
// rates per block so the selected block is provable in each assertion).
const TIERED_CATALOG: Catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          tiers: [
            { input: 3, output: 18, cache_read: 0.25, tier: { type: "context", size: 272_000 } },
          ],
          context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
        },
      },
    },
  },
};

describe("convertCatalog — tiers + context_over_200k parsing", () => {
  function modelWithCost(cost: unknown, id = "m"): Catalog {
    return {
      tp: {
        id: "tp",
        name: "Test",
        models: {
          [id]: {
            id,
            name: `Model ${id}`,
            release_date: "2026-01-01",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            cost: cost as Catalog["tp"]["models"][string]["cost"],
          },
        },
      },
    };
  }

  test("parses tiers and the over-200k block from the raw SDK shape", () => {
    const rate = convertCatalog(TIERED_CATALOG)["gpt-5.4"];
    expect(rate.in).toBe(2.5);
    expect(rate.out).toBe(15);
    expect(rate.cacheRead).toBe(0.25);
    expect(rate.tiers).toEqual([
      { input: 3, output: 18, cache_read: 0.25, tier: { type: "context", size: 272_000 } },
    ]);
    expect(rate.contextOver200k).toEqual({ input: 5, output: 22.5, cache_read: 0.5 });
  });

  test("absent tiers / over-200k stay undefined", () => {
    const rate = convertCatalog(modelWithCost({ input: 1, output: 2 }))["m"];
    expect(rate.in).toBe(1);
    expect(rate.tiers).toBeUndefined();
    expect(rate.contextOver200k).toBeUndefined();
  });

  test("zero tier rates and sizes are honored", () => {
    const rate = convertCatalog(
      modelWithCost({
        input: 1,
        output: 2,
        tiers: [{ input: 0, output: 0, tier: { type: "context", size: 0 } }],
        context_over_200k: { input: 0, output: 0 },
      }),
    )["m"];
    expect(rate.tiers).toEqual([{ input: 0, output: 0, tier: { type: "context", size: 0 } }]);
    expect(rate.contextOver200k).toEqual({ input: 0, output: 0 });
  });

  test("a negative tier rate rejects the whole model", () => {
    const table = convertCatalog(
      modelWithCost({
        input: 1,
        output: 2,
        tiers: [{ input: -1, output: 2, tier: { type: "context", size: 100_000 } }],
      }),
    );
    expect(table["m"]).toBeUndefined();
  });

  test("a negative over-200k rate rejects the whole model", () => {
    const table = convertCatalog(
      modelWithCost({ input: 1, output: 2, context_over_200k: { input: -5, output: 22.5 } }),
    );
    expect(table["m"]).toBeUndefined();
  });

  test("non-context tier types are dropped, not kept", () => {
    const rate = convertCatalog(
      modelWithCost({
        input: 1,
        output: 2,
        tiers: [
          { input: 3, output: 4, tier: { type: "context", size: 100_000 } },
          { input: 9, output: 9, tier: { type: "prompt", size: 50_000 } } as never,
        ],
      }),
    )["m"];
    expect(rate.tiers).toEqual([{ input: 3, output: 4, tier: { type: "context", size: 100_000 } }]);
  });
});

describe("estimateCost — tiered pricing (context-token selection)", () => {
  beforeEach(async () => {
    process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/tiered.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERED_CATALOG })),
    );
    await refreshPricingFromCatalog();
  });
  afterEach(() => {
    delete process.env.COWORK_MODEL_CATALOG_URL;
    vi.unstubAllGlobals();
  });

  test("1,050k context picks the 272k tier rate", () => {
    const cost = estimateCost({
      model: "gpt-5.4",
      tokensIn: 1_000_000,
      tokensOut: 0,
      contextTokens: 1_050_000,
    });
    expect(cost).toBeCloseTo(3, 6); // 1M in @ $3 (272k tier) per 1M
  });

  test("150k context stays on the base rate (no tier matches, under 200k)", () => {
    const cost = estimateCost({
      model: "gpt-5.4",
      tokensIn: 1_000_000,
      tokensOut: 0,
      contextTokens: 150_000,
    });
    expect(cost).toBeCloseTo(2.5, 6);
  });

  test("250k context falls to the over-200k block when no tier matches", () => {
    const cost = estimateCost({
      model: "gpt-5.4",
      tokensIn: 1_000_000,
      tokensOut: 0,
      contextTokens: 250_000,
    });
    expect(cost).toBeCloseTo(5, 6); // 1M in @ $5 (over-200k block) per 1M
  });

  test("50k context uses the base rate", () => {
    const cost = estimateCost({
      model: "gpt-5.4",
      tokensIn: 1_000_000,
      tokensOut: 0,
      contextTokens: 50_000,
    });
    expect(cost).toBeCloseTo(2.5, 6);
  });

  test("reasoning tokens are charged at the selected tier's output rate", () => {
    // 1M in @ tier in (3) + 1M out, all reasoning → visible out 0; 1M
    // reasoning @ tier out (18). If reasoning were billed at the input rate
    // this would be 6, not 21.
    const allReasoning = estimateCost({
      model: "gpt-5.4",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      reasoningTokens: 1_000_000,
      contextTokens: 1_050_000,
    });
    expect(allReasoning).toBeCloseTo(21, 6);
    // 2M out with 1M reasoning → 1M visible @ 18 + 1M reasoning @ 18,
    // plus 1M in @ 3.
    const mixed = estimateCost({
      model: "gpt-5.4",
      tokensIn: 1_000_000,
      tokensOut: 2_000_000,
      reasoningTokens: 1_000_000,
      contextTokens: 1_050_000,
    });
    expect(mixed).toBeCloseTo(39, 6);
  });

  test("contextTokens defaults to tokensIn when omitted (opencode parity)", () => {
    // 1M input → context 1M → 272k tier.
    expect(estimateCost("gpt-5.4", 1_000_000, 0)).toBeCloseTo(3, 6);
    // 150k input → context 150k → base rate.
    expect(estimateCost("gpt-5.4", 150_000, 0)).toBeCloseTo(0.375, 6);
  });

  test("context exactly equal to a tier size skips that tier (strictly greater)", () => {
    // 272k context is NOT > the 272k tier size — the tier must not apply
    // (a `>=` regression would bill this at the tier rate 3). The context
    // still exceeds 200k, so the over-200k block (5) applies instead.
    expect(
      estimateCost({ model: "gpt-5.4", tokensIn: 1_000_000, tokensOut: 0, contextTokens: 272_000 }),
    ).toBeCloseTo(5, 6);
  });

  test("context exactly 200k stays on the base rate (block threshold strictly greater)", () => {
    // 200k context is NOT > 200_000 — the over-200k block must not apply;
    // a `>=` regression would bill this at the block rate (5).
    expect(
      estimateCost({ model: "gpt-5.4", tokensIn: 1_000_000, tokensOut: 0, contextTokens: 200_000 }),
    ).toBeCloseTo(2.5, 6);
  });

  test("the selected tier's cache-read rate applies to cached input", () => {
    const cost = estimateCost({
      model: "gpt-5.4",
      tokensIn: 1_000_000,
      tokensOut: 0,
      cachedInputTokens: 500_000,
      contextTokens: 1_050_000,
    });
    // 500k fresh @ 3 + 500k cached @ 0.25 (tier cache_read).
    expect(cost).toBeCloseTo(1.5 + 0.125, 6);
  });
});

// A TWO-TIER model mirroring the bundled multi-tier entries (doubao/qwen
// families carry [32k, 128k]): the HIGHEST tier whose size is below the
// context count wins, and — per opencode's `??` chain — any qualifying tier
// shadows the over-200k block even when the context exceeds 200k.
const MULTI_TIER_CATALOG: Catalog = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "multi-tier": {
        id: "multi-tier",
        name: "Multi Tier",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 15,
          tiers: [
            { input: 1, output: 5, tier: { type: "context", size: 32_000 } },
            { input: 3, output: 18, tier: { type: "context", size: 128_000 } },
          ],
          context_over_200k: { input: 10, output: 50 },
        },
      },
    },
  },
};

describe("estimateCost — multi-tier selection (highest qualifying tier)", () => {
  beforeEach(async () => {
    process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/multi-tier.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => MULTI_TIER_CATALOG })),
    );
    await refreshPricingFromCatalog();
  });
  afterEach(() => {
    delete process.env.COWORK_MODEL_CATALOG_URL;
    vi.unstubAllGlobals();
  });

  test("the highest qualifying tier wins (1.05M context → 128k tier, not 32k)", () => {
    // Both tiers qualify (1.05M > 32k and > 128k); the sort-desc + first
    // selection must pick the 128k tier (3), not the 32k tier (1).
    expect(
      estimateCost({ model: "multi-tier", tokensIn: 1_000_000, tokensOut: 0, contextTokens: 1_050_000 }),
    ).toBeCloseTo(3, 6);
  });

  test("a smaller context picks the smaller qualifying tier (100k → 32k tier)", () => {
    // 100k > 32k but NOT > 128k → the 32k tier applies.
    expect(
      estimateCost({ model: "multi-tier", tokensIn: 1_000_000, tokensOut: 0, contextTokens: 100_000 }),
    ).toBeCloseTo(1, 6);
  });

  test("context equal to a tier size falls to the NEXT qualifying block", () => {
    // 32k is not > 32_000 and not > 128_000, and 32k < 200k → base (2.5).
    expect(
      estimateCost({ model: "multi-tier", tokensIn: 1_000_000, tokensOut: 0, contextTokens: 32_000 }),
    ).toBeCloseTo(2.5, 6);
    // 128k is not > 128_000 (upper tier skipped) but IS > 32_000 → the 32k
    // tier (1) applies — never the 128k tier (3), never base (2.5).
    expect(
      estimateCost({ model: "multi-tier", tokensIn: 1_000_000, tokensOut: 0, contextTokens: 128_000 }),
    ).toBeCloseTo(1, 6);
  });

  test("a qualifying tier shadows the over-200k block (opencode ??-chain semantics)", () => {
    // 250k > 32k and > 128k → the 128k tier (3) wins; the over-200k block
    // (10) must NOT apply even though the context exceeds 200k.
    expect(
      estimateCost({ model: "multi-tier", tokensIn: 1_000_000, tokensOut: 0, contextTokens: 250_000 }),
    ).toBeCloseTo(3, 6);
  });
});

// ─── fetchCustomCatalog hardening (fix 3) ────────────────────────────────────

describe("fetchCustomCatalog — fetch hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetch is called with redirect:'error', credentials:'omit', cache:'no-store', and no referrer", async () => {
    // The catalog fetch must never follow a redirect (a 3xx could bounce the
    // request to an attacker origin), never send ambient credentials/cookies,
    // and never reuse a cached response — mirroring the route transport's
    // hardening. No resolver exists in this runtime, so the DNS step degrades
    // to best-effort and the fetch proceeds.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({}) }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await fetchCustomCatalog("https://catalog.example.com/models.json");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(init?.cache).toBe("no-store");
      expect(init?.referrer).toBe("");
    } finally {
      warn.mockRestore();
    }
  });

  test("a non-HTTP scheme is refused before any fetch (redirect:'error' is asserted above)", async () => {
    await expect(fetchCustomCatalog("ftp://catalog.example.com/x.json")).rejects.toThrow(/non-HTTP/);
  });
});
