/**
 * Element classification helpers — shared DOM predicates used by the indexed
 * DOM-tree extractor ({@link ../extraction/page-state}) and the AX-tree
 * builder ({@link ../extraction/ax-tree-builder}) to classify and inspect DOM
 * nodes consistently.
 *
 * Before this file was extracted (along with {@link ./visibility},
 * {@link ./selectors}, {@link ./tree-walker}) into the `utils/` subdirectory,
 * the canonical definitions lived in `dom/dom-utils.ts`. The two extractors
 * had already drifted on `isInteractive` (ax-tree missed `draggable`,
 * role-set differences), `isVisible` (ax-tree used `offsetWidth/offsetHeight`
 * + missed `aria-hidden`), `directText` (ax-tree didn't collapse internal
 * whitespace), and the SKIP_TAGS list (each file skipped a different subset).
 * Keeping a single canonical set here avoids the two implementations slowly
 * drifting again.
 *
 * Performance: the DOM extractor is the hottest path in the agent loop — it
 * walks every node in the page on every step, for potentially 100+ steps per
 * run. The "expensive" visibility check (`isVisibleFull`, in {@link ./visibility})
 * is split out from the cheap pre-check (`isLikelyHidden`, in
 * {@link ./visibility}) so callers can short-circuit on `display:none` /
 * detached without paying the style-recalc cost on every visited node.
 */

import { INTERACTIVE_TAGS, INTERACTIVE_ROLES, SENSITIVE_AUTOCOMPLETE_SET, getRole } from "./classification-helpers";

// ─── Skip-tag set ───────────────────────────────────────────────────────────

/**
 * Tags whose subtrees we never traverse. Union of the historical skip lists
 * from the indexed-tree extractor (`script`, `style`, `noscript`, `svg`,
 * `path`) and the AX-tree builder (`script`, `style`, `meta`, `link`, `title`,
 * `noscript`) — we treat the union as canonical so neither extractor silently
 * resurrects a tag the other had agreed to ignore. (In practice this is a
 * no-op for the indexed-tree extractor, which starts from `document.body` and
 * never sees `<head>`-only tags like `meta`/`link`/`title`; it mostly affects
 * ax-tree, which now also skips `svg`/`path` subtrees like the extractor does.)
 */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  "script", "style", "noscript", "svg", "path", "meta", "link", "title",
]);

// ─── Interactive-element classification ─────────────────────────────────────

export function isInteractive(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
 // <a> is only interactive when it has an `href` attribute — per HTML spec,
 // <a> without href is a plain placeholder with no interactive semantics
 // (it's not focusable, not clickable-as-a-link, and ARIA assigns it the
 // generic role rather than "link"). Treating every <a> as interactive
 // would surface dead anchors to the LLM as click targets.
  if (tag === "a") return el.getAttribute("href") !== null;
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = getRole(el);
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  const contenteditable = el.getAttribute("contenteditable");
  if (contenteditable !== null && contenteditable !== "false") return true;
  if (el.getAttribute("onclick") !== null) return true;
  const tabindex = el.getAttribute("tabindex");
  // tabindex=-1 elements are still focusable/clickable (e.g. menu items,
  // custom widgets), so treat any explicit tabindex (incl. -1) as interactive.
  if (tabindex !== null && parseInt(tabindex, 10) >= -1) return true;
 // Only treat `draggable` as a signal of interactivity when it is explicitly
 // set to "true". `HTMLElement.draggable` defaults to `true` for `<img>` and
 // `<a href>` (the HTML "auto" default), so reading the property would
 // over-classify every image and link as an interactive click target and bloat
 // the serialized tree. Links are already covered by the `href` check above,
 // and images are not actionable, so we only honor an explicit opt-in.
  if (el.getAttribute("draggable") === "true") return true;
  return false;
}

// ─── Bounding-box propagation + containment ─────────────────────────────────
//
// "Propagating elements" are interactive containers (links, buttons,
// div[role=button], …) whose clickable surface typically spans the whole
// subtree. When a child element is ≥99% contained within a propagating
// ancestor's bounding box, the child is almost certainly a duplicate click
// target (a `<span>` inside a `<button>`, an `<svg>` icon inside an `<a>`).
// The indexed-tree extractor can use `isContained` to suppress the child's
// index, reducing redundant click targets in the LLM's tree.
//
// Pattern set (canonical — modelled on the well-known `PROPAGATING_ELEMENTS`
// taxonomy):
// - `{tag:"a"}` — anchors propagate (the whole link is clickable)
// - `{tag:"button"}` — buttons propagate
// - `{tag:"div", role:"button"}` — div-as-button
// - `{tag:"div", role:"combobox"}` — div-as-combobox
// - `{tag:"span", role:"button"}` — span-as-button
// - `{tag:"span", role:"combobox"}` — span-as-combobox
// - `{tag:"input", role:"combobox"}` — combobox input

/** A single propagating-element pattern: tag + optional role constraint. */
interface PropagatingElementPattern {
  /** Lowercased tag name (e.g. `"a"`, `"button"`, `"div"`). */
  tag: string;
  /** If set, the element's `role` attribute must match this value. */
  role?: string;
}

/**
 * Canonical set of propagating-element patterns. An element matching any
 * pattern is a "propagating" element — its bounding box propagates to
 * children, and children ≥99% contained within it are filtered out as
 * duplicate click targets.
 */
export const PROPAGATING_ELEMENTS: readonly PropagatingElementPattern[] = [
  { tag: "a" },
  { tag: "button" },
  { tag: "div", role: "button" },
  { tag: "div", role: "combobox" },
  { tag: "span", role: "button" },
  { tag: "span", role: "combobox" },
  { tag: "input", role: "combobox" },
];

/**
 * Test whether `el` matches a propagating-element pattern (a, button,
 * div[role=button], etc.). Used by the bounding-box propagation filter to
 * decide which ancestors' boxes "absorb" their children's boxes.
 */
export function isPropagatingElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const role = getRole(el);
  for (const p of PROPAGATING_ELEMENTS) {
    if (p.tag !== tag) continue;
    if (p.role !== undefined && p.role !== role) continue;
    return true;
  }
  return false;
}

/**
 * Default containment threshold — a child whose area is ≥99% inside the
 * parent is considered a duplicate click target.
 */
const DEFAULT_CONTAINMENT_THRESHOLD = 0.99;

/**
 * Compute the bounding-box containment ratio of `child` within `parent`.
 * Returns the fraction of `child`'s area that lies inside `parent`'s box
 * (0–1). Returns 0 if either element has a zero-area box (detached, hidden,
 * or not yet laid out).
 *
 * @param child The candidate contained element.
 * @param parent The candidate containing element.
 * @returns `intersectionArea / childArea` in `[0, 1]`.
 */
export function containmentRatio(child: Element, parent: Element): number {
  const c = child.getBoundingClientRect();
  const p = parent.getBoundingClientRect();
  const cArea = c.width * c.height;
  const pArea = p.width * p.height;
  if (cArea <= 0 || pArea <= 0) return 0;
  const ix = Math.max(0, Math.min(c.right, p.right) - Math.max(c.left, p.left));
  const iy = Math.max(0, Math.min(c.bottom, p.bottom) - Math.max(c.top, p.top));
  const intersection = ix * iy;
  return intersection / cArea;
}

/**
 * Test whether `child` is ≥ `threshold` (default 99%) contained within
 * `parent`'s bounding box. Used by the indexed-tree extractor's bounding-box
 * propagation filter to suppress duplicate click targets (e.g. a `<span>`
 * inside a `<button>` where the span fills the whole button).
 *
 * @param child The candidate contained element.
 * @param parent The candidate containing element.
 * @param threshold Fraction of `child`'s area that must lie inside `parent` (default 0.99).
 */
export function isContained(child: Element, parent: Element, threshold: number = DEFAULT_CONTAINMENT_THRESHOLD): boolean {
  return containmentRatio(child, parent) >= threshold;
}

/**
 * Find the nearest propagating ancestor of `el` (or `null` if none).
 * Walks up the parentNode chain, returning the first element that matches
 * {@link isPropagatingElement}. Consumed by {@link shouldExcludeAsContained}
 * and the test suite; no production caller wires it into the indexed-tree
 * extractor yet, so it performs no runtime de-duplication today.
 */
export function nearestPropagatingAncestor(el: Element): Element | null {
  // Seed from `parentNode` (not `parentElement`): an element that is a direct
  // child of a shadow root has `parentElement === null` (the ShadowRoot is not
  // an Element), and its light-DOM host on the other side of the boundary is
  // exactly the propagating ancestor we are looking for.
  let cur: Node | null = el.parentNode;
  while (cur) {
    if (cur instanceof Element && isPropagatingElement(cur)) return cur;
    // Cross shadow-DOM boundaries: a parenting shadow root's `.host` is the
    // light-DOM element on the other side, so containment suppression also
    // applies to nodes nested inside shadow trees.
    if (cur instanceof ShadowRoot) cur = cur.host;
    else cur = cur.parentNode;
  }
  return null;
}

/**
 * Test whether `child` should be EXCLUDED from the indexed tree because it's
 * a ≥99%-contained descendant of a propagating ancestor (a, button,
 * div[role=button], …). This is the bounding-box propagation filter: when a
 * propagating element fully wraps a child, the child is a redundant click
 * target — the user clicks the ancestor either way.
 *
 * Exceptions (never excluded even when contained):
 * - form elements (`input`, `select`, `textarea`) — they have their own
 * interaction semantics (typing, selecting) independent of the ancestor
 * - elements with an explicit `aria-label` — the label is independent
 * information the LLM should see
 * - elements with `role` in `{button, link, checkbox, radio, textbox,
 * combobox, listbox, option, tab, menuitem, switch}` — they're
 * independently interactive
 */
export function shouldExcludeAsContained(child: Element): boolean {
  const tag = child.tagName.toLowerCase();
 // Form elements are never excluded — they have independent interaction.
  if (tag === "input" || tag === "select" || tag === "textarea") return false;
 // Elements with an explicit aria-label carry independent information.
  // A blank aria-label="" is NOT independent info and must not keep a
  // duplicate click target from being suppressed; only a non-empty label counts.
  const ariaLabel = child.getAttribute("aria-label");
  if (ariaLabel !== null && ariaLabel.trim() !== "") return false;
 // Elements with an independent interactive role are not redundant.
  const role = getRole(child);
  if (role && INTERACTIVE_ROLES.has(role)) return false;

  const ancestor = nearestPropagatingAncestor(child);
  if (!ancestor) return false;
  return isContained(child, ancestor);
}

// ─── Sensitive-field detection ──────────────────────────────────────────────

export function isSensitive(el: HTMLElement): boolean {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const autocompleteTokens = (el.getAttribute("autocomplete") || "")
    .toLowerCase()
    .split(/\s+/);
  return autocompleteTokens.some((t) => SENSITIVE_AUTOCOMPLETE_SET.has(t));
}
