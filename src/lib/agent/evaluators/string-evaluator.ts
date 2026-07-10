/**
 * String-evaluator — deterministic check of the agent's final answer against
 * a reference answer.
 *
 * Three matching modes (mirroring the canonical benchmark pattern):
 *   - `exact_match(ref, pred)` — case-insensitive, strips surrounding quotes.
 *   - `must_include(ref, pred)` — substring check; supports ` |OR| `
 *     alternatives. Each alternative must appear in the prediction for the
 *     overall score to be 1.0.
 *   - `regex_match(ref, pred)` — `ref` treated as a regular expression.
 *
 * Scores multiply across all entries in `referenceAnswers`: 1.0 only if every
 * entry passes. The evaluator is fully deterministic (no LLM call) — it is
 * the cheapest of the three evaluators and the easiest to reason about.
 */

/** Tag used by {@link StringEvaluator} when surfacing which check failed. */
export const STRING_EVALUATOR_TAG = "string_match";

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
export function exactMatch(ref: string, pred: string): number {
  return cleanAnswer(pred) === cleanAnswer(ref) ? 1 : 0;
}

/**
 * Must-include check — does `pred` contain `ref` (after cleaning)?
 *
 * When `tokenize` is true AND `ref` is a single word, uses whole-word
 * matching so `ref="0"` does NOT match `pred="10"`. Otherwise falls back
 * to a plain substring check.
 */
export function mustInclude(ref: string, pred: string, tokenize = false): number {
  const cr = cleanAnswer(ref);
  const cp = cleanAnswer(pred);
  if (tokenize && /^\S+$/.test(cr)) {
    const tokens = cp.split(/\s+/);
    return tokens.includes(cr) ? 1 : 0;
  }
  return cp.includes(cr) ? 1 : 0;
}

/** Regex check — does `pred` match the regex `ref` (anywhere)? */
export function regexMatch(ref: string, pred: string): number {
  try {
    const re = new RegExp(ref, "i");
    return re.test(pred) ? 1 : 0;
  } catch {
    // Invalid regex pattern — treat as no match (don't crash the evaluator).
    return 0;
  }
}

/** Evaluate the prediction against every reference answer; multiply scores. */
export function evaluateString(input: StringEvaluatorInput): StringEvaluatorResult {
  let score = 1.0;
  const reasons: string[] = [];
  for (const ref of input.referenceAnswers) {
    let cur: number;
    switch (ref.type) {
      case "exact_match":
        cur = exactMatch(ref.ref, input.prediction);
        break;
      case "must_include":
        cur = mustInclude(ref.ref, input.prediction, input.tokenize);
        break;
      case "regex":
        cur = regexMatch(ref.ref, input.prediction);
        break;
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

/** OOP wrapper kept for parity with the other evaluators. */
export class StringEvaluator {
  readonly tag = STRING_EVALUATOR_TAG;
  evaluate(input: StringEvaluatorInput): StringEvaluatorResult {
    return evaluateString(input);
  }
}
