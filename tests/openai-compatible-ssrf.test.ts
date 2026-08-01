/**
 * Direct SSRF-guard tests for the provider layer.
 *
 * `assertSafeUserBaseURL` is the guard invoked at BOTH `resolveProfile` and
 * `configure` for every user-supplied `baseURL`, including the narrow
 * ollama/litellm curated-local-origin exemption. `resolveProfile` (reached via
 * `toLLMProvider`) additionally throws `UnknownProviderError` for an unknown
 * provider with no baseURL. These tests pin that behavior so a refactor that
 * drops one of the two guard calls — or the fail-closed unknown-provider path —
 * is caught rather than failing open.
 *
 * The anthropic / google / azure facades are covered here too: their
 * `allowLocalExemption` flag must be narrowed to the curated local origins
 * (never a blanket loopback/RFC1918 exemption), custom baseURL path prefixes
 * must survive into the fetch URL, and per-model routes must not clobber each
 * other in the route registry.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertSafeUserBaseURL,
  UnsafeBaseUrlError,
} from "../src/lib/agent/llm/providers/openai-compatible-profile";
import { toLLMProvider } from "../src/lib/agent/llm/providers/openai-compatible";
import { configure as configureAnthropic } from "../src/lib/agent/llm/providers/anthropic";
import { configure as configureGoogle } from "../src/lib/agent/llm/providers/google";
import { configure as configureAzure } from "../src/lib/agent/llm/providers/azure";
import { generate } from "../src/lib/agent/llm/route/client";

const g = globalThis as unknown as { chrome?: unknown };

let savedFetch: typeof globalThis.fetch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  delete g.chrome;
});

// The transport's DNS recheck (`resolveAndValidateLlmBaseUrl`) FAILS CLOSED
// without a resolver; shim a public IP for any hostname so the generate-based
// tests reach the mocked fetch.
function installPublicDnsShim(): void {
  g.chrome = {
    runtime: {},
    dns: { resolve: (_h: string, cb: (r: { addresses?: string[] }) => void) => cb({ addresses: ["93.184.216.34"] }) },
  };
}

// 200-OK response with an EMPTY SSE body: no frames flow, so the protocol's
// stream step is never invoked and generate() synthesizes a finish event.
function installOkFetch(): ReturnType<typeof vi.fn> {
  const encoder = new TextEncoder();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    type: "basic",
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    text: async () => "",
  }) as unknown as Response);
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  return fetchMock;
}

describe("assertSafeUserBaseURL (openai-compatible SSRF guard)", () => {
  test("no baseURL override is a no-op (curated profile is used)", () => {
    expect(() => assertSafeUserBaseURL(undefined, "deepseek")).not.toThrow();
    expect(() => assertSafeUserBaseURL(undefined, "ollama")).not.toThrow();
  });

  test("loopback baseURL smuggled through a non-local provider id is rejected", () => {
    // The ollama/litellm exemption must NOT apply when the provider is a cloud
    // id like `deepseek` — an injected `http://localhost:11434` must not reach
    // the user's local model server.
    expect(() => assertSafeUserBaseURL("http://localhost:11434", "deepseek")).toThrow(
      UnsafeBaseUrlError,
    );
    expect(() => assertSafeUserBaseURL("http://127.0.0.1:11434/v1", "groq")).toThrow(
      UnsafeBaseUrlError,
    );
  });

  test("ollama with the exact curated loopback origin passes (user-configured exemption)", () => {
    // The curated loopback exemption only applies for a USER-configured
    // `baseURL` (allowLocalExemption === true). An untrusted/injected baseUrl is
    // never exempted, so the explicit `true` third argument is required.
    expect(() => assertSafeUserBaseURL("http://localhost:11434", "ollama", true)).not.toThrow();
    expect(() => assertSafeUserBaseURL("http://localhost:11434/v1", "ollama", true)).not.toThrow();
    expect(() => assertSafeUserBaseURL("http://127.0.0.1:11434", "ollama", true)).not.toThrow();
  });

  test("ollama exemption is scoped to the curated origin — a cloud-metadata sink still rejects", () => {
    // Even with provider='ollama', a non-curated origin falls through to the
    // strict policy, so the cloud-metadata / link-local address is rejected.
    expect(() => assertSafeUserBaseURL("http://169.254.169.254:11434/v1", "ollama")).toThrow(
      UnsafeBaseUrlError,
    );
    expect(() => assertSafeUserBaseURL("http://169.254.169.254/", "litellm")).toThrow(
      UnsafeBaseUrlError,
    );
  });
});

describe("toLLMProvider (openai-compatible) unknown provider", () => {
  test("unknown provider with no baseURL throws UnknownProviderError", () => {
    expect(() =>
      toLLMProvider({ provider: "definitely-not-real", model: "x" }),
    ).toThrow(/Unknown OpenAI-compatible provider/);
  });
});

// ─── anthropic / google narrow allowLocalExemption to curated origins ────────

describe("anthropic / google facade SSRF exemption narrowing", () => {
  test("allowLocalExemption=true does NOT exempt a non-curated RFC1918 baseURL", () => {
    // Sibling facades (openai.ts / azure.ts) narrow the flag through
    // isCuratedLocalOriginUrl first; anthropic/google previously forwarded it
    // ungated, letting the config-time guard pass ANY loopback/RFC1918 URL.
    expect(() =>
      configureAnthropic({ baseURL: "http://192.168.1.5:8080", allowLocalExemption: true, apiKey: "k" }),
    ).toThrow(UnsafeBaseUrlError);
    expect(() =>
      configureGoogle({ baseURL: "http://192.168.1.5:8080", allowLocalExemption: true, apiKey: "k" }),
    ).toThrow(UnsafeBaseUrlError);
  });

  test("allowLocalExemption=true does NOT exempt a non-curated loopback port either", () => {
    // 127.0.0.1:11434 and localhost:4000 ARE curated origins (Ollama / LiteLLM
    // defaults, including their 127.0.0.1 spellings) — those must stay
    // reachable for a user who opts in. Any OTHER loopback URL is not curated
    // and must be rejected at config time.
    expect(() =>
      configureAnthropic({ baseURL: "http://127.0.0.1:9999", allowLocalExemption: true, apiKey: "k" }),
    ).toThrow(UnsafeBaseUrlError);
    expect(() =>
      configureGoogle({ baseURL: "http://localhost:12345", allowLocalExemption: true, apiKey: "k" }),
    ).toThrow(UnsafeBaseUrlError);
  });

  test("curated loopback origins still configure when the user opts in", () => {
    expect(() =>
      configureAnthropic({ baseURL: "http://localhost:11434", allowLocalExemption: true, apiKey: "k" }),
    ).not.toThrow();
    expect(() =>
      configureGoogle({ baseURL: "http://127.0.0.1:4000", allowLocalExemption: true, apiKey: "k" }),
    ).not.toThrow();
  });

  test("default endpoints still configure with the exemption flag on", () => {
    expect(() => configureAnthropic({ allowLocalExemption: true, apiKey: "k" })).not.toThrow();
    expect(() => configureGoogle({ allowLocalExemption: true, apiKey: "k" })).not.toThrow();
  });
});

// ─── anthropic custom baseURL path prefix must survive ──────────────────────

describe("anthropic facade baseURL path prefix", () => {
  test("a path-prefixed baseURL is preserved in the fetch URL", async () => {
    installPublicDnsShim();
    const fetchMock = installOkFetch();
    const cfg = configureAnthropic({ baseURL: "https://api.anthropic.com/proxy", apiKey: "sk-test" });
    const model = cfg.model("claude-3-5-sonnet");
    await generate({ model, messages: [{ role: "user", content: "hi" }] });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("https://api.anthropic.com/proxy/v1/messages");
  });
});

// ─── per-model routes must not clobber each other ───────────────────────────

describe("per-model route registration (azure / google)", () => {
  test("azure: distinct models get distinct routeIds and hit their own deployment URLs", async () => {
    installPublicDnsShim();
    const fetchMock = installOkFetch();
    const cfg = configureAzure({ resourceName: "my-resource", apiKey: "k", apiVersion: "2024-10-21" });
    const m1 = cfg.model("gpt-4o");
    const m2 = cfg.model("gpt-4o-mini");
    // Fixed route id (azure::azure-openai) would clobber: m1's handle would
    // resolve to m2's (newest) route and fetch the WRONG deployment URL.
    expect(m1.routeId).not.toBe(m2.routeId);
    await generate({ model: m1, messages: [{ role: "user", content: "hi" }] });
    await generate({ model: m2, messages: [{ role: "user", content: "hi" }] });
    const [u1] = fetchMock.mock.calls[0] as [string];
    const [u2] = fetchMock.mock.calls[1] as [string];
    expect(u1).toContain("/openai/deployments/gpt-4o/chat/completions");
    expect(u2).toContain("/openai/deployments/gpt-4o-mini/chat/completions");
  });

  test("google: distinct models get distinct routeIds and hit their own model paths", async () => {
    installPublicDnsShim();
    const fetchMock = installOkFetch();
    const cfg = configureGoogle({ apiKey: "k" });
    const m1 = cfg.model("gemini-2.0-flash");
    const m2 = cfg.model("gemini-2.5-pro");
    expect(m1.routeId).not.toBe(m2.routeId);
    await generate({ model: m1, messages: [{ role: "user", content: "hi" }] });
    await generate({ model: m2, messages: [{ role: "user", content: "hi" }] });
    const [u1] = fetchMock.mock.calls[0] as [string];
    const [u2] = fetchMock.mock.calls[1] as [string];
    expect(u1).toContain("gemini-2.0-flash:streamGenerateContent");
    expect(u2).toContain("gemini-2.5-pro:streamGenerateContent");
  });
});

// ─── distinct credentials on the same baseURL must not clobber ──────────────

describe("openai-compatible route isolation (distinct credentials)", () => {
  test("two providers on the same baseURL with different apiKeys each send their own key", async () => {
    installPublicDnsShim();
    const fetchMock = installOkFetch();
    const a = toLLMProvider({ provider: "groq", model: "llama-3.3", apiKey: "key-alpha" });
    const b = toLLMProvider({ provider: "groq", model: "llama-3.3", apiKey: "key-beta" });
    // The bridge builds the model handle from the provider's own config, so the
    // chat request carries no model — the auth used is the one bound at
    // configure() time. With the previous routeId (which hashed the raw apiKey)
    // the two providers registered under the SAME registry key and the last
    // writer won, so BOTH requests would send key-beta.
    await a.chat({ messages: [{ role: "user", content: "hi" }] });
    await b.chat({ messages: [{ role: "user", content: "hi" }] });
    const initA = fetchMock.mock.calls[0][1] as { headers?: Record<string, string> };
    const initB = fetchMock.mock.calls[1][1] as { headers?: Record<string, string> };
    expect(initA.headers?.authorization).toBe("Bearer key-alpha");
    expect(initB.headers?.authorization).toBe("Bearer key-beta");
  });
});
