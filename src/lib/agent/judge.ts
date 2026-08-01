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
import { wrapUntrusted } from "./security";
import { extractJson } from "./output-parser";
import { estimateCost } from "./llm/pricing";
import {
  type JudgementResult,
  MAX_SUMMARY_SNIPPET,
  truncate,
  renderHistoryItem,
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
export const JUDGE_PROMPT = `You are a judge evaluating whether an autonomous browser agent successfully completed a task.

You will see:
1. The original task (what the user asked for)
2. The agent's action history (what it did, step by step)
3. The agent's final result (its self-reported success + summary)

Your job is to INDEPENDENTLY evaluate whether the task was actually completed. Be initially doubtful of the agent's self-reported success — agents sometimes claim success when they didn't actually finish.

Evaluate based on EVIDENCE in the action history, not the agent's claims. For example:
- If the task was "fill the form and submit", verify that a submit action was taken AND no error was seen afterward.
- If the task was "find the price", verify that the price was actually extracted and reported.
- If the task was "answer all 8 questions", verify that 8 distinct answers were given.

Return JSON:
{
  "reasoning": "Your step-by-step evaluation of the evidence",
  "verdict": true/false,
  "failureReason": "If verdict=false, explain why (max 5 sentences). If verdict=true, null.",
  "impossibleTask": true/false,
  "reachedCaptcha": true/false
}

Rules:
- verdict=true ONLY if you have positive evidence the task was completed.
- If the agent called done(success=true) but you can't find evidence of completion, set verdict=false.
- If the task was impossible (broken site, login wall, CAPTCHA), set impossibleTask=true and verdict=false.
- If the agent hit a CAPTCHA during execution, set reachedCaptcha=true (regardless of verdict).`;

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

  const historyText = history.map(renderHistoryItem).join("\n");

  const truncatedSummary = truncate(agentResult.text, MAX_SUMMARY_SNIPPET);
  const userMessage = `Task: ${task}

Agent's final result:
- Self-reported success: ${agentResult.success}
- Summary: ${wrapUntrusted(truncatedSummary)}

Action history:
${historyText}

Evaluate whether the task was actually completed.`;

  let raw: string;
  let llmUsage: { model?: string; tokensIn?: number; tokensOut?: number; reasoningTokens?: number; cachedInputTokens?: number; cachedWriteInputTokens?: number } | undefined;
  try {
    const res = await llmCall(JUDGE_PROMPT, userMessage);
    raw = res.content;
    llmUsage = res.usage;
  } catch {
    return null;
  }

  if (onCost) {
    const tokensIn = llmUsage?.tokensIn ?? Math.ceil((JUDGE_PROMPT.length + userMessage.length) / 4);
    const tokensOut = llmUsage?.tokensOut ?? Math.ceil(raw.length / 4);
    const resolvedModel = llmUsage?.model || modelForCost;
    let costUsd = 0;
    try {
      const judgeProviderId = resolvedModel?.includes("/")
        ? resolvedModel.split("/")[0]
        : undefined;
      costUsd = resolvedModel
        ? estimateCost({
            model: resolvedModel,
            tokensIn,
            tokensOut,
            reasoningTokens: llmUsage?.reasoningTokens,
            cachedInputTokens: llmUsage?.cachedInputTokens,
            cachedWriteInputTokens: llmUsage?.cachedWriteInputTokens,
            providerId: judgeProviderId,
          })
        : 0;
    } catch (err) {
      console.warn("Judge cost estimation failed; reporting zero cost:", err);
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
