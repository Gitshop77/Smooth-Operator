/**
 * Agent-loop persistent memory coverage.
 *
 * The previously-named `agent-loop-memory.test.ts` only exercised
 * `injectCostBudgetWarning` (a cost-cap warning) and never touched any
 * loop-memory / persistence logic. This file actually covers the agent loop's
 * persistent per-site memory:
 *
 * 1. `persistent-memory.ts` — `saveMemory` (append/replace), `getMemoriesForUrl`
 * (read + subdomain/root-domain match), `formatMemories` (stable output).
 * 2. `loop/messages.ts` — `buildNavigatorUserMessage` loads the site memory via
 * `getMemoriesForUrl` + `formatMemories` and injects a `<site_memory>` block
 * into the navigator prompt. This is the "read/format/append *around the
 * loop*" path the old name implied but never tested.
 *
 * The localStorage stub is required because `persistent-memory.ts` falls back to
 * `localStorage` when `chrome.storage.local` is unavailable (jsdom test env).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  saveMemory,
  deleteMemory,
  getMemoriesForUrl,
  formatMemories,
  __resetMemoryCacheForTests,
  type SiteMemory,
} from "../src/lib/agent/persistent-memory";
import { buildNavigatorUserMessage } from "../src/lib/agent/loop/messages";
import { installLocalStorageStub, restoreLocalStorageStub } from "./helpers";

beforeAll(() => {
  installLocalStorageStub();
});

afterAll(() => {
  restoreLocalStorageStub();
});

beforeEach(() => {
 // Clear storage + in-memory cache so each test starts from a clean slate.
  localStorage.removeItem("__opencowork_site_memories");
  __resetMemoryCacheForTests();
});

// ─── Append / read ──────────────────────────────────────────────────────────

describe("persistent-memory append + read", () => {
  test("saveMemory appends a new entry readable via getMemoriesForUrl", async () => {
    await saveMemory("example.com", "username is alice");
    const memories = await getMemoriesForUrl("https://example.com/login");
    expect(memories).toHaveLength(1);
    expect(memories[0].domain).toBe("example.com");
    expect(memories[0].notes).toBe("username is alice");
  });

  test("saveMemory re-saving the same domain REPLACES (append-merge, not duplicate)", async () => {
    await saveMemory("example.com", "username is alice");
    await saveMemory("example.com", "use the search box first");
    const memories = await getMemoriesForUrl("https://example.com");
    expect(memories).toHaveLength(1); // not 2 — replaced
    expect(memories[0].notes).toBe("use the search box first");
  });

  test("getMemoriesForUrl matches on root-domain suffix (subdomain)", async () => {
    await saveMemory("github.com", "prefer the CLI");
    const memories = await getMemoriesForUrl("https://gist.github.com/foo");
    expect(memories).toHaveLength(1);
    expect(memories[0].domain).toBe("github.com");
  });

  test("getMemoriesForUrl returns [] for a non-matching domain", async () => {
    await saveMemory("example.com", "note");
    expect(await getMemoriesForUrl("https://other.org")).toHaveLength(0);
  });

  test("empty notes deletes the entry (saveMemory append-down to nothing)", async () => {
    await saveMemory("example.com", "temp note");
    expect(await getMemoriesForUrl("https://example.com")).toHaveLength(1);
    await saveMemory("example.com", "");
    expect(await getMemoriesForUrl("https://example.com")).toHaveLength(0);
  });

  test("deleteMemory removes a specific domain's entry", async () => {
    await saveMemory("example.com", "a");
    await saveMemory("other.com", "b");
    await deleteMemory("example.com");
    expect(await getMemoriesForUrl("https://example.com")).toHaveLength(0);
    expect(await getMemoriesForUrl("https://other.com")).toHaveLength(1);
  });
});

// ─── Format stability ────────────────────────────────────────────────────────

describe("formatMemories stable output", () => {
  test("renders the notes in the order provided (stable, no reordering)", () => {
    const memories: SiteMemory[] = [
      { domain: "apple.com", notes: "first", updatedAt: 2 },
      { domain: "zebra.com", notes: "second", updatedAt: 1 },
    ];
 // formatMemories is a pure formatter — it renders exactly in input order,
 // so the output is stable/byte-for-byte reproducible for a given input.
    expect(formatMemories(memories)).toBe(
      "<site_memory>\n[apple.com]: first\n[zebra.com]: second\n</site_memory>",
    );
    expect(formatMemories(memories)).toContain("<site_memory>");
    expect(formatMemories(memories)).toContain("</site_memory>");
  });

  test("returns empty string for no memories (stable, no empty tag)", () => {
    expect(formatMemories([])).toBe("");
  });

  test("output is byte-for-byte stable for identical input", () => {
    const memories: SiteMemory[] = [
      { domain: "example.com", notes: "x", updatedAt: 100 },
    ];
    expect(formatMemories(memories)).toBe(formatMemories(memories));
  });
});

// ─── Loop integration: memory is injected into the navigator prompt ──────────

describe("loop/messages — persistent memory injected into navigator prompt", () => {
 // Local factory: the four tests below each hand `buildNavigatorUserMessage`
 // an identical browser-state shape. Collapse the repeated literal into one
 // helper so the per-test delta (the URL / elements under test) is obvious.
  const makeBrowserState = (url: string, elementsText = "") => ({
    url,
    title: "T",
    tabs: [] as unknown[],
    elementsText,
    pageInfo: "",
    newElementCount: 0,
  });

  test("buildNavigatorUserMessage injects a <site_memory> block for the current domain", async () => {
    await saveMemory("example.com", "username is alice");
    await saveMemory("github.com", "prefer the CLI");

    const msg = await buildNavigatorUserMessage({
      task: "Log in",
      history: [],
      currentGoal: "fill the form",
      plan: undefined,
      currentPlanItem: undefined,
      browserState: makeBrowserState("https://example.com/login", "<button>Submit</button>"),
      step: 0,
      maxSteps: 50,
    });

    expect(msg).toContain("<site_memory>");
    expect(msg).toContain("username is alice");
 // The github.com memory is for a different domain and must NOT leak into
 // the example.com navigator prompt.
    expect(msg).not.toContain("prefer the CLI");
  });

  test("no <site_memory> block when no memory exists for the domain", async () => {
    const msg = await buildNavigatorUserMessage({
      task: "Search",
      history: [],
      currentGoal: "type a query",
      plan: undefined,
      currentPlanItem: undefined,
      browserState: makeBrowserState("https://no-memory-here.com/page", "<input>"),
      step: 0,
      maxSteps: 50,
    });
    expect(msg).not.toContain("<site_memory>");
  });

  test("memory is re-read live (an updated note for the current domain is reflected on the next build)", async () => {
    await saveMemory("example.com", "first note");
    const first = await buildNavigatorUserMessage({
      task: "t",
      history: [],
      currentGoal: "g",
      plan: undefined,
      currentPlanItem: undefined,
      browserState: makeBrowserState("https://example.com"),
      step: 0,
      maxSteps: 10,
    });
    expect(first).toContain("first note");

 // The options page can update the per-site note; the next loop build must
 // re-read storage and surface the NEW value (live read, not a stale cache).
    await saveMemory("example.com", "updated note");
    const second = await buildNavigatorUserMessage({
      task: "t",
      history: [],
      currentGoal: "g",
      plan: undefined,
      currentPlanItem: undefined,
      browserState: makeBrowserState("https://example.com"),
      step: 1,
      maxSteps: 10,
    });
    expect(second).toContain("updated note");
    expect(second).not.toContain("first note");
  });
});
