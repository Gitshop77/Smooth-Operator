/** Result of attempting to extract HTML for a locator. */
interface ExtractResult {
  /** The extracted HTML ("" when it didn't match / couldn't be extracted). */
  html: string;
  /**
   * When non-empty, explains WHY extraction produced no HTML — distinct from a
   * genuine content miss. Surfaces config/runtime problems (a `document.*` JS
   * snippet, a missing `DOMParser`, or an invalid CSS selector) so a failing
   * evaluator can be diagnosed instead of being silently confused with a real
   * content mismatch.
   */
  warning?: string;
}

/**
 * Extract the HTML for a given CSS locator from a full-page HTML string.
 *
 * Uses `DOMParser` when available (browser / jsdom). When the locator is
 * empty, returns the full page HTML. When the runtime doesn't expose
 * `DOMParser`, returns "" so the evaluator surfaces a clean "no match"
 * instead of throwing.
 */
export function extractLocatorHtml(
  locator: string,
  pageHtml: string,
  doc: Document | null,
): ExtractResult {
  if (!locator?.trim()) return { html: pageHtml };
  // Only attempt the DOMParser path when the locator looks like a CSS
  // selector (the original benchmark also supported `document.…` JS snippets
  // + `func:...` helpers, but those require executing JS in a real DOM and
  // are NOT supported by this pure evaluator).
  if (locator.startsWith("document.") || locator.startsWith("[...document.")) {
  // We can't safely `eval` arbitrary JS here, so these locators can never
  // match — report a warning rather than a silent empty result.
    return {
      html: "",
      warning:
        `locator "${locator}" is a document.* JS snippet, which this ` +
        `evaluator does not support; it can never match (target always fails).`,
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
