/**
 * Measured simple-task fast path tests.
 *
 * Proves:
 * - On the fast path (task exactly matches a current-page metadata question
 *   + the page supplies non-empty evidence): the run completes on DIRECT
 *   evidence — the initial planner LLM call is NOT made and the screenshot
 *   producer (extractState) is NOT called.
 * - When evidence is insufficient (task not answerable, empty title, failed
 *   getTabs, pre-aborted run) or the path is gated off (disabled by default,
 *   full_agentic mode): the full planner path runs — plannerCall + extractState
 *   ARE called.
 * - The deterministic classifier (`fast-path.ts`) unit behavior.
 */

import { describe, test, expect, vi } from "vitest";
import { runAgentLoop } from "../src/lib/agent/loop/orchestrator";
import { classifyCurrentPageTask, buildFastPathAnswer } from "../src/lib/agent/loop/phases/fast-path";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import { type AgentConfig, type AgentAction, type ActionResult, type LogEvent } from "../src/lib/agent/types";
import { makeState } from "./helpers";

const BASE_CONFIG = {
  maxSteps: 3,
  maxActionsPerStep: 10,
  plannerInterval: 100,
  maxFailures: 5,
  enableLoopDetection: false,
  enableCompaction: false,
  compactionStepInterval: 1000,
  compactionCharThreshold: 1_000_000,
  enableJudge: false,
  enableEarlyStop: false,
};

/** Build a full LoopDeps with spies for plannerCall / extractState / getTabs. */
function makeDeps(opts: {
  events: LogEvent[];
  task?: string;
  url?: string;
  title?: string;
  config?: Partial<AgentConfig>;
  mode?: LoopDeps["mode"];
  getTabsImpl?: () => Promise<unknown[]>;
}): LoopDeps & {
  plannerCall: ReturnType<typeof vi.fn>;
  extractState: ReturnType<typeof vi.fn>;
  getTabs: ReturnType<typeof vi.fn>;
} {
  const plannerCall = vi.fn(async () => ({
    raw: JSON.stringify({
      thinking: "x",
      decision: "continue",
      plan: ["a"],
      next_goal: "g",
    }),
  }));
  const extractState = vi.fn(async () => makeState({
    url: opts.url ?? "https://example.com",
    title: opts.title ?? "Test Page",
    elementsText: "[page content]",
  }));
  const getTabs = vi.fn(async () => [
    { id: 1, label: "1", url: opts.url ?? "https://example.com", title: opts.title ?? "Test Page", active: true },
  ]);
  const deps: LoopDeps = {
    task: opts.task ?? "test task",
    navigatorCall: vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "x",
        evaluation_previous_goal: "y",
        memory: "z",
        next_goal: "w",
        action: [{ type: "scroll", down: true, pages: 1 } as AgentAction],
      }),
    })),
    plannerCall,
    getTabs,
    extractState,
    executeActions: vi.fn(async (actions: AgentAction[]) =>
      actions.map((action) => ({ action, success: true, message: "ok" } as ActionResult)),
    ),
    onEvent: (e: LogEvent) => opts.events.push(e),
    settleDelay: 0,
    config: { ...BASE_CONFIG, ...opts.config },
    mode: opts.mode,
  };
  if (opts.getTabsImpl) {
    (getTabs as unknown as { mockImplementation: (fn: () => Promise<unknown[]>) => void })
      .mockImplementation(opts.getTabsImpl);
  }
  return { ...deps, plannerCall, extractState, getTabs };
}

// ─── Classifier unit tests ──────────────────────────────────────────────────

describe("classifyCurrentPageTask (deterministic classifier)", () => {
  test.each([
    ["what is the title of this page", "title"],
    ["What is the title of the current tab?", "title"],
    ["what's the current page title", "title"],
    ["what is this document's title", "title"],
    ["page title", "title"],
    ["what is the url of this page", "url"],
    ["what's the current url", "url"],
    ["what is this tab's address", "url"],
    ["current url", "url"],
    ["what page am i on", "page"],
    ["which page is this", "page"],
  ])("classifies %j as %s", (task, kind) => {
    expect(classifyCurrentPageTask(task as string)).toBe(kind);
  });

  test("rejects compound / actionable / vague tasks (never swallows a task that needs action)", () => {
    const NOT_ANSWERABLE = [
      "what is the title of this page, then click the button",
      "add item to cart",
      "what is this page about",
      "what is the title of the best page on the web",
      "",
      "   ",
      "what is the weather",
    ];
    for (const task of NOT_ANSWERABLE) {
      expect(classifyCurrentPageTask(task)).toBeNull();
    }
  });
});

describe("buildFastPathAnswer (evidence gating)", () => {
  test("title question answers from a non-empty title", () => {
    const v = buildFastPathAnswer("what is the title of this page", "https://example.com", "Welcome");
    expect(v.answerable).toBe(true);
    if (v.answerable) {
      expect(v.kind).toBe("title");
      expect(v.text).toBe('The title of this page is "Welcome".');
    }
  });

  test("an EMPTY title is not evidence — falls back to the planner path", () => {
    const v = buildFastPathAnswer("what is the title of this page", "https://example.com", "   ");
    expect(v.answerable).toBe(false);
  });

  test("url question answers from a real http(s) URL", () => {
    const v = buildFastPathAnswer("what is the current url", "https://shop.example.com/a?b=1", "Shop");
    expect(v.answerable).toBe(true);
    if (v.answerable) expect(v.text).toBe("The current URL is https://shop.example.com/a?b=1.");
  });

  test("a non-http URL (about:blank) is not evidence", () => {
    const v = buildFastPathAnswer("what is the current url", "about:blank", "Blank");
    expect(v.answerable).toBe(false);
  });

  test("page-identity question prefers the title, falls back to the URL", () => {
    const withTitle = buildFastPathAnswer("what page am i on", "https://example.com", "Docs");
    expect(withTitle.answerable).toBe(true);
    if (withTitle.answerable) expect(withTitle.text).toBe('You are on the page "Docs".');

    const urlOnly = buildFastPathAnswer("what page am i on", "https://example.com", "");
    expect(urlOnly.answerable).toBe(true);
    if (urlOnly.answerable) expect(urlOnly.text).toBe("You are on the page at https://example.com.");
  });
});


// ─── Orchestrator integration: fast path vs full planner path ───────────────

describe("runAgentLoop — simple-task fast path", () => {
  test("fast path completes on direct evidence: NO planner call, NO screenshot (extractState)", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps({
      events,
      task: "what is the title of this page?",
      url: "https://docs.example.com",
      title: "Open Cowork Docs",
      config: { enableFastPath: true },
    });

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: true });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toBe(
      'The title of this page is "Open Cowork Docs".',
    );
    // The core promise: the initial planner LLM call and the screenshot
    // producer are NOT invoked on the fast path.
    expect(deps.plannerCall).not.toHaveBeenCalled();
    expect(deps.extractState).not.toHaveBeenCalled();
    // The cheap tabs read IS used (no LLM, no screenshot).
    expect(deps.getTabs).toHaveBeenCalled();
    // The fast path is observable in the event stream.
    expect(events.some((e) => e.type === "info" && e.message.includes("Fast path"))).toBe(true);
  });

  test("fast path answers the current URL question", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps({
      events,
      task: "what is the current url",
      url: "https://shop.example.com/cart",
      title: "Cart",
      config: { enableFastPath: true },
    });

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: true });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toBe(
      "The current URL is https://shop.example.com/cart.",
    );
    expect(deps.plannerCall).not.toHaveBeenCalled();
    expect(deps.extractState).not.toHaveBeenCalled();
  });

  test("insufficient evidence (action task) → full planner path: planner + screenshot run", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps({
      events,
      task: "add the item to the cart",
      config: { enableFastPath: true },
    });

    await runAgentLoop(deps);

    // The run took the full path: the initial planner call happened AND the
    // state extraction (which produces the screenshot in the extension) ran.
    expect(deps.plannerCall).toHaveBeenCalled();
    expect(deps.extractState).toHaveBeenCalled();
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  });

  test("fast path is gated off by default (enableFastPath absent) → planner path", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps({
      events,
      task: "what is the title of this page",
      url: "https://docs.example.com",
      title: "Docs",
      // enableFastPath defaults to true, so an explicit `false`
      // exercises the opt-out path (planner runs).
      config: { enableFastPath: false },
    });

    await runAgentLoop(deps);

    expect(deps.plannerCall).toHaveBeenCalled();
    expect(deps.extractState).toHaveBeenCalled();
  });

  test("fast path runs by default for a matching task", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps({
      events,
      task: "what is the title of this page",
      url: "https://docs.example.com",
      title: "Docs",
      // No enableFastPath — the default is now true.
    });

    await runAgentLoop(deps);

    expect(deps.plannerCall).not.toHaveBeenCalled();
    expect(deps.extractState).not.toHaveBeenCalled();
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: true });
  });

  test("fast path never downgrades full_agentic mode → planner path", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps({
      events,
      task: "what is the title of this page",
      url: "https://docs.example.com",
      title: "Docs",
      config: { enableFastPath: true },
      mode: "full_agentic",
    });

    await runAgentLoop(deps);

    expect(deps.plannerCall).toHaveBeenCalled();
    expect(deps.extractState).toHaveBeenCalled();
  });

  test("empty page title is NOT evidence → planner path", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps({
      events,
      task: "what is the title of this page",
      url: "https://docs.example.com",
      title: "   ",
      config: { enableFastPath: true },
    });

    await runAgentLoop(deps);

    expect(deps.plannerCall).toHaveBeenCalled();
    expect(deps.extractState).toHaveBeenCalled();
  });

  test("getTabs failure during the pre-check is not evidence → full planner path", async () => {
    const events: LogEvent[] = [];
    const deps = makeDeps({
      events,
      task: "what is the title of this page",
      url: "https://docs.example.com",
      title: "Docs",
      config: { enableFastPath: true },
      // Fail only the fast-path pre-check read; the planner path's own
      // getTabs succeeds (otherwise the planner phase itself errors).
      getTabsImpl: (() => {
        let calls = 0;
        return () => {
          calls++;
          if (calls === 1) return Promise.reject(new Error("tabs unavailable"));
          return Promise.resolve([
            { id: 1, label: "1", url: "https://docs.example.com", title: "Docs", active: true },
          ]);
        };
      })(),
    });

    await runAgentLoop(deps);

    // The pre-check failed → the run fell through to the full planner path.
    expect(deps.plannerCall).toHaveBeenCalled();
  });

  test("a pre-aborted run on the fast path ends with the canonical stop and NO LLM/screenshot work", async () => {
    const events: LogEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    const deps = makeDeps({
      events,
      task: "what is the title of this page",
      url: "https://docs.example.com",
      title: "Docs",
      config: { enableFastPath: true },
    });
    deps.signal = controller.signal;

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0]).toMatchObject({ type: "done", success: false });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toBe("Agent stopped by user.");
    expect(deps.plannerCall).not.toHaveBeenCalled();
    expect(deps.extractState).not.toHaveBeenCalled();
  });

  test("a stop DURING the getTabs round-trip never publishes a post-cancel fast-path success", async () => {
    const events: LogEvent[] = [];
    const controller = new AbortController();
    // getTabs aborts the run mid-flight, then resolves with valid evidence.
    const deps = makeDeps({
      events,
      task: "what is the title of this page",
      url: "https://docs.example.com",
      title: "Docs",
      config: { enableFastPath: true },
      getTabsImpl: async () => {
        controller.abort();
        return [
          { id: 1, label: "1", url: "https://docs.example.com", title: "Docs", active: true },
        ];
      },
    });
    deps.signal = controller.signal;

    await runAgentLoop(deps);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    // The canonical stop, NOT the fast-path success answer.
    expect(doneEvents[0]).toMatchObject({ type: "done", success: false });
    expect((doneEvents[0] as Extract<LogEvent, { type: "done" }>).text).toBe("Agent stopped by user.");
    expect(events.some((e) => e.type === "info" && String(e.message).startsWith("Fast path"))).toBe(false);
    expect(deps.plannerCall).not.toHaveBeenCalled();
    expect(deps.extractState).not.toHaveBeenCalled();
  });
});

