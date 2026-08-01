/**
 * Tests for `src/lib/agent/llm/provider-bridge.ts` . Two untested branches are pinned here: the `costUsd`
 * recomputation and the conditional dropping of zero usage fields on every chat
 * call. We mock the route-layer `generate` so no network/credential is needed.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/agent/llm/route/client", () => ({
  generate: vi.fn(),
}));

import { generate } from "@/lib/agent/llm/route/client";
import { toLLMProvider } from "@/lib/agent/llm/provider-bridge";

const mockedGenerate = generate as unknown as ReturnType<typeof vi.fn>;

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

  test("enriches a 'No route registered' failure with the provider id", async () => {
    mockedGenerate.mockRejectedValue(
      new Error('No route registered for model "test/gpt-4o" (routeId "test::chat").'),
    );
    await expect(
      makeProvider().chat({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toThrow(/Bridged provider "test" failed to generate/);
  });
});
