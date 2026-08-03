/**
 * Regression tests for buildProvider's security logic in
 * src/extension/provider-config.ts. These pin the four guards that protect the
 * user's API key from exfiltration and the local network from SSRF:
 *
 *  - the API-key-exfiltration (canonical-host) guard,
 *  - the SSRF resolve/validate guard for injected provenance,
 *  - the keyless-remote-provider block,
 *  - readProviderConfig's fail-safe toward "injected" provenance.
 *
 * No security guard is weakened; these tests only assert existing behavior so a
 * future regression surfaces as a failing test.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  buildProvider,
  readProviderConfig,
  resolveModel,
  type ProviderConfig,
} from "../src/extension/provider-config";
import { DEFAULT_MODELS } from "../src/extension/provider-config";

const LOOPBACK_BASE_URL = "http://localhost:11434";

function makeStorageGet(store: Record<string, unknown>) {
  return (keys: string | string[] | null): Promise<Record<string, unknown>> => {
    const result: Record<string, unknown> = {};
    const arr = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
    for (const k of arr) if (k in store) result[k] = store[k];
    return Promise.resolve(result);
  };
}

// SSRF-guard DNS shim. `buildProvider` runs `resolveAndValidateLlmBaseUrl` on a
// user-supplied `baseUrl`; in the Node/vitest runtime there is no `chrome.dns`
// and no `require("dns")`, so the guard FAILS CLOSED for any hostname URL. Mock
// a resolver returning a public IP for ANY host so legitimate public-hostname
// configs pass the guard (the curated-local / metadata / RFC1918 cases in this
// file are rejected synchronously before any DNS lookup and are unaffected).
const dnsShimChrome: { v: unknown } = { v: undefined };
function installPublicDns(): void {
  dnsShimChrome.v = (globalThis as unknown as { chrome?: unknown }).chrome;
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: { lastError: undefined },
    dns: {
      resolve: (_h: string, cb: (r: { addresses?: string[] }) => void) =>
        cb({ addresses: ["93.184.216.34"] }),
    },
  };
}
function restoreChrome(): void {
  (globalThis as unknown as { chrome?: unknown }).chrome = dnsShimChrome.v;
}

/**
 * (a) An attacker-controlled storage write that stamps provenance:"user" on a
 * PUBLIC attacker host must NOT be trusted. The canonical-host guard must still
 * reject the baseUrl so the user's API key is never forwarded to it.
 */
describe("canonical-host exfil guard rejects public attacker hosts regardless of provenance", () => {
  beforeEach(installPublicDns);
  afterEach(restoreChrome);

  test("provenance 'user' + public attacker host is rejected", async () => {
    await expect(
      buildProvider({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        baseUrl: "https://1.2.3.4/v1",
        provenance: "user",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("provenance 'injected' + public attacker host is rejected", async () => {
    await expect(
      buildProvider({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        baseUrl: "https://1.2.3.4/v1",
        provenance: "injected",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("a matching canonical host is allowed (no false positive)", async () => {
    const provider = await buildProvider({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
    expect(provider.id).toContain("openai");
  });
});

/**
 * (a2) Suffix-canonical hosts (anthropic/google/azure) require a dotted
 * subdomain boundary: `proxy.anthropic.com` is allowed, but an attacker host
 * that merely ENDS WITH the canonical host (`evil-anthropic.com`,
 * `not-anthropic.com`) must be rejected — otherwise an injected baseUrl
 * redirects the user's API key (Bearer token) to the attacker's endpoint.
 */
describe("canonical-host suffix guard requires a dotted subdomain boundary", () => {
  beforeEach(installPublicDns);
  afterEach(restoreChrome);

  test("evil-anthropic.com is rejected (ends-with without dotted boundary)", async () => {
    await expect(
      buildProvider({
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKey: "sk-test",
        baseUrl: "https://evil-anthropic.com/v1",
        provenance: "user",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("not-anthropic.com is rejected (ends-with without dotted boundary)", async () => {
    await expect(
      buildProvider({
        provider: "anthropic",
        model: "claude-sonnet-5",
        apiKey: "sk-test",
        baseUrl: "https://not-anthropic.com/v1",
        provenance: "user",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("anthropic.com itself is allowed", async () => {
    const provider = await buildProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "sk-test",
      baseUrl: "https://anthropic.com/v1",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
    expect(provider.id).toContain("anthropic");
  });

  test("proxy.anthropic.com (a real subdomain) is allowed", async () => {
    const provider = await buildProvider({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "sk-test",
      baseUrl: "https://proxy.anthropic.com/v1",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
    expect(provider.id).toContain("anthropic");
  });

  test("evil-googleapis.com is rejected (ends-with without dotted boundary)", async () => {
    await expect(
      buildProvider({
        provider: "google",
        model: "gemini-3.5-flash",
        apiKey: "sk-test",
        baseUrl: "https://evil-googleapis.com/v1beta1",
        provenance: "user",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("api.googleapis.com (a real subdomain) is allowed", async () => {
    const provider = await buildProvider({
      provider: "google",
      model: "gemini-3.5-flash",
      apiKey: "sk-test",
      baseUrl: "https://api.googleapis.com/v1beta1",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
    expect(provider.id).toContain("google");
  });
});

/**
 * (b) For INJECTED provenance, the SSRF guard must reject loopback and
 * cloud-metadata addresses even though a "user" provenance is exempted for
 * those same endpoints.
 */
describe("injected provenance: loopback and cloud-metadata are rejected", () => {
  test("injected loopback (localhost Ollama) is rejected", async () => {
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

  test("injected cloud-metadata (169.254.169.254) is rejected", async () => {
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

  test("injected RFC1918 private address is rejected", async () => {
    await expect(
      buildProvider({
        provider: "openai",
        model: "x",
        apiKey: "k",
        baseUrl: "http://192.168.1.50:11434",
        provenance: "injected",
      }),
    ).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });
});

/**
 * (c) A remote (key-requiring) provider without an API key must be blocked —
 * it must not fall through to an unauthenticated request that could leak
 * config or reach an unintended endpoint.
 */
describe("keyless remote provider is blocked", () => {
  beforeEach(installPublicDns);
  afterEach(restoreChrome);

  test("openai-compatible remote provider without an apiKey throws", async () => {
    await expect(
      buildProvider({
        provider: "deepseek",
        model: "deepseek-chat",
        apiKey: "",
        baseUrl: "https://api.deepseek.com",
        provenance: "user",
      }),
    ).rejects.toThrow(/requires an API key/);
  });

  test("the same provider WITH an apiKey is allowed", async () => {
    const provider = await buildProvider({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
  });
});

/**
 * (d) readProviderConfig must treat a missing OR non-string provenance as
 * "injected" (fail-safe), so a corrupted / attacker-injected storage payload
 * cannot gain the loopback exemption. A subsequent buildProvider on a loopback
 * baseUrl must then be rejected by the SSRF guard.
 */
describe("readProviderConfig provenance fail-safe", () => {
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

  function seed(provenance: ProviderConfig["provenance"] | unknown | undefined): void {
    store.provider = "openai";
    store.model = "gpt-4o";
    store.baseUrl = LOOPBACK_BASE_URL;
    if (provenance !== undefined) store.provenance = provenance as unknown;
    sessionStore.apiKey = "sk-test";
  }

  test("missing provenance → 'injected'", async () => {
    seed(undefined);
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("injected");
  });

  test("non-string provenance (number) → 'injected'", async () => {
    seed(123);
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("injected");
  });

  test("non-string provenance (object) → 'injected'", async () => {
    seed({ hacked: true });
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("injected");
  });

  test("explicit provenance:'user' is preserved", async () => {
    seed("user");
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("user");
  });

  test("non-string provenance + loopback baseUrl → buildProvider rejected", async () => {
    seed(123);
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("injected");
    await expect(buildProvider(config!)).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });

  test("missing provenance + loopback baseUrl → buildProvider rejected", async () => {
    seed(undefined);
    const config = await readProviderConfig();
    expect(config?.provenance).toBe("injected");
    await expect(buildProvider(config!)).rejects.toThrow(/Unsafe LLM baseUrl rejected/);
  });
});

/**
 * (e) readProviderConfig must fall back to the default provider ("openai") when
 * the stored value is not in KNOWN_PROVIDERS. This prevents a corrupted or
 * attacker-injected provider id from locking the user out of all LLM calls
 * until manual reconfiguration.
 */
describe("readProviderConfig unknown provider fallback", () => {
  let store: Record<string, unknown>;
  let sessionStore: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    sessionStore = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: (keys: string | string[] | null): Promise<Record<string, unknown>> => {
            const result: Record<string, unknown> = {};
            const arr = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
            for (const k of arr) if (k in store) result[k] = store[k];
            return Promise.resolve(result);
          },
          set: (items: Record<string, unknown>): Promise<void> => {
            Object.assign(store, items);
            return Promise.resolve();
          },
        },
        session: { get: makeStorageGet(sessionStore) },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  test("unknown provider falls back to 'openai'", async () => {
    store.provider = "totally-fake-provider";
    store.model = "some-model";
    sessionStore.apiKey = "sk-test";

    const config = await readProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe("openai");
  });

  test("unknown-provider fallback clears the stored key (foreign-key protection)", async () => {
    // The stored key belongs to whatever provider the user last configured;
    // forwarding it to the default host would exfiltrate it (e.g. an Anthropic
    // key sent to api.openai.com). The fallback must require re-entry.
    store.provider = "totally-fake-provider";
    store.model = "some-model";
    sessionStore.apiKey = "sk-ant-secret";

    const config = await readProviderConfig();
    expect(config!.provider).toBe("openai");
    expect(config!.apiKey).toBe("");
  });

  test("writes provider_reset_warning flag when falling back", async () => {
    store.provider = "totally-fake-provider";
    store.model = "some-model";

    await readProviderConfig();
    expect(store.provider_reset_warning).toBe(true);
  });

  test("known provider is NOT overridden", async () => {
    store.provider = "anthropic";
    store.model = "claude-sonnet-5";
    sessionStore.apiKey = "sk-test";

    const config = await readProviderConfig();
    expect(config!.provider).toBe("anthropic");
    expect(store.provider_reset_warning).toBeUndefined();
  });
});

/**
 * (e) The forceReasoning user override: "on" must force reasoning-parameter
 * emission even for models the catalog doesn't flag (e.g. an
 * OpenAI-compatible reasoning model unknown to the catalog); "off"/"auto"/
 * unset must keep the catalog-derived flag. The override is read fail-safe —
 * provider construction must never crash on a missing/corrupt storage layer.
 */
describe("forceReasoning override", () => {
  function installChromeWithStorage(stored: Record<string, unknown>): void {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { lastError: undefined },
      dns: {
        resolve: (_h: string, cb: (r: { addresses?: string[] }) => void) =>
          cb({ addresses: ["93.184.216.34"] }),
      },
      storage: {
        local: { get: makeStorageGet(stored), set: async () => undefined },
      },
    };
  }

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  // `totally-unknown-model-xyz` is absent from the bundled catalog and matches
  // no reasoning name pattern, so the catalog-derived flag is deterministically
  // false — the override is the only thing that can flip it to true.
  const UNKNOWN_MODEL = "totally-unknown-model-xyz";

  test("forceReasoning 'on' forces supportsReasoning even for uncatalogued models", async () => {
    installChromeWithStorage({ forceReasoning: "on" });
    const provider = await buildProvider({
      provider: "openai",
      model: UNKNOWN_MODEL,
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      provenance: "user",
    });
    expect(provider.supportsReasoning).toBe(true);
  });

  test("unset forceReasoning keeps the catalog-derived flag", async () => {
    installChromeWithStorage({});
    const provider = await buildProvider({
      provider: "openai",
      model: UNKNOWN_MODEL,
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      provenance: "user",
    });
    expect(provider.supportsReasoning).toBe(false);
  });

  test("forceReasoning 'off' keeps the catalog-derived flag at build time", async () => {
    installChromeWithStorage({ forceReasoning: "off" });
    const provider = await buildProvider({
      provider: "openai",
      model: UNKNOWN_MODEL,
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      provenance: "user",
    });
    expect(provider.supportsReasoning).toBe(false);
  });
});

/**
 * resolveModel — the shared default-model resolution used by buildProvider and
 * extractStateForRun. Order: explicit model > curated offline DEFAULT_MODELS >
 * family priority (live catalog) > newest-stable > "".
 */
describe("resolveModel — default-model family priority", () => {
  test("offline DEFAULT_MODELS still resolve first", () => {
    expect(resolveModel({ provider: "openai", catalogId: "openai" })).toBe(DEFAULT_MODELS.openai);
  });

  test("an explicit model always wins", () => {
    expect(resolveModel({ provider: "openai", catalogId: "openai", model: "gpt-4o" })).toBe("gpt-4o");
  });

  test("a provider without a DEFAULT_MODELS entry resolves via its priority family", () => {
    // moonshotai has no DEFAULT_MODELS entry; its shipped priority prefers the
    // kimi-k2.x family over the newest kimi-k3 release.
    expect(resolveModel({ provider: "moonshotai", catalogId: "moonshotai" })).toBe("kimi-k2.5");
  });

  test("unknown provider id resolves to the empty string", () => {
    expect(resolveModel({ provider: "no-such-provider", catalogId: "no-such-provider" })).toBe("");
  });
});

/**
 * O8 — provider-scoped config record (`chrome.storage.local["providerConfigs"]`
 * keyed by provider id). The nested record wins over the flat top-level keys,
 * which stay as the active back-compat mirror. The nested record's provenance
 * follows the same fail-safe as the top-level: only an explicit "user" stamp is
 * trusted, everything else is "injected".
 */
describe("readProviderConfig providerConfigs nested record", () => {
  let store: Record<string, unknown>;
  let sessionStore: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    sessionStore = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: (keys: string | string[] | null): Promise<Record<string, unknown>> => {
            const result: Record<string, unknown> = {};
            const arr = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
            for (const k of arr) if (k in store) result[k] = store[k];
            return Promise.resolve(result);
          },
          set: (items: Record<string, unknown>): Promise<void> => {
            Object.assign(store, items);
            return Promise.resolve();
          },
        },
        session: { get: makeStorageGet(sessionStore) },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  test("nested record wins over top-level for baseUrl/model/resourceName", async () => {
    store.provider = "openai";
    store.model = "top-model";
    store.baseUrl = "https://top.example.com/v1";
    store.resourceName = "top-resource";
    store.provenance = "user";
    sessionStore.apiKey = "sk-test";
    store.providerConfigs = {
      openai: {
        model: "nested-model",
        baseUrl: "https://nested.example.com/v1",
        resourceName: "nested-resource",
        provenance: "user",
      },
    };

    const config = await readProviderConfig();
    expect(config!.provider).toBe("openai");
    expect(config!.model).toBe("nested-model");
    expect(config!.baseUrl).toBe("https://nested.example.com/v1");
    expect(config!.resourceName).toBe("nested-resource");
    expect(config!.provenance).toBe("user");
  });

  test("partial nested record merges per-field over the top-level mirror", async () => {
    store.provider = "anthropic";
    store.model = "claude-sonnet-5";
    store.baseUrl = "https://api.anthropic.com/v1";
    store.provenance = "user";
    sessionStore.apiKey = "sk-test";
    store.providerConfigs = {
      anthropic: { baseUrl: "https://nested.example.com/v1", provenance: "user" },
    };

    const config = await readProviderConfig();
    expect(config!.model).toBe("claude-sonnet-5"); // top-level wins when nested omits
    expect(config!.baseUrl).toBe("https://nested.example.com/v1");
  });

  test("absent nested entry for the resolved provider → top-level authoritative", async () => {
    store.provider = "openai";
    store.model = "top-model";
    store.baseUrl = "https://top.example.com/v1";
    store.provenance = "user";
    sessionStore.apiKey = "sk-test";
    store.providerConfigs = { anthropic: { model: "other-model", provenance: "user" } };

    const config = await readProviderConfig();
    expect(config!.model).toBe("top-model");
    expect(config!.baseUrl).toBe("https://top.example.com/v1");
  });

  test("providerConfigs absent entirely → top-level authoritative", async () => {
    store.provider = "openai";
    store.model = "top-model";
    store.baseUrl = "https://top.example.com/v1";
    store.provenance = "user";
    sessionStore.apiKey = "sk-test";

    const config = await readProviderConfig();
    expect(config!.model).toBe("top-model");
    expect(config!.baseUrl).toBe("https://top.example.com/v1");
  });

  test("nested record without a provenance stamp defaults to 'injected'", async () => {
    store.provider = "openai";
    store.provenance = "user";
    sessionStore.apiKey = "sk-test";
    store.providerConfigs = { openai: { baseUrl: LOOPBACK_BASE_URL } };

    const config = await readProviderConfig();
    expect(config!.provenance).toBe("injected");
    expect(config!.baseUrl).toBe(LOOPBACK_BASE_URL);
  });

  test("nested record with a non-string provenance defaults to 'injected'", async () => {
    store.provider = "openai";
    store.provenance = "user";
    sessionStore.apiKey = "sk-test";
    store.providerConfigs = { openai: { baseUrl: LOOPBACK_BASE_URL, provenance: "user-ish" } };

    const config = await readProviderConfig();
    expect(config!.provenance).toBe("injected");
  });

  test("unknown provider falls back to openai AND applies openai's nested record", async () => {
    store.provider = "totally-fake-provider";
    store.model = "some-model";
    sessionStore.apiKey = "sk-test";
    store.providerConfigs = {
      openai: { model: "nested-openai-model", baseUrl: "https://api.openai.com/v1", provenance: "user" },
    };

    const config = await readProviderConfig();
    expect(config!.provider).toBe("openai");
    expect(config!.model).toBe("nested-openai-model");
    expect(config!.baseUrl).toBe("https://api.openai.com/v1");
  });

  test("unknown-provider fallback keeps the foreign-key protection (key stays cleared)", async () => {
    store.provider = "totally-fake-provider";
    store.model = "some-model";
    sessionStore.apiKey = "sk-ant-secret";
    store.providerConfigs = { openai: { model: "nested-openai-model", provenance: "user" } };

    const config = await readProviderConfig();
    expect(config!.provider).toBe("openai");
    expect(config!.apiKey).toBe("");
    expect(store.provider_reset_warning).toBe(true);
  });

  test("malformed providerConfigs (non-object) is ignored", async () => {
    store.provider = "openai";
    store.model = "top-model";
    store.provenance = "user";
    sessionStore.apiKey = "sk-test";
    store.providerConfigs = "corrupted";

    const config = await readProviderConfig();
    expect(config!.model).toBe("top-model");
  });
});
