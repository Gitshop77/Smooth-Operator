/**
 * The navigator prompt-size stats must measure the RENDERED history window
 * (the last NAVIGATOR_HISTORY_LIMIT items), not the full stored array.
 *
 * Regression: the stuck-run transcript showed requestChars growing 2,269 →
 * 57,829 by step 19, but `jsonChars(request.history)` counted ALL stored
 * items (~7 of which were never rendered — the renderer slices to the last
 * 12). The metric misled diagnostics (and anyone reading the log) about the
 * true prompt size.
 */
import { describe, test, expect, vi } from "vitest";
import { callNavigatorWithRetry } from "../src/lib/agent/loop/helpers/llm-calls";
import { NAVIGATOR_HISTORY_LIMIT } from "../src/lib/agent/loop/messages-utils";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { AgentStepRequest, HistoryItem, LogEvent } from "../src/lib/agent/types";
import type { CallbackContext, CallbackDispatcher } from "../src/lib/agent/callbacks";

function historyItem(step: number): HistoryItem {
  return {
    step,
    agent: "navigator",
    evaluation: "e",
    memory: "m",
    goal: "g",
    results: [{ action: { type: "click", index: 1 } as const, success: true, message: `msg-${step}` }],
  };
}

describe("navigator prompt stats — rendered window", () => {
  test("requestChars measures the last NAVIGATOR_HISTORY_LIMIT items, not the full array", async () => {
    const history = Array.from({ length: NAVIGATOR_HISTORY_LIMIT + 3 }, (_, i) => historyItem(i));
    const events: LogEvent[] = [];
    const navigatorCall = vi.fn(async () => ({
      raw: JSON.stringify({
        thinking: "x",
        evaluation_previous_goal: "",
        memory: "",
        next_goal: "",
        action: [{ type: "click", index: 1 }],
      }),
      tokensIn: 10,
      tokensOut: 5,
    }));
    const deps = {
      onEvent: (e: LogEvent) => events.push(e),
      navigatorCall,
    } as unknown as LoopDeps;
    const request: AgentStepRequest = {
      task: "t",
      history,
      browserState: {
        url: "https://example.com",
        title: "Example",
        tabs: [],
        elementsText: "content",
        pageInfo: "",
        newElementCount: 0,
      },
      step: 0,
      maxSteps: 5,
    };
    const dispatcher = {
      llmStart: vi.fn(),
      llmEnd: vi.fn(),
      cost: vi.fn(),
    } as unknown as CallbackDispatcher;

    await callNavigatorWithRetry(
      deps,
      request,
      0,
      vi.fn(),
      dispatcher,
      {} as CallbackContext,
      new AbortController().signal,
      100,
    );

    const start = events.find((e) => e.type === "llm-call-start") as
      | Extract<LogEvent, { type: "llm-call-start" }>
      | undefined;
    expect(start).toBeDefined();
    const stats = start!.prompt;
    // Mirror navigatorPromptStats' field sum exactly, but over the RENDERED
    // window (last NAVIGATOR_HISTORY_LIMIT items) instead of the full array.
    const expected =
      request.task.length +
      JSON.stringify(history.slice(-NAVIGATOR_HISTORY_LIMIT)).length +
      request.browserState.url.length +
      request.browserState.title.length +
      JSON.stringify(request.browserState.tabs).length +
      request.browserState.elementsText.length +
      request.browserState.pageInfo.length;
    expect(stats.requestChars).toBe(expected);
    // The metric must EXCLUDE the oldest 3 items (never rendered).
    expect(stats.requestChars).toBeLessThan(JSON.stringify(history).length);
  });
});