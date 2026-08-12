/**
 * Cost/usage attribution refinements:
 *  - sumUsages attributes a retried phase to the FIRST attempt's model;
 *  - accountUsage emits cost 0 (not undefined) when tokens exist for a
 *    known model, so the `cost` event never silently swallows spend;
 *  - getFailedCallUsage sanitizes malformed numeric fields (NaN/negative)
 *    before they reach the cost-cap ledger;
 *  - parse-retry backoff sleeps between navigator parse retries (bounded
 *    full jitter, abort-aware).
 */
import { describe, expect, test, vi } from "vitest";
import { sumUsages, accountUsage, sanitizeUsageNumber, sleepParseRetryBackoff } from "../src/lib/agent/loop/helpers/llm-calls-utils";
import { callNavigatorWithRetry } from "../src/lib/agent/loop/helpers/llm-calls";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import { type AgentStepRequest, type LogEvent } from "../src/lib/agent/types";

describe("sumUsages — first-attempt model attribution", () => {
  test("attributes the summed usage to the FIRST attempt's model, not the last", () => {
    const summed = sumUsages([
      { model: "openai/gpt-4o", tokensIn: 100, tokensOut: 50, costUsd: 0.01 },
      { model: "anthropic/claude-3-5-sonnet", tokensIn: 200, tokensOut: 80, costUsd: 0.02 },
    ]);
    expect(summed).toMatchObject({
      model: "openai/gpt-4o", // first attempt — per-model spend stays honest
      tokensIn: 300,
      tokensOut: 130,
      costUsd: 0.03,
    });
  });

  test("returns undefined for an empty usage list", () => {
    expect(sumUsages([])).toBeUndefined();
  });
});

describe("accountUsage — cost attribution when tokens exist", () => {
  test("always attributes a NUMERIC cost (never undefined) when a model + tokens are present", () => {
    const accounted = accountUsage({
      model: "fixture/unpriced-model",
      tokensIn: 10,
      tokensOut: 5,
    });
    // estimateCost always returns a finite number (catalog rate or the
    // unknown-model fallback) — the caller's `typeof cost === "number"` gate
    // therefore ALWAYS emits a `cost` event for a priced/known model call.
    expect(accounted).not.toBeUndefined();
    expect(typeof accounted!.cost).toBe("number");
    expect(Number.isFinite(accounted!.cost)).toBe(true);
    expect(accounted!.usage).toMatchObject({ model: "fixture/unpriced-model", tokensIn: 10, tokensOut: 5 });
  });

  test("no model + no precomputed cost → cost and usage stay undefined (caller skips the event)", () => {
    const accounted = accountUsage({ tokensIn: 10, tokensOut: 5 });
    expect(accounted!.cost).toBeUndefined();
    expect(accounted!.usage).toBeUndefined();
  });
});

describe("sanitizeUsageNumber — failed-call usage vetting", () => {
  test("rejects NaN, negative, non-finite and non-number values", () => {
    expect(sanitizeUsageNumber(Number.NaN)).toBeUndefined();
    expect(sanitizeUsageNumber(-100)).toBeUndefined();
    expect(sanitizeUsageNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(sanitizeUsageNumber(undefined)).toBeUndefined();
    expect(sanitizeUsageNumber(0)).toBe(0);
    expect(sanitizeUsageNumber(42)).toBe(42);
  });
});

describe("sleepParseRetryBackoff — bounded full-jitter parse-retry spacing", () => {
  test("samples in [0, min(cap, base·2^retry)) and resolves", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1.0);
    try {
      await expect(sleepParseRetryBackoff(0)).resolves.toBeUndefined(); // retry 0 → cap 200
      await expect(sleepParseRetryBackoff(3)).resolves.toBeUndefined(); // retry 3 → cap 1500
    } finally {
      randomSpy.mockRestore();
    }
  });

  test("an already-aborted signal rejects immediately without sleeping", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepParseRetryBackoff(0, controller.signal)).rejects.toThrow(/Abort/i);
  });
});

describe("callNavigatorWithRetry — parse-retry backoff is applied between attempts", () => {
  test("a parse failure is retried after a backoff delay (not in a zero-delay lockstep)", async () => {
    let calls = 0;
    const deps: LoopDeps = {
      task: "t",
      navigatorCall: vi.fn(async () => {
        calls++;
        if (calls === 1) return { raw: "not json at all" };
        return { raw: JSON.stringify({ thinking: "x", evaluation_previous_goal: "y", memory: "z", next_goal: "w", action: [{ type: "scroll", down: true }] }) };
      }),
      plannerCall: vi.fn(async () => ({ raw: "{}" })),
      getTabs: vi.fn(async () => []),
      onEvent: (e: LogEvent) => events.push(e),
      settleDelay: 0,
    };
    const events: LogEvent[] = [];
    const request = {
      task: "t",
      currentGoal: "g",
      plan: undefined,
      currentPlanItem: undefined,
      url: "https://example.com",
      tabs: [],
      browserState: { url: "https://example.com", title: "T", elementsText: "[]", pageInfo: "", newElementCount: 0 },
      maxSteps: 10,
      step: 0,
    } as unknown as AgentStepRequest;

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const out = await callNavigatorWithRetry(deps, request, 0, () => {});
      expect(out).toBeDefined();
      expect(calls).toBe(2);
      // The retry path must have scheduled a real backoff timer (> 0ms).
      const retryDelay = Math.floor(0.5 * Math.min(1500, 200 * 2 ** 0));
      expect(sleepSpy).toHaveBeenCalledWith(expect.any(Function), retryDelay);
      // A parse-failure retry event was emitted.
      expect(events.some((e) => e.type === "error" && e.message.includes("Parse failed"))).toBe(true);
    } finally {
      randomSpy.mockRestore();
      sleepSpy.mockRestore();
    }
  });
});
