/**
 * Viewport-membership cache backed by a single IntersectionObserver on the
 * document root.
 *
 * Both extraction walks (`intersectsObservationViewport` in `page-state.ts`
 * and `intersectsViewport` in `ax-tree-builder.ts`) gate every element on the
 * viewport. The historical gate is rect math (`getBoundingClientRect` +
 * window dimensions) — on an unchanged page those reads are pure waste, since
 * the browser already computes intersection for us. One IO on the document
 * root reports membership on ANY intersection-ratio change (scroll, resize,
 * DOM growth, geometry-changing CSS animations) and guarantees an initial
 * callback on the first render cycle after `observe()`, so the next step on
 * an unchanged page serves every viewport gate from a WeakMap instead of
 * forcing layout.
 *
 * `isInViewport` returns `undefined` while membership is unknown — element
 * not yet observed, callback not yet delivered, or IO unavailable — and
 * callers then fall back to the existing rect math, which stays byte-identical
 * to the pre-tracker gate. `observe()` is idempotent (WeakSet), so re-observing
 * the freshly-walked element set every step is safe; unobserved elements stay
 * `undefined`.
 *
 * SECURITY: the membership WeakMap and observed set are instance state, never
 * exposed on `window` (the content script shares the page's `window`, so any
 * `window.__…` handle would let a hostile page forge membership). A page can
 * only influence membership through real layout changes it already controls;
 * the rect-math fallback remains the ground truth until the IO reports.
 *
 * LIFECYCLE: the tracker is rebuilt whenever the DOM epoch moves
 * (`getViewportTracker`). Membership is only meaningful for the epoch's DOM —
 * after a mutation the old memberships describe a different tree — and an
 * IntersectionObserver holds STRONG references to every observed element, so
 * a long-lived tracker would leak the elements of every past epoch (the
 * WeakMap/WeakSet alone cannot release them while the IO keeps them alive).
 * Disconnecting the previous tracker per epoch releases those references.
 * On an unchanged page (no mutations) the epoch never moves, so the tracker
 * and its membership cache persist across steps — the steady-state zero-reflow
 * win is untouched.
 */

import { getDomEpoch } from "./mutation-signal";

export class ViewportTracker {
  private readonly io: IntersectionObserver | null;
  private readonly memberships = new WeakMap<Element, boolean>();
  private observed = new WeakSet<Element>();

  constructor(root: Element) {
    this.io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) {
              this.memberships.set(entry.target, entry.isIntersecting);
            }
          }, { root })
        : null;
  }

  /** Register an element so the IO reports its membership. Idempotent. */
  observe(el: Element): void {
    if (!this.io || this.observed.has(el)) return;
    this.observed.add(el);
    this.io.observe(el);
  }

  /**
   * Cached viewport membership. `undefined` = unknown — the caller falls back
   * to rect math (identical to the pre-tracker gate).
   */
  isInViewport(el: Element): boolean | undefined {
    return this.memberships.get(el);
  }

  /** Stop the IO and forget the observed set (cleanup / page teardown). */
  disconnect(): void {
    this.io?.disconnect();
    // The WeakSet has no clear(); drop the reference so it can be GC'd and a
    // later observe() re-registers cleanly.
    this.observed = new WeakSet();
  }
}

let sharedTracker: { epoch: number; tracker: ViewportTracker } | null = null;

/**
 * The shared tracker — ONE IntersectionObserver on the document root for the
 * whole content-script instance, lazily created on first use so module
 * import never touches the DOM. Both extraction walks consume it, so their
 * membership caches stay coherent with each other.
 *
 * Rebuilt whenever the DOM epoch moves (see the class doc for why): the
 * previous tracker is disconnected — releasing the IO's strong element
 * references — and a fresh tracker serves the new epoch. On an unchanged page
 * the same tracker persists, so its membership cache keeps serving across
 * steps (zero forced layout reads).
 */
export function getViewportTracker(): ViewportTracker {
  const epoch = getDomEpoch();
  if (!sharedTracker || sharedTracker.epoch !== epoch) {
    if (sharedTracker) sharedTracker.tracker.disconnect();
    sharedTracker = { epoch, tracker: new ViewportTracker(document.documentElement) };
  }
  return sharedTracker.tracker;
}