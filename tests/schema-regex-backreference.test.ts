import { describe, it, expect } from "vitest";
import { validateConfig } from "@/lib/agent/config/schema";

describe("StringMatchSchema regex ref ReDoS guards", () => {
  it("rejects numeric backreference patterns", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "regex", ref: "(a)\\1" }],
        },
      }),
    ).toThrow(/backreference/);
  });

  it("rejects named backreference patterns", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "regex", ref: "(?<n>a)\\k<n>" }],
        },
      }),
    ).toThrow(/backreference/);
  });

  it("accepts benign regex refs", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "regex", ref: "^foo\\d+bar$" }],
        },
      }),
    ).not.toThrow();
  });

  it("does not flag a literal backslash+digit outside a backreference context", () => {
    // `\d` is a digit class, not a backreference — must be accepted.
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "regex", ref: "\\d{1,3}" }],
        },
      }),
    ).not.toThrow();
  });

  it("ignores backreference-like text in non-regex string matches", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "exact_match", ref: "(a)\\1" }],
        },
      }),
    ).not.toThrow();
  });
});
