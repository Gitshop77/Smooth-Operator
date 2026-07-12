/**
 * Tests for `src/lib/agent/llm/providers/openrouter.ts` (FULL-REVIEW #18 — 0%
 * branch coverage). OpenRouter is built via `makeOpenAIChatFacade`, so this also
 * exercises the shared facade's `configure`/`toLLMProvider` surface.
 */
import { describe, test, expect } from "vitest";
import * as openrouter from "@/lib/agent/llm/providers/openrouter";

describe("openrouter facade", () => {
  test("configure() returns the facade id and a model handle keyed by provider", () => {
    const cfg = openrouter.configure({});
    expect(cfg.id).toBe("openrouter");
    const model = cfg.model("openai/gpt-4o") as {
      id: string;
      provider: string;
      routeId: string;
    };
    expect(model.id).toBe("openai/gpt-4o");
    expect(model.provider).toBe("openrouter");
    expect(model.routeId).toBe("openrouter::openai-compatible-chat");
  });

  test("toLLMProvider exposes the expected chat-only provider shape", () => {
    const provider = openrouter.toLLMProvider({ model: "openai/gpt-4o" });
    expect(provider.id).toBe("openrouter:openai/gpt-4o");
    expect(provider.displayName).toBe("OpenRouter openai/gpt-4o");
    expect(provider.supportsVision).toBe(true);
    expect(provider.supportsStructuredOutput).toBe(true);
    expect(typeof provider.chat).toBe("function");
 // Bridged providers intentionally do not implement streamChat (optional).
    expect(provider.streamChat).toBeUndefined();
  });

  test("a user-supplied baseURL must pass the SSRF guard (invalid throws)", () => {
    expect(() => openrouter.configure({ baseURL: "http://169.254.169.254/" })).toThrow();
  });
});
