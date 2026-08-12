import type { HistoryItem } from "../types";
import { wrapUntrusted } from "../security";
import {
  MAX_SUMMARY_SNIPPET,
  truncate,
  renderHistoryItem,
} from "../judge-helpers";

export const JUDGE_SYSTEM_PROMPT = `You are a judge evaluating whether an autonomous browser agent successfully completed a task.

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

export interface JudgePromptInputV1 {
  task: string;
  history: HistoryItem[];
  agentResult: { success: boolean; text: string };
}

/** Exact historical judge user-message builder, extracted without byte edits. */
export function buildJudgeUserMessage(input: JudgePromptInputV1): string {
  const historyText = input.history.map(renderHistoryItem).join("\n");
  const truncatedSummary = truncate(input.agentResult.text, MAX_SUMMARY_SNIPPET);
  return `Task: ${input.task}

Agent's final result:
- Self-reported success: ${input.agentResult.success}
- Summary: ${wrapUntrusted(truncatedSummary)}

Action history:
${historyText}

Evaluate whether the task was actually completed.`;
}
