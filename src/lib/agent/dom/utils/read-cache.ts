/**
 * Per-walk read cache for the DOM extractors.
 *
 * Both extraction walks (`extractBrowserState` in `page-state.ts` and
 * `generateAccessibilityTree` in `ax-tree-builder.ts`) interleave layout reads
 * (`getBoundingClientRect`, `getComputedStyle`) with element classification.
 * Every read inside a loop where the DOM is not written forces a synchronous
 * layout. `batchRead` collapses the two reads per element into one tight pair
 * (rect + computed style) and later lookups (`getRect` / `getStyle` /
 * `getVisible`) serve from the cache — since no DOM writes happen between a
 * walk's reads, the cached values stay fresh for the whole walk.
 *
 * Precision note: `getComputedStyle` forces style recalc generally but forces
 * *layout* only for layout-dependent properties (width/height/margins/top/left
 * and transform- or grid-based properties) on shadow-tree elements or with
 * viewport media queries; reads are free when the tree is clean — this design
 * exploits exactly that.
 *
 * The cache is per-walk: `extractBrowserState` creates a fresh instance (and
 * clears it) at walk start, and the AX-tree builder creates its own. `clear()`
 * exists so a walk can explicitly reset the container (e.g. between the two
 * walks of a step); it must never outlive a synchronous walk.
 *
 * Since A2 the walkers ALSO share an epoch-stamped persistent instance via
 * {@link getSharedReadCache}: on an unchanged DOM (same epoch) the second
 * walk of a step — and the next step's walks — serve every element from the
 * previous walk's reads (0 forced reflows). Any DOM mutation bumps the epoch
 * (see `../mutation-signal`), which rebuilds the shared cache.
 */
import { isVisibleFull } from "./visibility";
import { getDomEpoch, isMutationSignalArmed } from "../mutation-signal";

interface ReadCacheEntry {
  rect: DOMRect | undefined;
  style: CSSStyleDeclaration | undefined;
  visible: boolean | undefined;
}

export class ReadCache {
  private entries = new Map<Element, ReadCacheEntry>();

  /**
   * Per-walk memo of "this element is aria-hidden or sits inside an
   * aria-hidden subtree" (the result of the ancestor scan in
   * `isVisibleFull`). Stored here so it follows the cache's lifecycle: it is
   * cleared by {@link clear()} and rebuilt whenever the epoch moves (a fresh
   * instance from `getSharedReadCache`), so it can never serve stale ancestry
   * across steps. Cache-correct because the ancestor chain is immutable
   * during a walk.
   */
  private ariaHiddenAncestry = new WeakMap<Element, boolean>();

  /** Read the element's bounding rect + computed style once and store them.
   * No-op when the element is already cached (cross-walk reuse serves it). */
  batchRead(el: Element): void {
    if (this.entries.has(el)) return;
    this.entries.set(el, {
      rect: el.getBoundingClientRect(),
      style: el instanceof HTMLElement ? window.getComputedStyle(el) : undefined,
      visible: undefined,
    });
  }

  /** Cached bounding rect, or undefined if the element was never read. */
  getRect(el: Element): DOMRect | undefined {
    return this.entries.get(el)?.rect;
  }

  /** Cached computed style, or undefined if the element was never read. */
  getStyle(el: HTMLElement): CSSStyleDeclaration | undefined {
    return this.entries.get(el)?.style;
  }

  /**
   * Visibility computed from the cached rect/style, memoized per element.
   * Returns undefined when the element was never read (caller falls back).
   */
  getVisible(el: HTMLElement, rect?: DOMRect): boolean | undefined {
    const entry = this.entries.get(el);
    if (!entry) return undefined;
    if (entry.visible === undefined) {
      const style = entry.style;
      if (!style) return undefined;
      entry.visible = isVisibleFull(el, rect ?? entry.rect, style, this.ariaHiddenAncestry);
    }
    return entry.visible;
  }

  /** Drop all cached entries — call at the start of a walk. */
  clear(): void {
    this.entries.clear();
    // WeakMap has no `clear()` — reassign so the per-walk aria-hidden
    // ancestry memo dies with the walk's read cache.
    this.ariaHiddenAncestry = new WeakMap<Element, boolean>();
  }
}

let sharedReadCache: { epoch: number; cache: ReadCache } | null = null;

/**
 * The epoch-stamped persistent ReadCache shared by both extraction walks.
 *
 * Rebuilds only when the DOM epoch moved — or when the mutation signal is
 * unarmed (the epoch then can't be trusted to move, so the cache fails closed
 * and a fresh instance is served instead). Otherwise the walkers serve every
 * element's rect/style/visibility from the previous walk's batch reads — on
 * an unchanged page the second walk of a step (and subsequent steps) performs
 * zero forced layout reads. The DOM is never written during a walk, so cached
 * values stay fresh for the whole epoch.
 */
export function getSharedReadCache(): ReadCache {
  const epoch = getDomEpoch();
  if (!isMutationSignalArmed() || !sharedReadCache || sharedReadCache.epoch !== epoch) {
    sharedReadCache = { epoch, cache: new ReadCache() };
  }
  return sharedReadCache.cache;
}