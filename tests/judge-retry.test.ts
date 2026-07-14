/**
 * Judge module tests — prompt construction + response parsing.
 * Retry module tests — backoff, max-attempt cutoff, non-retryable errors.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { judgeTask, JUDGE_PROMPT } from "../src/lib/agent/judge";
import { withLLMRetry } from "../src/lib/agent/llm/retry";
import { maybeJudgeAndFinalize } from "../src/lib/agent/loop/helpers/judges";
import { CallbackDispatcher, type AsyncCallbackHandler, type CallbackContext, type LLMUsageInfo } from "../src/lib/agent/callbacks";
import { LoopDetector } from "../src/lib/agent/loop/loop-detector";
import { estimateCost, refreshPricingFromCatalog } from "../src/lib/agent/llm/pricing";
import { DEFAULT_CONFIG } from "../src/lib/agent/types";
import type { LoopDeps, LoopState } from "../src/lib/agent/loop/types";
import type { AgentConfig } from "../src/lib/agent/types";
import { makeHistoryItem } from "./helpers";

// ─── Judge tests ────────────────────────────────────────────────────────────

describe("judgeTask", () => {
  test("JUDGE_PROMPT instructs the judge to evaluate evidence, not claims", () => {
    expect(JUDGE_PROMPT).toContain("INDEPENDENTLY");
    expect(JUDGE_PROMPT).toContain("evidence");
    expect(JUDGE_PROMPT).toContain("verdict");
    expect(JUDGE_PROMPT).toContain("impossibleTask");
    expect(JUDGE_PROMPT).toContain("reachedCaptcha");
  });

  test("returns verdict=true when the judge agrees with success", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        reasoning: "The action history shows a submit click followed by a success message.",
        verdict: true,
        failureReason: null,
        impossibleTask: false,
        reachedCaptcha: false,
      })
    );
    const result = await judgeTask({
      task: "Submit the form",
      history: [makeHistoryItem(0)],
      agentResult: { success: true, text: "Form submitted successfully." },
      llmCall: mockLlmCall,
    });
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe(true);
    expect(result!.failureReason).toBeNull();
    expect(mockLlmCall).toHaveBeenCalledTimes(1);
  });

  test("returns verdict=false when the judge disagrees", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        reasoning: "No submit action was taken despite the agent claiming success.",
        verdict: false,
        failureReason: "No submit button click found in history.",
        impossibleTask: false,
        reachedCaptcha: false,
      })
    );
    const result = await judgeTask({
      task: "Submit the form",
      history: [makeHistoryItem(0)],
      agentResult: { success: true, text: "Form submitted." },
      llmCall: mockLlmCall,
    });
    expect(result!.verdict).toBe(false);
    expect(result!.failureReason).toBe("No submit button click found in history.");
  });

  test("returns null when the LLM returns non-JSON", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue("This is not JSON.");
    const result = await judgeTask({
      task: "Submit the form",
      history: [],
      agentResult: { success: true, text: "Done." },
      llmCall: mockLlmCall,
    });
    expect(result).toBeNull();
  });

  test("returns null when the LLM call throws", async () => {
    const mockLlmCall = vi.fn().mockRejectedValue(new Error("LLM unavailable"));
    const result = await judgeTask({
      task: "Submit the form",
      history: [],
      agentResult: { success: true, text: "Done." },
      llmCall: mockLlmCall,
    });
    expect(result).toBeNull();
  });

  test("coerces lenient boolean values (string 'true', number 1)", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        reasoning: "x",
        verdict: 1, // number instead of boolean
        failureReason: null,
        impossibleTask: "true", // string instead of boolean
        reachedCaptcha: false,
      })
    );
    const result = await judgeTask({
      task: "x",
      history: [],
      agentResult: { success: true, text: "x" },
      llmCall: mockLlmCall,
    });
    expect(result!.verdict).toBe(true);
    expect(result!.impossibleTask).toBe(true);
  });

  test("wraps extracted content in untrusted tags in the history", async () => {
    const mockLlmCall = vi.fn().mockResolvedValue(
      JSON.stringify({ reasoning: "x", verdict: true, failureReason: null, impossibleTask: false, reachedCaptcha: false })
    );
    await judgeTask({
      task: "x",
      history: [{
        step: 0,
        agent: "navigator",
        evaluation: "",
        memory: "",
        goal: "",
        results: [{
          action: { type: "extract" } as never,
          success: true,
          message: "Extracted",
          extractedContent: "sensitive data from page",
        }],
      }],
      agentResult: { success: true, text: "x" },
      llmCall: mockLlmCall,
    });
    const userMessage = mockLlmCall.mock.calls[0][1] as string;
    expect(userMessage).toContain("<untrusted_page_data>");
    expect(userMessage).toContain("sensitive data from page");
  });
});

// ─── Retry tests ────────────────────────────────────────────────────────────

describe("withLLMRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns the result on the first successful call", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withLLMRetry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on 429 (rate limit)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 429: Too many requests"))
      .mockResolvedValueOnce("success");
    const promise = withLLMRetry(fn);
 // Advance past the backoff delay (1.5s base + jitter for first retry).
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("retries on 5xx (server error)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 500: Internal server error"))
      .mockResolvedValueOnce("success");
    const promise = withLLMRetry(fn);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("retries on network error (fetch failed)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce("success");
    const promise = withLLMRetry(fn);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("does NOT retry on 400 (bad request) — non-retryable 4xx", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 400: Bad request"));
    await expect(withLLMRetry(fn)).rejects.toThrow("400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("does NOT retry on 401 (auth error) — non-retryable 4xx", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 401: Unauthorized"));
    await expect(withLLMRetry(fn)).rejects.toThrow("401");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("does NOT retry on abort (user cancel)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("The operation was aborted"));
    await expect(withLLMRetry(fn)).rejects.toThrow("abort");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("gives up after MAX_RETRIES (3) + 1 initial = 4 attempts on persistent 429", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 429: Too many requests"));
    const promise = withLLMRetry(fn);
 // Advance through all backoff delays: 1.5s, 3s, 6s = 10.5s total.
 // Catch the rejection to prevent an unhandled-rejection error while the
 // timers are advancing (the awaited `expect(...).rejects` handler below
 // attaches only after this resolves).
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(12000);
    await expect(promise).rejects.toThrow("429");
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  test("honors an already-aborted signal (does not attempt)", async () => {
    const fn = vi.fn().mockResolvedValue("should not reach");
    const controller = new AbortController();
    controller.abort();
    await expect(withLLMRetry(fn, controller.signal)).rejects.toThrow("aborted");
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── judgeCachedInputTokens capture ─────────────────────────────────────
//
// The judge LLM call wrapper (`judgeLlmCall` in judges.ts) captures
// `cachedInputTokens` from `deps.plannerCall`'s response as a side effect,
// then `maybeJudgeAndFinalize`'s onCost callback recomputes the cost with
// `estimateCost(judgeModel, tokensIn, tokensOut, judgeReasoningTokens, judgeCachedInputTokens)`.
//
// `cachedInputTokens` is captured from the plannerCall response so cached
// judge calls are billed at the cacheRead rate (with the discount) instead
// of the full input rate.
//
// These tests verify:
// 1. `cachedInputTokens` flows from `plannerCall` → `dispatcher.cost` usage.
// 2. The recomputed `costUsd` reflects the cacheRead discount (differs from
// the no-cache cost).
// 3. The user's `onCost` callback receives the recomputed cost.

describe("maybeJudgeAndFinalize — judgeCachedInputTokens capture", () => {
  /** Build a minimal LoopState for maybeJudgeAndFinalize. */
  function makeLoopState(deps: LoopDeps, dispatcher?: CallbackDispatcher): LoopState {
    const config: AgentConfig = { ...DEFAULT_CONFIG, enableJudge: true };
    return {
      deps,
      config,
      task: "test task",
      onEvent: () => {},
      settleDelay: 0,
      navigatorHistory: [],
      loopDetector: new LoopDetector(),
      plan: undefined,
      currentPlanItem: undefined,
      step: 0,
      navigatorStepsSincePlanner: 0,
      consecutiveFailures: 0,
      consecutiveParseFailures: 0,
      totalCostUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      lastCompactionStep: undefined,
      compactedMemory: undefined,
      pendingLoopWarning: undefined,
      budgetWarningFired: false,
      costBudgetWarningFired: false,
      currentGoal: "test",
      dispatcher,
    };
  }

  /** Build the deps + dispatcher + capturedCosts + state + ctx for a judge run. */
  function buildJudgeHarness(plannerCall: ReturnType<typeof vi.fn>): {
    deps: LoopDeps;
    dispatcher: CallbackDispatcher;
    capturedCosts: LLMUsageInfo[];
    state: LoopState;
    ctx: CallbackContext;
  } {
    const deps: LoopDeps = {
      task: "test",
      navigatorCall: vi.fn(async () => ({ raw: "" })),
      plannerCall: plannerCall as unknown as LoopDeps["plannerCall"],
      getTabs: vi.fn(async () => []),
      onEvent: () => {},
    };
    const capturedCosts: LLMUsageInfo[] = [];
    const handler: AsyncCallbackHandler = {
      onCost: async (_ctx, usage) => { capturedCosts.push(usage); },
    };
    const dispatcher = new CallbackDispatcher();
    dispatcher.register(handler);
    const state = makeLoopState(deps, dispatcher);
    const ctx: CallbackContext = { task: "test", step: 0, history: [] };
    return { deps, dispatcher, capturedCosts, state, ctx };
  }

  test("cachedInputTokens flows from plannerCall → dispatcher.cost usage", async () => {
 // Mock plannerCall to return a verdict-true judge response WITH
 // cachedInputTokens: 200. The judge wrapper captures this value into
 // `judgeCachedInputTokens`, which then appears in the dispatcher.cost
 // usage object.
    const judgeJson = JSON.stringify({
      reasoning: "x",
      verdict: true,
      failureReason: null,
      impossibleTask: false,
      reachedCaptcha: false,
    });
    const plannerCall = vi.fn(async () => ({
      raw: judgeJson,
      tokensIn: 1000,
      tokensOut: 10,
      cachedInputTokens: 200,
      model: "claude-3-5-sonnet-20241022",
    }));
    const { deps, dispatcher, capturedCosts, state, ctx } = buildJudgeHarness(plannerCall);
    const userOnCostCalls: Array<{ usd: number; tokensIn: number; tokensOut: number }> = [];
    const userOnCost = (usd: number, tokensIn?: number, tokensOut?: number) => {
      userOnCostCalls.push({ usd, tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 });
    };

    const finalized = await maybeJudgeAndFinalize(
      deps,
      state.config,
      {
        step: 0,
        success: true,
        text: "done",
        navigatorHistory: [],
        onCost: userOnCost,
      },
      state,
      dispatcher,
      ctx,
    );

 // The judge agreed → run is finalized.
    expect(finalized).toBe(true);
 // plannerCall was called once (judge LLM call routes through plannerCall
 // when summarizeCall is not set).
    expect(plannerCall).toHaveBeenCalledTimes(1);
 // dispatcher.cost fired exactly once with the captured cachedInputTokens.
    expect(capturedCosts).toHaveLength(1);
    expect(capturedCosts[0].cachedInputTokens).toBe(200);
 // The model name is captured too (used for the cost recompute).
    expect(capturedCosts[0].model).toBe("claude-3-5-sonnet-20241022");
  });

  test("cost recompute uses cachedInputTokens (cacheRead discount applied)", async () => {
 // Pricing is now catalog-driven (no static table). Stub a catalog so
 // claude-3-5-sonnet has a real cacheRead rate (0.3 vs in=3); otherwise the
 // model falls back to the conservative default (no cacheRead discount) and
 // the with/without-cache costs would be identical.
    const ORIG_URL = process.env.COWORK_MODEL_CATALOG_URL;
    process.env.COWORK_MODEL_CATALOG_URL = "https://fake.test/judge-catalog.json";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          anthropic: {
            id: "anthropic",
            name: "Anthropic",
            models: {
              "claude-3-5-sonnet-20241022": {
                id: "claude-3-5-sonnet-20241022",
                name: "Claude 3.5 Sonnet",
                release_date: "2024-10-22",
                attachment: true,
                reasoning: false,
                temperature: true,
                tool_call: true,
                cost: { input: 3, output: 15, cache_read: 0.3 },
              },
            },
          },
        }),
      })),
    );
    await refreshPricingFromCatalog();
    try {
 // The onCost callback in judges.ts recomputes the cost via:
 // estimateCost(judgeModel, tokensIn, tokensOut, judgeReasoningTokens, judgeCachedInputTokens)
 // With cachedInputTokens=200 on claude-3-5-sonnet (cacheRead=0.3 vs in=3),
 // the cost should be LOWER than the no-cache cost. Verify the captured
 // costUsd matches the with-cache estimate AND differs from the without-cache.
    const judgeJson = JSON.stringify({
      reasoning: "x", verdict: true, failureReason: null,
      impossibleTask: false, reachedCaptcha: false,
    });
    const plannerCall = vi.fn(async () => ({
      raw: judgeJson,
      tokensIn: 1000,
      tokensOut: 10,
      cachedInputTokens: 200,
      model: "claude-3-5-sonnet-20241022",
    }));
    const { deps, dispatcher, capturedCosts, state, ctx } = buildJudgeHarness(plannerCall);
    const userOnCostCalls: number[] = [];
    const userOnCost = (usd: number) => { userOnCostCalls.push(usd); };

    await maybeJudgeAndFinalize(
      deps,
      state.config,
      { step: 0, success: true, text: "done", navigatorHistory: [], onCost: userOnCost },
      state,
      dispatcher,
      ctx,
    );

    expect(capturedCosts).toHaveLength(1);
    const usage = capturedCosts[0];
 // Expected cost WITH the cacheRead discount applied to 200 cached tokens.
    const expectedWithCache = estimateCost(
      "claude-3-5-sonnet-20241022",
      usage.tokensIn,
      usage.tokensOut,
      0, // judgeReasoningTokens not set in this mock
      200,
    );
 // Expected cost WITHOUT the cacheRead discount (cached billed at full input rate).
    const expectedWithoutCache = estimateCost(
      "claude-3-5-sonnet-20241022",
      usage.tokensIn,
      usage.tokensOut,
      0,
      0,
    );
 // The captured cost matches the WITH-cache computation (cacheRead discount applied).
    expect(usage.costUsd).toBeCloseTo(expectedWithCache, 12);
 // The two computations differ — confirms cachedInputTokens actually affects
 // the cost (i.e. the test would catch a regression that drops the param).
    expect(expectedWithCache).not.toBeCloseTo(expectedWithoutCache, 12);
    expect(expectedWithCache).toBeLessThan(expectedWithoutCache);
 // The user's onCost receives the recomputed cost (not 0, not the no-cache cost).
    expect(userOnCostCalls).toHaveLength(1);
    expect(userOnCostCalls[0]).toBeCloseTo(expectedWithCache, 12);
    } finally {
      if (ORIG_URL === undefined) delete process.env.COWORK_MODEL_CATALOG_URL;
      else process.env.COWORK_MODEL_CATALOG_URL = ORIG_URL;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  test("when cachedInputTokens is absent, the cost recompute still works (no discount)", async () => {
 // Regression guard: the cacheRead discount must not break the no-cache path. When
 // plannerCall returns no cachedInputTokens, judgeCachedInputTokens stays 0,
 // and estimateCost is called with cachedInputTokens=0 (no discount).
    const judgeJson = JSON.stringify({
      reasoning: "x", verdict: true, failureReason: null,
      impossibleTask: false, reachedCaptcha: false,
    });
    const plannerCall = vi.fn(async () => ({
      raw: judgeJson,
      tokensIn: 1000,
      tokensOut: 10,
      model: "claude-3-5-sonnet-20241022",
 // No cachedInputTokens field.
    }));
    const { deps, dispatcher, capturedCosts, state, ctx } = buildJudgeHarness(plannerCall);

    await maybeJudgeAndFinalize(
      deps,
      state.config,
      { step: 0, success: true, text: "done", navigatorHistory: [], onCost: () => {} },
      state,
      dispatcher,
      ctx,
    );

    expect(capturedCosts).toHaveLength(1);
 // cachedInputTokens is undefined (not 0) when the plannerCall response
 // doesn't carry it — the `> 0` guard in judges.ts:224 keeps it undefined.
    expect(capturedCosts[0].cachedInputTokens).toBeUndefined();
 // Cost is the no-cache estimate.
    const expectedNoCache = estimateCost(
      "claude-3-5-sonnet-20241022",
      capturedCosts[0].tokensIn,
      capturedCosts[0].tokensOut,
      0,
      0,
    );
    expect(capturedCosts[0].costUsd).toBeCloseTo(expectedNoCache, 12);
  });
});
