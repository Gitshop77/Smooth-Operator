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
 */
import { isVisibleFull } from "./visibility";

interface ReadCacheEntry {
  rect: DOMRect | undefined;
  style: CSSStyleDeclaration | undefined;
  visible: boolean | undefined;
}

export class ReadCache {
  private entries = new Map<Element, ReadCacheEntry>();

  /** Read the element's bounding rect + computed style once and store them. */
  batchRead(el: Element): void {
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
      entry.visible = isVisibleFull(el, rect ?? entry.rect, style);
    }
    return entry.visible;
  }

  /** Drop all cached entries — call at the start of a walk. */
  clear(): void {
    this.entries.clear();
  }
}