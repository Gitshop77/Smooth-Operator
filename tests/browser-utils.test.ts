import { describe, expect, it } from "vitest";

import { globMatches, sanitizeUrl } from "@/server/browser/utils";

describe("browser pure helpers", () => {
  it("matches URL globs across path separators", () => {
    expect(globMatches("https://example.com/path/a", "https://example.com/*")).toBe(false);
    expect(globMatches("https://example.com/path/a", "https://example.com/**")).toBe(true);
    expect(globMatches("https://example.com/path/a", "https://example.com/path")).toBe(false);
  });

  it("preserves useful URL state while redacting credential-like values", () => {
    const result = sanitizeUrl("https://example.com/items?page=2&token=secret#section-2");
    expect(result).toContain("/items?page=2");
    expect(result).toContain("token=%5Bredacted%5D");
    expect(result).toContain("#section-2");
    expect(sanitizeUrl("https://user:pass@example.com")).toBe("https://example.com/");
  });

  it("preserves duplicate query parameters and marks bounded query output", () => {
    const duplicate = sanitizeUrl("https://example.com/items?id=1&id=2&tag=a");
    expect(duplicate).toContain("id=1&id=2&tag=a");

    const bounded = sanitizeUrl(`https://example.com/items?${Array.from({ length: 70 }, (_, index) => `q${index}=v${index}`).join("&")}`);
    expect(bounded).toContain("q0=v0");
    expect(bounded).toContain("q63=v63");
    expect(bounded).toContain("__open_cowork_truncated=%5Btruncated%5D");
    expect(bounded).not.toContain("q64=v64");
  });

  it("fails closed on oversized URL and glob inputs", () => {
    expect(sanitizeUrl(`https://example.com/${"a".repeat(20_000)}`)).toBe("[URL_TOO_LONG]");
    expect(globMatches("https://example.com/ok", "*".repeat(20_000))).toBe(false);
  });
});
