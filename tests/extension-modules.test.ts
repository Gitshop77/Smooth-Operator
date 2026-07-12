/**
 * Extension module unit tests.
 *
 * Tests the pure logic in `src/extension/` that doesn't require a live
 * Chrome browser — `provider-config.ts` (provider resolution) and the
 * shared helpers. The background/content/sidepanel modules require
 * `chrome.*` API mocking and are left for a future integration test suite.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { buildProvider, readProviderConfig } from "../src/extension/provider-config";

// ─── provider-config: buildProvider ─────────────────────────────────────────

describe("provider-config: buildProvider", () => {
  test("builds an OpenAI provider", async () => {
    const provider = await buildProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o",
    });
    expect(provider.id).toContain("openai");
    expect(provider.supportsVision).toBe(true);
    expect(provider.supportsStructuredOutput).toBe(true);
  });

  test("builds an Anthropic provider", async () => {
    const provider = await buildProvider({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-20241022",
    });
    expect(provider.id).toContain("anthropic");
    expect(provider.supportsVision).toBe(true);
  });

  test("builds a Gemini provider", async () => {
    const provider = await buildProvider({
      provider: "gemini",
      apiKey: "AIza-test",
      model: "gemini-2.0-flash",
    });
    expect(provider.id).toContain("gemini");
    expect(provider.supportsVision).toBe(true);
  });

  test("throws for Anthropic without an API key", async () => {
    await expect(
      buildProvider({ provider: "anthropic", apiKey: "", model: "claude-3-5-sonnet-20241022" })
    ).rejects.toThrow(/API key/);
  });

  test("throws for Gemini without an API key", async () => {
    await expect(
      buildProvider({ provider: "gemini", apiKey: "", model: "gemini-2.0-flash" })
    ).rejects.toThrow(/API key/);
  });

  test("builds an OpenAI-compatible provider (deepseek)", async () => {
    const provider = await buildProvider({
      provider: "deepseek",
      apiKey: "sk-test",
      model: "deepseek-chat",
    });
    expect(provider.id).toContain("deepseek");
  });

  test("builds an OpenAI-compatible provider (groq) with default base URL", async () => {
    const provider = await buildProvider({
      provider: "groq",
      apiKey: "gsk_test",
      model: "llama-3.3-70b-versatile",
    });
    expect(provider.id).toContain("groq");
  });

  test("throws for unknown provider without baseUrl", async () => {
    await expect(
      buildProvider({ provider: "unknown-provider", apiKey: "key", model: "model" })
    ).rejects.toThrow(/Unknown provider/);
  });

  test("builds Ollama without an API key (local provider)", async () => {
    const provider = await buildProvider({
      provider: "ollama",
      apiKey: "",
      model: "llama3.3",
    });
    expect(provider.id).toContain("ollama");
  });

  test("builds Azure with resourceName", async () => {
    const provider = await buildProvider({
      provider: "azure",
      apiKey: "key",
      model: "gpt-4o",
      resourceName: "my-resource",
    });
    expect(provider.id).toContain("azure");
  });

  test("uses default model when model is empty", async () => {
    const provider = await buildProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "",
    });
 // The provider should still be built — the default model is used.
    expect(provider).toBeDefined();
  });
});

// ─── provider-config: readProviderConfig ────────────────────────────────────

describe("provider-config: readProviderConfig", () => {
  beforeEach(() => {
 // Stub chrome.storage for the test. The API key is intentionally kept in
 // `chrome.storage.session` (in-memory, never written to disk) for security —
 // it must NOT be persisted in chrome.storage.local as plaintext. The test
 // reflects that design: provider/model/baseUrl live in `local`, the apiKey
 // lives in `session`.
    const store: Record<string, unknown> = {};
    const sessionStore: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn((keys: string | string[]) => {
            const keyArr = Array.isArray(keys) ? keys : [keys];
            const result: Record<string, unknown> = {};
            for (const k of keyArr) {
              if (k in store) result[k] = store[k];
            }
            return Promise.resolve(result);
          }),
        },
        session: {
          get: vi.fn((keys: string | string[]) => {
            const keyArr = Array.isArray(keys) ? keys : [keys];
            const result: Record<string, unknown> = {};
            for (const k of keyArr) {
              if (k in sessionStore) result[k] = sessionStore[k];
            }
            return Promise.resolve(result);
          }),
        },
      },
    };
 // Expose stores for individual tests to populate.
    (globalThis as unknown as { __testStore: Record<string, unknown> }).__testStore = store;
    (globalThis as unknown as { __testSessionStore: Record<string, unknown> }).__testSessionStore =
      sessionStore;
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    delete (globalThis as unknown as { __testStore?: unknown }).__testStore;
    delete (globalThis as unknown as { __testSessionStore?: unknown }).__testSessionStore;
  });

  test("returns null when no provider is set", async () => {
    const config = await readProviderConfig();
    expect(config).toBeNull();
  });

  test("returns the stored provider config", async () => {
    const store = (globalThis as unknown as { __testStore: Record<string, unknown> }).__testStore;
    const sessionStore = (globalThis as unknown as { __testSessionStore: Record<string, unknown> })
      .__testSessionStore;
    store.provider = "openai";
    store.model = "gpt-4o";
    store.baseUrl = "";
 // The API key is read from chrome.storage.session (in-memory), never from
 // chrome.storage.local (plaintext on disk).
    sessionStore.apiKey = "sk-test";

    const config = await readProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe("openai");
    expect(config!.apiKey).toBe("sk-test");
    expect(config!.model).toBe("gpt-4o");
  });

  test("returns null when chrome.storage is unavailable", async () => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    const config = await readProviderConfig();
    expect(config).toBeNull();
  });
});
