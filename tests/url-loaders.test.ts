/**
 * URL-triggered page loaders (port of stealthy-auto-browse loaders).
 *
 * The engine lives in `src/lib/agent/dom/navigation/url-loaders.ts`:
 * - `parseLoaderRegistry` validates the chrome.storage registry (≥1 match
 *   field REQUIRED — fixes the stealthy catch-all hazard; control nodes are
 *   rejected; entries sorted by source key).
 * - `matchLoader` applies www-stripped domain / path_prefix / regex-substring
 *   semantics with AND composition and first-match-wins ordering.
 * - `expandLoaderSteps` substitutes `${url}` in top-level string values ONLY.
 * - `runMatchedLoaders` runs matched steps via an injected dispatch and
 *   reports failure HONESTLY (diverging from stealthy's success-masking).
 *
 * The recursion guard (`_fromLoader`) is exercised through `executeAction`:
 * an agent-driven navigate fires matched loaders; a loader-originated
 * navigate (4th arg `fromLoader`) does not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LOADER_REGISTRY_KEY,
  expandLoaderSteps,
  matchLoader,
  parseLoaderRegistry,
  readLoaderRegistry,
  runMatchedLoaders,
  type LoaderDef,
} from "../src/lib/agent/dom/navigation/url-loaders";
import { executeAction } from "../src/lib/agent/tools/executor";
import { makeState } from "./helpers";
import { makeChromeStorageMock } from "./helpers/chrome-storage-mock";
import type { ActionResult, AgentAction } from "../src/lib/agent/types";

function loaderDef(overrides: Partial<LoaderDef>): LoaderDef {
  return {
    source: "a.yaml",
    match: { domain: "example.com" },
    steps: [{ type: "get_page_info" } as unknown as AgentAction],
    ...overrides,
  };
}

function okResult(step: AgentAction): ActionResult {
  return { action: step, success: true, message: "ok" };
}

describe("parseLoaderRegistry", () => {
  it("parses block YAML + JSON entries and sorts by source key", () => {
    const { loaders, errors } = parseLoaderRegistry({
      "b.yaml": [
        "name: B",
        "match:",
        "  domain: example.com",
        "steps:",
        "  - type: wait",
        "    seconds: 1",
      ].join("\n"),
      "a.yaml": [
        "match:",
        "  path_prefix: /docs",
        "steps:",
        "  - type: get_page_info",
      ].join("\n"),
      "c.json": JSON.stringify({
        match: { domain: "json.example" },
        steps: [{ type: "get_page_info" }],
      }),
    });

    expect(errors).toEqual([]);
    expect(loaders.map((l) => l.source)).toEqual(["a.yaml", "b.yaml", "c.json"]);
    expect(loaders[0].match.path_prefix).toBe("/docs");
    expect(loaders[1].name).toBe("B");
    expect(loaders[1].match.domain).toBe("example.com");
    expect(loaders[1].steps[0]).toMatchObject({ type: "wait", seconds: 1 });
    expect(loaders[2].match.domain).toBe("json.example");
  });

  it("rejects a loader with NO match block (the stealthy catch-all hazard)", () => {
    const { loaders, errors } = parseLoaderRegistry({
      "bad.yaml": [
        "steps:",
        "  - type: get_page_info",
      ].join("\n"),
    });
    expect(loaders).toEqual([]);
    expect(errors.some((e) => e.includes("bad.yaml") && e.includes("match"))).toBe(true);
  });

  it("rejects a loader whose match block has only unknown keys", () => {
    const { loaders, errors } = parseLoaderRegistry({
      "bad.yaml": [
        "match:",
        "  mystery_field: x",
        "steps:",
        "  - type: get_page_info",
      ].join("\n"),
    });
    expect(loaders).toEqual([]);
    expect(errors.some((e) => e.includes("bad.yaml"))).toBe(true);
  });

  it("rejects an empty match field", () => {
    const { loaders, errors } = parseLoaderRegistry({
      "bad.yaml": [
        "match:",
        "  domain: \"\"",
        "steps:",
        "  - type: get_page_info",
      ].join("\n"),
    });
    expect(loaders).toEqual([]);
    expect(errors.length).toBe(1);
  });

  it("rejects control nodes inside loader steps", () => {
    const { loaders, errors } = parseLoaderRegistry({
      "bad.yaml": [
        "match:",
        "  domain: example.com",
        "steps:",
        "  - if:",
        "      condition:",
        "        url_contains: x",
        "      then:",
        "        - type: get_page_info",
      ].join("\n"),
    });
    expect(loaders).toEqual([]);
    expect(errors.some((e) => e.includes("control"))).toBe(true);
  });

  it("rejects entries that are not mappings / have no steps", () => {
    const { loaders, errors } = parseLoaderRegistry({
      "list.yaml": "- just\n- a list\n",
      "nosteps.yaml": [
        "match:",
        "  domain: example.com",
      ].join("\n"),
    });
    expect(loaders).toEqual([]);
    expect(errors.length).toBe(2);
  });
});

describe("matchLoader", () => {
  it("strips www from the URL side when matching a bare domain", () => {
    const defs = [loaderDef({ source: "a.yaml", match: { domain: "example.com" } })];
    expect(matchLoader(defs, "https://www.example.com/path")).toBe(defs[0]);
  });

  it("strips www from the pattern side when matching a bare URL host", () => {
    const defs = [loaderDef({ source: "a.yaml", match: { domain: "www.example.com" } })];
    expect(matchLoader(defs, "https://example.com/path")).toBe(defs[0]);
  });

  it("matches hostnames case-insensitively", () => {
    const defs = [loaderDef({ source: "a.yaml", match: { domain: "Example.COM" } })];
    expect(matchLoader(defs, "https://example.com/x")).toBe(defs[0]);
  });

  it("does NOT match a suffix host (exact hostname required)", () => {
    const defs = [loaderDef({ source: "a.yaml", match: { domain: "example.com" } })];
    expect(matchLoader(defs, "https://other.example.com/x")).toBeUndefined();
  });

  it("matches path_prefix with startswith semantics", () => {
    const defs = [loaderDef({ source: "a.yaml", match: { path_prefix: "/docs" } })];
    expect(matchLoader(defs, "https://example.com/docs/guide")).toBe(defs[0]);
    expect(matchLoader(defs, "https://example.com/doc")).toBeUndefined();
    expect(matchLoader(defs, "https://example.com/other/docs")).toBeUndefined();
  });

  it("matches regex as a substring search", () => {
    const defs = [loaderDef({ source: "a.yaml", match: { regex: "login" } })];
    expect(matchLoader(defs, "https://example.com/login?next=/")).toBe(defs[0]);
    expect(matchLoader(defs, "https://example.com/home")).toBeUndefined();
  });

  it("ANDs multiple match fields together", () => {
    const defs = [loaderDef({ source: "a.yaml", match: { domain: "example.com", path_prefix: "/docs", regex: "v2" } })];
    expect(matchLoader(defs, "https://example.com/docs/v2/guide")).toBe(defs[0]);
    expect(matchLoader(defs, "https://example.com/other/v2/guide")).toBeUndefined();
    expect(matchLoader(defs, "https://example.com/docs/v1/guide")).toBeUndefined();
    expect(matchLoader(defs, "https://other.com/docs/v2/guide")).toBeUndefined();
  });

  it("returns the first match in the given (sorted) order", () => {
    const first = loaderDef({ source: "a.yaml", match: { domain: "example.com" } });
    const second = loaderDef({ source: "b.yaml", match: { domain: "example.com" } });
    expect(matchLoader([first, second], "https://example.com/")).toBe(first);
  });

  it("returns undefined for an unparseable URL", () => {
    const defs = [loaderDef({ source: "a.yaml", match: { domain: "example.com" } })];
    expect(matchLoader(defs, "not a url")).toBeUndefined();
  });
});

describe("expandLoaderSteps", () => {
  it("substitutes ${url} in top-level string values only", () => {
    const def = loaderDef({
      source: "a.yaml",
      steps: [
        { type: "navigate", url: "${url}/#section" },
        { type: "input", index: 1, text: "visit ${url} now", nested: { deep: "${url}" } },
      ] as unknown as AgentAction[],
    });

    const expanded = expandLoaderSteps(def, "https://example.com/page");
    expect(expanded[0]).toMatchObject({ type: "navigate", url: "https://example.com/page/#section" });
    expect(expanded[1]).toMatchObject({
      type: "input",
      index: 1,
      text: "visit https://example.com/page now",
    });
    // Nested values are exempt.
    expect((expanded[1] as unknown as { nested: { deep: string } }).nested.deep).toBe("${url}");
  });
});

describe("runMatchedLoaders", () => {
  const registry = {
    "a.yaml": [
      "match:",
      "  domain: example.com",
      "steps:",
      "  - type: get_page_info",
    ].join("\n"),
  };

  it("runs matched steps and reports success honestly", async () => {
    const dispatch = vi.fn(async (step: AgentAction) => okResult(step));
    const result = await runMatchedLoaders({
      url: "https://www.example.com/x",
      readRegistry: async () => registry,
      dispatch,
    });

    expect(result.matched).toBe(true);
    expect(result.loader).toBe("a.yaml");
    expect(result.allSuccess).toBe(true);
    expect(result.stepsRun).toBe(1);
    expect(result.message).toContain("ran 1 step(s)");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: "get_page_info" });
  });

  it("does not dispatch when no loader matches", async () => {
    const dispatch = vi.fn(async (step: AgentAction) => okResult(step));
    const result = await runMatchedLoaders({
      url: "https://other.com/x",
      readRegistry: async () => registry,
      dispatch,
    });

    expect(result.matched).toBe(false);
    expect(result.allSuccess).toBe(true);
    expect(result.stepsRun).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reports a failed step HONESTLY (no success:true wrapping)", async () => {
    const dispatch = vi.fn(async (step: AgentAction) => ({
      action: step,
      success: false,
      message: "boom: element not found",
    }));
    const result = await runMatchedLoaders({
      url: "https://example.com/x",
      readRegistry: async () => registry,
      dispatch,
    });

    expect(result.matched).toBe(true);
    expect(result.allSuccess).toBe(false);
    expect(result.message).toContain("boom: element not found");
    expect(result.message).toContain("FAILED");
  });

  it("stops on the first failed step (later steps not dispatched)", async () => {
    const failing = {
      "a.yaml": [
        "match:",
        "  domain: example.com",
        "steps:",
        "  - type: get_page_info",
        "  - type: get_page_info",
        "  - type: get_page_info",
      ].join("\n"),
    };
    let calls = 0;
    const dispatch = vi.fn(async (step: AgentAction) => {
      calls++;
      return calls === 2 ? { action: step, success: false, message: "boom" } : okResult(step);
    });
    const result = await runMatchedLoaders({
      url: "https://example.com/x",
      readRegistry: async () => failing,
      dispatch,
    });

    expect(result.allSuccess).toBe(false);
    expect(result.stepsRun).toBe(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("reports a dispatch throw as a failure", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("dispatch crashed");
    });
    const result = await runMatchedLoaders({
      url: "https://example.com/x",
      readRegistry: async () => registry,
      dispatch,
    });

    expect(result.matched).toBe(true);
    expect(result.allSuccess).toBe(false);
    expect(result.message).toContain("dispatch crashed");
  });
});

describe("readLoaderRegistry", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it("reads the registry from chrome.storage.local", async () => {
    const local = new Map<string, unknown>([
      [LOADER_REGISTRY_KEY, { "a.yaml": "match:\n  domain: example.com\nsteps:\n  - type: get_page_info\n" }],
    ]);
    (globalThis as Record<string, unknown>).chrome = makeChromeStorageMock(local, new Map());

    const entries = await readLoaderRegistry();
    expect(entries).toEqual({ "a.yaml": expect.stringContaining("example.com") });
  });

  it("returns {} without a chrome context and ignores non-string entries", async () => {
    const local = new Map<string, unknown>([
      [LOADER_REGISTRY_KEY, { "a.yaml": 123, "b.yaml": "match:\n  domain: x\nsteps:\n  - type: get_page_info\n" }],
    ]);
    (globalThis as Record<string, unknown>).chrome = makeChromeStorageMock(local, new Map());

    const withChrome = await readLoaderRegistry();
    expect(Object.keys(withChrome)).toEqual(["b.yaml"]);

    delete (globalThis as Record<string, unknown>).chrome;
    const withoutChrome = await readLoaderRegistry();
    expect(withoutChrome).toEqual({});
  });
});

describe("executeAction recursion guard", () => {
  const registry = {
    "a.yaml": [
      "match:",
      "  domain: open-cowork.test",
      "  regex: '#matched'",
      "steps:",
      "  - type: get_page_info",
    ].join("\n"),
  };

  beforeEach(() => {
    const local = new Map<string, unknown>([[LOADER_REGISTRY_KEY, registry]]);
    (globalThis as Record<string, unknown>).chrome = makeChromeStorageMock(local, new Map());
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it("agent-driven navigate runs matched loader steps", async () => {
    const res = await executeAction(
      { type: "navigate", url: "https://open-cowork.test/#matched", new_tab: false },
      makeState(),
    );

    expect(res.success).toBe(true);
    expect(res.message).toContain("[loader 'a.yaml': ran 1 step(s)]");
  });

  it("loader-originated navigate (_fromLoader) does NOT re-trigger loaders", async () => {
    const res = await executeAction(
      { type: "navigate", url: "https://open-cowork.test/#matched", new_tab: false },
      makeState(),
      undefined,
      true,
    );

    expect(res.success).toBe(true);
    expect(res.message).not.toContain("[loader");
  });

  it("no loader matches → message stays clean", async () => {
    const res = await executeAction(
      { type: "navigate", url: "https://open-cowork.test/#other", new_tab: false },
      makeState(),
    );

    expect(res.success).toBe(true);
    expect(res.message).not.toContain("[loader");
  });
});
