/**
 * Evaluator combinator — combines the three deterministic evaluators
 * (string / URL / HTML-content) into a single combined score.
 *
 * The combination rule is multiplication: 1.0 only if EVERY evaluator
 * returns 1.0. Each evaluator checks one aspect of task completion, and a
 * task is only "passed" when every aspect is satisfied.
 *
 * The orchestrator builds an `EvaluatorComb` directly (via the
 * `new EvaluatorComb(kinds)` constructor) from a task config's `eval_types`
 * list — `"string_match"`, `"url_match"`, `"program_html"`.
 */

import {
  StringEvaluator,
  type StringEvaluatorInput,
  type StringEvaluatorResult,
} from "./string-evaluator";
import {
  URLEvaluator,
  type URLEvaluatorInput,
  type URLEvaluatorResult,
} from "./url-evaluator";
import {
  HTMLContentEvaluator,
  type HTMLContentEvaluatorInput,
  type HTMLContentEvaluatorResult,
} from "./html-content-evaluator";

/** Discriminator for the three evaluator kinds. */
export type EvaluatorKind = "string_match" | "url_match" | "program_html";

/** Inputs to the combinator — one entry per evaluator kind. */
export interface EvaluatorCombInput {
  /** Optional string-match input. Skipped when `undefined`. */
  string?: StringEvaluatorInput;
  /** Optional URL-match input. Skipped when `undefined`. */
  url?: URLEvaluatorInput;
  /** Optional HTML-content input. Skipped when `undefined`. */
  html?: HTMLContentEvaluatorInput;
}

/** One evaluator's result (regardless of kind). */
export interface EvaluatorResult {
  /** 1.0 = pass, 0.0 = fail (we don't do partial credit). */
  score: number;
  /** Tag identifying which evaluator produced this result. */
  tag: string;
  /** Human-readable reason for a non-1.0 score (empty when score === 1). */
  reason: string;
}

/** Combined result from running an `EvaluatorComb`. */
export interface EvaluatorCombResult {
  /** Product of every evaluator's score (1.0 only if all pass). */
  score: number;
  /** Per-evaluator results, in evaluation order. */
  results: EvaluatorResult[];
  /** Human-readable reasons for the failing evaluators (empty when all pass). */
  reasons: string[];
}

/**
 * EvaluatorComb — runs every configured evaluator, multiplies scores.
 *
 * Holds the three deterministic evaluator instances so callers don't have
 * to construct them per call. Each `evaluate` invocation only runs the
 * evaluators whose input is present (others are skipped — they don't
 * contribute to the score).
 */
export class EvaluatorComb {
  /** Constructed once — re-used across calls. */
  private readonly stringEval = new StringEvaluator();
  private readonly urlEval = new URLEvaluator();
  private readonly htmlEval = new HTMLContentEvaluator();
  /** The kinds configured for this comb (for inspection / debugging). */
  readonly kinds: EvaluatorKind[];

  constructor(kinds: EvaluatorKind[] = []) {
    this.kinds = kinds;
  }

  /** Run every configured evaluator and multiply scores. */
  async evaluate(input: EvaluatorCombInput): Promise<EvaluatorCombResult> {
    const results: EvaluatorResult[] = [];
    const reasons: string[] = [];
    let score = 1.0;

    if (input.string) {
      const r: StringEvaluatorResult = this.stringEval.evaluate(input.string);
      results.push(r);
      score *= r.score;
      if (r.score < 1) reasons.push(r.reason);
    }
    if (input.url) {
      const r: URLEvaluatorResult = this.urlEval.evaluate(input.url);
      results.push(r);
      score *= r.score;
      if (r.score < 1) reasons.push(r.reason);
    }
    if (input.html) {
      const r: HTMLContentEvaluatorResult = await this.htmlEval.evaluate(input.html);
      results.push(r);
      score *= r.score;
      if (r.score < 1) reasons.push(r.reason);
    }

    return { score, results, reasons };
  }
}

// Re-export the individual evaluators + their input types so callers can
// import everything from a single module.
export {
  StringEvaluator,
  type StringEvaluatorInput,
  type StringEvaluatorResult,
  type StringReferenceAnswer,
} from "./string-evaluator";
export {
  URLEvaluator,
  type URLEvaluatorInput,
  type URLEvaluatorResult,
} from "./url-evaluator";
export {
  HTMLContentEvaluator,
  type HTMLContentEvaluatorInput,
  type HTMLContentEvaluatorResult,
  type HTMLContentTarget,
  type RequiredContents,
} from "./html-content-evaluator";
