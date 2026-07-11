/**
 * Visibility helpers — shared by the indexed DOM-tree extractor and the
 * AX-tree builder. Extracted here (along with the rest of `dom-utils.ts`)
 * so both extractors classify elements identically.
 *
 * Performance: the DOM extractor is the hottest path in the agent loop — it
 * walks every node in the page on every step, for potentially 100+ steps per
 * run. `window.getComputedStyle` forces a full cascade resolution and
 * `getBoundingClientRect` forces a layout flush, so the "expensive" check
 * (`isVisibleFull`) is split out from the cheap pre-check (`isLikelyHidden`)
 * so callers can short-circuit on `display:none`/detached without paying the
 * style-recalc cost on every visited node.
 */

/**
 * Cheap visibility pre-check. Catches `display:none`, detached elements, and
 * most hidden cases WITHOUT forcing a style recalc.
 *
 * `offsetParent` is `null` for:
 *   - `display: none` (the common case — and the one we care about most)
 *   - `position: fixed` (rare; the element is usually visible)
 *   - `position: sticky` in some browsers (rare)
 *   - elements detached from the document
 *
 * To avoid false positives on fixed/sticky elements, we fall back to a single
 * `getComputedStyle` lookup only when `offsetParent` is null. Fixed/sticky
 * positioning is rare enough that this cost is negligible in practice.
 *
 * Returns `true` if the element is *definitely* hidden; `false` if it might
 * still be visible (caller should run {@link isVisibleFull} to be sure).
 *
 * Performance: this is the hot-path pre-check the DOM walker uses on every
 * visited node. It avoids `getComputedStyle` for the common visible case
 * (`offsetParent !== null`) and pays a single `getComputedStyle` only for the
 * rare `offsetParent === null` case (which is either a genuinely hidden
 * element — most common — or a fixed/sticky element that needs disambiguation).
 */
export function isLikelyHidden(el: HTMLElement): boolean {
  if (el.offsetParent === null) {
    // Could be display:none, detached, or position:fixed/sticky. Disambiguate
    // with one getComputedStyle call (rare path — most elements either have
    // a non-null offsetParent or are genuinely display:none).
    const style = window.getComputedStyle(el);
    if (style.position === "fixed" || style.position === "sticky") {
      // Could still be hidden via opacity/visibility — let isVisibleFull decide.
      return false;
    }
    return true; // display:none or detached
  }
  return false;
}

/**
 * Determine whether an element is *actually* visible to the user. Combines
 * computed style (display / visibility / opacity), bounding-box, and
 * `aria-hidden` checks.
 *
 * EXPENSIVE — calls `window.getComputedStyle` (full cascade resolution) and
 * `getBoundingClientRect` (layout flush). For hot paths (e.g. the DOM walker),
 * gate this behind {@link isLikelyHidden} so display:none / detached nodes
 * never reach this function.
 *
 * Canonical version — matches the historical `extractor.ts` definition, which
 * uses `getBoundingClientRect` (more accurate than `offsetWidth/offsetHeight`
 * for rotated/transformed elements). Also folds in the `aria-hidden` check
 * that the historical `ax-tree.ts` was missing inside its `isVisible`. The
 * rect parameter lets callers reuse a rect they already fetched (e.g. the
 * extractor computes it once for the `ExtractedElement` payload and passes it
 * here for the visibility check, avoiding a second layout flush).
 *
 * @param rect optional pre-computed bounding rect; if omitted, a fresh
 *             `getBoundingClientRect()` is called.
 */
export function isVisibleFull(el: HTMLElement, rect?: DOMRect): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  if (parseFloat(style.opacity) === 0) return false;
  // `opacity` is NOT an inherited property, so a child of an `opacity:0`
  // ancestor computes its own opacity as `"1"` even though it is visually
  // invisible. Walk the ancestor chain (up to the document root) and treat the
  // element as hidden if any ancestor is fully transparent — otherwise the agent
  // could target a transparent, non-interactable element.
  for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (parseFloat(window.getComputedStyle(ancestor).opacity) === 0) return false;
  }
  const r = rect ?? el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  // `clip: rect(0, 0, 0, 0)` (legacy) and `clip-path: inset(100%)` (modern)
  // are both common techniques to hide an element while keeping it in the
  // accessibility tree. Treat them as hidden — they're invisible to the user
  // even though `display`, `visibility`, and `opacity` all report visible.
  if (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clip === "rect(0,0,0,0)") return false;
  const clipPath = style.clipPath;
  if (clipPath && (clipPath === "inset(100%)" || clipPath === "inset(100% 100% 100% 100%)")) return false;
  return true;
}
