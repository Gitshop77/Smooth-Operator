/**
 * Coverage for the `search_page` handler's ReDoS static guard and the pattern
 * length cap. `hasNestedQuantifier` is the PRIMARY defense against
 * catastrophic-backtracking regexes supplied by the LLM / via prompt injection,
 * so its acceptance/rejection behavior is locked down here.
 */

import { describe, test, expect, afterEach } from "vitest";
import { vi } from "vitest";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import type { BrowserState } from "../src/lib/agent/types";
import { hasNestedQuantifier, hasBackreference, handleSearchPage } from "../src/lib/agent/tools/handlers/search-page";
import { makeState } from "./helpers";

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
    "(?:ab)+",
    "a+b+c+",
    "(a+){3}",
    "(a|b){50}",
    "(a{100})+",
  ];

  // Shapes that MUST be rejected: a group containing an unbounded quantifier,
  // itself quantified by an unbounded quantifier (or by a large exact {n}),
  // OR an ambiguous alternation under an unbounded quantifier.
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
    "(?:a|a)+",
    "(?:a+)+",
    "((a|a))+",
    "(a+){100}b",
    "(a|aa){100}b",
    "([\\d]|5)+",
    "([\\x41]|A)+",
  ];

  test.each(safe)("accepts safe shape: %s", (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(false);
  });

  test.each(unsafe)("rejects unsafe shape: %s", (pattern) => {
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


  test.each(withBackref)("rejects backreference pattern: %s", (pattern) => {
    expect(hasBackreference(pattern)).toBe(true);
  });

  test.each(withoutBackref)("accepts non-backreference pattern: %s", (pattern) => {
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

describe("handleSearchPage redaction-failure masking", () => {
  const ctx = {
    state: makeState(),
    beforeUrl: location.href,
    beforeFingerprint: "fingerprint",
  } as ActionContext;

  afterEach(() => {
    document.body.innerHTML = "";
    delete (globalThis as Record<string, unknown>).chrome;
  });

  test("when redactSecrets fails, matched text is masked — never shipped raw", async () => {
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        session: {
          get: vi.fn().mockRejectedValue(new Error("SW asleep")),
        },
      },
    };
    document.body.innerHTML = `
      <div>alpha secret-tok-1 omega</div>
      <div>beta secret-tok-2 gamma</div>
    `;
    const res = await handleSearchPage(ctx, {
      type: "search_page",
      pattern: "secret-tok",
      regex: false,
      case_sensitive: false,
    });
    expect(res.success).toBe(true);
    expect(res.extractedContent).not.toContain("secret-tok-1");
    expect(res.extractedContent).not.toContain("secret-tok-2");
    expect(res.extractedContent).toContain("[REDACTED");
  });
});
