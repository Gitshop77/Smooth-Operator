import { describe, expect, it } from "vitest";

import { NetworkJournal } from "@/server/browser/network";

describe("NetworkJournal", () => {
  it("correlates request and response metadata without retaining sensitive fields", () => {
    const journal = new NetworkJournal({ capacity: 10 });

    journal.recordRequest({
      pageId: "page-1",
      requestId: "request-1",
      url: "https://user:password@example.test/api?token=secret&ok=1",
      method: " post ",
      resourceType: "XHR",
      timestamp: "2026-08-30T10:00:00.000Z",
      headers: { Authorization: "Bearer secret" },
      cookies: "session=secret",
      postData: "password=secret",
    } as never);
    journal.recordResponse({
      pageId: "page-1",
      requestId: "request-1",
      status: 201,
      timestamp: "2026-08-30T10:00:01.000Z",
      body: "secret response",
    } as never);

    const result = journal.query({ pageId: "page-1" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      pageId: "page-1",
      requestId: "request-1",
      url: "https://example.test/api?token=%5Bredacted%5D&ok=1",
      method: "POST",
      status: 201,
      resourceType: "XHR",
      requestTimestamp: "2026-08-30T10:00:00.000Z",
      responseTimestamp: "2026-08-30T10:00:01.000Z",
    });
    expect(result.entries[0]).not.toHaveProperty("headers");
    expect(result.entries[0]).not.toHaveProperty("cookies");
    expect(result.entries[0]).not.toHaveProperty("postData");
    expect(result.entries[0]).not.toHaveProperty("body");
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(result)).not.toContain("Bearer secret");
    expect(JSON.stringify(result)).not.toContain("secret response");
  });

  it("assigns deterministic IDs when an event does not provide one", () => {
    const journal = new NetworkJournal({ capacity: 10 });

    const first = journal.recordRequest({ pageId: "page-1", url: "https://example.test/one", method: "GET" });
    const second = journal.recordRequest({ pageId: "page-1", url: "https://example.test/two", method: "GET" });

    expect(first.requestId).toBe("page-1:request-1");
    expect(second.requestId).toBe("page-1:request-2");

    journal.recordResponse({ pageId: "page-1", requestId: first.requestId, status: 200 });
    expect(journal.query({ pageId: "page-1" }).entries).toHaveLength(2);
    expect(journal.query({ pageId: "page-1", requestId: first.requestId }).entries).toHaveLength(1);
  });

  it("keeps a fixed per-page capacity and reports evictions explicitly", () => {
    const journal = new NetworkJournal({ capacity: 2 });

    for (const path of ["/one", "/two", "/three"]) {
      journal.recordRequest({ pageId: "page-1", url: `https://example.test${path}`, method: "GET" });
    }

    const result = journal.query({ pageId: "page-1", limit: 10 });
    expect(result.entries.map((entry) => entry.url)).toEqual([
      "https://example.test/two",
      "https://example.test/three",
    ]);
    expect(result.capacity).toBe(2);
    expect(result.retainedCount).toBe(2);
    expect(result.evictedCount).toBe(1);
    expect(result.capacityReached).toBe(true);
    expect(result.omittedCount).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("includes per-page evictions when an entire page journal is evicted", () => {
    const journal = new NetworkJournal({ capacity: 1, maxPages: 1 });

    journal.recordRequest({ pageId: "page-1", url: "https://example.test/one", method: "GET" });
    journal.recordRequest({ pageId: "page-1", url: "https://example.test/two", method: "GET" });
    journal.recordRequest({ pageId: "page-2", url: "https://example.test/three", method: "GET" });

    expect(journal.query()).toMatchObject({
      retainedCount: 1,
      evictedCount: 2,
      capacityReached: true,
    });
  });

  it("filters and paginates deterministically across supported metadata", () => {
    const journal = new NetworkJournal({ capacity: 10 });
    const events = [
      ["req-a", "https://example.test/products/1", "GET", 200, "Document"],
      ["req-b", "https://example.test/api/products", "POST", 201, "Fetch"],
      ["req-c", "https://other.test/api/products", "POST", 500, "XHR"],
      ["req-d", "https://example.test/api/cart", "POST", 200, "Fetch"],
    ] as const;
    for (const [requestId, url, method, status, resourceType] of events) {
      journal.recordRequest({ pageId: "page-1", requestId, url, method, resourceType });
      journal.recordResponse({ pageId: "page-1", requestId, status });
    }

    const filtered = journal.query({
      pageId: "page-1",
      url: "/api/",
      method: "post",
      resourceType: "fetch",
      status: 200,
      limit: 1,
      offset: 0,
    });
    expect(filtered.entries.map((entry) => entry.requestId)).toEqual(["req-d"]);
    expect(filtered.total).toBe(1);
    expect(filtered.returnedCount).toBe(1);

    const paginated = journal.query({ pageId: "page-1", url: "example.test", limit: 2, offset: 1 });
    expect(paginated.entries.map((entry) => entry.requestId)).toEqual(["req-b", "req-d"]);
    expect(paginated.total).toBe(3);
    expect(paginated.returnedCount).toBe(2);
    expect(paginated.omittedCount).toBe(1);
    expect(paginated.hasMore).toBe(false);
  });

  it("searches bounded metadata efficiently and reports pagination omission", () => {
    const journal = new NetworkJournal({ capacity: 10 });
    journal.recordRequest({ pageId: "page-1", requestId: "checkout-1", url: "https://example.test/cart", method: "POST", resourceType: "Fetch" });
    journal.recordResponse({ pageId: "page-1", requestId: "checkout-1", status: 202 });
    journal.recordRequest({ pageId: "page-1", requestId: "profile-1", url: "https://example.test/profile", method: "GET", resourceType: "Document" });
    journal.recordResponse({ pageId: "page-1", requestId: "profile-1", status: 200 });

    const result = journal.search("CHECKOUT", { pageId: "page-1", limit: 1 });
    expect(result.entries.map((entry) => entry.requestId)).toEqual(["checkout-1"]);
    expect(result.total).toBe(1);
    expect(result.omittedCount).toBe(0);

    const statusSearch = journal.search("202", { pageId: "page-1" });
    expect(statusSearch.entries.map((entry) => entry.requestId)).toEqual(["checkout-1"]);
  });

  it("isolates page journals while retaining fixed capacity per page", () => {
    const journal = new NetworkJournal({ capacity: 1 });
    journal.recordRequest({ pageId: "page-1", requestId: "same", url: "https://one.test", method: "GET" });
    journal.recordRequest({ pageId: "page-2", requestId: "same", url: "https://two.test", method: "GET" });

    expect(journal.query({ pageId: "page-1" }).entries[0]?.url).toBe("https://one.test/");
    expect(journal.query({ pageId: "page-2" }).entries[0]?.url).toBe("https://two.test/");
    expect(journal.query().retainedCount).toBe(2);
  });

  it("rejects invalid journal configuration and page identifiers", () => {
    expect(() => new NetworkJournal({ capacity: 0 })).toThrow(/capacity/i);
    const journal = new NetworkJournal();
    expect(() => journal.recordRequest({ pageId: "", url: "https://example.test", method: "GET" })).toThrow(/pageId/i);
    expect(() => journal.query({ limit: 0 })).toThrow(/limit/i);
    expect(() => journal.query({ offset: -1 })).toThrow(/offset/i);
  });
});
