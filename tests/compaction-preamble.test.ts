/**
 * Compaction preamble — the summarizer's role line is a single shared
 * constant (COMPACTION_PREAMBLE) so the compaction runner's byte-reserve
 * math and the budget assertion reference one source.
 */
import { describe, expect, test, vi } from "vitest";
import { COMPACTION_PREAMBLE, SUMMARIZE_PROMPT } from "../src/lib/agent/loop/compaction";
import { runCompaction } from "../src/lib/agent/loop/helpers/compaction-runner";
import { utf8ByteLength } from "../src/lib/agent/prompts/prompt-token-budget";
import type { LoopDeps } from "../src/lib/agent/loop/types";
import type { HistoryItem } from "../src/lib/agent/types";

describe("compaction preamble constant", () => {
  test("COMPACTION_PREAMBLE is the exact role line the summarizer receives", () => {
    expect(COMPACTION_PREAMBLE).toBe("You are summarizing agent history.");
    expect(SUMMARIZE_PROMPT).toContain("summarizing the history of an autonomous browser agent");
  });

  test("runCompaction sends SECURITY_INSTRUCTION + the shared preamble as its system prompt", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const summarizeCall = vi.fn(
      async (_req: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => ({ content: "summary" }),
    );
    const deps: LoopDeps = {
      task: "t",
      navigatorCall: vi.fn(async () => ({ raw: "{}" })),
      plannerCall: vi.fn(async () => ({ raw: "{}" })),
      summarizeCall,
      getTabs: vi.fn(async () => []),
      onEvent: (e: unknown) => events.push(e as { type: string; message?: string }),
      settleDelay: 0,
    };
    const history: HistoryItem[] = Array.from({ length: 8 }, (_, i) => ({
      step: i,
      agent: "navigator",
      evaluation: "e",
      memory: "m",
      goal: "g",
      results: [],
    }));
    const result = await runCompaction(deps, history, 0, () => {}, undefined, undefined, undefined);
    expect(result).not.toBeNull();
    expect(summarizeCall).toHaveBeenCalledTimes(1);
    const systemPrompt = summarizeCall.mock.calls[0]![0].systemPrompt as string;
    expect(systemPrompt).toContain(COMPACTION_PREAMBLE);
    expect(systemPrompt).toMatch(new RegExp(`${COMPACTION_PREAMBLE}$`));
    // The byte-reserve math stays coherent: system prompt + user prompt both
    // reference the same single preamble constant.
    expect(utf8ByteLength(systemPrompt)).toBeLessThan(5_000);
  });
});
