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
import { hasNestedQuantifier, hasBackreference, handleSearchPage } from "../src/lib/agent/tools/handlers/search-page";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import type { BrowserState } from "../src/lib/agent/types";
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

    test("rejects group-prefixed and single-wrapper ambiguities", () => {
      // `(?:a|a)+` must be analyzed against the inner alternation, not the
      // `?:` prefix; `((a|a))+` must recurse into the wrapper group.
      expect(hasNestedQuantifier("(?:a|a)+")).toBe(true);
      expect(hasNestedQuantifier("(?:a+)+")).toBe(true);
      expect(hasNestedQuantifier("((a|a))+")).toBe(true);
    });

    test("accepts safe alternation under unbounded quantifier", () => {
      expect(hasNestedQuantifier("(abc|def)+")).toBe(false);
      expect(hasNestedQuantifier("(a|b|c)+")).toBe(false);
      expect(hasNestedQuantifier("(?:ab)+")).toBe(false);
    });

    test("accepts exact repetitions and ? quantifiers", () => {
      expect(hasNestedQuantifier("(a+){3}")).toBe(false);
      expect(hasNestedQuantifier("(a)?")).toBe(false);
    });

    test("rejects large exact {n} on an ambiguous or nested-quantifier group", () => {
      // `(a+){100}` and `(a|aa){100}` keep the full exponential blowup of the
      // unbounded forms — only the repetition count is bounded, which does
      // not bound the path count.
      expect(hasNestedQuantifier("(a+){100}b")).toBe(true);
      expect(hasNestedQuantifier("(a|aa){100}b")).toBe(true);
      expect(hasNestedQuantifier("(a+){32}")).toBe(true);
    });

    test("accepts bounded exact {n} and bounded atoms under large repetitions", () => {
      expect(hasNestedQuantifier("(a+){3}")).toBe(false);
      expect(hasNestedQuantifier("(a|b){50}")).toBe(false);
      expect(hasNestedQuantifier("(?:ab){100}")).toBe(false);
      expect(hasNestedQuantifier("(a{100})+")).toBe(false);
      expect(hasNestedQuantifier("(a{100}){50}")).toBe(false);
    });

    test("rejects ambiguous alternation whose branch starts with a character class", () => {
      expect(hasNestedQuantifier("([ab]|b)+")).toBe(true);
      expect(hasNestedQuantifier("([a-z]|m)+")).toBe(true);
      expect(hasNestedQuantifier("([^0-9]|x)+")).toBe(true);
    });

    test("rejects class-escape branches that overlap a literal alternative", () => {
      expect(hasNestedQuantifier("([\\d]|5)+")).toBe(true);
      expect(hasNestedQuantifier("([\\s]| )+")).toBe(true);
      expect(hasNestedQuantifier("([\\D]|x)+")).toBe(true);
      expect(hasNestedQuantifier("([\\x41]|A)+")).toBe(true);
      expect(hasNestedQuantifier("([a-z\\x41]|A)+")).toBe(true);
    });

    test("rejects alternation overlapping via a hex escape literal", () => {
      expect(hasNestedQuantifier("(\\x41|A)+")).toBe(true);
    });

    test("rejects alternation overlapping via a unicode-property escape", () => {
      expect(hasNestedQuantifier("(\\p{L}|a)+")).toBe(true);
    });

    test("does not flag escaped literals whose real char differs (\\n is not 'n')", () => {
      expect(hasNestedQuantifier("(n|\\n)+")).toBe(false);
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
    const ctx = {
      state: {} as BrowserState,
      beforeUrl: "",
      beforeFingerprint: "",
    } as ActionContext;

    test("matches the expected bound", () => {
      expect(LIMITS.searchPageMaxRegexPattern).toBeGreaterThan(0);
    });

    test("guard rejects patterns exceeding the cap", async () => {
      const long = "a".repeat(LIMITS.searchPageMaxRegexPattern + 1);
      const res = await handleSearchPage(ctx, {
        type: "search_page",
        pattern: long,
        regex: true,
        case_sensitive: false,
      });
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/too long/i);
    });

    test("guard accepts patterns within the cap", async () => {
      const ok = "a".repeat(LIMITS.searchPageMaxRegexPattern);
      const res = await handleSearchPage(ctx, {
        type: "search_page",
        pattern: ok,
        regex: true,
        case_sensitive: false,
      });
      expect(res.success).toBe(true);
    });
  });
});
