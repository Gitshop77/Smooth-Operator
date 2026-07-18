/**
 * HTML-content-evaluator — deterministic check of page DOM content against
 * a list of required contents.
 *
 * For each target entry, the evaluator:
 * 1. Optionally selects a sub-element via a CSS selector (or
 * `document.querySelector`-style JS snippet). When the selector is
 * empty, the whole page HTML is matched.
 * 2. Matches `required_contents` against the extracted HTML using either
 * `exact_match` (string equality) and/or `must_include` (each entry must
 * appear; supports ` |OR| ` alternatives). Both may be set on one target —
 * when they are, both constraints are enforced (logical AND).
 *
 * Scores multiply across all targets + all required contents.
 *
 * Fail-closed on extraction warnings: when a locator cannot be extracted
 * (unsupported `document.*` snippet without a resolver, missing `DOMParser`,
 * or an invalid selector) the affected target scores 0 by default rather than
 * risking a false PASS. This matters because a degenerate spec such as
 * `exact_match: ""` (or a `must_include` of empty / ` |OR| ` entries) trivially
 * matches the empty extraction and would otherwise score 1.0. Callers that
 * knowingly accept that risk can opt in via `failOpenOnExtractionWarning`.
 *
 * SECURITY / injection-bypass tradeoff: this evaluator grades the RAW page
 * HTML, so page-controlled content (attacker- or model-injected markup that
 * happens to contain the `required_contents` strings) can satisfy the grading
 * gate. This is by design — the evaluator is a deterministic content check, not
 * a trust boundary. Do NOT use it as a security gate on untrusted pages; treat
 * a passing score as "the expected text is present in the DOM", not "the page
 * is benign".
 */

import { htmlExactMatch, htmlMustInclude, splitOrAlternatives } from "./string-evaluator";

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
 * - empty locator → `pageHtml` (whole-page match), or
 * - non-empty locator → the first match of the CSS selector against
 * `pageHtml`, extracted via a `DOMParser` (when available in the
 * runtime), or "" when the selector doesn't match.
 *
 * The callback form lets the caller plug in a real browser tab (Chrome
 * extension content script) or a Playwright `page.evaluate` call.
 */
  resolveLocator?: (locator: string, pageHtml: string) => string | Promise<string>;
  /**
 * When `true`, extraction warnings (unsupported `document.*` snippet without
 * a resolver, missing `DOMParser`, invalid selector) are treated as
 * diagnostics only — the target is still graded against the (empty)
 * extraction, so a degenerate spec like `exact_match: ""` can PASS.
 *
 * Defaults to `false` (fail-closed): a warned target scores 0 so a
 * misconfigured/undextractable locator can never masquerade as a pass.
 * Only enable this if you understand and accept the false-PASS risk.
 */
  failOpenOnExtractionWarning?: boolean;
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
/** Result of attempting to extract HTML for a locator. */
interface ExtractResult {
  /** The extracted HTML ("" when it didn't match / couldn't be extracted). */
  html: string;
  /**
 * When non-empty, explains WHY extraction produced no HTML — distinct from a
 * genuine content miss. Surfaces config/runtime problems (a `document.*` JS
 * snippet without a `resolveLocator` callback, a missing `DOMParser`, or an
 * invalid CSS selector) so a failing evaluator can be diagnosed instead of
 * being silently confused with a real content mismatch.
 */
  warning?: string;
}

function extractLocatorHtml(
  locator: string,
  pageHtml: string,
  doc: Document | null,
): ExtractResult {
  if (!locator?.trim()) return { html: pageHtml };
 // Only attempt the DOMParser path when the locator looks like a CSS
 // selector (the original benchmark also supported `document.…` JS snippets
 // + `func:...` helpers, but those require a real DOM and are routed
 // through the `resolveLocator` callback by the caller).
  if (locator.startsWith("document.") || locator.startsWith("[...document.")) {
 // We can't safely `eval` arbitrary JS here — the caller must pass a
 // `resolveLocator` callback for these cases. Without one, the target can
 // never match, so report a warning rather than a silent empty result.
    return {
      html: "",
      warning:
        `locator "${locator}" is a document.* JS snippet, which requires a ` +
        `resolveLocator callback; without one it can never match (target always fails).`,
    };
  }
  if (doc === null) {
    return {
      html: "",
      warning:
        "DOMParser is unavailable in this runtime, so CSS selectors cannot be " +
        "evaluated (target always fails).",
    };
  }
  try {
    const el = doc.querySelector(locator);
    if (!el) return { html: "" }; // genuine content miss — no warning
    return { html: el.innerHTML };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      html: "",
      warning: `invalid CSS selector "${locator}" (${msg}); target always fails.`,
    };
  }
}

/** Bound on {@link HTMLContentEvaluator.warnedLocators} so it cannot grow unbounded across a long session. */
const MAX_WARNED_LOCATORS = 256;

/**
 * Deterministic evaluator — checks page DOM content against a list of required
 * contents; returns a 0/1 score that is the product of every target's score.
 */
export class HTMLContentEvaluator {
  readonly tag = HTML_CONTENT_EVALUATOR_TAG;

  /**
   * Locators whose extraction warning has already been logged. Keeps the
   * per-`evaluate()` diagnostic from spamming the console on every pass of a
   * task loop when a locator is permanently broken — the failure is still
   * recorded in the returned `reasons` every time.
   */
  private readonly warnedLocators = new Map<string, true>();

  async evaluate(input: HTMLContentEvaluatorInput): Promise<HTMLContentEvaluatorResult> {
 // Fail CLOSED on an empty target list: with no targets there is nothing to
 // grade, so the default 1.0 would silently pass a task that was never
 // checked. This mirrors the extraction-warning fail-closed path below.
    if (input.targets.length === 0) {
      return {
        score: 0,
        tag: HTML_CONTENT_EVALUATOR_TAG,
        reason: "no HTML-content targets configured — failing closed",
      };
    }
    let score = 1.0;
    const reasons: string[] = [];
 // Parse the page HTML once when we are grading locators locally (no
 // `resolveLocator`). The same `Document` is then reused for every target,
 // instead of re-parsing the whole page HTML per target.
    const useLocalDoc = input.resolveLocator === undefined;
    const doc =
      useLocalDoc && typeof DOMParser !== "undefined"
        ? new DOMParser().parseFromString(input.pageHtml, "text/html")
        : null;
    for (let i = 0; i < input.targets.length; i++) {
      const target = input.targets[i];
      const rc = target.required_contents;

 // Extract the selected HTML (via the caller's resolver, or our local
 // CSS-selector extractor). Capture any extraction warning separately so
 // it isn't mistaken for a content mismatch.
      const scoreBefore = score;
      let selected = "";
      let extractWarn: string | undefined;
      if (input.resolveLocator !== undefined) {
        try {
          selected = (await input.resolveLocator(target.locator ?? "", input.pageHtml)) ?? "";
        } catch (e) {
          selected = "";
          extractWarn = `resolveLocator threw: ${e instanceof Error ? e.message : String(e)}`;
        }
      } else {
        const r = extractLocatorHtml(target.locator ?? "", input.pageHtml, doc);
        selected = r.html;
        extractWarn = r.warning;
      }
      if (extractWarn) {
 // Observable diagnostic — a misconfigured locator yields a permanent
 // FAIL that should never masquerade as a genuine task failure. Only log
 // the first time we see a given locator so a broken locator doesn't
 // spam the console on every pass of a task loop (the failure still
 // contributes to `reasons` below on every iteration).
        const locKey = target.locator ?? "";
        if (!this.warnedLocators.has(locKey)) {
          if (this.warnedLocators.size >= MAX_WARNED_LOCATORS) {
            const oldest = this.warnedLocators.keys().next().value;
            if (oldest !== undefined) this.warnedLocators.delete(oldest);
          }
          this.warnedLocators.set(locKey, true);
          console.warn(`[html-content-evaluator] target[${i}] extraction warning: ${extractWarn}`);
        }
      }

      const hasExact = rc.exact_match !== undefined;
      const hasInclude = rc.must_include !== undefined;
      if (!hasExact && !hasInclude) {
 // No required_contents specified — skip (don't multiply by 0).
        continue;
      }

 // Fail CLOSED on extraction warnings: a misconfigured / undextractable
 // locator must never PASS. Without this, a degenerate spec such as
 // `exact_match: ""` (or a `must_include` of empty / ` |OR| ` entries)
 // would score 1.0 against the empty extraction, silently turning a broken
 // selector into a pass. Callers can opt out via
 // `failOpenOnExtractionWarning` when they accept that risk.
      if (extractWarn && input.failOpenOnExtractionWarning !== true) {
        score *= 0;
        reasons.push(`target[${i}] extraction issue (failing closed): ${extractWarn}`);
        break; // score is now 0; nothing later can raise it
      }

      if (hasExact && hasInclude) {
 // Config ambiguity: both constraints set. Enforce BOTH (logical AND)
 // so neither requirement is silently dropped on a misconfigured task.
        console.warn(
          `[html-content-evaluator] target[${i}] sets BOTH exact_match and ` +
            `must_include; enforcing both (AND).`,
        );
      }

      if (hasExact) {
 // RAW, case-sensitive equality (HTML text/attributes are case-sensitive;
 // reusing the answer-cleaning `exactMatch` would wrongly pass
 // `"<Div>"` against `<div>` and silently strip quotes).
        const cur = htmlExactMatch(rc.exact_match!, selected);
        score *= cur;
        if (cur === 0) reasons.push(`target[${i}].exact_match failed`);
      }
      if (hasInclude) {
 // A `must_include` list that is empty ([]) or contains only blank /
 // ` |OR| ` alternatives asserts nothing — every entry would be a no-op
 // and the target would silently PASS at score 1.0. That is the exact
 // zero-evidence false-pass the empty-targets guard was added to
 // prevent, so fail CLOSED here when there is no exact_match either.
        let effectiveAssertions = 0;
        for (const content of rc.must_include!) {
          effectiveAssertions += splitOrAlternatives(content).length;
        }
        if (effectiveAssertions === 0 && !hasExact) {
          score *= 0;
          reasons.push(
            `target[${i}].must_include has no effective assertions — failing closed`,
          );
          break;
        }
        for (const content of rc.must_include!) {
 // `htmlMustInclude` compares RAW (case-sensitive, quotes preserved)
 // and honors ` |OR| ` alternatives as a pass-if-any. An empty entry
 // is a no-op (no requirement), not a failure.
          const cur = htmlMustInclude(content, selected);
          score *= cur;
          if (cur === 0) {
            reasons.push(`target[${i}].must_include("${content.slice(0, 60)}") failed`);
          }
        }
      }

 // If this target failed to match AND extraction itself was problematic,
 // surface the root cause once so operators can distinguish a bad
 // selector / unsupported runtime from a real content mismatch.
      if (extractWarn && score < scoreBefore) {
        reasons.push(`target[${i}] extraction issue: ${extractWarn}`);
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
