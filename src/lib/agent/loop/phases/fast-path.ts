/**
 * Measured simple-task fast path (deterministic classifier).
 *
 * For simple READ-ONLY tasks whose answer is exactly derivable from the
 * current page's own metadata (title / URL), the orchestrator can complete
 * on DIRECT evidence without spending an initial planner LLM call and
 * without capturing a screenshot. This module is the deterministic pre-check
 * that decides whether that evidence exists.
 *
 * Safety properties (conservative defaults — see `maybeRunFastPath` in
 * `orchestrator-helpers.ts` for the full gate list):
 *
 * - The classifier is EXACT: a task matches only when the normalized task
 *   text is one of the small, enumerated current-page-metadata questions.
 *   Vague or compound tasks ("what is this page, then click…") never match,
 *   so the fast path can never swallow a task that needs action.
 * - The evidence is the page's own title/URL — the SAME deterministic
 *   evidence the completion-with-evidence invariant accepts (like a passing
 *   deterministic evaluator). An empty title / missing URL is NOT evidence:
 *   the task falls back to the full planner path.
 * - The fast path only runs when `config.enableFastPath === true` (default
 *   false — off until measurement justifies enabling it) and never in
 *   `full_agentic` mode (safety modes are never silently downgraded).
 */

/**
 * The kind of current-page evidence the task is asking for.
 * - `title` — the task is answered by the page's document title.
 * - `url` — the task is answered by the page's current URL.
 * - `page` — the task asks which page this is; answered by title (preferred)
 *   or URL.
 */
export type CurrentPageTaskKind = "title" | "url" | "page";

/**
 * Decide whether a task can start with the Navigator instead of paying for a
 * separate planning call. This is deliberately narrower than a generic task
 * classifier: it admits only read-only, current-page questions and rejects
 * anything that implies mutation, transactions, multi-site research, or an
 * explicitly sequenced workflow. The Navigator still plans its immediate
 * action in its structured response; the Planner remains available on the
 * periodic/recovery paths.
 */
export function shouldUseDirectNavigatorStart(
  task: string,
  mode: "restricted" | "standard" | "full_agentic" | string | undefined,
): boolean {
  if (mode === "full_agentic" || typeof task !== "string") return false;
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 420) return false;

  const readOnlyIntent = /\b(what|which|who|when|where|how|find|report|tell|summari[sz]e|explain|identify|extract|read|list)\b/.test(normalized);
  if (!readOnlyIntent) return false;
  const currentPageAnchor = /\b(?:this|current)\b.{0,40}\b(?:page|article|site|document)\b/.test(normalized);
  if (!currentPageAnchor) return false;

  // These intents benefit materially from an up-front global plan or can
  // change external state. False negatives only cost one planner call; false
  // positives would reduce reliability, so keep this list conservative.
  const complexOrMutating = /\b(click|type|enter|fill|submit|send|post|publish|upload|download|delete|remove|edit|change|create|book|buy|purchase|pay|sign|log\s?in|register|apply|schedule|email|message|reply|compare|research|investigate|across|multiple|several|websites?|sources?|tabs?|then|after that|finally|spreadsheet|presentation|document|report\s+(?:with|from)\s+(?:multiple|several))\b/.test(normalized);
  if (complexOrMutating) return false;
  if (/\b(?:step\s*\d+|first\b.*\bthen\b|second\b.*\bthird\b)/.test(normalized)) return false;

  return true;
}

/** Positive fast-path verdict: direct evidence answers the task. */
export interface FastPathAnswer {
  answerable: true;
  kind: CurrentPageTaskKind;
  /** The final answer text (the completion evidence itself). */
  text: string;
}

/** Negative fast-path verdict: fall back to the full planner path. */
export interface FastPathNotAnswerable {
  answerable: false;
}

export type FastPathVerdict = FastPathAnswer | FastPathNotAnswerable;

/** Normalize a task for exact pattern matching (case + punctuation collapse). */
function normalizeTask(task: string): string {
  return task
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bwhat's\b/g, "what is")
    .replace(/[?!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Exact-match patterns over the NORMALIZED task. Each pattern is anchored and
// fully consumes the task, so a compound task (metadata question + action)
// never matches. `(?:page|tab|document)` covers the current-page vocabulary.
const TITLE_PATTERNS: RegExp[] = [
  /^what (?:is|'s) the title of (?:this|the current) (?:page|tab|document)$/,
  /^what (?:is|'s) the current (?:page|tab|document) title$/,
  /^what (?:is|'s) the (?:page|tab|document) title$/,
  /^what (?:is|'s) this (?:page|tab|document)['’]?s title$/,
  /^(?:the )?(?:page|tab|document) title$/,
];

const URL_PATTERNS: RegExp[] = [
  /^what (?:is|'s) the (?:url|address|link) of (?:this|the current) (?:page|tab)$/,
  /^what (?:is|'s) the current (?:url|address|link)$/,
  /^what (?:is|'s) the (?:page|tab) (?:url|address|link)$/,
  /^what (?:is|'s) this (?:page|tab)['’]?s (?:url|address|link)$/,
  /^(?:the )?current (?:url|address)$/,
];

const PAGE_PATTERNS: RegExp[] = [
  /^what page am i on$/,
  /^which page (?:am i on|is this)$/,
];

/**
 * Classify a task as a current-page metadata question. Returns the evidence
 * kind, or `null` when the task is NOT one of the exact patterns (falls back
 * to the full planner path). Deterministic — no LLM, no heuristics beyond the
 * enumerated patterns above.
 */
export function classifyCurrentPageTask(task: string): CurrentPageTaskKind | null {
  if (typeof task !== "string" || task.trim().length === 0) return null;
  const normalized = normalizeTask(task);
  if (TITLE_PATTERNS.some((re) => re.test(normalized))) return "title";
  if (URL_PATTERNS.some((re) => re.test(normalized))) return "url";
  if (PAGE_PATTERNS.some((re) => re.test(normalized))) return "page";
  return null;
}

/** The page's title is positive evidence only when it is non-empty. */
function titleEvidence(title: string): string | null {
  const trimmed = (title ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The page's URL is positive evidence only when it is a real http(s) URL. */
function urlEvidence(url: string): string | null {
  const trimmed = (url ?? "").trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * Build the fast-path verdict for a task against the current page's
 * title/URL. `answerable: true` ONLY when the classifier matched AND the
 * page provides the required non-empty evidence. Everything else is
 * `answerable: false` → the run falls back to the full planner path.
 */
export function buildFastPathAnswer(
  task: string,
  url: string,
  title: string,
): FastPathVerdict {
  const kind = classifyCurrentPageTask(task);
  if (kind === null) return { answerable: false };

  if (kind === "title") {
    const evidence = titleEvidence(title);
    if (evidence === null) return { answerable: false };
    return { answerable: true, kind, text: `The title of this page is "${evidence}".` };
  }

  if (kind === "url") {
    const evidence = urlEvidence(url);
    if (evidence === null) return { answerable: false };
    return { answerable: true, kind, text: `The current URL is ${evidence}.` };
  }

  // kind === "page" — prefer the title, fall back to the URL. Either is
  // direct evidence of which page the user is on.
  const pageTitle = titleEvidence(title);
  if (pageTitle !== null) {
    return { answerable: true, kind, text: `You are on the page "${pageTitle}".` };
  }
  const pageUrl = urlEvidence(url);
  if (pageUrl !== null) {
    return { answerable: true, kind, text: `You are on the page at ${pageUrl}.` };
  }
  return { answerable: false };
}
