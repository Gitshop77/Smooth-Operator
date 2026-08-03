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

describe("StringMatchSchema ref must assert something", () => {
  it("rejects an empty ref (would be a silent no-op pass)", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "must_include", ref: "" }],
        },
      }),
    ).toThrow(/Too small/);
  });

  it("rejects a whitespace-only ref", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "must_include", ref: "   " }],
        },
      }),
    ).toThrow(/non-blank/);
  });

  it("rejects an empty exact_match ref (degenerate assertion)", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "exact_match", ref: "" }],
        },
      }),
    ).toThrow(/Too small/);
  });

  it("accepts a |OR| ref that still contains alternatives", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "must_include", ref: "apple |OR| pear" }],
        },
      }),
    ).not.toThrow();
  });
});

describe("HtmlContentTargetSchema contents bounds", () => {
  it("rejects a blank must_include item", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          html: [{ locator: "", required_contents: { must_include: [""] } }],
        },
      }),
    ).toThrow(/non-blank/);
  });

  it("rejects a whitespace-only must_include item", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          html: [{ locator: "", required_contents: { must_include: ["   "] } }],
        },
      }),
    ).toThrow(/non-blank/);
  });

  it("caps must_include item length", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          html: [{ locator: "", required_contents: { must_include: ["a".repeat(2001)] } }],
        },
      }),
    ).toThrow();
  });

  it("caps locator and exact_match length", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          html: [{ locator: "a".repeat(2001), required_contents: { exact_match: "x" } }],
        },
      }),
    ).toThrow();
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          html: [{ locator: "", required_contents: { exact_match: "a".repeat(2001) } }],
        },
      }),
    ).toThrow();
  });

  it("still accepts a normal target", () => {
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          html: [{ locator: ".card", required_contents: { must_include: ["in stock"] } }],
        },
      }),
    ).not.toThrow();
  });
});

describe("backreference over-rejection (documented conservative behavior)", () => {
  it("rejects \\8 and \\g<...> even though they are legacy identity escapes", () => {
    // `\8`/`\9` are octal/identity escapes and `\g` is a legacy identity
    // escape in non-unicode mode, never backreferences — but distinguishing
    // them from real backreferences requires parsing the pattern's group
    // structure. The guard intentionally over-rejects (fail-closed); keep
    // this behavior pinned so it stays explicit.
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "regex", ref: "a\\8b" }],
        },
      }),
    ).toThrow(/backreference/);
    expect(() =>
      validateConfig({
        expectedOutcomes: {
          string: [{ type: "regex", ref: "\\g<x>" }],
        },
      }),
    ).toThrow(/backreference/);
  });
});
