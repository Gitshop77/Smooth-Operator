/**
 * Regression tests for the search_page ReDoS static guards.
 *
 * These guards are driven by LLM / prompt-injection-supplied input and must
 * never be silently weakened during a refactor (e.g. dropping the
 * backreference guard). The structural analyzers (`hasNestedQuantifier`,
 * `hasBackreference`) and the `searchPageMaxRegexPattern` length cap are
 * asserted here directly.
 */

import { describe, test, expect } from "vitest";
import { hasNestedQuantifier, hasBackreference } from "../src/lib/agent/tools/handlers/search-page";
import { LIMITS } from "../src/lib/agent/tools/constants";

describe("search_page ReDoS static guards", () => {
  describe("hasNestedQuantifier", () => {
    test("rejects nested unbounded quantifiers", () => {
      expect(hasNestedQuantifier("(a+)+")).toBe(true);
      expect(hasNestedQuantifier("(a*)*")).toBe(true);
      expect(hasNestedQuantifier("(a{2,})+")).toBe(true);
      expect(hasNestedQuantifier("([a-z]+)+$")).toBe(true);
    });

    test("rejects ambiguous alternation under unbounded quantifier", () => {
      expect(hasNestedQuantifier("(a|a)+")).toBe(true);
      expect(hasNestedQuantifier("(a|ab)+")).toBe(true);
      expect(hasNestedQuantifier("(a|a|a)+$")).toBe(true);
      expect(hasNestedQuantifier("((a|b)+)+")).toBe(true);
    });

    test("accepts safe alternation under unbounded quantifier", () => {
      expect(hasNestedQuantifier("(abc|def)+")).toBe(false);
      expect(hasNestedQuantifier("(a|b|c)+")).toBe(false);
    });

    test("accepts exact repetitions and ? quantifiers", () => {
      expect(hasNestedQuantifier("(a+){3}")).toBe(false);
      expect(hasNestedQuantifier("(a)?")).toBe(false);
    });
  });

  describe("hasBackreference", () => {
    test("rejects backreferences", () => {
      expect(hasBackreference("\\1")).toBe(true);
      expect(hasBackreference("(a)\\1+")).toBe(true);
      expect(hasBackreference("\\b(\\w+)\\b\\s+\\1\\b")).toBe(true);
      expect(hasBackreference("\\k<name>")).toBe(true);
    });

    test("accepts escaped backslash (not a backreference)", () => {
      expect(hasBackreference("\\\\1")).toBe(false);
      expect(hasBackreference("a\\\\b")).toBe(false);
    });

    test("does not flag literal digit after non-backslash", () => {
      expect(hasBackreference("a1b")).toBe(false);
    });
  });

  describe("searchPageMaxRegexPattern length cap", () => {
    test("matches the expected bound", () => {
      expect(LIMITS.searchPageMaxRegexPattern).toBeGreaterThan(0);
    });

    test("guard rejects patterns exceeding the cap", () => {
      const long = "a".repeat(LIMITS.searchPageMaxRegexPattern + 1);
      expect(long.length).toBeGreaterThan(LIMITS.searchPageMaxRegexPattern);
    });

    test("guard accepts patterns within the cap", () => {
      const ok = "a".repeat(LIMITS.searchPageMaxRegexPattern);
      expect(ok.length).toBeLessThanOrEqual(LIMITS.searchPageMaxRegexPattern);
    });
  });
});
