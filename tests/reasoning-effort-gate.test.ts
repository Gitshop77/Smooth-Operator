/**
 * Effort gate: which OpenAI-compatible providers may receive the
 * `reasoning_effort` parameter (O1). `reasoningEffortSupported(providerId)`
 * is the predicate the request layer uses to decide whether to forward a
 * configured effort; `supportsReasoningEffort` is the per-profile capability
 * flag. Conservative first cut: only providers documented to pass
 * OpenAI-compatible reasoning params through (openrouter) opt in; everything
 * else (and unknown providers) fails closed so a stray `reasoning_effort`
 * never 400s a non-reasoning endpoint.
 */

import { describe, test, expect } from "vitest";
import {
  reasoningEffortSupported,
  byProvider,
  profiles,
} from "../src/lib/agent/llm/providers/openai-compatible-profile";

describe("reasoningEffortSupported", () => {
  test("true for openrouter (documented reasoning-param pass-through)", () => {
    expect(reasoningEffortSupported("openrouter")).toBe(true);
  });

  test("false for providers that do not opt in", () => {
    expect(reasoningEffortSupported("groq")).toBe(false);
    expect(reasoningEffortSupported("ollama")).toBe(false);
    expect(reasoningEffortSupported("together")).toBe(false);
  });

  test("false (fail-closed) for an unknown provider id", () => {
    expect(reasoningEffortSupported("does-not-exist")).toBe(false);
    expect(reasoningEffortSupported("")).toBe(false);
  });

  test("every profile row carries an explicit supportsReasoningEffort flag", () => {
    for (const key of Object.keys(profiles)) {
      expect(typeof profiles[key as keyof typeof profiles].supportsReasoningEffort).toBe("boolean");
    }
  });

  test("byProvider lookups resolve the same flag the predicate reads", () => {
    expect(byProvider.openrouter?.supportsReasoningEffort).toBe(true);
    expect(byProvider.groq?.supportsReasoningEffort).toBe(false);
  });
});
