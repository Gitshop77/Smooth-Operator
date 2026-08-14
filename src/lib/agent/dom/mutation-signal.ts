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
 *
 * The epoch is only a trustworthy "the DOM is unchanged" signal while the
 * observer is actually installed and observing the current root. When the
 * signal is UNARMED (no `MutationObserver` in the environment, no document
 * root at install time, or the observed root was replaced), the epoch may
 * freeze while the DOM still changes — the caches must then fail closed and
 * rebuild per walk instead of serving. The stamp sites consult
 * `isMutationSignalArmed()` for exactly that.
 */

let epoch = 0;
let observer: MutationObserver | null = null;
let observedRoot: Node | null = null;

/** The current DOM epoch. Any DOM mutation observed since install bumps it. */
export function getDomEpoch(): number {
  return epoch;
}

/** Explicitly bump the epoch (also called by the observer's callback). */
export function bumpDomEpoch(): void {
  epoch++;
}

/**
 * Whether the signal is armed: the observer is installed AND still observing
 * the current `document.documentElement`. Only then can `getDomEpoch()` be
 * trusted to move on any DOM mutation. When unarmed, the epoch may be frozen
 * while the DOM still changes, so cache stamp sites must rebuild per use
 * instead of serving the last epoch's memo.
 */
export function isMutationSignalArmed(): boolean {
  return observer !== null && observedRoot === document.documentElement;
}

/**
 * Install the mutation observer — idempotent (no-op when already installed
 * on the current root; re-installs when the observed root was replaced).
 * Guards `typeof MutationObserver !== "undefined"` (jsdom ≥13.2 supports MO
 * with real records and microtask delivery, so tests need no stub; other
 * environments may not).
 */
export function installMutationSignal(): void {
  if (observer && observedRoot === document.documentElement) return;
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
  observedRoot = document.documentElement;
}

/**
 * @internal Test-only: disarm the signal, simulating an environment where
 * `installMutationSignal()` cannot arm (e.g. no `MutationObserver`).
 * Re-arming happens automatically on the next `installMutationSignal()`.
 */
export function __test_disarmMutationSignalForTests(): void {
  observer = null;
  observedRoot = null;
}