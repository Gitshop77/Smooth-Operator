/**
 * Phase 8 prompt token-economics tests.
 *
 * Covers the deterministic UTF-8 byte budget port, the per-kind budget
 * profiles, fail-closed admission, and the deterministic byte-bounded
 * compaction text primitive. These are the measurable token/cost controls the
 * master plan requires: conservative upper-bound admission, deterministic
 * truncation, and an observable marker for anything dropped.
 */

import { describe, expect, test } from "vitest";
import {
  PROMPT_BUDGET_PROFILES_V1,
  PromptBudgetExceededError,
  UTF8_PROMPT_BUDGET_V1,
  assertCompiledPromptWithinProfileV1,
  assertPromptWithinProfileV1,
  utf8ByteLength,
} from "../src/lib/agent/prompts/prompt-token-budget";
import { boundPromptTextV1 } from "../src/lib/agent/prompts/bounded-prompt-text";

describe("utf8ByteLength", () => {
  test("measures ASCII bytes 1:1", () => {
    expect(utf8ByteLength("hello")).toBe(5);
    expect(utf8ByteLength("")).toBe(0);
  });

  test("measures multibyte UTF-8 exactly", () => {
    // é = 2 bytes, € = 3 bytes, 𐍈 = 4 bytes (supplementary plane).
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("𐍈")).toBe(4);
    expect(utf8ByteLength("aé€𐍈")).toBe(1 + 2 + 3 + 4);
  });
});

describe("UTF8_PROMPT_BUDGET_V1", () => {
  test("admits text within the budget and rejects over it", () => {
    const port = UTF8_PROMPT_BUDGET_V1;
    expect(port.version).toBe(1);
    expect(() => port.assertWithinBudget("test", "abc", 3)).not.toThrow();
    expect(() => port.assertWithinBudget("test", "abcd", 3)).toThrow(PromptBudgetExceededError);
  });

  test("is a deterministic upper bound (bytes never under-count tokens)", () => {
    // The port counts bytes; every token is at least one byte, so the estimate
    // can never be lower than the true token count for any tokenizer.
    const estimate = UTF8_PROMPT_BUDGET_V1.estimateTokens("x".repeat(10_000));
    expect(estimate).toBe(10_000);
  });

  test("throws a typed, label-carrying error", () => {
    let caught: unknown;
    try {
      UTF8_PROMPT_BUDGET_V1.assertWithinBudget("navigator", "z".repeat(5), 4);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PromptBudgetExceededError);
    const typed = caught as PromptBudgetExceededError;
    expect(typed.code).toBe("PROMPT_BUDGET_EXCEEDED");
    expect(typed.budgetExceeded).toBe(true);
    expect(typed.label).toBe("navigator");
    expect(typed.estimatedTokens).toBe(5);
    expect(typed.maxTokens).toBe(4);
    expect(typed.message).toContain("navigator");
  });

  test("rejects a non-safe-integer budget as a TypeError", () => {
    expect(() => UTF8_PROMPT_BUDGET_V1.assertWithinBudget("test", "abc", -1)).toThrow(TypeError);
    expect(() => UTF8_PROMPT_BUDGET_V1.assertWithinBudget("test", "abc", 1.5)).toThrow(TypeError);
  });
});

describe("PROMPT_BUDGET_PROFILES_V1", () => {
  test("maxInputTokens is context minus output and reasoning reserves", () => {
    for (const kind of ["navigator", "planner", "judge", "compaction"] as const) {
      const profile = PROMPT_BUDGET_PROFILES_V1[kind];
      expect(profile.kind).toBe(kind);
      expect(profile.maxInputTokens).toBe(
        profile.contextTokens - profile.outputReserveTokens - profile.reasoningReserveTokens,
      );
      expect(profile.contextTokens).toBeGreaterThan(profile.maxInputTokens);
      expect(profile.maxInputTokens).toBeGreaterThan(0);
    }
  });

  test("navigator budget is the largest (heaviest context)", () => {
    const navigator = PROMPT_BUDGET_PROFILES_V1.navigator;
    for (const kind of ["planner", "judge", "compaction"] as const) {
      expect(navigator.contextTokens).toBeGreaterThan(PROMPT_BUDGET_PROFILES_V1[kind].contextTokens);
    }
  });
});

describe("assertPromptWithinProfileV1", () => {
  test("passes a small prompt for every kind", () => {
    for (const kind of ["navigator", "planner", "judge", "compaction"] as const) {
      expect(() => assertPromptWithinProfileV1(kind, kind, "hello")).not.toThrow();
    }
  });

  test("fails closed when a prompt exceeds the kind profile", () => {
    expect(() =>
      assertPromptWithinProfileV1("judge", "judge", "x".repeat(PROMPT_BUDGET_PROFILES_V1.judge.maxInputTokens + 1)),
    ).toThrow(PromptBudgetExceededError);
  });
});

describe("assertCompiledPromptWithinProfileV1", () => {
  test("sums system + user message bodies conservatively", () => {
    expect(() =>
      assertCompiledPromptWithinProfileV1("planner", "planner", [
        { content: "system" },
        { content: "user" },
      ]),
    ).not.toThrow();
  });
});

describe("boundPromptTextV1", () => {
  test("returns the source untouched when it fits", () => {
    const result = boundPromptTextV1("short text", { maxBytes: 1_000, label: "x" });
    expect(result.text).toBe("short text");
    expect(result.originalBytes).toBe(10);
    expect(result.retainedBytes).toBe(10);
    expect(result.droppedBytes).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test("keeps a code-point-safe prefix that fits with the marker", () => {
    const source = "a".repeat(100);
    const result = boundPromptTextV1(source, { maxBytes: 50, label: "history" });
    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(50);
    expect(result.droppedBytes).toBe(result.originalBytes - result.retainedBytes);
    expect(result.text).toContain("[truncated");
    expect(result.text).toContain("history");
  });

  test("never splits a surrogate pair at the boundary", () => {
    // 𐍈 (U+10348) is a 4-byte char encoded as two UTF-16 code units.
    const source = "a".repeat(10) + "𐍈" + "b".repeat(10);
    const result = boundPromptTextV1(source, { maxBytes: 14, label: "emoji" });
    expect(result.truncated).toBe(true);
    // The retained prefix plus marker must stay within budget, and the
    // truncated result must not end in a lone low surrogate.
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(14);
    const last = result.text[result.text.length - 1];
    expect(last.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });

  test("handles a budget too small for the marker by returning a bounded marker", () => {
    const result = boundPromptTextV1("large content here", { maxBytes: 4, label: "tiny" });
    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(4);
    expect(result.droppedBytes).toBe(result.originalBytes);
    expect(result.retainedBytes).toBe(0);
  });

  test("rejects an invalid byte bound", () => {
    expect(() => boundPromptTextV1("x", { maxBytes: -1, label: "x" })).toThrow(TypeError);
    expect(() => boundPromptTextV1("x", { maxBytes: 1.5, label: "x" })).toThrow(TypeError);
  });

  test("byte accounting is exact across a multibyte boundary", () => {
    // 5 ASCII + 3-byte € + 10 ASCII = 18 bytes; bound at 12 keeps 5 ASCII +
    // the € (8 bytes) + up to 4 ASCII — the € must never be split.
    const source = "aaaaa€bbbbbbbbbb";
    const result = boundPromptTextV1(source, { maxBytes: 12, label: "bytes" });
    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(12);
    // The € must be entirely present or entirely absent.
    const hasEuro = result.text.includes("€");
    if (hasEuro) {
      expect(utf8ByteLength(result.text)).toBeGreaterThanOrEqual(5 + 3);
    }
  });
});

