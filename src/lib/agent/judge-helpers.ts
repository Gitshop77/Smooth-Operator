/**
 * Pure helpers for the judge module — extracted from judge.ts.
 */

import type { HistoryItem } from "./types";
import { wrapUntrusted } from "./security";

/** Maximum characters of `extractedContent` to include per history entry. */
const MAX_EXTRACT_SNIPPET = 200;

/** Maximum number of characters to include from the agent's final summary. */
export const MAX_SUMMARY_SNIPPET = 4000;

/** Slice `text` to `max` chars, appending an ellipsis only when actually truncated. */
export function truncate(text: string, max: number): string {
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

/**
 * Render a single history item as text for the judge.
 * Truncates extracted content to keep the prompt bounded. Wraps every
 * non-authoritative field in `<untrusted>` so the judge LLM can't be
 * prompt-injected — extracted content is page-derived (untrusted), and the
 * agent's own `evaluation`/`memory`/`goal` notes are model output that may
 * echo page-derived text it copied, so they are untrusted too. The user
 * `task` is the only trusted (author-provided) field and is left unwrapped.
 */
export function renderHistoryItem(h: HistoryItem): string {
  let s = `Step ${h.step} (${h.agent}):\n`;
  if (h.evaluation) s += `  Evaluation: ${wrapUntrusted(h.evaluation)}\n`;
  if (h.memory) s += `  Memory: ${wrapUntrusted(h.memory)}\n`;
  if (h.goal) s += `  Goal: ${wrapUntrusted(h.goal)}\n`;
  if (h.results?.length) {
    s += `  Actions:\n`;
    for (const r of h.results) {
      const actionType = r.action?.type ?? "(unknown action)";
      s += `    - ${wrapUntrusted(actionType)}: ${wrapUntrusted(r.message)}${r.success ? "" : " (FAILED)"}\n`;
      if (r.extractedContent) {
        const full = r.extractedContent;
        s += `      Extracted: ${wrapUntrusted(truncate(full, MAX_EXTRACT_SNIPPET))}\n`;
      }
    }
  }
  return s;
}

/** Truthy values we accept as a `true` boolean from the judge LLM. */
const TRUTHY_BOOLEANS = new Set<unknown>([
  true, 1, "1", "true", "True", "TRUE", "yes", "Yes", "YES",
]);

/**
 * Coerce a parsed JSON value to a JudgementResult with lenient booleans.
 *
 * `verdict` is the AUTHORITATIVE decision. Its presence (true/false) means the
 * judge rendered a determination, so a missing/omitted `verdict` (or `null`)
 * means the response was structurally incomplete and must route back to the
 * planner (UNVERIFIED → `null`), exactly like an unparseable one.
 */
export function coerceJudgement(parsed: Record<string, unknown>): JudgementResult | null {
  if (parsed.verdict == null) {
    return null;
  }
  const impossibleTask = parsed.impossibleTask == null
    ? (console.warn("[judge] coerceJudgement: missing `impossibleTask`; defaulting to false."), false)
    : TRUTHY_BOOLEANS.has(parsed.impossibleTask);
  const reachedCaptcha = parsed.reachedCaptcha == null
    ? (console.warn("[judge] coerceJudgement: missing `reachedCaptcha`; defaulting to false."), false)
    : TRUTHY_BOOLEANS.has(parsed.reachedCaptcha);
  const verdict = TRUTHY_BOOLEANS.has(parsed.verdict);
  return {
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : null,
    verdict,
    failureReason: verdict ? null : (typeof parsed.failureReason === "string" ? parsed.failureReason : null),
    impossibleTask,
    reachedCaptcha,
  };
}
