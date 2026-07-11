/**
 * HTML-content-evaluator — deterministic check of page DOM content against
 * a list of required contents.
 *
 * For each target entry, the evaluator:
 *   1. Optionally selects a sub-element via a CSS selector (or
 *      `document.querySelector`-style JS snippet). When the selector is
 *      empty, the whole page HTML is matched.
 *   2. Matches `required_contents` against the extracted HTML using either
 *      `exact_match` (string equality) or `must_include` (each entry must
 *      appear; supports ` |OR| ` alternatives).
 *
 * Scores multiply across all targets + all required contents.
 */

import { htmlExactMatch, htmlMustInclude } from "./string-evaluator";

/** Tag used by {@link HTMLContentEvaluator} when surfacing which check failed. */
export const HTML_CONTENT_EVALUATOR_TAG = "program_html";

/** Required-contents spec — one of `exact_match` or `must_include`. */
export interface RequiredContents {
  /** When `exact_match`: the selected HTML must equal this string. */
  exact_match?: string;
  /** When `must_include`: each entry must appear in the selected HTML. */
  must_include?: string[];
}

/** A single HTML-content target — extract text from `locator`, then match. */
export interface HTMLContentTarget {
  /**
   * CSS selector used to extract the relevant sub-element. When empty,
   * the whole page HTML is used. (The original benchmark supported
   * `document.querySelector(...)`-style JS snippets + `func:...` helpers
   * — we expose a `evaluator` callback on the input for those cases.)
   */
  locator?: string;
  /** Required-contents spec applied to the extracted HTML. */
  required_contents: RequiredContents;
}

/** Inputs to {@link HTMLContentEvaluator.evaluate}. */
export interface HTMLContentEvaluatorInput {
  /**
   * The full HTML of the page that should be checked. The caller is
   * responsible for navigating to the right page before extracting the
   * HTML — this evaluator is pure (no DOM access).
   */
  pageHtml: string;
  /**
   * Optional callback that returns the HTML for a given target's locator.
   * When omitted, the evaluator falls back to:
   *   - empty locator → `pageHtml` (whole-page match), or
   *   - non-empty locator → the first match of the CSS selector against
   *     `pageHtml`, extracted via a `DOMParser` (when available in the
   *     runtime), or "" when the selector doesn't match.
   *
   * The callback form lets the caller plug in a real browser tab (Chrome
   * extension content script) or a Playwright `page.evaluate` call.
   */
  resolveLocator?: (locator: string, pageHtml: string) => string | Promise<string>;
  /** The list of HTML-content targets to evaluate. */
  targets: HTMLContentTarget[];
}

/** Result of a single {@link HTMLContentEvaluator.evaluate} call. */
export interface HTMLContentEvaluatorResult {
  /** Product of every target's per-target score (1.0 only if all pass). */
  score: number;
  /** Tag identifying which evaluator produced this result. */
  tag: string;
  /** Human-readable reason for a non-1.0 score (empty when score === 1). */
  reason: string;
}

/**
 * Extract the HTML for a given CSS locator from a full-page HTML string.
 *
 * Uses `DOMParser` when available (browser / jsdom). When the locator is
 * empty, returns the full page HTML. When the runtime doesn't expose
 * `DOMParser`, returns "" so the evaluator surfaces a clean "no match"
 * instead of throwing. Kept private — only the {@link HTMLContentEvaluator}
 * class uses it.
 */
function extractLocatorHtml(locator: string, pageHtml: string): string {
  if (!locator?.trim()) return pageHtml;
  // Only attempt the DOMParser path when the locator looks like a CSS
  // selector (the original benchmark also supported `document.…` JS snippets
  // + `func:...` helpers, but those require a real DOM and are routed
  // through the `resolveLocator` callback by the caller).
  if (locator.startsWith("document.") || locator.startsWith("[...document.")) {
    // We can't safely `eval` arbitrary JS here — the caller should pass a
    // `resolveLocator` callback for these cases.
    return "";
  }
  if (typeof DOMParser === "undefined") return "";
  try {
    const doc = new DOMParser().parseFromString(pageHtml, "text/html");
    const el = doc.querySelector(locator);
    return el ? el.innerHTML : "";
  } catch {
    return "";
  }
}

/**
 * Deterministic evaluator — checks page DOM content against a list of required
 * contents; returns a 0/1 score that is the product of every target's score.
 */
export class HTMLContentEvaluator {
  readonly tag = HTML_CONTENT_EVALUATOR_TAG;

  async evaluate(input: HTMLContentEvaluatorInput): Promise<HTMLContentEvaluatorResult> {
    let score = 1.0;
    const reasons: string[] = [];
    for (let i = 0; i < input.targets.length; i++) {
      const target = input.targets[i];
      const selected =
        input.resolveLocator !== undefined
          ? await input.resolveLocator(target.locator ?? "", input.pageHtml)
          : extractLocatorHtml(target.locator ?? "", input.pageHtml);
      const rc = target.required_contents;
      if (rc.exact_match !== undefined) {
        // RAW, case-sensitive equality (HTML text/attributes are case-sensitive;
        // reusing the answer-cleaning `exactMatch` would wrongly pass
        // `"<Div>"` against `<div>` and silently strip quotes).
        const cur = htmlExactMatch(rc.exact_match, selected);
        score *= cur;
        if (cur === 0) reasons.push(`target[${i}].exact_match failed`);
      } else if (rc.must_include !== undefined) {
        for (const content of rc.must_include) {
          // `htmlMustInclude` compares RAW (case-sensitive, quotes preserved)
          // and honors ` |OR| ` alternatives as a pass-if-any. An empty entry
          // is a no-op (no requirement), not a failure.
          const cur = htmlMustInclude(content, selected);
          score *= cur;
          if (cur === 0) {
            reasons.push(`target[${i}].must_include("${content.slice(0, 60)}") failed`);
          }
        }
      } else {
        // No required_contents specified — skip (don't multiply by 0).
      }
      // Defensive: ensure we never produce a negative score from float math.
      if (score <= 0) break;
    }
    return {
      score,
      tag: HTML_CONTENT_EVALUATOR_TAG,
      reason: reasons.join("; "),
    };
  }
}

// This module exposes the {@link HTMLContentEvaluator} class. It imports the
// `htmlExactMatch` / `htmlMustInclude` helpers from `./string-evaluator` (used
// in the `evaluate` method above) to perform RAW, case-sensitive per-target
// content checks — deliberately NOT the answer-cleaning string helpers, so HTML
// matching honors case and surrounding quotes.
