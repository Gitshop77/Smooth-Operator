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
import { buildProvider, readProviderConfig, type ProviderConfig } from "../src/extension/provider-config";

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
