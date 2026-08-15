/**
 * Judge — a post-hoc LLM evaluation of whether the task actually succeeded.
 *
 * The agent self-reports success, but agents sometimes hallucinate. The judge
 * reads the full trajectory + the task + the agent's final result, then
 * independently evaluates whether the task was actually completed.
 *
 * The judge's verdict does NOT override the agent's self-report — both values
 * are returned and the caller decides how to reconcile them.
 */

import type { HistoryItem } from "./types";
import type { ImagePartV1 } from "./llm/image-part";
import { extractJson } from "./output-parser";
import { estimateCost } from "./llm/pricing";
import { redactKeyLeak } from "./redact-shared";
import { compileJudgePromptV1 } from "./prompts/prompt-compiler";
import { JUDGE_SYSTEM_PROMPT } from "./prompts/judge-prompt";
import { assertCompiledPromptWithinProfileV1 } from "./prompts/prompt-token-budget";
import {
  type JudgementResult,
  coerceJudgement,
} from "./judge-helpers";
export { coerceJudgement } from "./judge-helpers";

/** Inputs to {@link judgeTask}. */
interface JudgeTaskArgs {
  /** Original user task. */
  task: string;
  /** Full action history. */
  history: HistoryItem[];
  /** The agent's self-reported final result. */
  agentResult: { success: boolean; text: string };
  /** Low-level LLM call function (systemPrompt, userMessage) → raw response + optional usage. */
  llmCall: (systemPrompt: string, userMessage: string) => Promise<{
    content: string;
    usage?: {
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      cachedWriteInputTokens?: number;
      /** Provider-computed charge; local providers return exactly zero. */
      costUsd?: number;
    };
  }>;
  /** Optional cost callback fired once per judge LLM call. Lets the agent
   * loop accrue judge cost into the same budget tracker used for the
   * navigator + planner.
   *
   * the callback MAY be async. `judgeTask` AWAITS it OUTSIDE its
   * own try/catches so a cost callback
   * propagates up to `maybeJudgeAndFinalize`'s catch — which finalizes the
   * run as FAILURE (not "judge agreement"). A throw here MUST propagate so
   * the run is aborted rather than silently finalized as judge-agreement. */
  onCost?: (usage: {
    tokensIn: number;
    tokensOut: number;
    /** The actual model used for the judge call, or "judge" when
   * `modelForCost` was not supplied. */
    model: string;
    costUsd: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cachedWriteInputTokens?: number;
  }) => void | Promise<void>;
  /**
   * Optional model name for cost estimation. The judge's `llmCall` wrapper
   * doesn't return the model name, so the judge can't look up pricing on its
   * own. When provided, `onCost` reports the real cost; when omitted, cost
   * is reported as 0 (safe but under-reported).
   */
  modelForCost?: string;
}

/**
 * System prompt for the judge. Instructs it to evaluate evidence (not the
 * agent's claims) and to flag impossible tasks + CAPTCHAs separately from
 * the success verdict.
 */
export const JUDGE_PROMPT = JUDGE_SYSTEM_PROMPT;

/**
 * Run the judge on a completed task.
 *
 * @returns The judge's verdict, or `null` if the judge LLM call failed or
 * returned an unparseable response. Returning `null` (rather than
 * throwing) ensures a judge failure can't crash the run — but a null
 * verdict is NOT treated as agreement. `maybeJudgeAndFinalize` routes
 * a null verdict back to the planner (UNVERIFIED) instead of failing
 * open with success:true.
 */
export async function judgeTask(args: JudgeTaskArgs): Promise<JudgementResult | null> {
  const { task, history, agentResult, llmCall, onCost, modelForCost } = args;

  const compiled = await compileJudgePromptV1({ task, history, agentResult });
  // Budget guard: the judge prompt (system + user) must fit the judge
  // profile's conservative UTF-8-byte input budget before any tokens are spent.
  // A failure here surfaces as a typed `PromptBudgetExceededError` and is
  // classified by the caller exactly like a cost-cap stop.
  assertCompiledPromptWithinProfileV1("judge", "judge", compiled.messages);
  // The compiled messages are plain text for the judge (no image parts), but
  // `ChatMessage.content` is `string | Array<string | ImagePartV1>` — branch
  // so a widened content type can never leak an object into llmCall.
  const messageText = (content: string | Array<string | ImagePartV1>): string =>
    typeof content === "string"
      ? content
      : content.filter((part): part is string => typeof part === "string").join("");
  const systemPrompt = messageText(compiled.messages[0]?.content ?? "");
  const userMessage = messageText(compiled.messages[1]?.content ?? "");

  let raw: string;
  let llmUsage: { model?: string; tokensIn?: number; tokensOut?: number; reasoningTokens?: number; cachedInputTokens?: number; cachedWriteInputTokens?: number; costUsd?: number } | undefined;
  try {
    const res = await llmCall(systemPrompt, userMessage);
    raw = res.content;
    llmUsage = res.usage;
  } catch {
    return null;
  }

  if (onCost) {
    const tokensIn = llmUsage?.tokensIn ?? Math.ceil((systemPrompt.length + userMessage.length) / 4);
    const tokensOut = llmUsage?.tokensOut ?? Math.ceil(raw.length / 4);
    const resolvedModel = llmUsage?.model || modelForCost;
    let costUsd = typeof llmUsage?.costUsd === "number" && Number.isFinite(llmUsage.costUsd)
      ? llmUsage.costUsd
      : 0;
    try {
      const judgeProviderId = resolvedModel?.includes("/")
        ? resolvedModel.split("/")[0]
        : undefined;
      costUsd = llmUsage?.costUsd === undefined && resolvedModel
        ? estimateCost({
            model: resolvedModel,
            tokensIn,
            tokensOut,
            reasoningTokens: llmUsage?.reasoningTokens,
            cachedInputTokens: llmUsage?.cachedInputTokens,
            cachedWriteInputTokens: llmUsage?.cachedWriteInputTokens,
            providerId: judgeProviderId,
          })
        : costUsd;
    } catch (err) {
      // Mask any key-shaped secret that could have leaked into the pricing
      // error before it reaches the console / run log.
      console.warn("Judge cost estimation failed; reporting zero cost:", redactKeyLeak(String(err)));
    }
    await onCost({
      tokensIn,
      tokensOut,
      model: resolvedModel ?? "judge",
      costUsd,
      reasoningTokens: llmUsage?.reasoningTokens,
      cachedInputTokens: llmUsage?.cachedInputTokens,
      cachedWriteInputTokens: llmUsage?.cachedWriteInputTokens,
    });
  }

  try {
    const jsonText = extractJson(raw);
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return coerceJudgement(parsed);
  } catch {
    return null;
  }
}
