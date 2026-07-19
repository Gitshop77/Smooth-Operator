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
// use the shared balanced-brace JSON extractor from output-parser
// instead of a duplicate implementation.
import { extractJson } from "./output-parser";

/** Maximum characters of `extractedContent` to include per history entry. */
const MAX_EXTRACT_SNIPPET = 200;

/** Maximum number of characters to include from the agent's final summary. */
const MAX_SUMMARY_SNIPPET = 4000;

/** Slice `text` to `max` chars, appending an ellipsis only when actually truncated. */
function truncate(text: string, max: number): string {
  const s = text.slice(0, max);
  return s + (text.length > max ? "…" : "");
}

/** Result returned by the judge LLM. */
export interface JudgementResult {
  /** The judge's step-by-step reasoning, or null if the LLM omitted it. */
  reasoning: string | null;
  /** True = task succeeded. */
  verdict: boolean;
  /** ≤ 5 sentences explaining why the task failed (null if verdict=true). */
  failureReason: string | null;
  /** True if the task was impossible (vague instructions, broken site, etc.). */
  impossibleTask: boolean;
  /** True if the agent hit a CAPTCHA during execution. */
  reachedCaptcha: boolean;
}

/** Inputs to {@link judgeTask}. */
export interface JudgeTaskArgs {
  /** Original user task. */
  task: string;
  /** Full action history. */
  history: HistoryItem[];
  /** The agent's self-reported final result. */
  agentResult: { success: boolean; text: string };
  /** Low-level LLM call function (systemPrompt, userMessage) → raw response. */
  llmCall: (systemPrompt: string, userMessage: string) => Promise<string>;
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
 * Render a single history item as text for the judge.
 * Truncates extracted content to keep the prompt bounded. Wraps every
 * non-authoritative field in `<untrusted>` so the judge LLM can't be
 * prompt-injected — extracted content is page-derived (untrusted), and the
 * agent's own `evaluation`/`memory`/`goal` notes are model output that may
 * echo page-derived text it copied, so they are untrusted too. The user
 * `task` is the only trusted (author-provided) field and is left unwrapped.
 */
function renderHistoryItem(h: HistoryItem): string {
  let s = `Step ${h.step} (${h.agent}):\n`;
  if (h.evaluation) s += `  Evaluation: ${wrapUntrusted(h.evaluation)}\n`;
  if (h.memory) s += `  Memory: ${wrapUntrusted(h.memory)}\n`;
  if (h.goal) s += `  Goal: ${wrapUntrusted(h.goal)}\n`;
 // Null-guard `h.results` — older history items (or hand-built test fixtures)
 // may have `results: undefined`. Without this, `h.results.length` throws.
  if (h.results?.length) {
    s += `  Actions:\n`;
    for (const r of h.results) {
 // `r.action.type` is a model-chosen label and `r.message` is the agent's
 // free-text description of an action, which routinely echoes page-derived
 // content (e.g. "typed '<extracted text>' into the search box"). Both are
 // untrusted per this module's trust model and must be wrapped so they
 // can't prompt-inject the judge LLM.
      s += `    - ${wrapUntrusted(r.action.type)}: ${wrapUntrusted(r.message)}${r.success ? "" : " (FAILED)"}\n`;
      if (r.extractedContent) {
 // Truncate AND add an ellipsis when truncated so the judge can tell
 // the snippet was cut short (otherwise it might infer the task
 // failed because the data "ended abruptly").
        const full = r.extractedContent;
        s += `      Extracted: ${wrapUntrusted(truncate(full, MAX_EXTRACT_SNIPPET))}\n`;
      }
    }
  }
  return s;
}

/** Truthy values we accept as a `true` boolean from the judge LLM. */
// Handle all case variants of "true" (True/TRUE) + "yes" (Yes/YES). Without
// this, a judge LLM emitting `"verdict": "True"` (capitalized) would be
// treated as false → false-negative verdict. Matches flexibleBoolean's case
// coverage in schema.ts.
const TRUTHY_BOOLEANS = new Set<unknown>([
  true, 1, "1", "true", "True", "TRUE", "yes", "Yes", "YES",
]);

/**
 * Coerce a parsed JSON value to a JudgementResult with lenient booleans.
 *
 * `verdict` is the AUTHORITATIVE decision. Its presence (true/false) means the
 * judge rendered a determination, so a missing/omitted `verdict` (or `null`)
 * means the response was structurally incomplete and must route back to the
 * planner (UNVERIFIED → `null`), exactly like an unparseable one. This preserves
 * the fail-closed property: a missing `verdict` can NEVER become `verdict: false`.
 *
 * `impossibleTask` / `reachedCaptcha` are ADVISORY flags, not the verdict. If
 * the judge omitted one of them we default it to `false` (the safe assumption:
 * the task was not impossible and no CAPTCHA was hit) WITH a logged warning,
 * rather than discarding the entire (valid) verdict. This avoids throwing
 * away a useful `verdict: true` simply because the model skipped an optional
 * field. The dangerous case — manufacturing a false-negative `verdict` — is
 * still prevented, because only the optional flags fall back to `false`; the
 * `verdict` itself is never invented.
 */
export function coerceJudgement(parsed: Record<string, unknown>): JudgementResult | null {
 // `== null` catches both `undefined` (omitted field) and `null`. The verdict
 // is required; without it the response is UNVERIFIED (route back to planner).
  if (parsed.verdict == null) {
    return null;
  }
 // Advised flags: default to `false` when omitted, but warn so a silent
 // downgrade of an intentionally-set flag is observable (it isn't here — the
 // judge simply skipped it).
  const impossibleTask = parsed.impossibleTask == null
    ? (console.warn("[judge] coerceJudgement: missing `impossibleTask`; defaulting to false."), false)
    : TRUTHY_BOOLEANS.has(parsed.impossibleTask);
  const reachedCaptcha = parsed.reachedCaptcha == null
    ? (console.warn("[judge] coerceJudgement: missing `reachedCaptcha`; defaulting to false."), false)
    : TRUTHY_BOOLEANS.has(parsed.reachedCaptcha);
  return {
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : null,
 // Loosen boolean coercion — LLMs sometimes emit "true" (string) or 1
 // (number) instead of a JSON `true`. Accept all the common variants.
    verdict: TRUTHY_BOOLEANS.has(parsed.verdict),
    failureReason: typeof parsed.failureReason === "string" ? parsed.failureReason : null,
    impossibleTask,
    reachedCaptcha,
  };
}

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

// split the LLM-call try/catch from the onCost call so a
 // budget-exceeded throw from `onCost` (raised by the cost callback)
 // propagates UP to `maybeJudgeAndFinalize`'s catch — which finalizes the
 // run as FAILURE.
  let raw: string;
  try {
    raw = await llmCall(JUDGE_PROMPT, userMessage);
  } catch {
 // Judge LLM failure — don't crash the run. Return null (UNVERIFIED). The
 // caller (`maybeJudgeAndFinalize`) routes a null verdict back to the
 // planner rather than failing open with success:true.
    return null;
  }

 // Best-effort cost tracking — the judge's `llmCall` doesn't return usage,
 // so we estimate from the prompt + completion lengths. The model name is
 // passed via `args.modelForCost` (the orchestrator knows which model the
 // planner/navigator used). Without it, estimateCost returns 0 for unknown
 // models — safe but under-reports the judge's cost.
 //
 // AWAIT `onCost` OUTSIDE any try/catch so a budget-exceeded
 // throw propagates to `maybeJudgeAndFinalize`'s catch (which finalizes
 // the run as FAILURE when the budget is exceeded).
  if (onCost) {
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    try {
      tokensIn = Math.ceil((JUDGE_PROMPT.length + userMessage.length) / 4);
      tokensOut = Math.ceil(raw.length / 4);
      const { estimateCost } = await import("./llm/pricing");
      // When the cost model id is provider-prefixed (e.g. an OpenRouter-style
      // "google/gemini-2.5-pro"), thread that provider so pricing disambiguates
      // the same bare id across providers (lookupPricing's provider-prefixed
      // key wins). Bare ids (no "/") have no provider context at the judge
      // layer — the orchestrator's AgentConfig doesn't carry providerId — so we
      // leave it undefined and rely on the first-writer-wins bare-id resolution
      // in pricing.ts.
      const judgeProviderId = modelForCost?.includes("/")
        ? modelForCost.split("/")[0]
        : undefined;
      costUsd = modelForCost
        ? estimateCost(
            modelForCost,
            tokensIn,
            tokensOut,
            undefined,
            undefined,
            undefined,
            undefined,
            judgeProviderId,
          )
        : 0;
    } catch (err) {
 // Pricing import / estimateCost failed — report zero cost (safe
 // default; onCost still fires so the dispatcher sees the call). Surface
 // the error so a broken pricing path is observable rather than being
 // silently zeroed forever (which would under-report judge cost and could
 // defeat budget-cap enforcement for the judge portion of a run). The
 // expected "unknown model → 0" case is `modelForCost` being absent, not
 // a thrown error, so any throw here is genuine and worth seeing.
      console.warn("Judge cost estimation failed; reporting zero cost:", err);
    }
 // Propagates budget-exceeded throws to the caller.
 // Report the real model (when known) rather than a generic "judge" label,
 // so per-model cost accounting buckets judge spend under the correct model.
    await onCost({ tokensIn, tokensOut, model: modelForCost ?? "judge", costUsd });
  }

 // use the shared extractJson from output-parser (handles markdown
 // fences + balanced-brace extraction). If the extracted text isn't valid
 // JSON, return null (UNVERIFIED — NOT agreement).
  try {
    const jsonText = extractJson(raw);
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return coerceJudgement(parsed);
  } catch {
 // LLM produced unparseable JSON — return null (UNVERIFIED). The caller
 // routes this back to the planner rather than failing open.
    return null;
  }
}
