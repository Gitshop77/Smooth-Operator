/**
 * DOM-epoch mutation signal.
 *
 * One content-script `MutationObserver` on `document.documentElement` whose
 * callback bumps a monotonic epoch counter. The extraction caches
 * (`visibilityCache` in page-state, `transparentAncestorCache` in visibility,
 * `nthOfTypeCache` in element-info, and the shared `ReadCache`) stamp the
 * epoch at first use and clear themselves only when the epoch moved — so on a
 * static page `isVisibleFull` becomes a 0-cost lookup, while ANY DOM mutation
 * invalidates every cache.
 *
 * The observer observes `childList + subtree + characterData + attributes`.
 * `attributeFilter` is deliberately omitted so ALL attribute changes
 * (including JS `style`-attribute writes) invalidate. Records are delivered in
 * microtasks per the spec — no extra debouncing is added (debouncing could
 * race a synchronous walk).
 *
 * Safety: out-of-walk callers (e.g. `find_text`'s action-time probe) must
 * never depend on the observer being installed. The caches handle that
 * themselves — `isFullyTransparent` only consults its memo while a walk is
 * active (`beginVisibilityCache`/`endVisibilityCache`), and every persistent
 * cache revalidates its epoch stamp at use.
 */

let epoch = 0;
let observer: MutationObserver | null = null;

/** The current DOM epoch. Any DOM mutation observed since install bumps it. */
export function getDomEpoch(): number {
  return epoch;
}

/** Explicitly bump the epoch (also called by the observer's callback). */
export function bumpDomEpoch(): void {
  epoch++;
}

/**
 * Install the mutation observer — idempotent (no-op when already installed).
 * Guards `typeof MutationObserver !== "undefined"` (jsdom ≥13.2 supports MO
 * with real records and microtask delivery, so tests need no stub; other
 * environments may not).
 */
export function installMutationSignal(): void {
  if (observer) return;
  if (typeof MutationObserver === "undefined") return;
  if (typeof document === "undefined" || !document.documentElement) return;
  observer = new MutationObserver(() => {
    bumpDomEpoch();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
}