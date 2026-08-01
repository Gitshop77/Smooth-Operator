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
 * - `display: none` (the common case — and the one we care about most)
 * - `position: fixed` (rare; the element is usually visible)
 * - `position: sticky` in some browsers (rare)
 * - elements detached from the document
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
 // `document.body` and `document.documentElement` always have a null
 // `offsetParent` in every browser, so the check below would wrongly report
 // them as hidden — which would drop the entire page from the serialized tree.
 // Guard them explicitly; they are never genuinely hidden.
  if (el === document.body || el === document.documentElement) return false;
 // `HTMLElement.offsetParent` does NOT cross shadow-tree boundaries: a
 // normally-flowing, fully-visible element inside an open/closed shadow root
 // also reports `offsetParent === null`. Don't mark such elements hidden here;
 // defer to isVisibleFull, which resolves real computed-style/rect visibility
 // across shadow boundaries (so visible shadow-DOM content isn't dropped).
  if (el.getRootNode() instanceof ShadowRoot) return false;
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
 * Returns true when a `clip` / `clip-path` value provably collapses the element
 * to zero visible area (so it should be treated as hidden). Shape clips that
 * still leave the element visible (`circle(50%)`, `ellipse(...)`, `inset(0)`,
 * `polygon(...)`, …) return false so they are NOT pruned as phantom/hidden.
 */
function clipCollapsesToZero(value: string): boolean {
  const v = value.trim().toLowerCase();
  // legacy: rect(top right bottom left)
  const rectM = v.match(/^rect\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)$/);
  if (rectM) {
    const top = parseFloat(rectM[1]);
    const right = parseFloat(rectM[2]);
    const bottom = parseFloat(rectM[3]);
    const left = parseFloat(rectM[4]);
    return right <= left || bottom <= top;
  }
  if (v.startsWith("inset(")) {
    const geo = v.slice(5, -1).split(/round/)[0].trim();
    const parts = geo.length ? geo.split(/\s+/) : ["0px"];
    const pct = (tok: string): number => {
      const t = tok.trim();
      return t.endsWith("%") ? parseFloat(t) : 0;
    };
    const top = pct(parts[0] ?? "0px");
    const right = pct(parts[1] ?? parts[0] ?? "0px");
    const bottom = pct(parts[2] ?? parts[0] ?? "0px");
    const left = pct(parts[3] ?? parts[1] ?? parts[0] ?? "0px");
    return top + bottom >= 100 || left + right >= 100;
  }
  if (v.startsWith("circle(")) {
    const size = v.slice(7, -1).trim().split(/\s+at\s+/)[0].trim();
    return isZeroSize(size);
  }
  if (v.startsWith("ellipse(")) {
    const inner = v.slice(8, -1).trim().split(/\s+at\s+/)[0].trim();
    const [rx, ry] = inner.split(/\s+/);
    return isZeroSize(rx ?? "0") || isZeroSize(ry ?? "0");
  }
  // polygon(...), path(...), url(...), etc. — can't prove they collapse; keep visible.
  return false;
}

/** True when a clip size token is exactly zero (e.g. `0`, `0px`, `0%`). */
function isZeroSize(token: string): boolean {
  const t = token.trim();
  if (!t || t === "0" || t === "0px") return true;
  if (t.endsWith("%")) return parseFloat(t) === 0;
  return false;
}

/**
 * Per-extract memo of "this ancestor is fully transparent" (`opacity: 0`).
 *
 * `isVisibleFull` walks the ancestor chain of every interactive element, and
 * `getComputedStyle` is the single most expensive operation in the walker.
 * On a page with thousands of siblings under one `<body>`, the same ancestors
 * are re-resolved for every sibling; memoizing per ancestor within one
 * extraction collapses that to one style resolution per ancestor.
 *
 * The memo is only active while a walker is running (`beginVisibilityCache` /
 * `endVisibilityCache`): `isVisibleFull` is also called outside extractions
 * (e.g. `find_text`'s action-time visibility probe), and the DOM can change
 * between those calls, so the cache must never outlive the synchronous walk.
 */
let transparentAncestorCache: WeakMap<HTMLElement, boolean> | null = null;

/** Start a memoized walk — call at the beginning of every DOM extraction. */
export function beginVisibilityCache(): void {
  transparentAncestorCache = new WeakMap<HTMLElement, boolean>();
}

/** End the memoized walk — call when the extraction finishes (even on error). */
export function endVisibilityCache(): void {
  transparentAncestorCache = null;
}

/** True when the element has `opacity: 0` per computed style (memoized during a walk). */
function isFullyTransparent(el: HTMLElement): boolean {
  const cache = transparentAncestorCache;
  if (cache) {
    let transparent = cache.get(el);
    if (transparent === undefined) {
      transparent = parseFloat(window.getComputedStyle(el).opacity) === 0;
      cache.set(el, transparent);
    }
    return transparent;
  }
  return parseFloat(window.getComputedStyle(el).opacity) === 0;
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
 * `getBoundingClientRect()` is called.
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
    if (isFullyTransparent(ancestor)) return false;
    if (ancestor.getAttribute("aria-hidden") === "true") return false;
  }
  const r = rect ?? el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
 // `aria-hidden` is commonly set on an ancestor to prune a decorative subtree
 // from the accessibility tree while keeping it visible. An element inside such
 // a subtree is not a legitimate interaction target for an AT-driven agent, so
 // walk the ancestor chain and treat it as hidden if any ancestor is aria-hidden.
 // `clip: rect(...)` (legacy) and `clip-path: ...` (modern) are both common
 // techniques to hide an element while keeping it in the accessibility tree.
 // A clip only HIDES the element when it provably collapses the visible region
 // to zero area — e.g. `rect(0,0,0,0)`, `inset(100%)`, `circle(0)`. A shape clip
 // that still leaves the element visible (`circle(50%)`, `ellipse(...)`,
 // `inset(0)`, `polygon(...)`) must NOT be treated as hidden, or legitimately
 // visible, clickable elements are wrongly pruned and become phantom/missing
 // targets. So we only fail closed on clips that collapse to zero area.
  const clip = style.clip;
  if (clip && clip !== "auto" && clipCollapsesToZero(clip)) return false;
  const clipPath = style.clipPath;
  if (clipPath && clipPath !== "none" && clipPath !== "auto" && clipCollapsesToZero(clipPath)) return false;
  return true;
}
