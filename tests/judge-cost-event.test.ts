/**
 * Shared cost-event reporter — the judge's `cost` event now includes
 * reasoning/cache tokens (previously dropped, under-reporting cache-write
 * spend). Proves reportCostEvent's shape parity across the main path and the
 * judge path.
 */
import { describe, expect, test } from "vitest";
import { reportCostEvent } from "../src/lib/agent/loop/helpers/llm-calls-utils";
import type { LogEvent } from "../src/lib/agent/types";

describe("reportCostEvent — shared cost-event shape", () => {
  test("includes reasoningTokens / cachedInputTokens / cachedWriteInputTokens when present", () => {
    const events: LogEvent[] = [];
    reportCostEvent((e) => events.push(e), 4, {
      model: "anthropic/claude-3-5-sonnet",
      tokensIn: 1000,
      tokensOut: 200,
      costUsd: 0.05,
      reasoningTokens: 300,
      cachedInputTokens: 400,
      cachedWriteInputTokens: 500,
    });
    expect(events).toHaveLength(1);
    const cost = events[0] as Extract<LogEvent, { type: "cost" }>;
    expect(cost).toMatchObject({
      type: "cost",
      step: 4,
      tokensIn: 1000,
      tokensOut: 200,
      costUsd: 0.05,
      model: "anthropic/claude-3-5-sonnet",
      reasoningTokens: 300,
      cachedInputTokens: 400,
      cachedWriteInputTokens: 500,
    });
  });

  test("omits zero/absent optional token fields (clean shape on the common path)", () => {
    const events: LogEvent[] = [];
    reportCostEvent((e) => events.push(e), 0, { model: "m", tokensIn: 10, tokensOut: 5, costUsd: 0.001 });
    const cost = events[0] as Extract<LogEvent, { type: "cost" }>;
    expect(cost).toMatchObject({ type: "cost", step: 0, tokensIn: 10, tokensOut: 5, costUsd: 0.001, model: "m" });
    expect("reasoningTokens" in cost).toBe(false);
    expect("cachedInputTokens" in cost).toBe(false);
    expect("cachedWriteInputTokens" in cost).toBe(false);
  });
});
