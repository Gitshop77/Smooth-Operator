/**
 * Race condition test for the provider cache in llm-direct.ts.
 *
 * Verifies that when two concurrent `getProvider` calls race with different
 * configs, the final cached provider matches the last-to-resolve config — not
 * a stale intermediate state caused by premature `cachedProviderConfig`
 * assignment.
 *
 * The bug: `cachedProviderConfig = config` was assigned BEFORE `buildProvider`
 * completed (line 211). Two concurrent calls could both overwrite
 * `cachedProviderConfig`, causing the hot-path cache check (line 186) to
 * return a provider built from a different config than expected.
 *
 * The fix: remove the premature assignment — `cachedProviderConfig` is only set
 * inside the epoch guard AFTER a successful build.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentStepRequest } from "../src/lib/agent/types";

const h = vi.hoisted(() => ({
  buildConfigs: [] as string[],
  buildDelays: [10, 200] as number[],
  readCallIndex: 0,
  configs: [
    { provider: "openai", apiKey: "key-a", model: "model-a" },
    { provider: "anthropic", apiKey: "key-b", model: "model-b" },
  ] as { provider: string; apiKey: string; model: string }[],
}));

vi.mock("../src/extension/provider-config", () => ({
  readProviderConfig: async () => {
    const idx = h.readCallIndex;
    h.readCallIndex++;
    return h.configs[idx % h.configs.length];
  },
  resolveModel: (cfg: { provider?: string; model?: string; catalogId?: string }) =>
    cfg.model ?? "resolved-default",
  buildProvider: async (cfg: { provider: string; apiKey: string; model: string }) => {
    const idx = h.buildConfigs.length;
    h.buildConfigs.push(cfg.provider);
    const delay = h.buildDelays[idx] ?? 100;
    await new Promise((r) => setTimeout(r, delay));
    return {
      id: `provider-${cfg.provider}-${idx}`,
      supportsStructuredOutput: true,
      supportsVision: false,
      supportsReasoning: false,
      // The raw content is passed through untouched by navigatorCallDirect, so
      // embedding the config's provider id lets tests observe WHICH provider
      // instance served a call (cache-hit calls reuse the committed provider).
      chat: async () => ({
        content: JSON.stringify({ provider: cfg.provider }),
      }),
    };
  },
}));

vi.mock("../src/lib/agent/prompts/navigator-prompt", () => ({
  buildNavigatorPrompt: () => "SYSTEM",
}));

vi.mock("../src/lib/agent/prompts/planner-prompt", () => ({
  buildPlannerPrompt: () => "PLANNER",
}));

vi.mock("../src/lib/agent/loop/messages", () => ({
  buildNavigatorUserMessage: async () => "USER",
  buildPlannerUserMessage: async () => "PLANNER_USER",
}));

let store: Record<string, unknown>;

function installChrome() {
  store = {};
  const get = (keys: string | string[]) => {
    const arr = Array.isArray(keys) ? keys : [keys];
    const result: Record<string, unknown> = {};
    for (const k of arr) if (k in store) result[k] = store[k];
    return Promise.resolve(result);
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: { get, set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
  };
}

beforeEach(() => {
  h.buildConfigs = [];
  h.buildDelays = [10, 200];
  h.readCallIndex = 0;
  h.configs = [
    { provider: "openai", apiKey: "key-a", model: "model-a" },
    { provider: "anthropic", apiKey: "key-b", model: "model-b" },
  ];
  installChrome();
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.resetModules();
});

function makeRequest(): AgentStepRequest {
  return {
    task: "test task",
    history: [],
    browserState: {
      url: "https://example.com",
      title: "Example",
      tabs: [],
      elementsText: "content",
      pageInfo: "",
      newElementCount: 0,
      screenshot: "SCREENSHOT",
    },
    step: 1,
    maxSteps: 10,
  };
}

describe("provider cache race condition", () => {
  test("concurrent getProvider calls with different configs both build and resolve correctly", async () => {
    // Two concurrent calls: readProviderConfig returns config A first, config B
    // second. Both should trigger buildProvider (neither hits the cache).
    const { navigatorCallDirect } = await import("../src/extension/llm-direct");

    // Start both calls concurrently — each reads a different config from storage.
    const p1 = navigatorCallDirect(makeRequest());
    const p2 = navigatorCallDirect(makeRequest());

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both calls should succeed
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    // Both configs should have been built (config A fast, config B slow)
    expect(h.buildConfigs).toContain("openai");
    expect(h.buildConfigs).toContain("anthropic");

    // The last-to-build should be config B (the slow one)
    expect(h.buildConfigs[h.buildConfigs.length - 1]).toBe("anthropic");

    // The committed cache must match the last-to-resolve config (B): a third
    // call hits the hot path — no new build, and the provider serving it is
    // the one built from config B.
    const r3 = await navigatorCallDirect(makeRequest());
    expect(h.buildConfigs).toHaveLength(2);
    expect(JSON.parse(r3.raw).provider).toBe("anthropic");
  });

  test("slow config resolves last and wins the cache", async () => {
    // Config A resolves fast (10ms); config B resolves slow (300ms). The
    // slow-to-resolve config B should commit last and be the cached provider.
    h.buildDelays = [10, 300];

    const { navigatorCallDirect } = await import("../src/extension/llm-direct");

    const p1 = navigatorCallDirect(makeRequest());
    const p2 = navigatorCallDirect(makeRequest());

    await Promise.all([p1, p2]);

    // Both were built
    expect(h.buildConfigs).toEqual(["openai", "anthropic"]);

    // The cache committed the slow config: a third call reuses it without a
    // new build (the exact property the file's header claims the test locks).
    const r3 = await navigatorCallDirect(makeRequest());
    expect(h.buildConfigs).toEqual(["openai", "anthropic"]);
    expect(JSON.parse(r3.raw).provider).toBe("anthropic");
  });

  test("same config concurrent calls reuse the in-flight build (pendingProviders)", async () => {
    // Both calls read the same config — the second should reuse the first's
    // in-flight build via pendingProviders, not start a second buildProvider.
    h.buildDelays = [200, 200];
    // Force both reads to return the same config (config A)
    h.readCallIndex = 0;
    h.configs = [
      { provider: "openai", apiKey: "key-a", model: "model-a" },
    ];

    const { navigatorCallDirect } = await import("../src/extension/llm-direct");

    const p1 = navigatorCallDirect(makeRequest());
    const p2 = navigatorCallDirect(makeRequest());

    await Promise.all([p1, p2]);

    // Only ONE build should have been triggered (the second reused the in-flight).
    expect(h.buildConfigs).toEqual(["openai"]);

    // The committed provider is that single build; a third call short-circuits
    // the cache without rebuilding or re-reading the config.
    const r3 = await navigatorCallDirect(makeRequest());
    expect(h.buildConfigs).toEqual(["openai"]);
    expect(JSON.parse(r3.raw).provider).toBe("openai");
  });
});
