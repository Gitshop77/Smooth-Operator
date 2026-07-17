/**
 * SSRF provenance guard — the core defense that prevents an injected
 * `baseUrl` (arriving via prompt injection / malicious settings-sync / crafted
 * tool call, i.e. `provenance: "injected"`) from reaching a local model or a
 * cloud-metadata address. A `"user"` baseUrl keeps the curated
 * local-provider loopback exemption (the user's own Ollama/LiteLLM).
 *
 * These tests also pin the regression fixed by the readProviderConfig change:
 * `readProviderConfig` must NOT hardcode `provenance: "user"`. An injected or
 * absent `provenance` must fail-safe to `"injected"` so the loopback/SSRF
 * exemption is denied.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { buildProvider, readProviderConfig, normalizeString, type ProviderConfig } from "../src/extension/provider-config";

const LOOPBACK_BASE_URL = "http://localhost:11434";

function makeStorageGet(store: Record<string, unknown>) {
  return (keys: string | string[] | null): Promise<Record<string, unknown>> => {
    const result: Record<string, unknown> = {};
    const arr = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
    for (const k of arr) if (k in store) result[k] = store[k];
    return Promise.resolve(result);
  };
}

describe("buildProvider SSRF provenance gate", () => {
  test("injected loopback baseUrl is rejected", async () => {
    await expect(
      buildProvider({
        provider: "openai",
        model: "x",
        apiKey: "k",
        baseUrl: LOOPBACK_BASE_URL,
        provenance: "injected",
      }),
    ).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });

  test("user loopback baseUrl (Ollama) keeps the exemption and resolves", async () => {
    const provider = await buildProvider({
      provider: "openai",
      model: "x",
      apiKey: "k",
      baseUrl: LOOPBACK_BASE_URL,
      provenance: "user",
    });
    expect(provider).toBeTruthy();
    expect(provider.id).toContain("openai");
  });

  test("injected cloud-metadata baseUrl (169.254.169.254) is rejected", async () => {
    await expect(
      buildProvider({
        provider: "openai",
        model: "x",
        apiKey: "k",
        baseUrl: "http://169.254.169.254",
        provenance: "injected",
      }),
    ).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });

  test("user cloud-metadata baseUrl (169.254.169.254) is still rejected (never exempt)", async () => {
    await expect(
      buildProvider({
        provider: "openai",
        model: "x",
        apiKey: "k",
        baseUrl: "http://169.254.169.254",
        provenance: "user",
      }),
    ).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });
});

describe("readProviderConfig provenance (fail-safe)", () => {
  let store: Record<string, unknown>;
  let sessionStore: Record<string, unknown>;

  beforeEach(() => {
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

  function seed(provenance: ProviderConfig["provenance"] | undefined): void {
    store.provider = "openai";
    store.model = "gpt-4o";
    store.baseUrl = LOOPBACK_BASE_URL;
    if (provenance !== undefined) store.provenance = provenance;
    sessionStore.apiKey = "sk-test";
  }

  test("explicit provenance:'injected' + loopback baseUrl → rejected", async () => {
    seed("injected");
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("injected");
    await expect(buildProvider(config!)).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });

  test("absent provenance defaults to 'injected' (fail-safe, no exemption)", async () => {
    seed(undefined);
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("injected");
    await expect(buildProvider(config!)).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });

  test("provenance:'user' + loopback baseUrl → allowed (trusted Options save)", async () => {
    seed("user");
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("user");
    const provider = await buildProvider(config!);
    expect(provider).toBeTruthy();
  });
});

describe("provenance spoofing is not trusted for public hosts", () => {
  let store: Record<string, unknown>;
  let sessionStore: Record<string, unknown>;

  beforeEach(() => {
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

  test("an attacker-written storage entry stamping provenance:'user' + public host is still rejected (key-exfil guard)", async () => {
    store.provider = "openai";
    store.model = "gpt-4o";
    // Public IP-literal attacker host. It deterministically passes the SSRF
    // guard's IP check without DNS resolution, so the canonical-host guard is
    // the layer that must fire. The stored provenance:'user' is NOT trusted
    // here — a hostile write must not skip the API-key-exfiltration guard.
    store.baseUrl = "https://1.2.3.4/v1";
    store.provenance = "user";
    sessionStore.apiKey = "sk-test";

    const config = await readProviderConfig();
    expect(config?.provenance).toBe("user");
    await expect(buildProvider(config!)).rejects.toThrow(/not the canonical host/);
  });
});

describe("buildProvider unknown provider", () => {
  test("an unknown provider id throws 'Unknown provider'", async () => {
    await expect(
      buildProvider({
        provider: "definitely-not-real",
        model: "x",
        apiKey: "k",
        provenance: "user",
      }),
    ).rejects.toThrow(/Unknown provider/);
  });
});

describe("buildProvider local provider (Ollama) exemption", () => {
  test("user Ollama loopback baseUrl resolves without an API key", async () => {
    const provider = await buildProvider({
      provider: "ollama",
      model: "llama3.3",
      apiKey: "",
      baseUrl: LOOPBACK_BASE_URL,
      provenance: "user",
    });
    expect(provider).toBeTruthy();
  });

  test("injected Ollama loopback baseUrl is rejected by the SSRF guard", async () => {
    await expect(
      buildProvider({
        provider: "ollama",
        model: "llama3.3",
        apiKey: "",
        baseUrl: LOOPBACK_BASE_URL,
        provenance: "injected",
      }),
    ).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });
});

describe("normalizeString", () => {
  test("passes strings through unchanged", () => {
    expect(normalizeString("x")).toBe("x");
    expect(normalizeString("")).toBe("");
  });

  test("coerces non-string values to '' (rejects wrong-type payloads)", () => {
    expect(normalizeString(123)).toBe("");
    expect(normalizeString(true)).toBe("");
    expect(normalizeString(null)).toBe("");
    expect(normalizeString(undefined)).toBe("");
    expect(normalizeString({})).toBe("");
  });
});
