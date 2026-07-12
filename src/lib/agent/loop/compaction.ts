/**
 * Context compaction — when history grows too long, summarize the oldest
 * steps into a `<compacted_memory>` block using a cheap LLM call. This keeps
 * the per-step token budget bounded without losing long-horizon context.
 *
 * Triggers when both:
 *   - `step - lastCompactionStep >= compactionStepInterval`, AND
 *   - `historyTextLength >= compactionCharThreshold`
 *
 * Summarizes the oldest steps (including the FIRST item / init, so the summary
 * keeps its context) and keeps the most recent `KEEP_RECENT` items intact.
 * `partitionHistory` is the authority here — see its docstring. The
 * summarization prompt preserves counts, errors, and URLs but explicitly avoids
 * inferring success that wasn't confirmed.
 */

import type { HistoryItem } from "../types";
import { wrapUntrusted } from "../security";

/** Number of recent steps to keep intact (not summarized). */
const KEEP_RECENT = 6;

/** The system instruction prepended to the summarization request. */
export const SUMMARIZE_PROMPT = `You are summarizing the history of an autonomous browser agent. Condense the following step history into a brief <compacted_memory> block. Rules:
- Report ONLY what was confirmed (actions taken, results seen, pages visited, data found).
- NEVER infer completion or success that wasn't explicitly confirmed.
- Preserve counts (e.g. "answered 3 of 8 questions", "visited 2 pages").
- Preserve any errors, blockers, or failures encountered.
- Preserve URLs visited and key data extracted.
- PRESERVE extracted data verbatim — if a step extracted text (price, name, count, etc.), include the exact value in the summary. This data is critical for task completion and must not be lost during compaction.
- Be concise (2-5 sentences). This is memory, not a full log.
- Start with "Prior steps summary:" and end with a period.

Step history to summarize:`;

/**
 * Decide whether compaction should run on this step.
 *
 * @param step                 Current step number.
 * @param lastCompactionStep   Step number of the last compaction (undefined = never).
 * @param historyTextLength    Current rendered-history length in characters.
 *   NOTE: this should be the ACTUAL serialized/rendered length (e.g.
 *   `renderHistoryForSummarization(...).length`), not a per-item estimate such
 *   as `history.length * 500`. A non-validated proxy can drift far from the
 *   real size once extracted content accumulates, defeating the context-window
 *   protection this gate exists to provide. The caller (orchestrator) is
 *   responsible for supplying a representative value.
 * @param interval             Minimum steps between compactions.
 * @param threshold            Minimum history length (chars) before compaction.
 */
export function shouldCompact(
  step: number,
  lastCompactionStep: number | undefined,
  historyTextLength: number,
  interval: number,
  threshold: number
): boolean {
  // Guard against a non-validated / malformed length driving a safety-relevant
  // decision: an infinite or negative value must never trigger compaction.
  if (!Number.isFinite(historyTextLength) || historyTextLength < 0) return false;
  const stepGap = step - (lastCompactionStep ?? 0);
  return stepGap >= interval && historyTextLength >= threshold;
}

/**
 * Partition history into the items to summarize (oldest, excluding the most
 * recent) and the items to keep intact (the most recent N). The very first
 * item (init) is always included in `toSummarize` so the summary has context.
 */
export function partitionHistory(history: HistoryItem[]): {
  toSummarize: HistoryItem[];
  toKeep: HistoryItem[];
} {
  if (history.length <= KEEP_RECENT + 1) {
    return { toSummarize: [], toKeep: history };
  }
  const first = history[0];
  const recent = history.slice(-KEEP_RECENT);
  const middle = history.slice(1, -KEEP_RECENT);
  return { toSummarize: [first, ...middle], toKeep: recent };
}

/** Render history items for the summarization LLM call.
 *
 * Include `extractedContent` (wrapped in `wrapUntrusted`) so the summarization
 * LLM can PRESERVE extracted data verbatim (per the rule in `SUMMARIZE_PROMPT`).
 * Extracted content is UNTRUSTED (page-derived) so it's wrapped to prevent prompt
 * injection via the summary. */
export function renderHistoryForSummarization(items: HistoryItem[]): string {
  return items
    .map((h) => {
      let s = `<step_${h.step} agent="${h.agent}">\n`;
      if (h.evaluation) s += `Evaluation: ${h.evaluation}\n`;
      if (h.memory) s += `Memory: ${h.memory}\n`;
      if (h.goal) s += `Goal: ${h.goal}\n`;
      if (h.results.length) {
        s += `Results:\n`;
        for (const r of h.results) {
          s += `- ${r.action.type}: ${r.message}${r.success ? "" : " (FAILED)"}\n`;
          if (r.extractedContent) {
            s += `  Extracted: ${wrapUntrusted(r.extractedContent.slice(0, 500))}\n`;
          }
        }
      }
      s += `</step_${h.step}>\n`;
      return s;
    })
    .join("\n");
}

/** Build the full summarization request string (prompt + history to summarize). */
export function buildCompactionRequest(history: HistoryItem[]): string {
  const { toSummarize } = partitionHistory(history);
  return `${SUMMARIZE_PROMPT}\n\n${renderHistoryForSummarization(toSummarize)}`;
}

import { PROMPT_TAGS as PROMPT_TAGS_LIST } from "../security";

/** Strip prompt-level XML tags (with or without attributes) from a string so
 * the LLM can't forge them inside a summary. The summarization LLM echoes
 * page-derived content; if that content contains prompt tags like
 * `<system>` or `<browser_state>`, the navigator would see forged prompt
 * blocks inside `<compacted_memory>`.
 *
 * Uses the shared PROMPT_TAGS constant from security.ts (single source of
 * truth) — both sanitizers stay in sync automatically. */
export function sanitizeCompactedMemory(memory: string): string {
  return memory.replace(
    new RegExp(`<\\/?(?:${PROMPT_TAGS_LIST.join("|")})[^>]*>`, "g"),
    "[tag]",
  );
}
