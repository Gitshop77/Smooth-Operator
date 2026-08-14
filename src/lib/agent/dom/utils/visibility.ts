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

import { getDomEpoch } from "../mutation-signal";

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
 * Cross-step memo of "this ancestor is fully transparent" (`opacity: 0`).
 *
 * `isVisibleFull` walks the ancestor chain of every interactive element, and
 * `getComputedStyle` is the single most expensive operation in the walker.
 * On a page with thousands of siblings under one `<body>`, the same ancestors
 * are re-resolved for every sibling; memoizing per ancestor collapses that to
 * one style resolution per ancestor.
 *
 * The memo is PERSISTENT across walks, invalidated by the DOM-epoch signal
 * (`getDomEpoch` in `../mutation-signal`): the epoch-stamped stamp layer
 * survives between walks and is only rebuilt when a mutation bumped the
 * epoch. The ACTIVE layer (`transparentAncestorCache`) is non-null only while
 * a walker is running (`beginVisibilityCache` / `endVisibilityCache`), so
 * `isFullyTransparent` calls outside extractions (e.g. `find_text`'s
 * action-time visibility probe) always take the direct computation path and
 * can never be served stale data — the DOM can change between those calls and
 * they must not depend on the observer being installed.
 */
let transparentAncestorCache: WeakMap<HTMLElement, boolean> | null = null;
let transparentAncestorStamp: { epoch: number; cache: WeakMap<HTMLElement, boolean> } | null = null;

/**
 * Start a memoized walk — call at the beginning of every DOM extraction.
 *
 * Persistent mode: reuses the previous walk's memo when the DOM epoch is
 * unchanged (a static page becomes a 0-cost lookup); rebuilds it only when
 * the epoch moved. In-walk calls only — out-of-walk `isVisibleFull` callers
 * must not begin a cache.
 */
export function beginVisibilityCache(): void {
  const epoch = getDomEpoch();
  if (!transparentAncestorStamp || transparentAncestorStamp.epoch !== epoch) {
    transparentAncestorStamp = { epoch, cache: new WeakMap<HTMLElement, boolean>() };
  }
  transparentAncestorCache = transparentAncestorStamp.cache;
}

/**
 * End the memoized walk — call when the extraction finishes (even on error).
 *
 * Restores the pre-walk state instead of a hard null: the active layer is
 * deactivated (out-of-walk callers keep the null-cache path) while the
 * epoch-stamped persistent layer survives for the next walk's reuse.
 */
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
 * True when the element carries `aria-hidden="true"` (matched
 * case-insensitively — the ARIA spec treats attribute values as ASCII
 * case-insensitive).
 */
function isAriaHidden(el: Element): boolean {
  return (el.getAttribute("aria-hidden") || "").toLowerCase() === "true";
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
 * rect and style parameters let callers reuse values they already fetched
 * (e.g. the extractor's `ReadCache` batch-reads both once per element and
 * passes them here, avoiding a second layout flush and a second style recalc).
 *
 * @param rect optional pre-computed bounding rect; if omitted, a fresh
 * `getBoundingClientRect()` is called.
 * @param style optional pre-computed computed style; if omitted, a fresh
 * `window.getComputedStyle()` is called.
 */
export function isVisibleFull(el: HTMLElement, rect?: DOMRect, style?: CSSStyleDeclaration): boolean {
  const s = style ?? window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
  if (parseFloat(s.opacity) === 0) return false;
  // Zero-size check first: every check below is conjunctive, so the outcome is
  // identical regardless of order — and a zero-size element (the common hidden
  // case in jsdom, and the cheapest to prove hidden in a real browser)
  // short-circuits before the ancestor style walk. Callers that batch their
  // reads can therefore serve a hidden element without touching the style
  // system again.
  const r = rect ?? el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
 // `opacity` is NOT an inherited property, so a child of an `opacity:0`
 // ancestor computes its own opacity as `"1"` even though it is visually
 // invisible. Walk the ancestor chain (up to the document root) and treat the
 // element as hidden if any ancestor is fully transparent — otherwise the agent
 // could target a transparent, non-interactable element. The walk crosses
 // shadow-tree boundaries via `parentNode` → `ShadowRoot` → `host`, so an
 // `opacity:0` host hides the interactive content rendered inside its shadow
 // root just like a light-DOM ancestor would.
  let ancestor: Node | null = el.parentNode;
  while (ancestor) {
    if (ancestor instanceof ShadowRoot) {
      ancestor = ancestor.host;
      continue;
    }
    if (ancestor instanceof Element) {
      if (isFullyTransparent(ancestor as HTMLElement)) return false;
      if (isAriaHidden(ancestor)) return false;
    }
    ancestor = ancestor.parentNode;
  }
  if (isAriaHidden(el)) return false;
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
  const clip = s.clip;
  if (clip && clip !== "auto" && clipCollapsesToZero(clip)) return false;
  const clipPath = s.clipPath;
  if (clipPath && clipPath !== "none" && clipPath !== "auto" && clipCollapsesToZero(clipPath)) return false;
  return true;
}
