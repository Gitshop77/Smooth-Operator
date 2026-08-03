/**
 * Run-usage accumulation + side-panel usage surface.
 *
 * The service worker accumulates per-call `cost` events into `RunState.usage`;
 * the side panel renders that accumulated usage plus a context-window meter.
 * The pure helpers are shared by both sides so the panel display always matches
 * what the worker persisted.
 */

import { describe, test, expect, beforeAll, vi } from "vitest";

// Stub the pricing lookup so the uncatalogued-flag propagation is deterministic
// (no lazy catalog refresh / warn side effects in tests). vi.hoisted keeps the
// spy reference usable inside the hoisted vi.mock factory.
const { pricingMock, refreshPricingMock } = vi.hoisted(() => ({
  pricingMock: vi.fn(),
  refreshPricingMock: vi.fn(),
}));
vi.mock("@/lib/agent/llm/pricing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/llm/pricing")>();
  pricingMock.mockImplementation((model: string) => actual.getPricingForModel(model));
  return { ...actual, getPricingForModel: pricingMock, refreshPricingFromCatalog: refreshPricingMock };
});

import {
  zeroRunUsage,
  addCostEvent,
  type CostEventLike,
} from "../src/extension/background/state-store-utils";
import {
  completionTokens,
  contextUsagePct,
  isUncataloguedModel,
} from "../src/extension/sidepanel/usage-panel";

function costEvent(over: Partial<CostEventLike>): CostEventLike {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0, model: "", ...over };
}

describe("run-usage accumulation (service-worker side)", () => {
  test("zeroRunUsage returns an all-zero record", () => {
    expect(zeroRunUsage()).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, model: "" });
  });

  test("addCostEvent sums tokens + cost and keeps the latest model", () => {
    const a = addCostEvent(zeroRunUsage(), costEvent({ tokensIn: 100, tokensOut: 50, costUsd: 0.001, model: "gpt-5.4" }));
    const b = addCostEvent(a, costEvent({ tokensIn: 300, tokensOut: 200, costUsd: 0.004, model: "gpt-5.4" }));
    expect(b).toEqual({ tokensIn: 400, tokensOut: 250, costUsd: 0.005, model: "gpt-5.4" });
  });

  test("addCostEvent carries reasoning/cache token fields", () => {
    const a = addCostEvent(zeroRunUsage(), costEvent({ tokensIn: 10, tokensOut: 20, costUsd: 0.001, model: "m", reasoningTokens: 8, cachedInputTokens: 5, cachedWriteInputTokens: 2 }));
    const b = addCostEvent(a, costEvent({ tokensIn: 1, tokensOut: 2, costUsd: 0.0001, model: "m", reasoningTokens: 2, cachedInputTokens: 1 }));
    expect(b.reasoningTokens).toBe(10);
    expect(b.cachedInputTokens).toBe(6);
    expect(b.cachedWriteInputTokens).toBe(2);
  });

  test("addCostEvent leaves rich fields undefined when no event carried them", () => {
    const a = addCostEvent(zeroRunUsage(), costEvent({ tokensIn: 10, tokensOut: 20, costUsd: 0.001, model: "m" }));
    expect(a.reasoningTokens).toBeUndefined();
    expect(a.cachedInputTokens).toBeUndefined();
    expect(a.cachedWriteInputTokens).toBeUndefined();
  });

  test("addCostEvent is immutable (input record unchanged)", () => {
    const input = zeroRunUsage();
    addCostEvent(input, costEvent({ tokensIn: 5, tokensOut: 5, costUsd: 0.001, model: "m" }));
    expect(input).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, model: "" });
  });
});

describe("usage-panel presentation helpers", () => {
  test("completionTokens subtracts reasoning tokens (Gemini counts thoughts in tokensOut)", () => {
    expect(completionTokens({ tokensOut: 120, reasoningTokens: 20 })).toBe(100);
  });

  test("completionTokens floors at zero (never negative)", () => {
    expect(completionTokens({ tokensOut: 5, reasoningTokens: 20 })).toBe(0);
    expect(completionTokens({ tokensOut: 5 })).toBe(5);
  });

  test("contextUsagePct returns 0 when no limit is available", () => {
    expect(contextUsagePct({ tokensIn: 1000, tokensOut: 1000 }, undefined)).toBe(0);
    expect(contextUsagePct({ tokensIn: 1000, tokensOut: 1000 }, 0)).toBe(0);
  });

  test("contextUsagePct computes the share of the context window", () => {
    const usage = { tokensIn: 40_000, tokensOut: 10_000 };
    expect(contextUsagePct(usage, 200_000)).toBeCloseTo(25, 5);
  });

  test("contextUsagePct uses completion-adjusted output (reasoning tokens not double-counted)", () => {
    const usage = { tokensIn: 40_000, tokensOut: 30_000, reasoningTokens: 20_000 };
    expect(contextUsagePct(usage, 200_000)).toBeCloseTo(25, 5);
  });

  test("contextUsagePct clamps at 100 and never below 0", () => {
    expect(contextUsagePct({ tokensIn: 999_999, tokensOut: 999_999 }, 10_000)).toBe(100);
    expect(contextUsagePct({ tokensIn: 0, tokensOut: 0 }, 10_000)).toBe(0);
  });

  test("isUncataloguedModel delegates to the pricing flag", () => {
    pricingMock.mockReturnValueOnce({ uncatalogued: true } as never);
    expect(isUncataloguedModel("totally-unknown-model-xyz")).toBe(true);
    pricingMock.mockReturnValueOnce({ uncatalogued: false } as never);
    expect(isUncataloguedModel("gpt-5.4")).toBe(false);
    expect(isUncataloguedModel("")).toBe(false);
  });
});

describe("usage-panel DOM mount", () => {
  beforeAll(async () => {
    document.body.innerHTML = `<div class="status-bar"></div>`;
    vi.resetModules();
    await import("../src/extension/sidepanel/usage-panel");
  });

  test("mounts a usage panel section after the status bar", () => {
    const panel = document.getElementById("usagePanel");
    expect(panel).not.toBeNull();
    const statusBar = document.querySelector(".status-bar");
    expect(statusBar?.nextElementSibling).toBe(panel);
  });

  test("panel starts hidden until a run accumulates usage", () => {
    const panel = document.getElementById("usagePanel");
    expect(panel?.hidden).toBe(true);
  });
});

describe("usage-panel catalog prime", () => {
  test("kicks the pricing refresh at import when chrome storage is available", async () => {
    vi.resetModules();
    refreshPricingMock.mockClear();
    (globalThis as { chrome?: unknown }).chrome = { storage: { local: {} } };
    await import("../src/extension/sidepanel/usage-panel");
    // The prime's dynamic import resolves in a later microtask than the module
    // import itself, so wait for the refresh kick before asserting.
    await vi.waitFor(() => {
      expect(refreshPricingMock).toHaveBeenCalled();
    });
  });

  test("skips the prime when chrome is unavailable (test/offline contexts)", async () => {
    vi.resetModules();
    refreshPricingMock.mockClear();
    delete (globalThis as { chrome?: unknown }).chrome;
    await import("../src/extension/sidepanel/usage-panel");
    expect(refreshPricingMock).not.toHaveBeenCalled();
  });
});
