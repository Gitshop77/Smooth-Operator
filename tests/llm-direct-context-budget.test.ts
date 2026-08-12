/**
 * Tests for the model-context-aware prompt-budget wiring in llm-direct.ts.
 *
 * Locks:
 * - `catalogContextFor`: derives a known model's declared context from the
 *   models.dev catalog (REAL bundled data); returns `undefined` for unknown
 *   models (e.g. arbitrary local Ollama names).
 * - `getContextTokens`: the user override is validated at the storage boundary
 *   (1k floor, finite number) so a corrupt value can't derive a degenerate budget.
 * - `getEffectiveContextTokens`: override wins; else catalog-derived; else
 *   `undefined` (fixed per-kind profiles apply).
 * - `assertPromptBudget`: dispatches to the context-aware assert when a context
 *   is known (a 64k model fails closed on an oversized prompt) and to the fixed
 *   profile when unknown.
 * - `navigatorCallDirect`: with a 64k effective context, an oversized compiled
 *   navigator prompt throws `PromptBudgetExceededError` BEFORE the provider is
 *   called — the fail-closed guarantee is real at runtime, not just tested.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentStepRequest } from "../src/lib/agent/types";

const h = vi.hoisted(() => ({
  mockProviderId: "openai",
  mockModel: "gpt-4o-mini",
  chatRequests: [] as Record<string, unknown>[],
  chatContent: "{}",
  navigatorUserContent: "USER_MESSAGE",
}));

vi.mock("../src/extension/provider-config", () => ({
  readProviderConfig: async () => ({
    provider: h.mockProviderId,
    apiKey: "k",
    model: h.mockModel,
  }),
  resolveModel: (c: { provider?: string; model?: string; catalogId?: string }) =>
    c.model ?? "resolved-default",
  buildProvider: async () => ({
    id: h.mockProviderId,
    model: h.mockModel,
    supportsStructuredOutput: true,
    supportsVision: false,
    chat: async (req: { messages: unknown[] }) => {
      h.chatRequests.push(req as Record<string, unknown>);
      return { content: h.chatContent };
    },
  }),
}));

vi.mock("../src/lib/agent/prompts/navigator-prompt", () => ({
  buildNavigatorPrompt: () => "SYSTEM_PROMPT",
}));

vi.mock("../src/lib/agent/loop/messages", () => ({
  buildNavigatorUserMessage: async () => h.navigatorUserContent,
  buildPlannerUserMessage: async () => "PLANNER_MESSAGE",
}));

/** In-memory chrome.storage.local backing the module under test. */
let store: Record<string, unknown> = {};

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
      onChanged: { addListener: () => undefined },
    },
  };
}

beforeEach(() => {
  h.chatRequests = [];
  h.navigatorUserContent = "USER_MESSAGE";
  installChrome();
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.resetModules();
});

function makeRequest(): AgentStepRequest {
  return {
    task: "do something",
    history: [],
    browserState: {
      url: "https://example.com",
      title: "Example",
      tabs: [],
      elementsText: "els",
      pageInfo: "",
      newElementCount: 0,
    },
    step: 1,
    maxSteps: 10,
  };
}
describe("catalogContextFor (real bundled catalog)", () => {
  test("derives the declared context for a known catalog model", async () => {
    const { catalogContextFor } = await import("../src/extension/llm-direct");
    // gpt-4o-mini declares a 128k context window in the models.dev snapshot.
    expect(catalogContextFor("openai", "gpt-4o-mini")).toBe(128_000);
  });

  test("returns undefined for an unknown model (no catalog entry)", async () => {
    const { catalogContextFor } = await import("../src/extension/llm-direct");
    expect(catalogContextFor("openai", "definitely-not-a-real-model")).toBeUndefined();
    expect(catalogContextFor("ollama", "llama3.1-custom")).toBeUndefined();
  });
});

describe("getContextTokens (user override)", () => {
  test("returns a valid stored override", async () => {
    store.contextTokens = 64_000;
    const { getContextTokens } = await import("../src/extension/llm-direct");
    expect(await getContextTokens()).toBe(64_000);
  });

  test("floors a fractional value", async () => {
    store.contextTokens = 64_999.5;
    const { getContextTokens } = await import("../src/extension/llm-direct");
    expect(await getContextTokens()).toBe(64_999);
  });

  test("rejects a below-floor value (corrupt/degenerate context)", async () => {
    store.contextTokens = 42;
    const { getContextTokens } = await import("../src/extension/llm-direct");
    expect(await getContextTokens()).toBeUndefined();
  });

  test("rejects a non-number", async () => {
    store.contextTokens = "64000";
    const { getContextTokens } = await import("../src/extension/llm-direct");
    expect(await getContextTokens()).toBeUndefined();
  });

  test("unset → undefined", async () => {
    const { getContextTokens } = await import("../src/extension/llm-direct");
    expect(await getContextTokens()).toBeUndefined();
  });
});

describe("getEffectiveContextTokens", () => {
  test("the user override wins over the catalog ('256k native, but I run at 64k')", async () => {
    store.contextTokens = 64_000;
    const { getEffectiveContextTokens } = await import("../src/extension/llm-direct");
    // gpt-4o-mini is catalog 128k — the override must cap it.
    expect(await getEffectiveContextTokens()).toBe(64_000);
  });

  test("falls back to the catalog-derived context for the active model", async () => {
    const { getEffectiveContextTokens } = await import("../src/extension/llm-direct");
    expect(await getEffectiveContextTokens()).toBe(128_000);
  });
});

describe("assertPromptBudget", () => {
  const messages = [{ content: "x".repeat(50_000) }];

  test("fails closed against the DERIVED budget when a context is known (64k)", async () => {
    const { assertPromptBudget } = await import("../src/extension/llm-direct");
    // 64k navigator → maxInput = 64k − 8k output − 16k reasoning = 39,424 < 50,000.
    expect(() => assertPromptBudget("navigator", "navigator-64k", messages, 64_000)).toThrow(
      /Prompt budget exceeded/,
    );
  });

  test("passes the same prompt under a larger context", async () => {
    const { assertPromptBudget } = await import("../src/extension/llm-direct");
    // 200k navigator → maxInput = 200k − 8k − 16k = 176,000 > 50,000.
    expect(() => assertPromptBudget("navigator", "navigator-200k", messages, 200_000)).not.toThrow();
  });

  test("falls back to the fixed profile when the context is unknown", async () => {
    const { assertPromptBudget } = await import("../src/extension/llm-direct");
    // 50k < fixed 128k navigator maxInput (103,424) → passes; 110k would fail.
    expect(() => assertPromptBudget("navigator", "navigator-fixed", messages, undefined)).not.toThrow();
    expect(() =>
      assertPromptBudget("navigator", "navigator-fixed-over", [{ content: "x".repeat(110_000) }], undefined),
    ).toThrow(/Prompt budget exceeded/);
  });
});

describe("navigatorCallDirect fail-closed at runtime", () => {
  test("an oversized navigator prompt never reaches the provider (64k model)", async () => {
    store.contextTokens = 64_000;
    // Simulate a large page: the user message alone exceeds the 64k-derived
    // maxInput (39,424), so the assembled prompt must be rejected before any
    // provider round-trip.
    h.navigatorUserContent = "PAGE_CONTENT_" + "x".repeat(50_000);

    const { navigatorCallDirect } = await import("../src/extension/llm-direct");
    await expect(navigatorCallDirect(makeRequest())).rejects.toThrow(/Prompt budget exceeded/);
    expect(h.chatRequests.length).toBe(0);
  });

  test("a fitting prompt proceeds to the provider (64k model)", async () => {
    store.contextTokens = 64_000;
    h.navigatorUserContent = "small page";

    const { navigatorCallDirect } = await import("../src/extension/llm-direct");
    const result = await navigatorCallDirect(makeRequest());
    expect(h.chatRequests.length).toBe(1);
    expect(result).toBeDefined();
  });
});

