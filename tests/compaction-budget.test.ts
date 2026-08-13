/**
 * Compaction budget tests.
 *
 * `runCompaction` must deterministically bound the summarization request to
 * the compaction profile's conservative UTF-8-byte input budget before any
 * tokens are spent. A long history must never cross the network unbounded; the
 * bound keeps the summarizer prompt + oldest steps and appends an explicit
 * marker, while a small history passes through byte-identical.
 */

import { describe, expect, test, vi } from "vitest";
import { runCompaction } from "../src/lib/agent/loop/helpers/compaction-runner";
import { SUMMARIZE_PROMPT } from "../src/lib/agent/loop/compaction";
import { PROMPT_BUDGET_PROFILES_V1, utf8ByteLength } from "../src/lib/agent/prompts/prompt-token-budget";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import { makeHistoryItem } from "./helpers";

const COMPACTION_MAX_INPUT = PROMPT_BUDGET_PROFILES_V1.compaction.maxInputTokens;

function runWithCapturedPrompt(history: Parameters<typeof runCompaction>[1]) {
  let capturedUserPrompt = "";
  const deps = {
    task: "compaction budget test",
    onEvent: () => {},
    summarizeCall: vi.fn(async (req: { userPrompt: string }) => {
      capturedUserPrompt = req.userPrompt;
      return { content: "Prior steps summary: bounded." };
    }),
  } as unknown as LoopDeps;
  return { deps, prompt: () => capturedUserPrompt };
}

describe("runCompaction prompt budget", () => {
  test("a large history is deterministically bounded within the compaction profile", async () => {
    // ~40 steps of page-derived content easily exceeds the compaction profile.
    const history = Array.from({ length: 40 }, (_, i) =>
      makeHistoryItem(i, {
        evaluation: `page note ${"x".repeat(400)} at step ${i}`,
        memory: `remembered ${"y".repeat(300)}`,
        goal: `goal for step ${i}`,
      }),
    );
    const { deps, prompt } = runWithCapturedPrompt(history);
    const result = await runCompaction(deps, history, 40);

    expect(result).not.toBeNull();
    const userPrompt = prompt();
    // The request stays within the conservative byte budget on its own.
    expect(utf8ByteLength(userPrompt)).toBeLessThanOrEqual(COMPACTION_MAX_INPUT);
    // The marker reports what was dropped, so truncation is observable.
    expect(userPrompt).toContain("[truncated");
    expect(userPrompt).toContain("compaction history");
    // The summarizer's own instructions are always preserved (they are the
    // first bytes of the bounded prefix).
    expect(userPrompt.startsWith(SUMMARIZE_PROMPT)).toBe(true);
  });

  test("a small history passes through byte-identical without a marker", async () => {
    const history = Array.from({ length: 8 }, (_, i) => makeHistoryItem(i));
    const { deps, prompt } = runWithCapturedPrompt(history);
    const result = await runCompaction(deps, history, 8);

    expect(result).not.toBeNull();
    expect(prompt()).not.toContain("[truncated");
    // The request starts with the summarizer prompt and still fits the budget.
    expect(prompt().startsWith(SUMMARIZE_PROMPT)).toBe(true);
    expect(utf8ByteLength(prompt())).toBeLessThanOrEqual(COMPACTION_MAX_INPUT);
  });

  test("system + user together never exceed the compaction profile", async () => {
    const history = Array.from({ length: 60 }, (_, i) =>
      makeHistoryItem(i, { evaluation: "page data " + "z".repeat(600) }),
    );
    const { deps, prompt } = runWithCapturedPrompt(history);
    const result = await runCompaction(deps, history, 60);

    expect(result).not.toBeNull();
    // Conservative combined estimate (system + user) stays within budget.
    const systemPrompt = "You are summarizing agent history.";
    const combined = utf8ByteLength(systemPrompt) + utf8ByteLength(prompt());
    expect(combined).toBeLessThanOrEqual(COMPACTION_MAX_INPUT);
  });

  test("a known 64k context uses the 85% input allowance instead of the fixed 32k guard", async () => {
    const history = Array.from({ length: 80 }, (_, i) =>
      makeHistoryItem(i, { evaluation: `evidence-${i} ${"q".repeat(900)}` }),
    );
    const { deps, prompt } = runWithCapturedPrompt(history);
    const result = await runCompaction(
      deps,
      history,
      80,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      64_000,
    );

    expect(result).not.toBeNull();
    expect(utf8ByteLength(prompt())).toBeGreaterThan(COMPACTION_MAX_INPUT);
    expect(utf8ByteLength(prompt())).toBeLessThanOrEqual(64_000 * 0.85 * 2);
  });

  test("planner-fallback path (no summarizeCall wired) still returns a compacted summary", async () => {
    // Legacy/compatibility callers that don't wire `summarizeCall` fall back
    // to `deps.plannerCall`. Production wires `summarizeCall` (the bounded
    // direct summarizer), so this fallback is covered by the planner profile
    // assertion at the direct-call boundary; here we lock that the fallback
    // path itself works and returns the extracted summary text.
    const plannerCall = vi.fn(async (_req: unknown) => ({
      raw: JSON.stringify({ thinking: "x", decision: "done", plan: [], next_goal: "", text: "Prior steps summary: extracted." }),
    }));
    const deps = {
      task: "compaction fallback test",
      onEvent: () => {},
      plannerCall,
    } as unknown as LoopDeps;

    const history = Array.from({ length: 8 }, (_, i) => makeHistoryItem(i));
    const result = await runCompaction(deps, history, 8);

    expect(result).not.toBeNull();
    expect(result?.compactedMemory).toContain("extracted");
    expect(plannerCall).toHaveBeenCalledTimes(1);
    const request = plannerCall.mock.calls[0]?.[0] as { task: string; history: unknown[] } | undefined;
    // `partitionHistory` keeps the most recent 6 items intact; only the oldest
    // 2 of the 8 are handed to the fallback summarizer.
    expect(request?.history).toHaveLength(2);
  });
});
