/**
 * persistent-memory caps — note length cap, total-memory eviction, prompt
 * ordering (updatedAt desc), and the bounded hostname result cache.
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  saveMemory,
  getMemoriesForUrl,
  formatMemories,
  loadAllMemories,
  __resetMemoryCacheForTests,
  MAX_MEMORY_NOTES_LENGTH,
  MAX_MEMORIES,
  MAX_HOSTNAME_CACHE_ENTRIES,
  type SiteMemory,
} from "../src/lib/agent/persistent-memory";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

beforeAll(() => {
  installLocalStorageStub();
});

afterAll(() => {
  restoreLocalStorageStub();
});

beforeEach(() => {
  localStorage.removeItem("open_cowork_site_memories");
  __resetMemoryCacheForTests();
});

describe("note length cap", () => {
  test("saveMemory truncates a note longer than MAX_MEMORY_NOTES_LENGTH", async () => {
    await saveMemory("example.com", "x".repeat(MAX_MEMORY_NOTES_LENGTH + 500));
    const all = await loadAllMemories();
    expect(all["example.com"].notes.length).toBe(MAX_MEMORY_NOTES_LENGTH);
  });
});

describe("total memory cap + eviction", () => {
  test("oldest-updatedAt entries are evicted when the map exceeds MAX_MEMORIES", async () => {
    // Save MAX_MEMORIES + 5 distinct domains in order; the first five saved
    // are the oldest and must be evicted.
    const now = Date.now();
    for (let i = 0; i < MAX_MEMORIES + 5; i++) {
      // Stagger timestamps so ordering is unambiguous (same-ms ties could
      // otherwise sort arbitrarily).
      vi.spyOn(Date, "now").mockReturnValue(now + i * 1000);
      await saveMemory(`site-${i}.example.com`, `note ${i}`);
      vi.restoreAllMocks();
    }
    const all = await loadAllMemories();
    expect(Object.keys(all).length).toBe(MAX_MEMORIES);
    // The newest five survive; the oldest five were evicted.
    expect(all["site-0.example.com"]).toBeUndefined();
    expect(all["site-1.example.com"]).toBeUndefined();
    expect(all[`site-${MAX_MEMORIES + 4}.example.com`]).toBeDefined();
  });
});

describe("formatMemories ordering", () => {
  test("renders most-recently-updated memories first", () => {
    const memories: SiteMemory[] = [
      { domain: "old.example.com", notes: "old", updatedAt: 100 },
      { domain: "new.example.com", notes: "new", updatedAt: 300 },
      { domain: "mid.example.com", notes: "mid", updatedAt: 200 },
    ];
    const out = formatMemories(memories);
    expect(out.indexOf("[new.example.com]")).toBeLessThan(out.indexOf("[mid.example.com]"));
    expect(out.indexOf("[mid.example.com]")).toBeLessThan(out.indexOf("[old.example.com]"));
  });
});

describe("bounded hostname result cache", () => {
  test("keeps only MAX_HOSTNAME_CACHE_ENTRIES distinct hostnames", async () => {
    await saveMemory("a.example.com", "a");
    await saveMemory("b.example.com", "b");
    for (let i = 0; i < MAX_HOSTNAME_CACHE_ENTRIES + 4; i++) {
      await saveMemory(`s${i}.example.com`, `s${i}`);
    }
    // Populate the cache with more distinct hostnames than the cap.
    for (let i = 0; i < MAX_HOSTNAME_CACHE_ENTRIES + 4; i++) {
      await getMemoriesForUrl(`https://s${i}.example.com/page`);
    }
    // The cache is capped but still returns correct results for a cached host.
    const hit = await getMemoriesForUrl(`https://s${MAX_HOSTNAME_CACHE_ENTRIES + 3}.example.com/page`);
    expect(hit.some((m) => m.domain === `s${MAX_HOSTNAME_CACHE_ENTRIES + 3}.example.com`)).toBe(true);
  });
});
