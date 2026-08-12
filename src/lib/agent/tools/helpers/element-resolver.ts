/**
 * Element-resolution + DOM helpers used by the executor's handlers:
 * - {@link resolveElement} — index → live `HTMLElement` from the browser state.
 * - {@link isVisible} — local visibility check (used by `find_text` +
 * `search_page`).
 * - {@link safeScrollIntoView} — best-effort `scrollIntoView` that never
 * throws (jsdom-safe).
 * - {@link generateCssSelector} — used by the click fallback's strategy 3
 * (re-find element by CSS selector); relies on the module-private
 * `cssEscape` helper for identifier escaping.
 */

import type { BrowserState } from "../../types";
import { NoSuchElementException } from "../../errors";
import { elementIdentity } from "../../dom/extraction/element-info";

/**
 * Resolve an `[index]` to its live `HTMLElement` from the browser state's
 * selector map. Throws if the index is missing (the page may have changed
 * since extraction — the caller should re-extract state and retry).
 *
 * ## Stale-element guard (identity verification)
 *
 * Beyond the structural checks below, when the state carries the identities
 * captured at OBSERVATION time (`state.elementIdentities[index]`), the live
 * element's identity is recomputed and compared. `elementIdentity` covers the
 * tag, key attributes (`role`/`type`/`name`/`id`/`placeholder`/`aria-label`/
 * `href`/`for`) and the branch path (nth-of-type chain), so:
 * - a node REPLACED since extraction fails the `isConnected` check above
 *   (the old reference is detached); and
 * - a node that is still connected but whose identity-affecting attributes or
 *   position changed (SPA re-render, list re-order, button relabeled) fails
 *   the identity comparison — the snapshot the agent saw no longer matches
 *   the live element, so acting on it could target the wrong control.
 *
 * The identity guard is fail-closed: a mismatch throws the same
 * `NoSuchElementException` the loop's retry contract expects ("extract state
 * again"), never operating on a possibly-stale element.
 */
export function resolveElement(state: BrowserState, index: number): HTMLElement {
  const el = state.selectorMap[index];
 // `selectorMap` values are typed `unknown`, so a corrupted / incorrectly
 // populated entry must be caught here rather than failing later as an opaque
 // "el.scrollIntoView is not a function" deep in a handler. Throwing the
 // typed `NoSuchElementException` lets the executor branch on it and re-extract
 // state (the documented "element disappeared" → retry contract).
  if (el === undefined || el === null) {
    throw new NoSuchElementException(
      `element [${index}] not found (page may have changed — extract state again)`,
    );
  }
 // Feature-detect the DOM global so this helper can't throw
 // `ReferenceError: HTMLElement is not defined` if it is ever invoked in a
 // non-DOM context (e.g. the MV3 service worker). In a real page `HTMLElement`
 // is always present, so page-side behavior is unchanged.
  if (typeof HTMLElement !== "undefined") {
    if (!(el instanceof HTMLElement)) {
      throw new NoSuchElementException(
        `element [${index}] is not an HTMLElement (got ${(el as object).constructor.name})`,
      );
    }
    // A live reference that is no longer connected to the document (removed /
    // re-rendered since extraction) must not be operated on — dispatching
    // events or clicking a detached node is a silent no-op reported as
    // success. Fail with the same "element disappeared" contract so the
    // executor re-extracts state and retries.
    if (!el.isConnected) {
      throw new NoSuchElementException(
        `element [${index}] is detached from the document (page may have changed — extract state again)`,
      );
    }
    // Identity fingerprint check: the element the agent referenced must be the
    // SAME element it observed. A node that is still connected but has changed
    // identity since extraction (relabeled / re-ordered / attribute-swapped by
    // an SPA) must fail closed rather than receive the action.
    const observed = state.elementIdentities?.[index];
    if (observed !== undefined) {
      try {
        if (elementIdentity(el) !== observed) {
          throw new NoSuchElementException(
            `element [${index}] changed since extraction (page may have changed — extract state again)`,
          );
        }
      } catch (e) {
        // A DOM exception while recomputing identity (e.g. the node was
        // invalidated mid-check) is treated as a stale element — fail closed.
        if (e instanceof NoSuchElementException) throw e;
        throw new NoSuchElementException(
          `element [${index}] identity could not be verified (page may have changed — extract state again)`,
        );
      }
    }
    return el;
  }
  // Non-DOM context (e.g. the MV3 service worker): this helper is only ever
  // invoked from a DOM context at runtime, so the element type can't be
  // validated here — return it as-is (the cast is safe because callers only
  // run this in a real page).
  return el as HTMLElement;
}

/** `checkVisibility` is Baseline since March 2024 and avoids the forced style
 *  recalc of `getComputedStyle` in the `find_text`/`search_page` hot loops. */
const SUPPORTS_CHECK_VISIBILITY =
  typeof Element !== "undefined" && typeof Element.prototype.checkVisibility === "function";

function styleHiddenByComputedStyle(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return true;
  if (parseFloat(style.opacity) === 0) return true;
  return false;
}

/** Local visibility check used by `find_text` and `search_page`. */
export function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
 // Rendered (non-zero box) is necessary but not sufficient: `getBoundingClientRect`
 // is viewport-relative, so an element scrolled fully off-screen still reports a
 // positive size. Callers (`find_text`, `search_page`) use this to decide whether
 // to scroll an element into view, so we also require viewport intersection.
  if (rect.width <= 0 && rect.height <= 0) return false;
 // `isVisible` always runs in a DOM context (it takes an `HTMLElement`), so the
 // viewport dimensions are always available. An off-screen element is not visible
 // regardless of its computed style, so we reject it BEFORE the (more expensive)
 // style check below — this trims forced style/layout flushes in the
 // `find_text`/`search_page` hot loops (and avoids a burst of `getComputedStyle`
 // calls that reads as an automation signal).
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const inViewport = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  if (!inViewport) return false;
 // Elements inside an `[inert]` subtree are not focusable or clickable for real
 // users/AT — surfacing or clicking them would be both an a11y gap and a
 // correctness issue (clicks on inert elements are no-ops). A fast attribute
 // lookup (no style/layout flush) excludes only genuinely non-interactable nodes.
  if (el.closest("[inert]")) return false;
  if (SUPPORTS_CHECK_VISIBILITY) {
    // Native style-skip check: display/visibility/opacity/hidden in one walk,
    // without forcing per-element style recalc.
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }
  return !styleHiddenByComputedStyle(el);
}

/**
 * Rendered-only visibility check (no viewport requirement), used by
 * `find_text`. An element with a non-zero box that is not hidden by
 * display/visibility/opacity/inert is *rendered* even when scrolled below the
 * fold; `isVisible` additionally requires viewport intersection, which made
 * `find_text` reject off-screen matches before it could scroll to them
 * (reporting "not found" for text that exists further down the page).
 */
export function isRendered(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  if (el.closest("[inert]")) return false;
  if (SUPPORTS_CHECK_VISIBILITY) {
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }
  return !styleHiddenByComputedStyle(el);
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
 // Use an INSTANT (non-animated) scroll so layout settles synchronously.
 // The previous `behavior: "smooth"` started an async animated scroll;
 // callers that read `getBoundingClientRect()` immediately after (click,
 // press-and-hold, input, select-dropdown) would read mid-animation rects
 // and dispatch CDP coordinate clicks at the element's pre-scroll position
 // — a silent misclick reported as success. An instant scroll centers the
 // element before the rect is read.
      el.scrollIntoView({ block: "center" });
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
 * Used by the click fallback's strategy 3 (re-find element by selector) and
 * by `list_interactive` descriptors.
 *
 * Strategy chain (extended from the original 2 to 5):
 * 1. If `el.id` is non-empty, return `*[id="<escaped-id>"]` (byte-for-byte
 *    stable with the pre-extension output).
 * 2. `tagname.class1.class2…` — returned ONLY when globally unique
 *    (previously returned even when ambiguous; the unique case is unchanged).
 * 3. `tag[name="…"]` — when globally unique.
 * 4. `tag[data-testid|aria-label|title|placeholder="…"]` — first unique
 *    attribute (quotes escaped).
 * 5. CSS sibling-count chain (`html > body > div:nth-of-type(2) > …`) — the
 *    XPath `/html[1]/body[1]/div[2]` walk expressed as `:nth-of-type`, which
 *    stays CSS-parseable for the click fallback's `querySelectorAll`.
 *
 * If no strategy yields a unique selector, the bare tag is returned — the
 * callers (click fallback) handle the ambiguous case by falling through to
 * the next strategy.
 */
export function generateCssSelector(el: Element): string {
  if (el.id) {
  // The id is interpolated into a DOUBLE-QUOTED attribute string
  // (`*[id="…"]`), so it must be escaped for STRING context, not identifier
  // context — `CSS.escape` (used by `cssEscape` for the class branch below)
  // is for identifier context and would mis-escape an id whose escaped form is
  // immediately followed by a hex digit (e.g. id `"b` → `\22b` parses as
  // U+022B, not `"` + `b`). Escape only the characters that are special
  // inside a CSS string: backslash and double-quote.
    const id = el.id
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\A ")
      .replace(/\r/g, "\\D ")
      .replace(/\0/g, "\\0 ");
    return `*[id="${id}"]`;
  }
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList);
  if (classes.length > 0) {
    const classSel = `${tag}${classes.map((c) => `.${cssEscape(c)}`).join("")}`;
    if (isUnique(classSel)) return classSel;
  }
  const name = el.getAttribute("name");
  if (name) {
    const nameSel = `${tag}[name="${escapeCssString(name)}"]`;
    if (isUnique(nameSel)) return nameSel;
  }
  for (const attr of ["data-testid", "aria-label", "title", "placeholder"]) {
    const value = el.getAttribute(attr);
    if (value) {
      const attrSel = `${tag}[${attr}="${escapeCssString(value)}"]`;
      if (isUnique(attrSel)) return attrSel;
    }
  }
  const chain = toCssSiblingChain(el);
  if (isUnique(chain)) return chain;
  return tag;
}

/** True when `selector` matches exactly one element (never throws). */
function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/** Escape a value for a DOUBLE-QUOTED CSS attribute selector. */
function escapeCssString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\A ")
    .replace(/\r/g, "\\D ")
    .replace(/\0/g, "\\0 ");
}

/**
 * Sibling-count walk (the XPath `/html[1]/body[1]/div[2]/button[1]` pattern)
 * expressed as a CSS selector: each ancestor becomes `tag:nth-of-type(i)`
 * where `i` is the element's index among its same-tag siblings.
 */
function toCssSiblingChain(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node) {
    const tag = node.tagName.toLowerCase();
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    let index = 1;
    let sibling: Element | null = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === node.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    node = parent;
  }
  return parts.join(" > ");
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
