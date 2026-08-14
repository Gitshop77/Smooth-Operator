import { describe, it, expect } from "vitest";
import { parseUsage, parseUsageLine, extractAnswer } from "../src/lib/agent/lightpanda/usage-parse";

describe("parseUsageLine", () => {
  it("parses a real usage line (format pinned by Agent.zig:556-568)", () => {
    expect(parseUsageLine("$usage prompt=1200 completion=340 total=1540 cached=0 cache_creation=0")).toEqual({
      tokensIn: 1200, tokensOut: 340, cached: 0, cacheCreation: 0,
    });
  });
  it("parses a line with non-zero cached fields", () => {
    expect(parseUsageLine("$usage prompt=10 completion=5 total=15 cached=2 cache_creation=1")).toEqual({
      tokensIn: 10, tokensOut: 5, cached: 2, cacheCreation: 1,
    });
  });
  it("returns null for non-usage lines", () => {
    expect(parseUsageLine("info: navigating")).toBeNull();
  });
});

describe("parseUsage", () => {
  it("finds the usage line inside mixed stderr", () => {
    const stderr = "info: loading page\n$usage prompt=10 completion=5 total=15 cached=2 cache_creation=1\ninfo: done";
    expect(parseUsage(stderr)).toEqual({ tokensIn: 10, tokensOut: 5, cached: 2, cacheCreation: 1 });
  });
  it("returns null when absent", () => {
    expect(parseUsage("nothing here")).toBeNull();
  });
});

describe("extractAnswer", () => {
  it("trims whitespace and the trailing newline Terminal.printAssistant adds", () => {
    expect(extractAnswer("  The answer.\n  ")).toBe("The answer.");
    expect(extractAnswer("The answer.\n")).toBe("The answer.");
  });
  it("returns empty string for empty stdout", () => {
    expect(extractAnswer("")).toBe("");
  });
});
