import { describe, expect, test, vi } from "vitest";
import {
  callNavigatorWithRetry,
  runPlanner,
} from "../src/lib/agent/loop/helpers/llm-calls";
import type { LoopDeps } from "../src/lib/agent/loop/types";

function unusableOutputError() {
  return Object.assign(new Error("The model used its response for reasoning but returned no visible answer."), {
    code: "REASONING_ONLY_OUTPUT",
    usage: {
      raw: "",
      tokensIn: 100,
      tokensOut: 50,
      reasoningTokens: 50,
      model: "reasoner",
      costUsd: 0.01,
    },
  });
}

describe("usage accounting for unusable model completions", () => {
  test("navigator accounts usage once and does not enter parse retry", async () => {
    const onEvent = vi.fn();
    const navigatorCall = vi.fn(async () => { throw unusableOutputError(); });
    const deps = { navigatorCall, onEvent } as unknown as LoopDeps;
    const onCost = vi.fn();

    await expect(callNavigatorWithRetry(
      deps,
      {
        task: "hey",
        history: [],
        browserState: {
          url: "https://example.com",
          title: "Example",
          tabs: [],
          elementsText: "",
          pageInfo: "",
          newElementCount: 0,
        },
        step: 0,
        maxSteps: 3,
      },
      0,
      onCost,
    )).rejects.toMatchObject({ code: "REASONING_ONLY_OUTPUT" });

    expect(navigatorCall).toHaveBeenCalledTimes(1);
    expect(onCost).toHaveBeenCalledWith(0.01, 100, 50);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "cost",
      tokensIn: 100,
      tokensOut: 50,
      reasoningTokens: 50,
    }));
    const lifecycle = onEvent.mock.calls.map(([event]) => event.type);
    expect(lifecycle).toContain("llm-call-start");
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "llm-call-end",
      role: "navigator",
      status: "error",
      tokensIn: 100,
      reasoningTokens: 50,
    }));
  });

  test("planner accounts usage on the same typed terminal path", async () => {
    const onEvent = vi.fn();
    const plannerCall = vi.fn(async () => { throw unusableOutputError(); });
    const deps = { plannerCall, onEvent } as unknown as LoopDeps;
    const onCost = vi.fn();

    await expect(runPlanner(deps, {
      task: "hey",
      navigatorHistory: [],
      plan: [],
      currentPlanItem: 0,
      url: "https://example.com",
      tabs: [],
      step: 0,
      maxSteps: 3,
      onCost,
    })).rejects.toMatchObject({ code: "REASONING_ONLY_OUTPUT" });

    expect(plannerCall).toHaveBeenCalledTimes(1);
    expect(onCost).toHaveBeenCalledWith(0.01, 100, 50);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "llm-call-start",
      role: "planner",
      prompt: expect.objectContaining({ historyItems: 0 }),
    }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "llm-call-end",
      role: "planner",
      status: "error",
      reasoningTokens: 50,
    }));
  });

  test("a no-usage provider error after a used parse-fail attempt reports undefined tokens", async () => {
    const onEvent = vi.fn();
    const onCost = vi.fn();
    let call = 0;
    const navigatorCall = vi.fn(async () => {
      call++;
      if (call === 1) return { raw: "not valid agent output json", tokensIn: 10, tokensOut: 5, model: "m" };
      throw new Error("network down");
    });
    const deps = { navigatorCall, onEvent } as unknown as LoopDeps;
    // Zero the full-jitter backoff so the retry cycle runs in ~0ms.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await expect(callNavigatorWithRetry(
        deps,
        {
          task: "hey",
          history: [],
          browserState: {
            url: "https://example.com",
            title: "Example",
            tabs: [],
            elementsText: "",
            pageInfo: "",
            newElementCount: 0,
          },
          step: 0,
          maxSteps: 3,
        },
        0,
        onCost,
      )).rejects.toThrow("network down");

      // Attempt 1's usage was already reported by its own success event; the
      // attempt-2 error event must NOT re-report attempt 1's tokens.
      const errorEnd = onEvent.mock.calls
        .map(([e]) => e as {
          type: string;
          status?: string;
          attempt?: number;
          tokensIn?: number;
          tokensOut?: number;
          reasoningTokens?: number;
        })
        .find((e) => e.type === "llm-call-end" && e.status === "error" && e.attempt === 2);
      expect(errorEnd).toBeDefined();
      const errEnd = errorEnd!;
      expect(errEnd.tokensIn).toBeUndefined();
      expect(errEnd.tokensOut).toBeUndefined();
      expect(errEnd.reasoningTokens).toBeUndefined();
      // The cost ledger is untouched by the no-usage attempt: only attempt 1
      // accrued cost (via estimateCost on its 10/5 tokens).
      expect(onCost).toHaveBeenCalledTimes(1);
      expect(onCost).toHaveBeenCalledWith(expect.any(Number), 10, 5);
    } finally {
      randomSpy.mockRestore();
    }
  });
});
