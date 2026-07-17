/**
 * String-evaluator — deterministic check of the agent's final answer against
 * a reference answer.
 *
 * Three matching modes (mirroring the canonical benchmark pattern):
 * - `exact_match(ref, pred)` — case-insensitive, strips surrounding quotes.
 * - `must_include(ref, pred)` — substring check; supports ` |OR| `
 * alternatives (the prediction must contain ANY one of the alternatives).
 * - `regex_match(ref, pred)` — `ref` treated as a regular expression.
 *
 * Scores multiply across all entries in `referenceAnswers`: 1.0 only if every
 * entry passes. The evaluator is fully deterministic (no LLM call) — it is
 * the cheapest of the three evaluators and the easiest to reason about.
 *
 * NOTE: HTML content is compared RAW (case-sensitive, quotes preserved) via
 * {@link htmlExactMatch}/{@link htmlMustInclude} — see `html-content-evaluator`.
 */

/** Tag used by {@link StringEvaluator} when surfacing which check failed. */
export const STRING_EVALUATOR_TAG = "string_match";

/**
 * Maximum prediction length fed to a `regex` match. Config-supplied patterns
 * are already validated/length-capped/bounded against catastrophic constructs
 * by the schema, but large inputs still widen the ReDoS window — capping the
 * subject bounds the worst case. Predictions longer than this are matched
 * against their prefix only.
 */
const MAX_REGEX_INPUT_CHARS = 200_000;

/** A single reference-answer entry — one of three matching modes. */
export interface StringReferenceAnswer {
  /** Discriminator for which match strategy to use. */
  type: "exact_match" | "must_include" | "regex";
  /** The reference string (or regex pattern when `type === "regex"`). */
  ref: string;
}

/** Inputs to {@link StringEvaluator.evaluate}. */
export interface StringEvaluatorInput {
  /** The agent's final answer / extracted text (the "prediction"). */
  prediction: string;
  /** One or more reference answers; the overall score is the product. */
  referenceAnswers: StringReferenceAnswer[];
  /**
 * When true, `must_include` performs word-boundary matching to avoid
 * false positives like `ref="0"` matching `"10"`. Default `false`.
 */
  tokenize?: boolean;
}

/** Result of a single {@link StringEvaluator.evaluate} call. */
export interface StringEvaluatorResult {
  /** 1.0 = full match, 0.0 = no match (we don't do partial credit). */
  score: number;
  /** Tag identifying which evaluator produced this result. */
  tag: string;
  /** Human-readable reason for a non-1.0 score (empty when score === 1). */
  reason: string;
}

/**
 * Clean an answer for case-insensitive, quote-insensitive comparison.
 *
 * Strips leading/trailing whitespace and a single pair of surrounding single
 * or double quotes (so `"yes"` matches `yes`). Lowercases the result.
 */
export function cleanAnswer(answer: string): string {
  let s = answer.trim();
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    s = s.slice(1, -1);
  }
  return s.toLowerCase();
}

/** Exact-match check (case-insensitive, quote-stripped). Returns 1 or 0. */
export function exactMatch(ref: string, pred: string, predClean?: string): number {
  return (predClean ?? cleanAnswer(pred)) === cleanAnswer(ref) ? 1 : 0;
}

/**
 * Split a `must_include` reference into ` |OR| ` alternatives. Returns the
 * trimmed, non-empty parts. Empty after filtering (e.g. an empty entry) → [].
 */
export function splitOrAlternatives(ref: string): string[] {
  return ref
    .split(/\s\|OR\|\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Must-include check — does `pred` contain `ref` (after cleaning)?
 *
 * `ref` may use ` |OR| ` to list alternatives; the prediction must contain
 * ANY one of them (matches the HTML evaluator's semantics). When `tokenize`
 * is true AND every alternative is a single word, uses whole-word matching so
 * `ref="0"` does NOT match `pred="10"`. Otherwise falls back to a plain
 * substring check. An empty reference (no alternatives) is a no-op → 1.
 */
export function mustInclude(ref: string, pred: string, tokenize = false, predClean?: string): number {
  const cp = predClean ?? cleanAnswer(pred);
  const alternatives = splitOrAlternatives(ref).map(cleanAnswer);
  if (alternatives.length === 0) return 1;
  if (tokenize && alternatives.every((a) => /^\S+$/.test(a))) {
    const tokens = cp.split(/\s+/);
    return alternatives.some((a) => tokens.includes(a)) ? 1 : 0;
  }
  return alternatives.some((a) => cp.includes(a)) ? 1 : 0;
}

/**
 * HTML exact-match — RAW string equality (case-sensitive, quotes preserved).
 *
 * Unlike {@link exactMatch}, this does NOT lower-case or strip quotes, because
 * HTML element text and attribute values are case-sensitive. Whitespace at the
 * very start/end of either side is trimmed so config authoring artifacts don't
 * cause spurious failures.
 */
export function htmlExactMatch(ref: string, html: string): number {
  return html.trim() === ref.trim() ? 1 : 0;
}

/**
 * HTML must-include — RAW substring check (case-sensitive, quotes preserved).
 *
 * Splits the reference on ` |OR| ` so an entry like `"Login |OR| Sign in"`
 * passes if the HTML contains EITHER alternative. Empty entries are no-ops.
 */
export function htmlMustInclude(ref: string, html: string): number {
  const alternatives = splitOrAlternatives(ref);
  if (alternatives.length === 0) return 1;
  return alternatives.some((alt) => html.includes(alt)) ? 1 : 0;
}

/**
 * Deterministic evaluator — checks the agent's final answer against a list of
 * reference answers (three matching modes) and returns a 0/1 score that is the
 * product of all entries.
 *
 * `exactMatch` / `mustInclude` are applied per-entry; regex matching is inlined
 * in the `regex` case below. See {@link StringReferenceAnswer} for the
 * supported `type` discriminators.
 */
export class StringEvaluator {
  readonly tag = STRING_EVALUATOR_TAG;

  evaluate(input: StringEvaluatorInput): StringEvaluatorResult {
 // Fail CLOSED on an empty reference-answer list: with no assertions there
 // is nothing to grade, so the default 1.0 would silently pass a task that
 // was never checked. Mirrors the HTML-content empty-targets guard and the
 // evaluator-combination empty-kinds guard.
    if (input.referenceAnswers.length === 0) {
      return {
        score: 0,
        tag: STRING_EVALUATOR_TAG,
        reason: "no reference answers configured — failing closed",
      };
    }
    let score = 1.0;
    const reasons: string[] = [];
    const cleanPred = cleanAnswer(input.prediction);
    for (const ref of input.referenceAnswers) {
      let cur: number;
      switch (ref.type) {
        case "exact_match":
          cur = exactMatch(ref.ref, input.prediction, cleanPred);
          break;
        case "must_include":
          cur = mustInclude(ref.ref, input.prediction, input.tokenize, cleanPred);
          break;
        case "regex": {
 // Invalid regex pattern — treat as no match (don't crash).
 // An empty/whitespace-only pattern compiles to `new RegExp("")` which matches
 // ANY subject, so a degenerate reference would silently always pass. Fail
 // CLOSED instead — a mis-authored pattern must never grade a task complete.
          if (!ref.ref || !ref.ref.trim()) {
            cur = 0;
            break;
          }
          try {
            const re = new RegExp(ref.ref, "i");
 // Bound the subject length to limit ReDoS exposure (see
 // MAX_REGEX_INPUT_CHARS). The schema already rejects the worst
 // nested-quantifier patterns and caps pattern length.
            const subject =
              input.prediction.length > MAX_REGEX_INPUT_CHARS
                ? input.prediction.slice(0, MAX_REGEX_INPUT_CHARS)
                : input.prediction;
            cur = re.test(subject) ? 1 : 0;
          } catch {
            cur = 0;
          }
          break;
        }
        default:
          cur = 0;
          reasons.push(`unknown match type`);
          break;
      }
      score *= cur;
      if (cur === 0) {
        reasons.push(`${ref.type}("${ref.ref.slice(0, 60)}") failed`);
      }
    }
    return {
      score,
      tag: STRING_EVALUATOR_TAG,
      reason: reasons.join("; "),
    };
  }
}
