/**
 * HTML-summarizer pre-pass — a heuristic DOM filter that runs BEFORE the
 * navigator LLM sees the page, returning only the elements relevant to the
 * current task.
 *
 * On dense pages (real-estate listings, admin dashboards, social feeds) the
 * full DOM can be 200K+ characters — that's expensive (cost), distracting
 * (quality), and sometimes exceeds the context window of cheaper models
 * (compatibility). A pre-pass that filters the DOM to task-relevant
 * elements can shrink the prompt 10× without hurting accuracy.
 *
 * This implementation is HEURISTIC (no LLM in the loop):
 * 1. Tokenize the user task + current goal into keywords (lowercase,
 * stop-word-filtered).
 * 2. Score each interactive element by how well it matches the keywords:
 * - +3 if the element's text/accessibility-name contains a keyword.
 * - +2 if any attribute value (placeholder, aria-label, name, id,
 * href, value) contains a keyword.
 * - +1 if the element's tag is "task-relevant" (see below).
 * 3. Keep the top N elements by score (preserving their original indices
 * so the navigator's `[index]` references still resolve via the
 * selector map). When fewer than N elements have a non-zero score,
 * fall back to returning the full DOM (the summarizer is best-effort
 * — a wrong filter is worse than no filter).
 *
 * Tag-relevance heuristics (tuned for web-form / navigation tasks):
 * - Form tasks ("fill", "submit", "login", "form", "enter"): input,
 * textarea, select, button, label.
 * - Navigation tasks ("go to", "open", "navigate", "visit"): a, button.
 * - Search tasks ("search", "find", "look up"): input[type=search],
 * input, button, a.
 * - Reading tasks ("read", "summarize", "what", "list"): a, h1-h6, p,
 * li, td, article.
 *
 * The function is pure — it takes the task/goal/elements and returns a
 * filtered elementsText string + the list of kept indices. The orchestrator
 * decides whether to substitute the filtered text into the navigator
 * request.
 */

import type { ExtractedElement } from "./types";

/** Common English stop-words to filter out of the keyword set. */
const STOP_WORDS = new Set<string>([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "for",
  "of", "to", "in", "on", "at", "by", "with", "from", "as", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "should", "could", "can", "may",
  "might", "must", "shall", "this", "that", "these", "those", "i", "you",
  "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours", "hers",
  "ours", "theirs", "all", "any", "some", "no", "not", "nor", "only",
  "own", "same", "so", "than", "too", "very", "just", "now", "up",
  "down", "out", "off", "over", "under", "again", "further", "once",
  "here", "there", "when", "where", "why", "how", "what", "which",
  "who", "whom", "page", "site", "tab", "browser", "agent",
]);

/** Minimum keyword length to keep (filters out 1-char noise). */
const MIN_KEYWORD_LENGTH = 2;

/**
 * Tokenize a free-text prompt into a set of lowercased keywords.
 *
 * Splits on whitespace + punctuation, drops stop-words + 1-char tokens,
 * lowercases everything. Returns a Set for O(1) membership checks.
 */
export function extractKeywords(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/i);
  for (const tok of tokens) {
    if (tok.length < MIN_KEYWORD_LENGTH) continue;
    if (STOP_WORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** Task-intent detection — returns a set of "intents" the task implies. */
/** Pre-compiled intent-detection patterns (hoisted so they aren't reallocated on every call). */
const FORM_INTENT_RE = /\b(fill|submit|login|sign in|sign up|register|enter|form|password|email|username|checkout|pay)\b/;
const NAV_INTENT_RE = /\b(go to|open|navigate|visit|browse|click|link)\b/;
const SEARCH_INTENT_RE = /\b(search|find|look up|query|filter)\b/;
const READ_INTENT_RE = /\b(read|summarize|list|what|who|when|where|how many|tell me|give me|show me)\b/;

export function detectIntents(text: string): Set<"form" | "nav" | "search" | "read"> {
  const intents = new Set<"form" | "nav" | "search" | "read">();
  const t = text.toLowerCase();
  if (FORM_INTENT_RE.test(t)) {
    intents.add("form");
  }
  if (NAV_INTENT_RE.test(t)) {
    intents.add("nav");
  }
  if (SEARCH_INTENT_RE.test(t)) {
    intents.add("search");
  }
  if (READ_INTENT_RE.test(t)) {
    intents.add("read");
  }
  return intents;
}

/** Tag sets for each intent. */
const INTENT_TAGS: Record<"form" | "nav" | "search" | "read", Set<string>> = {
  form: new Set(["input", "textarea", "select", "button", "label", "option"]),
  nav: new Set(["a", "button"]),
  search: new Set(["input", "button", "a"]),
  read: new Set(["a", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "td", "article", "section"]),
};

/**
 * Score a single element against the keyword set + intents.
 *
 * Higher score = more relevant. Elements with score 0 are filtered out
 * (unless the summarizer falls back to "keep all" because too few elements
 * scored non-zero).
 */
export function scoreElement(
  el: ExtractedElement,
  keywords: Set<string>,
  intents: Set<"form" | "nav" | "search" | "read">,
): number {
  let score = 0;

 // Tag-based intent match.
  for (const intent of intents) {
    if (INTENT_TAGS[intent].has(el.tag)) {
      score += 1;
      break; // Don't double-count across intents.
    }
  }

 // Text/attribute keyword scoring only matters when there are keywords to
 // match against; skip the lowercasing/attribute-join entirely otherwise.
  if (keywords.size > 0) {
 // Text-based keyword match (highest weight — the element's accessible
 // name is the most direct signal of what it does).
    const textLower = (el.text ?? "").toLowerCase();
    for (const kw of keywords) {
      if (textLower.includes(kw)) {
        score += 3;
        break; // Don't double-count the same keyword.
      }
    }

 // Attribute-based keyword match (placeholder, aria-label, name, id, href,
 // value, type — these often carry task-relevant hints even when the
 // visible text doesn't).
    const attrStr = el.attributes
      ? Object.entries(el.attributes).map(([k, v]) => `${k}=${v}`).join(" ").toLowerCase()
      : "";
    if (attrStr) {
      for (const kw of keywords) {
        if (attrStr.includes(kw)) {
          score += 2;
          break;
        }
      }
    }
  }

  return score;
}

/** Default cap on the number of elements the summarizer keeps. */
export const DEFAULT_MAX_SUMMARIZED_ELEMENTS = 30;

/**
 * Bounded cap on how many elements we keep when falling back (too few keywords
 * matched). Even on fallback we must not return the FULL DOM — a bounded,
 * score-ordered subset is always smaller and still useful to the navigator.
 * Guarantees at least this many best-scored elements are surfaced, but never
 * the full DOM.
 */
export const FALLBACK_CAP_ELEMENTS = 50;

/** Default minimum `elementsText` length to trigger the summarizer at all. */
export const DEFAULT_MIN_HTML_LENGTH = 10_000;

/** Inputs to {@link summarizeDom}. */
export interface SummarizeDomInput {
  /** The user's original task description. */
  task: string;
  /** The current sub-goal the navigator is pursuing. */
  currentGoal: string;
  /** The interactive elements extracted from the page. */
  elements: ExtractedElement[];
  /** Max elements to keep (default {@link DEFAULT_MAX_SUMMARIZED_ELEMENTS}). */
  maxElements?: number;
}

/** Output of {@link summarizeDom}. */
export interface SummarizeDomOutput {
  /** The indices (1-based, matching `ExtractedElement.index`) that were kept. */
  keptIndices: number[];
  /** The filtered element objects (preserving their original `index`). */
  keptElements: ExtractedElement[];
  /** A short summary line describing why these elements were kept. */
  summary: string;
  /** Whether the summarizer fell back to "keep all" (too few non-zero scores). */
  fellBack: boolean;
}

/**
 * Filter the page's interactive elements down to the task-relevant subset.
 *
 * Steps:
 * 1. Extract keywords from `task` + `currentGoal`.
 * 2. Detect task intents (form / nav / search / read).
 * 3. Score every element against the keywords + intents.
 * 4. Keep the top `maxElements` by score (preserving original order).
 * 5. If fewer than ~5 elements scored non-zero, fall back to keeping all
 * (the summarizer is best-effort — returning too few elements is
 * worse than no filter at all, since the navigator can't act on what
 * it can't see).
 */
export function summarizeDom(input: SummarizeDomInput): SummarizeDomOutput {
  const { task, currentGoal, elements } = input;
  const maxElements = input.maxElements ?? DEFAULT_MAX_SUMMARIZED_ELEMENTS;

  const keywords = new Set<string>([
    ...extractKeywords(task),
    ...extractKeywords(currentGoal),
  ]);
  const intents = detectIntents(`${task} ${currentGoal}`);

 // Score every element.
  const scored = elements.map((el) => ({
    el,
    score: scoreElement(el, keywords, intents),
  }));

 // Keep the top N by score (preserve original order).
  const nonZero = scored.filter((s) => s.score > 0);
  const fellBack = nonZero.length < 5;
  const pool = fellBack ? scored : nonZero;
 // Sort by score desc, then by original index asc for stable ordering.
  pool.sort((a, b) => b.score - a.score || a.el.index - b.el.index);
 // When NOT falling back, cap at maxElements. When falling back (too few
 // task-relevant matches), we used to keep EVERY element — but that returns
 // the full DOM for zero savings while still paying the O(elements) scoring
 // pass, and the navigator silently ignores it anyway. Instead we still cap to
 // `maxElements` (ordered by score), guaranteeing a bounded, smaller-than-full
 // payload: returning fewer elements is always preferable to sending the
 // entire DOM. A fallback cap (`FALLBACK_CAP_ELEMENTS`) ensures we still surface a
 // reasonable number of the best elements rather than an over-aggressive 1-2.
  const cap = fellBack ? Math.max(maxElements, FALLBACK_CAP_ELEMENTS) : maxElements;
  const kept = pool.slice(0, cap);
 // Re-sort the kept set by index so the navigator sees them in DOM order.
  kept.sort((a, b) => a.el.index - b.el.index);

  const keptElements = kept.map((s) => s.el);
  const keptIndices = kept.map((s) => s.el.index);

  const intentStr = [...intents].join("+") || "none";
  const summary = fellBack
    ? `HTML summarizer: too few task-relevant matches — kept top ${kept.length}/${elements.length} elements by score (capped, not full DOM).`
    : `HTML summarizer: kept ${kept.length}/${elements.length} elements relevant to ${intentStr} intent (${keywords.size} keywords).`;

  return { keptIndices, keptElements, summary, fellBack };
}

/**
 * Render a filtered `elementsText` block from the kept elements.
 *
 * Mirrors the format the DOM extractor produces for the full
 * `elementsText` field: `[index]<tag attr="value" />text` per line. The `*`
 * (new-element) marker is dropped — the extractor's `isNew` flag isn't
 * threaded into this layer. The orchestrator swaps this filtered text into
 * the navigator request when the summarizer is enabled.
 */
/** Collapse runs of CR/LF into a single space for compact element text. */
function stripNewlines(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

/** HTML-attribute string escape (ampersand / angle brackets / quotes). */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderElementsText(keptElements: ExtractedElement[]): string {
  const lines: string[] = [];
  for (const el of keptElements) {
    const attrs = el.attributes
      ? Object.entries(el.attributes)
          .map(([k, v]) => `${escapeAttr(k)}="${escapeAttr(stripNewlines(v)).slice(0, 80)}"`)
          .join(" ")
      : "";
    const attrStr = attrs ? ` ${attrs}` : "";
    const textStr = el.text
      ? ` ${escapeAttr(stripNewlines(el.text)).slice(0, 80)}`
      : "";
    lines.push(`[${el.index}]<${el.tag}${attrStr} />${textStr}`);
  }
  return lines.join("\n");
}
