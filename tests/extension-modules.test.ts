/**
 * Extension module unit tests.
 *
 * Tests the pure logic in `src/extension/` that doesn't require a live
 * Chrome browser — `provider-config.ts` (provider resolution) and the
 * shared helpers. The background/content/sidepanel modules require
 * `chrome.*` API mocking and are left for a future integration test suite.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { buildProvider, readProviderConfig, type ProviderConfig } from "../src/extension/provider-config";

// ─── provider-config: buildProvider ─────────────────────────────────────────

describe("provider-config: buildProvider", () => {
  const happyCases: Array<{
    args: ProviderConfig;
    idContains: string;
    vision?: boolean;
    structured?: boolean;
  }> = [
    { args: { provider: "openai", apiKey: "sk-test", model: "gpt-4o" }, idContains: "openai", vision: true, structured: true },
    { args: { provider: "anthropic", apiKey: "sk-ant-test", model: "claude-3-5-sonnet-20241022" }, idContains: "anthropic", vision: true },
    { args: { provider: "gemini", apiKey: "AIza-test", model: "gemini-2.0-flash" }, idContains: "gemini", vision: true },
    { args: { provider: "deepseek", apiKey: "sk-test", model: "deepseek-chat" }, idContains: "deepseek" },
    { args: { provider: "groq", apiKey: "gsk_test", model: "llama-3.3-70b-versatile" }, idContains: "groq" },
    { args: { provider: "ollama", apiKey: "", model: "llama3.3" }, idContains: "ollama" },
    { args: { provider: "azure", apiKey: "key", model: "gpt-4o", resourceName: "my-resource" }, idContains: "azure" },
  ];

  test.each(happyCases)("builds a $args.provider provider", async (c) => {
    const provider = await buildProvider(c.args);
    expect(provider.id).toContain(c.idContains);
    if (c.vision !== undefined) expect(provider.supportsVision).toBe(c.vision);
    if (c.structured !== undefined) expect(provider.supportsStructuredOutput).toBe(c.structured);
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

  test("throws for unknown provider without baseUrl", async () => {
    await expect(
      buildProvider({ provider: "unknown-provider", apiKey: "key", model: "model" })
    ).rejects.toThrow(/Unknown provider/);
  });

  test("uses default model when model is empty", async () => {
    const provider = await buildProvider({
      provider: "openai",
      apiKey: "sk-test",
      model: "",
    });
 // `LLMProvider` does not expose the resolved `model` field, but its id embeds
 // the resolved model. An empty input must resolve to a CONCRETE default model
 // (the models.dev catalog default, or `DEFAULT_MODELS['openai'] = 'gpt-4o'`
 // offline) rather than staying empty — assert a non-empty model was resolved.
    expect(provider.id).toMatch(/^openai:[a-z0-9.\-]+$/i);
  });
});

// ─── provider-config: readProviderConfig ────────────────────────────────────

describe("provider-config: readProviderConfig", () => {
  let store: Record<string, unknown> = {};
  let sessionStore: Record<string, unknown> = {};

  const makeStorageGet = (s: Record<string, unknown>) =>
    vi.fn((keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const k of arr) if (k in s) result[k] = s[k];
      return Promise.resolve(result);
    });

  beforeEach(() => {
 // Stub chrome.storage for the test. The API key is intentionally kept in
 // `chrome.storage.session` (in-memory, never written to disk) for security —
 // it must NOT be persisted in chrome.storage.local as plaintext. The test
 // reflects that design: provider/model/baseUrl live in `local`, the apiKey
 // lives in `session`.
    store = {};
    sessionStore = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: { get: makeStorageGet(store) },
        session: { get: makeStorageGet(sessionStore) },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  test("returns null when no provider is set", async () => {
    const config = await readProviderConfig();
    expect(config).toBeNull();
  });

  test("returns the stored provider config", async () => {
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

  test("prefers the in-memory session API key over the plaintext local key", async () => {
    store.provider = "openai";
    store.model = "gpt-4o";
    store.apiKey = "sk-local";
    sessionStore.apiKey = "sk-session";
    const config = await readProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.apiKey).toBe("sk-session");
  });

  test("never trusts a plaintext local key when no session key exists", async () => {
    store.provider = "openai";
    store.model = "gpt-4o";
    // A plaintext key left in chrome.storage.local is attacker-writable
    // (prompt injection / crafted settings-sync) and must NEVER be trusted as
    // the provider key — an attacker could plant it. The key lives ONLY in
    // chrome.storage.session (in-memory), so a missing session key means there
    // is no usable key, and `readProviderConfig` must not fall back to local.
    store.apiKey = "sk-local";
    const config = await readProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.apiKey).not.toBe("sk-local");
    expect(config!.apiKey).toBe("");
  });

  test("returns null when chrome.storage is unavailable", async () => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    const config = await readProviderConfig();
    expect(config).toBeNull();
  });
});
