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
});
