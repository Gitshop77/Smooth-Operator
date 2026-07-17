/**
 * Coverage for the `search_page` handler's ReDoS static guard and the pattern
 * length cap. `hasNestedQuantifier` is the PRIMARY defense against
 * catastrophic-backtracking regexes supplied by the LLM / via prompt injection,
 * so its acceptance/rejection behavior is locked down here.
 */

import { describe, test, expect } from "vitest";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import type { BrowserState } from "../src/lib/agent/types";
import { hasNestedQuantifier, hasBackreference, handleSearchPage } from "../src/lib/agent/tools/handlers/search-page";

describe("hasNestedQuantifier (ReDoS static guard)", () => {
  // Shapes that MUST be allowed: disjunctions of disjoint tokens, exact and
  // bounded repetitions, lookarounds, and plain literal/character-class text.
  const safe = [
    "(abc|def)+",
    "(a|b|c)+",
    "(a{2})",
    "(a{2,4})",
    "(?=a)b",
    "(?!a)b",
    "(?<=a)b",
    "(?<!a)b",
    "a{3}",
    "[a-z]+",
    "foo",
    "(:?ab)+",
    "a+b+c+",
  ];

  // Shapes that MUST be rejected: a group containing an unbounded quantifier,
  // itself quantified by an unbounded quantifier, OR an ambiguous alternation
  // under an unbounded quantifier.
  const unsafe = [
    "(a+)+",
    "(a*)*",
    "(a+)*",
    "(a{2,})+",
    "([a-z]+)+$",
    "(a|a)+",
    "(a|ab)+",
    "(a|a|a)+$",
    "((a|b)+)+",
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  test.each(safe as any[])("accepts safe shape: %s", (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(false);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  test.each(unsafe as any[])("rejects unsafe shape: %s", (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(true);
  });
});

describe("hasBackreference (ReDoS backreference guard)", () => {
  // Patterns containing a backreference escape (backslash + digit 1–9) are the
  // classic catastrophic-backtracking vectors the structural quantifier check
  // cannot model.
  const withBackref = [
    "\\b(\\w+)\\b\\s+\\1\\b",
    "(a)\\1+",
    "(.+?)\\1+",
    "(ab)\\2",
    "(?<x>\\w+)\\k<x>+",
    "(?<g>.)\\k<g>",
  ];

  // Patterns that legitimately contain a backslash but NO backreference escape
  // (e.g. \d, \w, an escaped literal) must still be accepted.
  const withoutBackref = [
    "(abc|def)+",
    "(a|b|c)+",
    "a{2,4}",
    "^\\d+$",
    "(.+)",
    "foo\\\\bar",
    "(a|b)\\k",
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  test.each(withBackref as any[])("rejects backreference pattern: %s", (pattern) => {
    expect(hasBackreference(pattern)).toBe(true);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  test.each(withoutBackref as any[])("accepts non-backreference pattern: %s", (pattern) => {
    expect(hasBackreference(pattern)).toBe(false);
  });
});

describe("handleSearchPage pattern-length cap", () => {
  const ctx = {
    state: {} as BrowserState,
    beforeUrl: "",
    beforeFingerprint: "",
  } as ActionContext;

  test("rejects an over-long regex pattern before any DOM access", async () => {
    const longPattern = "a".repeat(1000);
    const res = await handleSearchPage(ctx, {
      type: "search_page",
      pattern: longPattern,
      regex: true,
      case_sensitive: false,
    });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/too long/i);
  });

  test("rejects a backreference regex pattern before RegExp construction", async () => {
    const res = await handleSearchPage(ctx, {
      type: "search_page",
      pattern: "(a)\\1+",
      regex: true,
      case_sensitive: false,
    });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/backreference/i);
  });
});
