/**
 * Element-resolution + DOM helpers used by the executor's handlers:
 *   - {@link resolveElement} — index → live `HTMLElement` from the browser state.
 *   - {@link isVisible} — local visibility check (used by `find_text` +
 *     `search_page`).
 *   - {@link safeScrollIntoView} — best-effort `scrollIntoView` that never
 *     throws (jsdom-safe).
 *   - {@link generateCssSelector} — used by the click fallback's strategy 3
 *     (re-find element by CSS selector); relies on the module-private
 *     `cssEscape` helper for identifier escaping.
 */

import type { BrowserState } from "../../types";

/**
 * Resolve an `[index]` to its live `HTMLElement` from the browser state's
 * selector map. Throws if the index is missing (the page may have changed
 * since extraction — the caller should re-extract state and retry).
 */
export function resolveElement(state: BrowserState, index: number): HTMLElement {
  const el = state.selectorMap[index];
  if (!el) throw new Error(`element [${index}] not found (page may have changed — extract state again)`);
  return el as HTMLElement;
}

/** Local visibility check used by `find_text` and `search_page`. */
export function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * Best-effort `scrollIntoView` that never throws.
 *
 * Real browsers implement `Element.prototype.scrollIntoView`, but some
 * non-browser environments used for testing (jsdom) don't — calling it
 * raises `TypeError: el.scrollIntoView is not a function`. Wrapping the
 * call in a typeof guard lets the executor run in those environments
 * without the click/input/hover/find_text actions failing before they
 * even reach their strategy fallbacks. In a real browser the guard is
 * always true and the call behaves identically to a direct
 * `el.scrollIntoView({...})`.
 */
export function safeScrollIntoView(el: HTMLElement): void {
  if (typeof el.scrollIntoView === "function") {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) {
      // Some environments implement scrollIntoView but reject the options
      // bag (older Edge / IE). Swallow — scrolling is best-effort — but
      // surface the error for observability so genuine runtime errors
      // (e.g. a getter throwing on a proxied element) aren't silently lost.
      if (typeof console !== "undefined" && typeof console.debug === "function") {
        console.debug("[executor] safeScrollIntoView failed (best-effort):", e);
      }
    }
  }
}

/**
 * Generate a CSS selector that uniquely identifies `el` (or comes close).
 * Used by the click fallback's strategy 3 (re-find element by selector).
 *
 * Strategy:
 *   1. If `el.id` is non-empty, return `#<escaped-id>`.
 *   2. Otherwise, build `tagname.class1.class2...` from the element's
 *      `tagName` + `classList`. If `classList` is empty, return just the tag.
 *
 * The returned selector is NOT guaranteed to be unique on the page — the
 * caller (strategy 3) handles the "matched multiple elements" case by
 * falling back to the next strategy.
 */
export function generateCssSelector(el: Element): string {
  if (el.id) {
    return `*[id="${cssEscape(el.id)}"]`;
  }
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).map((c) => `.${cssEscape(c)}`);
  return classes.length > 0 ? `${tag}${classes.join("")}` : tag;
}

/**
 * CSS-identifier escaper (defers to the platform `CSS.escape` when
 * available). Mirrors the `escapeCss` helper from `dom/dom-utils.ts` — kept
 * local to this module so the executor doesn't grow a cross-module import
 * for a 5-line helper.
 *
 * Module-private: `generateCssSelector` is the only consumer and is the
 * public entry point; `cssEscape` is not re-exported from the barrel.
 */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  // Minimal hand-rolled fallback (sufficient for typical id/class values).
  // Escape special characters the simple way.
  let escaped = s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  // A CSS identifier must not begin with a digit. `CSS.escape` emits a hex
  // code point followed by a space for a leading digit (e.g. "5item" ->
  // "\35 item"); mirror that here so jsdom/test environments (which lack
  // CSS.escape) still produce a valid, parseable selector.
  if (/^[0-9]/.test(escaped)) {
    escaped = "\\3" + escaped[0] + " " + escaped.slice(1);
  }
  return escaped;
}
