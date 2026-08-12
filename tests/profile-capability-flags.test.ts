/**
 * Provider profile capability flags — per-provider structured-output and
 * reasoning-effort support. DeepSeek only honors `json_object` (the
 * `json_schema` variant 400s), so `supportsStructuredOutput: false` triggers
 * the schema-less downgrade + in-prompt schema fallback; DeepSeek and xAI
 * document `reasoning_effort` so their requests must not have it stripped.
 */
import { describe, expect, test } from "vitest";
import { byProvider, reasoningEffortSupported } from "../src/lib/agent/llm/providers/openai-compatible-profile";

describe("OpenAI-compatible profile capability flags", () => {
  test("deepseek: supportsStructuredOutput false (json_schema 400s), reasoning_effort supported", () => {
    expect(byProvider.deepseek.supportsStructuredOutput).toBe(false);
    expect(byProvider.deepseek.supportsReasoningEffort).toBe(true);
    expect(reasoningEffortSupported("deepseek")).toBe(true);
  });

  test("xai: reasoning_effort is a first-class param for grok reasoning models", () => {
    expect(byProvider.xai.supportsStructuredOutput).toBe(true);
    expect(byProvider.xai.supportsReasoningEffort).toBe(true);
    expect(reasoningEffortSupported("xai")).toBe(true);
  });

  test("groq stays conservative: effort is model-scoped, not forwarded blindly", () => {
    expect(byProvider.groq.supportsReasoningEffort).toBe(false);
    expect(reasoningEffortSupported("groq")).toBe(false);
  });

  test("unknown providers fail closed (never forward reasoning_effort)", () => {
    expect(reasoningEffortSupported("some-unknown-provider")).toBe(false);
  });
});
