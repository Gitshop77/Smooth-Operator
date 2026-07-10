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

import { exactMatch, mustInclude } from "./string-evaluator";

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
 * instead of throwing.
 */
export function extractLocatorHtml(locator: string, pageHtml: string): string {
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

/** Evaluate every target; multiply per-target scores. */
export async function evaluateHtmlContent(
  input: HTMLContentEvaluatorInput,
): Promise<HTMLContentEvaluatorResult> {
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
      const cur = exactMatch(rc.exact_match, selected);
      score *= cur;
      if (cur === 0) reasons.push(`target[${i}].exact_match failed`);
    } else if (rc.must_include !== undefined) {
      for (const content of rc.must_include) {
        // ` |OR| ` alternatives — any match counts. Split on the ` |OR| `
        // separator (with surrounding spaces) so plain `|` characters in the
        // user's content survive intact (e.g. a requirement like
        // `"Login |OR| Sign in"` produces `["Login", "Sign in"]`).
        const alternatives = content
          .split(/\s\|OR\|\s/)
          .map((s) => s.trim())
          .filter(Boolean);
        // If all alternatives were empty strings (e.g. must_include: [""]),
        // `alternatives` is empty after filter(Boolean). Evaluating
        // `[].some(...)` = false would produce a spurious FAIL. An empty
        // must_include entry is a no-op (no requirement), not a failure.
        if (alternatives.length === 0) continue;
        const cur = alternatives.some((alt) => mustInclude(alt, selected) === 1) ? 1 : 0;
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

/** OOP wrapper kept for parity with the other evaluators. */
export class HTMLContentEvaluator {
  readonly tag = HTML_CONTENT_EVALUATOR_TAG;
  async evaluate(input: HTMLContentEvaluatorInput): Promise<HTMLContentEvaluatorResult> {
    return evaluateHtmlContent(input);
  }
}

// Re-export the string helpers we use internally so callers have one place
// to import everything HTML-content-related. (`cleanAnswer` is re-exported
// for parity — it's not used here but is useful for callers who want to
// normalize the page HTML before passing it in.)
