/**
 * Tests for `src/lib/agent/llm/route/endpoint.ts`.
 *
 * Focuses on the query-string construction paths the FULL-REVIEW audit flagged
 * as 0%-branch-covered: the malformed double-"?" guard and the relative-path
 * query merge.
 */
import { describe, test, expect } from "vitest";
import { Endpoint, buildURL } from "@/lib/agent/llm/route/endpoint";

describe("endpoint buildURL", () => {
  test("merges endpoint.query into an absolute base URL with a single '?'", () => {
    const ep = Endpoint.path("/v1/chat", {
      baseURL: "https://api.openai.com",
      query: { alt: "sse" },
    });
    const url = buildURL(ep, {});
    expect(url).toBe("https://api.openai.com/v1/chat?alt=sse");
    expect(url.split("?").length).toBe(2);
  });

  test("relative path carrying its own query + endpoint query emits one '?'", () => {
    const ep = Endpoint.path("/chat?foo=1", { query: { bar: "2" } });
    const url = buildURL(ep, {});
    expect(url).toBe("/chat?foo=1&bar=2");
    expect(url.split("?").length).toBe(2);
  });

  test("relative path with no endpoint query is returned unchanged", () => {
    const ep = Endpoint.path("/chat");
    expect(buildURL(ep, {})).toBe("/chat");
  });

  test("absolute base URL without endpoint query leaves the path intact", () => {
    const ep = Endpoint.path("/v1/chat", { baseURL: "https://api.openai.com" });
    expect(buildURL(ep, {})).toBe("https://api.openai.com/v1/chat");
  });
});

describe("endpoint merge", () => {
  test("Endpoint.path(...).merge(...) produces a combined endpoint with merged query", () => {
    const base = Endpoint.path("/v1/chat", {
      baseURL: "https://x.ai",
      query: { a: "1" },
    });
    const merged = base.merge({ query: { b: "2" } });
    expect(buildURL(merged, {})).toBe("https://x.ai/v1/chat?a=1&b=2");
 // The original endpoint is not mutated by merge().
    expect(buildURL(base, {})).toBe("https://x.ai/v1/chat?a=1");
  });
});
