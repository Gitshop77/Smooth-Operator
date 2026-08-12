/**
 * Tests for `src/lib/agent/llm/provider-bridge.ts` . Two untested branches are pinned here: the `costUsd`
 * recomputation and the conditional dropping of zero usage fields on every chat
 * call. We mock the route-layer `generate` so no network/credential is needed.
 *
 * Also pins the capability wiring: `reasoning` must be read live off the
 * receiver (provider-config patches it AFTER construction via a spread copy),
 * `structuredOutputStrict` must be forwarded when the facade opts in, and
 * provider errors must propagate unchanged.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/agent/llm/route/client", () => ({
  generate: vi.fn(),
  // `make` is stubbed so facade-level tests can build bridged providers
  // without registering real routes; `model()` returns the Model handle the
  // bridge forwards to `generate`.
  make: vi.fn(() => ({
    model: (modelInput: { id: string; provider?: string }) => ({
      id: modelInput.id,
      provider: modelInput.provider ?? "test",
      routeId: "test::chat",
    }),
  })),
}));

import { generate, make } from "@/lib/agent/llm/route/client";
import { toLLMProvider } from "@/lib/agent/llm/provider-bridge";
import { toLLMProvider as openaiCompatibleToLLMProvider } from "@/lib/agent/llm/providers/openai-compatible";

const mockedGenerate = generate as unknown as ReturnType<typeof vi.fn>;
const mockedMake = make as unknown as ReturnType<typeof vi.fn>;

const makeProvider = () =>
  toLLMProvider({
    providerId: "test",
    providerDisplayName: "Test",
    model: "gpt-4o",
    supportsVision: true,
    supportsStructuredOutput: true,
    configureResult: {
      model: () => ({ id: "gpt-4o", provider: "test", routeId: "test::chat" }),
    },
  });

describe("provider-bridge chat()", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  test("recomputes costUsd and drops zero usage fields", async () => {
    mockedGenerate.mockResolvedValue({
      content: "hi",
      usage: {
        tokensIn: 1000,
        tokensOut: 500,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cachedWriteInputTokens: 0,
      },
    });
    const res = await makeProvider().chat({ messages: [{ role: "user", content: "hello" }] });
    expect(res.content).toBe("hi");
    expect(res.usage).toBeDefined();
    expect(res.usage!.model).toBe("gpt-4o");
    expect(res.usage!.costUsd).toBeGreaterThan(0);
 // Zero-valued optional fields are dropped (not emitted as `0`).
    expect(res.usage!.reasoningTokens).toBeUndefined();
    expect(res.usage!.cachedInputTokens).toBeUndefined();
    expect(res.usage!.cachedWriteInputTokens).toBeUndefined();
  });

  test("keeps non-zero usage fields intact", async () => {
    mockedGenerate.mockResolvedValue({
      content: "hi",
      usage: {
        tokensIn: 1000,
        tokensOut: 500,
        reasoningTokens: 100,
        cachedInputTokens: 200,
        cachedWriteInputTokens: 50,
      },
    });
    const res = await makeProvider().chat({ messages: [{ role: "user", content: "hello" }] });
    expect(res.usage!.reasoningTokens).toBe(100);
    expect(res.usage!.cachedInputTokens).toBe(200);
    expect(res.usage!.cachedWriteInputTokens).toBe(50);
  });

  test("returns usage: undefined when the protocol reports none", async () => {
    mockedGenerate.mockResolvedValue({ content: "hi" });
    const res = await makeProvider().chat({ messages: [{ role: "user", content: "hello" }] });
    expect(res.content).toBe("hi");
    expect(res.usage).toBeUndefined();
  });

  test("preserves an additive route terminal diagnostic for direct callers", async () => {
    mockedGenerate.mockResolvedValue({
      content: "",
      terminalDiagnostic: {
        code: "reasoning_only",
        protocol: "openai-chat",
        visibleContentChars: 0,
        terminalSeen: true,
      },
    });
    const res = await makeProvider().chat({ messages: [{ role: "user", content: "hello" }] });
    expect((res as typeof res & { terminalDiagnostic?: unknown }).terminalDiagnostic).toEqual({
      code: "reasoning_only",
      protocol: "openai-chat",
      visibleContentChars: 0,
      terminalSeen: true,
    });
  });

  test("enriches a 'No route registered' failure with the provider id", async () => {
    mockedGenerate.mockRejectedValue(
      new Error('No route registered for model "test/gpt-4o" (routeId "test::chat").'),
    );
    await expect(
      makeProvider().chat({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow(/Bridged provider "test" failed to generate/);
  });
});

describe("provider-bridge capability wiring", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  test("reads a post-construction supportsReasoning patch off the receiver", async () => {
    // `provider-config.ts` patches the bridged provider via a spread copy
    // (`result = { ...result, supportsReasoning: true }`), which is invisible
    // to the bridge closure (it captures the ORIGINAL config). chat() must
    // read the live flag off `this` or the route layer never learns the model
    // is a reasoning model — `temperature` would be sent to o-series /
    // grok-reasoning and the provider would 400.
    const provider = makeProvider();
    const patched = { ...provider, supportsReasoning: true };
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await patched.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(mockedGenerate.mock.calls[0][0].reasoning).toBe(true);
  });

  test("does not forward reasoning when the provider is not a reasoning model", async () => {
    const provider = makeProvider();
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(mockedGenerate.mock.calls[0][0].reasoning).toBeUndefined();
  });

  test("forwards reasoningConfig to reasoning providers", async () => {
    // The reasoning override (effort / budget / force) must reach the route
    // layer ONLY when the provider is a reasoning model — a stray reasoning
    // param can 400 on non-reasoning endpoints.
    const provider = makeProvider();
    const patched = { ...provider, supportsReasoning: true };
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await patched.chat({
      messages: [{ role: "user", content: "hello" }],
      reasoning: { effort: "high", budgetTokens: 16000, enabled: true },
    });
    expect(mockedGenerate.mock.calls[0][0].reasoningConfig).toEqual({
      effort: "high",
      budgetTokens: 16000,
      enabled: true,
    });
  });

  test("drops reasoningConfig on non-reasoning providers", async () => {
    const provider = makeProvider();
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await provider.chat({
      messages: [{ role: "user", content: "hello" }],
      reasoning: { effort: "high" },
    });
    expect(mockedGenerate.mock.calls[0][0].reasoningConfig).toBeUndefined();
  });

  test("forwards cacheEligible when the caller marks the prompt reusable", async () => {
    const provider = makeProvider();
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await provider.chat({ messages: [{ role: "user", content: "hello" }], cacheEligible: true });
    expect(mockedGenerate.mock.calls[0][0].cacheEligible).toBe(true);
  });

  test("omits cacheEligible for one-shot calls", async () => {
    const provider = makeProvider();
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(mockedGenerate.mock.calls[0][0].cacheEligible).toBeUndefined();
  });

  test("forwards structuredOutputStrict when the facade opts in", async () => {
    const provider = toLLMProvider({
      providerId: "test",
      providerDisplayName: "Test",
      model: "gpt-4o",
      supportsVision: true,
      supportsStructuredOutput: true,
      structuredOutputStrict: true,
      configureResult: {
        model: () => ({ id: "gpt-4o", provider: "test", routeId: "test::chat" }),
      },
    });
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(mockedGenerate.mock.calls[0][0].structuredOutputStrict).toBe(true);
  });

  test("omits structuredOutputStrict when the facade does not opt in", async () => {
    const provider = makeProvider();
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(mockedGenerate.mock.calls[0][0].structuredOutputStrict).toBeUndefined();
  });
});

describe("provider-bridge facade wiring (openai-compatible)", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  test("forwards structuredOutputStrict for profiles marked structured-output capable", async () => {
    // Without this the openai-compatible-chat protocol downgrades json_schema
    // to schema-less json_object while llm-direct's in-prompt fallback is
    // gated on supportsStructuredOutput === false — the schema contract would
    // reach the model in NO form for OpenRouter/Groq/xAI/DeepSeek/….
    const provider = openaiCompatibleToLLMProvider({
      provider: "openrouter",
      model: "gpt-4o",
      apiKey: "test-key",
    });
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(mockedGenerate.mock.calls[0][0].structuredOutputStrict).toBe(true);
  });

  test("omits structuredOutputStrict for profiles without structured-output support", async () => {
    // Ollama's shim doesn't honor json_schema; llm-direct's in-prompt schema
    // fallback carries the contract instead.
    const provider = openaiCompatibleToLLMProvider({
      provider: "ollama",
      model: "llama3.1",
    });
    mockedGenerate.mockResolvedValue({ content: "hi" });
    await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(mockedGenerate.mock.calls[0][0].structuredOutputStrict).toBeUndefined();
  });
});

describe("provider-bridge error propagation", () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  test("propagates provider errors unchanged (transport/network failure)", async () => {
    // the rejection path was untested — a change that swallowed
    // errors would have passed. The original error object must surface.
    const networkError = new TypeError("fetch failed");
    mockedGenerate.mockRejectedValue(networkError);
    await expect(
      makeProvider().chat({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toBe(networkError);
  });
});

describe("openai-compatible route-id stability", () => {
  beforeEach(() => {
    mockedMake.mockClear();
  });

  test("identical configs reuse the same route id (no registry leak)", () => {
    // The global route registry (route/client.ts) never evicts entries; a
    // fresh per-call nonce would leak one dead route per toLLMProvider() call
    // for the life of the service worker. Repeated calls with an IDENTICAL
    // config must reuse the same route id so the registry's Map.set
    // overwrites in place.
    openaiCompatibleToLLMProvider({ provider: "groq", model: "llama-3.3", apiKey: "key-a" });
    openaiCompatibleToLLMProvider({ provider: "groq", model: "llama-3.3", apiKey: "key-a" });
    const [id1, id2] = mockedMake.mock.calls.map((c) => c[0].id as string);
    expect(id1).toBe(id2);
  });

  test("different credentials on the same baseURL get distinct route ids", () => {
    // Credential isolation must survive the nonce memoization: a different
    // apiKey must register under its own route id (the last writer would
    // otherwise clobber the wrong credential's route).
    openaiCompatibleToLLMProvider({ provider: "groq", model: "llama-3.3", apiKey: "key-a" });
    openaiCompatibleToLLMProvider({ provider: "groq", model: "llama-3.3", apiKey: "key-b" });
    const [id1, id2] = mockedMake.mock.calls.map((c) => c[0].id as string);
    expect(id1).not.toBe(id2);
  });
});
