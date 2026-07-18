/**
 * Tests for `src/lib/agent/llm/providers/openrouter.ts` . OpenRouter is built via `makeOpenAIChatFacade`, so this also
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
 // A legitimate HTTPS endpoint MUST be accepted — this pins the guard's scope
 // so a regression toward over-rejection (the realistic failure mode that
 // erodes the control) is caught. Do not weaken the guard to make this pass.
    expect(() => openrouter.configure({ baseURL: "https://openrouter.ai/api/v1" })).not.toThrow();
    expect(() => openrouter.configure({ baseURL: "http://169.254.169.254/" })).toThrow();
 // Alternate IP encodings must also be rejected (Node normalizes them to the
 // same dangerous host, e.g. decimal 2852039166 → 169.254.169.254, and IPv4-
 // mapped IPv6). A regression here would re-open the cloud-metadata SSRF sink.
    expect(() => openrouter.configure({ baseURL: "http://2852039166/" })).toThrow();
    expect(() => openrouter.configure({ baseURL: "http://[::ffff:169.254.169.254]/" })).toThrow();
 // Hex dotted-form encodings normalize to the same metadata IP too.
    expect(() => openrouter.configure({ baseURL: "http://0xa9.0xfe.0xa9.0xfe/" })).toThrow();
 // Non-network schemes must be rejected too (no file:///etc/passwd exfil sink).
    expect(() => openrouter.configure({ baseURL: "file:///etc/passwd" })).toThrow();
  });
});
