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
import { checkCanonicalHost, OPENAI_COMPAT_DEFAULT_BASE } from "../src/extension/options/connection-test-utils";

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
      provider: "ollama",
      model: "x",
      apiKey: "k",
      baseUrl: LOOPBACK_BASE_URL,
      provenance: "user",
    });
    expect(provider).toBeTruthy();
    expect(provider.id).toContain("ollama");
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
    store.provider = "ollama";
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

// ─── DNS-backed hostname classification ─────────────────────────────────────
//
// `resolveAndValidateLlmBaseUrl` resolves hostnames through the injectable
// `chrome.dns.resolve` seam (read at call time in ssrf-dns.ts), so the
// hostname classification branch is exercised here the same way the loaded
// extension runs it. Without a resolver the guard fails closed for untrusted
// provenance and best-effort allows user-configured URLs.

function installDns(addresses: string[]): void {
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: { lastError: undefined },
    dns: {
      resolve: (_h: string, cb: (r: { addresses?: string[] }) => void) =>
        cb({ addresses }),
    },
  };
}
function removeDns(): void {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
}

describe("buildProvider hostname SSRF classification (DNS-backed)", () => {
  afterEach(removeDns);

  test("a hostname resolving to a public IP passes for a user baseUrl", async () => {
    installDns(["93.184.216.34"]);
    const provider = await buildProvider({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
  });

  test("a hostname resolving to the cloud-metadata address is rejected", async () => {
    installDns(["169.254.169.254"]);
    await expect(
      buildProvider({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        baseUrl: "https://api.example.attacker/v1",
        provenance: "user",
      }),
    ).rejects.toThrow(/resolves to a private\/loopback\/link-local/);
  });

  test("a hostname resolving to loopback is rejected for injected provenance", async () => {
    installDns(["127.0.0.1"]);
    await expect(
      buildProvider({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        baseUrl: "https://api.example.attacker/v1",
        provenance: "injected",
      }),
    ).rejects.toThrow(/resolves to a private\/loopback\/link-local/);
  });

  test("no resolver: user-configured hostname is allowed (best-effort), injected is refused", async () => {
    const userProvider = await buildProvider({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      provenance: "user",
    });
    expect(userProvider).toBeTruthy();
    await expect(
      buildProvider({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        baseUrl: "https://api.example.attacker/v1",
        provenance: "injected",
      }),
    ).rejects.toThrow(/DNS resolver unavailable/);
  });
});

// ─── Azure suffix confinement (provenance-gated) ────────────────────────────
//
// Azure resource names are attacker-creatable (`{anything}.openai.azure.com`
// can be claimed by any Azure account), so the suffix allowance must not apply
// to an injected config. Injected azure configs with a custom baseUrl fail
// closed unless the host is EXACTLY the canonical host (which is not a real
// endpoint, so nothing is reachable).

describe("buildProvider azure suffix confinement", () => {
  beforeEach(() => installDns(["93.184.216.34"]));
  afterEach(removeDns);

  test("user azure config may use its own per-resource subdomain", async () => {
    const provider = await buildProvider({
      provider: "azure",
      model: "gpt-4o",
      apiKey: "key",
      baseUrl: "https://my-resource.openai.azure.com/v1",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
    expect(provider.id).toContain("azure");
  });

  test("injected azure config with an attacker subdomain is rejected", async () => {
    await expect(
      buildProvider({
        provider: "azure",
        model: "gpt-4o",
        apiKey: "key",
        baseUrl: "https://evil.openai.azure.com/v1",
        provenance: "injected",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("injected azure config with the exact canonical host is allowed (but unreachable)", async () => {
    const provider = await buildProvider({
      provider: "azure",
      model: "gpt-4o",
      apiKey: "key",
      baseUrl: "https://openai.azure.com/v1",
      provenance: "injected",
    });
    expect(provider).toBeTruthy();
  });
});

// ─── Injected keyless configs are still host-confined ───────────────────────
//
// A keyless injected config (local-model users) previously skipped host
// confinement entirely, letting page data (task text, screenshots) flow to an
// attacker host. Confinement now applies to every injected public baseUrl
// regardless of whether an API key is present.

describe("buildProvider injected keyless host confinement", () => {
  beforeEach(() => installDns(["93.184.216.34"]));
  afterEach(removeDns);

  test("injected keyless ollama with a public attacker host is rejected", async () => {
    await expect(
      buildProvider({
        provider: "ollama",
        model: "llama3.3",
        apiKey: "",
        baseUrl: "https://attacker.example.com/v1",
        provenance: "injected",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("injected keyless openai with a public attacker host is rejected", async () => {
    await expect(
      buildProvider({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "",
        baseUrl: "https://attacker.example.com/v1",
        provenance: "injected",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("injected keyless tail provider (no canonical host) with a public host is rejected", async () => {
    await expect(
      buildProvider({
        provider: "nvidia",
        model: "llama-3.3-70b",
        apiKey: "",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        provenance: "injected",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });

  test("user keyless ollama with a remote public host stays allowed (no regression)", async () => {
    const provider = await buildProvider({
      provider: "ollama",
      model: "llama3.3",
      apiKey: "",
      baseUrl: "https://ollama.example.com",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
  });
});

// ─── Canonical-host compare ignores the port ────────────────────────────────

describe("buildProvider canonical-host port handling", () => {
  beforeEach(() => installDns(["93.184.216.34"]));
  afterEach(removeDns);

  test("a user baseUrl on the canonical host with a non-default port is allowed", async () => {
    const provider = await buildProvider({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com:8443/v1",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
  });

  test("a port on a foreign host does not help it pass confinement", async () => {
    await expect(
      buildProvider({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com.evil.com:8443/v1",
        provenance: "user",
      }),
    ).rejects.toThrow(/not the canonical host/);
  });
});

// ─── Config-time narrowing for the curated local providers ──────────────────
//
// The transport layer only ever allows the curated Ollama/LiteLLM loopback
// origins for local endpoints. A user baseUrl on a non-curated local address
// (LAN host, non-default port) previously passed the config-time guard and
// failed on EVERY request with an opaque error; it must fail at configuration
// time instead.

describe("buildProvider curated local-origin narrowing (ollama/litellm)", () => {
  test("user ollama on a non-curated loopback port is rejected at config time", async () => {
    await expect(
      buildProvider({
        provider: "ollama",
        model: "llama3.3",
        apiKey: "",
        baseUrl: "http://127.0.0.1:9999",
        provenance: "user",
      }),
    ).rejects.toThrow(/curated|allowlist/i);
  });

  test("user ollama on a LAN host is rejected at config time", async () => {
    await expect(
      buildProvider({
        provider: "ollama",
        model: "llama3.3",
        apiKey: "",
        baseUrl: "http://192.168.1.5:8080",
        provenance: "user",
      }),
    ).rejects.toThrow(/curated|allowlist/i);
  });

  test("user ollama IPv6 loopback spelling of the curated endpoint is allowed", async () => {
    const provider = await buildProvider({
      provider: "ollama",
      model: "llama3.3",
      apiKey: "",
      baseUrl: "http://[::1]:11434",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
  });

  test("user litellm on its curated port is allowed", async () => {
    const provider = await buildProvider({
      provider: "litellm",
      model: "gpt-5.5",
      apiKey: "sk-lite",
      baseUrl: "http://localhost:4000/v1",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
  });

  test("user ollama on a public host remains allowed", async () => {
    const provider = await buildProvider({
      provider: "ollama",
      model: "llama3.3",
      apiKey: "",
      baseUrl: "https://ollama.example.com",
      provenance: "user",
    });
    expect(provider).toBeTruthy();
  });
});

// ─── Options-side canonical-host mirror parity ──────────────────────────────
//
// The options Test Connection runs its own canonical-host mirror so it never
// green-lights a config the agent loop refuses (and never sends the key to a
// non-canonical host during the test). The mirror must stay in lockstep with
// `canonicalLlmHost`/`buildProvider`: derived from the runtime profiles table,
// hostname (port-stripped) comparison, and null-canonical-host => reject.

describe("checkCanonicalHost mirror parity", () => {
  test("byProvider-derived: baseten/deepinfra/fireworks have canonical hosts (Gap A)", () => {
    expect(OPENAI_COMPAT_DEFAULT_BASE.baseten).toBe("https://inference.baseten.co/v1");
    expect(OPENAI_COMPAT_DEFAULT_BASE.deepinfra).toBe("https://api.deepinfra.com/v1/openai");
    expect(OPENAI_COMPAT_DEFAULT_BASE.fireworks).toBe("https://api.fireworks.ai/inference/v1");
    expect(checkCanonicalHost("baseten", "https://inference.baseten.co/v1", "sk-x")).toBeNull();
    expect(checkCanonicalHost("deepinfra", "https://api.deepinfra.com/v1/openai", "sk-x")).toBeNull();
    expect(checkCanonicalHost("fireworks", "https://api.fireworks.ai/inference/v1", "sk-x")).toBeNull();
  });

  test("byProvider-derived: foreign hosts for those providers are rejected", () => {
    expect(checkCanonicalHost("baseten", "https://evil.example.com/v1", "sk-x")).not.toBeNull();
    expect(checkCanonicalHost("deepinfra", "https://evil.example.com/v1", "sk-x")).not.toBeNull();
    expect(checkCanonicalHost("fireworks", "https://evil.example.com/v1", "sk-x")).not.toBeNull();
  });

  test("tail provider (no canonical host) with a key is rejected — null-reject parity (Gap B)", () => {
    const err = checkCanonicalHost("nvidia", "https://integrate.api.nvidia.com/v1", "sk-x");
    expect(err).not.toBeNull();
    expect(err).toContain("canonical host");
  });

  test("port on the canonical host is ignored (hostname compare)", () => {
    expect(
      checkCanonicalHost("openai", "https://api.openai.com:8443/v1", "sk-x"),
    ).toBeNull();
  });

  test("port on a lookalike host still fails", () => {
    expect(
      checkCanonicalHost("openai", "https://api.openai.com.evil.com:8443/v1", "sk-x"),
    ).not.toBeNull();
  });

  test("loopback-only profiles derive their canonical host from byProvider", () => {
    expect(OPENAI_COMPAT_DEFAULT_BASE.ollama).toBe("http://localhost:11434/v1");
    expect(OPENAI_COMPAT_DEFAULT_BASE.litellm).toBe("http://localhost:4000/v1");
    // A public host for keyed ollama is rejected, mirroring the runtime
    // (canonicalLlmHost returns the loopback host, so a public host mismatches).
    expect(checkCanonicalHost("ollama", "https://ollama.example.com", "sk-x")).not.toBeNull();
    // Local endpoints are governed by the SSRF guard, not host confinement.
    expect(checkCanonicalHost("ollama", "http://127.0.0.1:11434/v1", "sk-x")).toBeNull();
  });

  test("no key → no confinement regardless of provider", () => {
    expect(checkCanonicalHost("nvidia", "https://evil.example.com/v1", "")).toBeNull();
  });

  test("azure per-resource suffix stays allowed (user-side parity)", () => {
    expect(
      checkCanonicalHost("azure", "https://my-resource.openai.azure.com/openai/v1", "sk-x"),
    ).toBeNull();
  });
});
