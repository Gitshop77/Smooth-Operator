/**
 * P3 — search macros (14 site templates).
 *
 * Mirrors camofox's macros.test.js behavior pins, with every macro encoding
 * the query via `encodeURIComponent` uniformly (no wikipedia exception).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/agent/tools/helpers/domain-config", () => ({
  checkUrlAllowedWithDomainConfig: vi.fn(),
}));

import {
  expandSearchMacro,
  getSupportedSearchMacros,
  tryExpandSearchMacro,
} from "../src/lib/agent/tools/constants";
import { handleTabAction } from "../src/extension/background/tab-manager";
import { checkUrlAllowedWithDomainConfig } from "@/lib/agent/tools/helpers/domain-config";
import type { RunState } from "../src/extension/background/state-store";
import type { AgentAction } from "../src/lib/agent/types";

describe("SEARCH_MACROS table", () => {
  test("exposes all 14 camofox macros", () => {
    const macros = getSupportedSearchMacros();
    expect(macros).toHaveLength(14);
    expect(macros).toEqual(
      expect.arrayContaining([
        "@google_search",
        "@youtube_search",
        "@amazon_search",
        "@reddit_search",
        "@reddit_subreddit",
        "@wikipedia_search",
        "@twitter_search",
        "@yelp_search",
        "@spotify_search",
        "@netflix_search",
        "@linkedin_search",
        "@instagram_search",
        "@tiktok_search",
        "@twitch_search",
      ]),
    );
  });

  test("getSupportedSearchMacros returns a fresh array each call", () => {
    expect(getSupportedSearchMacros()).not.toBe(getSupportedSearchMacros());
  });
});

describe("expandSearchMacro", () => {
  test("@google_search expands correctly", () => {
    expect(expandSearchMacro("@google_search", "test query"))
      .toBe("https://www.google.com/search?q=test%20query");
  });

  test("@youtube_search expands correctly", () => {
    expect(expandSearchMacro("@youtube_search", "funny cats"))
      .toBe("https://www.youtube.com/results?search_query=funny%20cats");
  });

  test("@amazon_search expands correctly", () => {
    expect(expandSearchMacro("@amazon_search", "laptop stand"))
      .toBe("https://www.amazon.com/s?k=laptop%20stand");
  });

  test("@reddit_search expands correctly (JSON endpoint + limit)", () => {
    expect(expandSearchMacro("@reddit_search", "programming"))
      .toBe("https://www.reddit.com/search.json?q=programming&limit=25");
  });

  test("@reddit_subreddit expands correctly", () => {
    expect(expandSearchMacro("@reddit_subreddit", "programming"))
      .toBe("https://www.reddit.com/r/programming.json?limit=25");
  });

  test("@reddit_subreddit defaults to 'all' when the query is empty", () => {
    expect(expandSearchMacro("@reddit_subreddit", ""))
      .toBe("https://www.reddit.com/r/all.json?limit=25");
    expect(expandSearchMacro("@reddit_subreddit", null))
      .toBe("https://www.reddit.com/r/all.json?limit=25");
  });

  test("@wikipedia_search expands correctly (query is encoded like every other macro)", () => {
    expect(expandSearchMacro("@wikipedia_search", "JavaScript"))
      .toBe("https://en.wikipedia.org/wiki/Special:Search?search=JavaScript");
    expect(expandSearchMacro("@wikipedia_search", "C++ programming"))
      .toBe("https://en.wikipedia.org/wiki/Special:Search?search=C%2B%2B%20programming");
  });

  test("@twitter_search expands correctly", () => {
    expect(expandSearchMacro("@twitter_search", "breaking news"))
      .toBe("https://twitter.com/search?q=breaking%20news");
  });

  test("@yelp_search expands correctly", () => {
    expect(expandSearchMacro("@yelp_search", "italian restaurant"))
      .toBe("https://www.yelp.com/search?find_desc=italian%20restaurant");
  });

  test("@spotify_search expands correctly", () => {
    expect(expandSearchMacro("@spotify_search", "jazz music"))
      .toBe("https://open.spotify.com/search/jazz%20music");
  });

  test("@netflix_search expands correctly", () => {
    expect(expandSearchMacro("@netflix_search", "comedy"))
      .toBe("https://www.netflix.com/search?q=comedy");
  });

  test("@linkedin_search expands correctly", () => {
    expect(expandSearchMacro("@linkedin_search", "software engineer"))
      .toBe("https://www.linkedin.com/search/results/all/?keywords=software%20engineer");
  });

  test("@instagram_search expands correctly", () => {
    expect(expandSearchMacro("@instagram_search", "travel"))
      .toBe("https://www.instagram.com/explore/tags/travel");
  });

  test("@tiktok_search expands correctly", () => {
    expect(expandSearchMacro("@tiktok_search", "dance"))
      .toBe("https://www.tiktok.com/search?q=dance");
  });

  test("@twitch_search expands correctly", () => {
    expect(expandSearchMacro("@twitch_search", "gaming"))
      .toBe("https://www.twitch.tv/search?term=gaming");
  });

  test("special characters are URL encoded", () => {
    expect(expandSearchMacro("@google_search", "hello & world"))
      .toBe("https://www.google.com/search?q=hello%20%26%20world");
    expect(expandSearchMacro("@google_search", "test?param=value"))
      .toBe("https://www.google.com/search?q=test%3Fparam%3Dvalue");
    expect(expandSearchMacro("@google_search", "C++ programming"))
      .toBe("https://www.google.com/search?q=C%2B%2B%20programming");
  });

  test("empty query is handled", () => {
    expect(expandSearchMacro("@google_search", "")).toBe("https://www.google.com/search?q=");
    expect(expandSearchMacro("@google_search", null)).toBe("https://www.google.com/search?q=");
    expect(expandSearchMacro("@google_search", undefined)).toBe("https://www.google.com/search?q=");
  });

  test("unknown macro returns null", () => {
    expect(expandSearchMacro("@unknown_macro", "test")).toBeNull();
    expect(expandSearchMacro("@fake_search", "query")).toBeNull();
    expect(expandSearchMacro("google_search", "no @ prefix")).toBeNull();
  });

  test("unicode characters are encoded", () => {
    expect(expandSearchMacro("@google_search", "日本語"))
      .toBe("https://www.google.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E");
    expect(expandSearchMacro("@google_search", "café"))
      .toBe("https://www.google.com/search?q=caf%C3%A9");
  });
});

describe("tryExpandSearchMacro", () => {
  test("expands a query that starts with a supported macro", () => {
    const match = tryExpandSearchMacro("@google_search hello world");
    expect(match).not.toBeNull();
    expect(match!.name).toBe("@google_search");
    expect(match!.url).toBe("https://www.google.com/search?q=hello%20world");
  });

  test("expands with no query text", () => {
    const match = tryExpandSearchMacro("@google_search");
    expect(match!.url).toBe("https://www.google.com/search?q=");
  });

  test("expands with surrounding whitespace", () => {
    const match = tryExpandSearchMacro("  @reddit_subreddit programming  ");
    expect(match!.url).toBe("https://www.reddit.com/r/programming.json?limit=25");
  });

  test("returns null for plain text, unknown macros, and non-strings", () => {
    expect(tryExpandSearchMacro("hello world")).toBeNull();
    expect(tryExpandSearchMacro("@unknown_macro x")).toBeNull();
    expect(tryExpandSearchMacro("google_search x")).toBeNull();
    expect(tryExpandSearchMacro("")).toBeNull();
    expect(tryExpandSearchMacro(null)).toBeNull();
    expect(tryExpandSearchMacro(undefined)).toBeNull();
  });

  test("does not treat a URL containing an @ as a macro", () => {
    expect(tryExpandSearchMacro("https://example.com/@user")).toBeNull();
  });
});

describe("handleTabAction macro expansion (SW path)", () => {
  let chromeMock: {
    tabs: {
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      sendMessage: ReturnType<typeof vi.fn>;
      onUpdated: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    };
    storage: { session: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } };
  };

  function installChrome(): void {
    chromeMock = {
      tabs: {
        update: vi.fn(async () => ({ id: 1 })),
        create: vi.fn(async () => ({ id: 9 })),
        get: vi.fn(async () => ({ id: 1, status: "complete" })),
        sendMessage: vi.fn(async () => ({ ok: true })),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
      },
    };
    (globalThis as Record<string, unknown>).chrome = chromeMock;
  }

  const runState: RunState = {
    task: "t",
    maxSteps: 10,
    mode: "standard",
    startTabId: 1,
    currentTabId: 1,
    step: 0,
    active: true,
    abortRequested: false,
  };

  beforeEach(() => {
    installChrome();
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ allowed: true }),
    );
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
    vi.clearAllMocks();
  });

  test("search with a macro query navigates to the expanded URL", async () => {
    const res = await handleTabAction(
      { type: "search", query: "@google_search hello world", engine: "duckduckgo" } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect(res.pageChanged).toBe(true);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ url: "https://www.google.com/search?q=hello%20world" }),
    );
  });

  test("search with a plain query still uses the engine path", async () => {
    const res = await handleTabAction(
      { type: "search", query: "plain query", engine: "google" } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ url: "https://www.google.com/search?q=plain%20query" }),
    );
  });

  test("search with an unknown macro falls back to the engine path", async () => {
    const res = await handleTabAction(
      { type: "search", query: "@unknown_macro query", engine: "duckduckgo" } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ url: "https://duckduckgo.com/?q=%40unknown_macro%20query" }),
    );
  });

  test("navigate with a macro URL expands before the scheme check", async () => {
    const res = await handleTabAction(
      { type: "navigate", url: "@wikipedia_search C++", new_tab: false } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ url: "https://en.wikipedia.org/wiki/Special:Search?search=C%2B%2B" }),
    );
  });

  test("navigate with a macro URL and new_tab opens the expanded URL in a new tab", async () => {
    const res = await handleTabAction(
      { type: "navigate", url: "@reddit_subreddit programming", new_tab: true } as never,
      runState,
    );
    expect(res.success).toBe(true);
    expect(chromeMock.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://www.reddit.com/r/programming.json?limit=25" }),
    );
  });

  test("a macro-expanded URL is still subject to the domain gate", async () => {
    (checkUrlAllowedWithDomainConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => ({ allowed: false, reason: "blocked host" }),
    );
    const res = await handleTabAction(
      { type: "search", query: "@google_search hello", engine: "duckduckgo" } as never,
      runState,
    );
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/BLOCKED/);
    expect(chromeMock.tabs.update).not.toHaveBeenCalled();
  });

  test("a macro-expanded URL with a bad scheme is BLOCKED", async () => {
    const res = await handleTabAction(
      { type: "navigate", url: "javascript:@google_search x", new_tab: false } as never,
      runState,
    );
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/unsupported URL scheme/);
  });
});

describe("executor macro expansion (content path)", () => {
  // Use a minimal location stub like executor.test.ts so same-tab navigation
  // via location.href does not trigger jsdom's unimplemented navigation.
  const REAL_LOCATION = globalThis.location;
  const fakeLocation = { href: "https://example.test/" };

  beforeEach(() => {
    Object.defineProperty(globalThis, "location", {
      value: fakeLocation,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "location", {
      value: REAL_LOCATION,
      configurable: true,
      writable: true,
    });
    vi.clearAllMocks();
  });

  test("search with a macro query navigates to the expanded URL", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const { makeState } = await import("./helpers");
    const action = { type: "search", query: "@twitter_search breaking news", engine: "duckduckgo" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(result.pageChanged).toBe(true);
    expect(fakeLocation.href).toBe("https://twitter.com/search?q=breaking%20news");
  });

  test("search with a plain query keeps the engine behavior", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const { makeState } = await import("./helpers");
    const action = { type: "search", query: "plain", engine: "duckduckgo" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(fakeLocation.href).toContain("duckduckgo.com");
  });

  test("navigate with a macro URL expands to the target", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const { makeState } = await import("./helpers");
    const action = { type: "navigate", url: "@amazon_search laptop stand", new_tab: false } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(fakeLocation.href).toBe("https://www.amazon.com/s?k=laptop%20stand");
  });

  test("navigate with a normal URL is unchanged", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const { makeState } = await import("./helpers");
    const action = { type: "navigate", url: "https://example.test/page", new_tab: false } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(fakeLocation.href).toBe("https://example.test/page");
  });

  test("an unknown macro in search keeps the engine behavior", async () => {
    const { executeAction } = await import("../src/lib/agent/tools/executor");
    const { makeState } = await import("./helpers");
    const action = { type: "search", query: "@bogus query", engine: "duckduckgo" } as AgentAction;
    const result = await executeAction(action, makeState());
    expect(result.success).toBe(true);
    expect(fakeLocation.href).toContain("duckduckgo.com");
  });
});
