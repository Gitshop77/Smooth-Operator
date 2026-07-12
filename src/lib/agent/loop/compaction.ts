/**
 * Context compaction — when history grows too long, summarize the oldest
 * steps into a `<compacted_memory>` block using a cheap LLM call. This keeps
 * the per-step token budget bounded without losing long-horizon context.
 *
 * Triggers when both:
 * - `step - lastCompactionStep >= compactionStepInterval`, AND
 * - `historyTextLength >= compactionCharThreshold`
 *
 * Summarizes the oldest steps — INCLUDING the FIRST item / init — for context,
 * while keeping the most recent `KEEP_RECENT` items intact. `partitionHistory`
 * is the authority here — see its docstring. The summarization prompt preserves
 * counts, errors, and URLs but explicitly avoids inferring success that wasn't
 * confirmed.
 */

import type { HistoryItem } from "../types";
import { wrapUntrusted, sanitizeUntrusted, PROMPT_TAGS } from "../security";

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
 * @param step Current step number.
 * @param lastCompactionStep Step number of the last compaction (undefined = never).
 * @param historyTextLength Current rendered-history length in characters.
 * This should be the ACTUAL serialized/rendered length (e.g.
 * `renderHistoryForSummarization(...).length`), not a per-item estimate such
 * as `history.length * 500`. A non-validated proxy can drift far from the
 * real size once extracted content accumulates, defeating the context-window
 * protection this gate exists to provide. The caller (orchestrator) supplies
 * the real rendered length.
 * @param interval Minimum steps between compactions.
 * @param threshold Minimum history length (chars) before compaction.
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
 // Validate the gate config: a degenerate interval/threshold (0, negative, NaN,
 // or non-finite) would make the gate fail-open to always-compact. Both must be
 // positive, finite numbers for compaction to ever run.
  if (!Number.isFinite(interval) || interval <= 0) return false;
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
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

// ─── XML escaping ─────────────────────────────────────────────────────────────
// The rendered history is handed to the summarizer LLM as plain text, but it is
// shaped like XML (`<step_N agent="...">` ... `</step_N>`). Interpolating
// page-derived values without escaping would let a malicious page forge
// `<step_N>` / prompt-like structure inside the summarization request. Escape
// both attribute and text contexts so injected markup stays inert.

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Secret redaction ─────────────────────────────────────────────────────────
// `wrapUntrusted` already redacts `%token%` secret placeholders and injection
// phrases from page-derived content. Literal credentials (raw API keys, JWTs)
// that appear in extracted content are NOT covered by those patterns, so a naive
// summary could echo a real key back at the (project-owned) summarizer and, via
// `sanitizeCompactedMemory`, into the navigator's `<compacted_memory>`. Redact
// high-confidence secret shapes before the content leaves the user's machine.
// Patterns are intentionally conservative (well-known key formats) to avoid
// wiping legitimate extracted data (prices, ids, etc.).

function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[redacted]",
    );
}

/** Render history items for the summarization LLM call.
 *
 * Include `extractedContent` (wrapped in `wrapUntrusted`) so the summarization
 * LLM can PRESERVE extracted data verbatim (per the rule in `SUMMARIZE_PROMPT`).
 * Extracted content is UNTRUSTED (page-derived): it is XML-escaped, secret-
 * redacted, then wrapped to prevent prompt injection via the summary. The full
 * value is passed through (no per-extraction truncation) so the summarizer can
 * honor the "preserve verbatim" instruction — long extracted data is the whole
 * point of compaction, not something to silently drop. */
export function renderHistoryForSummarization(items: HistoryItem[]): string {
  return items
    .map((h) => {
      let s = `<step_${escapeXmlAttr(String(h.step))} agent="${escapeXmlAttr(h.agent)}">\n`;
      if (h.evaluation) s += `Evaluation: ${escapeXmlText(h.evaluation)}\n`;
      if (h.memory) s += `Memory: ${escapeXmlText(h.memory)}\n`;
      if (h.goal) s += `Goal: ${escapeXmlText(h.goal)}\n`;
      if (h.results.length) {
        s += `Results:\n`;
        for (const r of h.results) {
          s += `- ${escapeXmlText(r.action.type)}: ${escapeXmlText(r.message)}${r.success ? "" : " (FAILED)"}\n`;
          if (r.extractedContent) {
            s += `  Extracted: ${wrapUntrusted(redactSecrets(r.extractedContent))}\n`;
          }
        }
      }
      s += `</step_${escapeXmlAttr(String(h.step))}>\n`;
      return s;
    })
    .join("\n");
}

/**
 * Build the full summarization request (system-ish prompt + rendered history)
 * from a navigator history. Only the items that should be summarized
 * (`partitionHistory(...).toSummarize` — excluding the most-recent `KEEP_RECENT`
 * steps) are rendered, mirroring the partitioning the orchestrator uses before
 * calling `runCompaction`. Exported so tests and callers can reproduce the exact
 * request the compaction pass will send.
 */
export function buildCompactionRequest(history: HistoryItem[]): string {
  const { toSummarize } = partitionHistory(history);
  return `${SUMMARIZE_PROMPT}\n\n${renderHistoryForSummarization(toSummarize)}`;
}

/**
 * Strip prompt-level XML tags (with or without attributes) from a *summary*
 * string so the navigator can't see forged prompt blocks inside
 * `<compacted_memory>`.
 *
 * The summary is the summarization LLM's OWN prose, not raw page content — so
 * we must NOT redact entire forged tag blocks (that would wipe benign text the
 * agent needs, e.g. a real `<site_memory>` excerpt's content). Instead we
 * replace ONLY the `<tag>` / `</tag>` markers with `[tag]`, neutralizing a
 * forged prompt boundary while preserving the surrounding legitimate text.
 *
 * After the tag markers are gone, the shared `sanitizeUntrusted` runs as
 * defense-in-depth: it NFKC-normalizes, strips zero-width characters, and
 * redacts injection phrases (e.g. "ignore previous instructions") and `%token%`
 * secret placeholders that the summarizer may have echoed. Crucially, because
 * the tag markers are already gone, `sanitizeUntrusted`'s block-redaction
 * pattern can no longer fire and over-redact content.
 *
 * We also run `redactSecrets` so a real key/JWT the summarizer echoed from page
 * content is never handed back to the navigator via `<compacted_memory>`.
 *
 * Uses the shared `PROMPT_TAGS` constant from security.ts (single source of
 * truth) so both sanitizers stay in sync.
 */
export function sanitizeCompactedMemory(memory: string): string {
 // 1) Replace ONLY the tag markers (`<tag>`/`</tag>`, with or without
 // attributes) with `[tag]`. Content between tags is preserved.
  const tagStripped = memory.replace(
    new RegExp(`<\\/?(?:${PROMPT_TAGS.join("|")})[^>]*>`, "g"),
    "[tag]",
  );
 // 2) Redact high-confidence secrets echoed by the summarizer (defense in
 // depth — the navigator must not receive a real key/JWT).
  const secretsOut = redactSecrets(tagStripped);
 // 3) Run the shared untrusted sanitizer (injection phrases, %token%,
 // NFKC + zero-width). Tag markers are already gone, so its block-redaction
 // pattern cannot over-redact content.
  return sanitizeUntrusted(secretsOut);
}
