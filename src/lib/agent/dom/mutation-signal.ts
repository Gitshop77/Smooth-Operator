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
 * The same callback ALSO records the TOPMOST mutated subtrees of each epoch
 * window (see `getDirtyRoots`/`clearDirtyRoots`): `extractBrowserState`'s
 * partial re-walk (page-state.ts) consumes them to re-serialize only the
 * changed regions instead of re-walking the whole document.
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
 * `isMutationSignalArmed()` for exactly that. The dirty-root set is likewise
 * untrustworthy when unarmed (records may be missing entirely), so the
 * partial re-walk refuses to run on an unarmed signal and falls back to a
 * full walk.
 */

let epoch = 0;
let observer: MutationObserver | null = null;
let observedRoot: Node | null = null;

/**
 * Dirty roots per epoch: one bucket per epoch, holding the TOPMOST mutated
 * elements observed by the callback that bumped the epoch to that value.
 * Records within one batch are attributed to the single epoch bump they
 * caused; the consuming walker merges the buckets of every epoch since its
 * last extraction (see `getDirtyRoots`).
 */
const dirtyRootsByEpoch = new Map<number, Element[]>();
/** The highest epoch whose dirty roots a walk has consumed. */
let lastConsumedEpoch = -1;

/** The element a mutation record's target belongs to (text nodes → parent). */
function recordTargetElement(record: MutationRecord): Element | null {
  const target = record.target;
  if (target.nodeType === Node.ELEMENT_NODE) return target as Element;
  return target.parentElement;
}

/**
 * Append a record batch's targets to the current epoch's bucket, keeping only
 * TOPMOST elements: a target whose ancestor is already in the bucket is
 * dropped (the ancestor's re-walk covers it), and a new target drops any
 * bucket members inside its own subtree (it is the better root for them).
 */
function recordDirtyTargets(records: MutationRecord[]): void {
  const bucketEpoch = epoch;
  let bucket = dirtyRootsByEpoch.get(bucketEpoch);
  if (!bucket) {
    bucket = [];
    dirtyRootsByEpoch.set(bucketEpoch, bucket);
  }
  for (const record of records) {
    const el = recordTargetElement(record);
    if (!el || bucket.includes(el)) continue;
    let covered = false;
    for (let cur = el.parentElement; cur; cur = cur.parentElement) {
      if (bucket.includes(cur)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (el.contains(bucket[i])) bucket.splice(i, 1);
    }
    bucket.push(el);
  }
}

/** Drop any element whose ancestor is also in the list (cross-bucket dedupe). */
function dedupeTopmost(roots: Element[]): Element[] {
  const out: Element[] = [];
  for (const el of roots) {
    if (out.includes(el)) continue;
    let covered = false;
    for (let cur = el.parentElement; cur; cur = cur.parentElement) {
      if (out.includes(cur)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    for (let i = out.length - 1; i >= 0; i--) {
      if (el.contains(out[i])) out.splice(i, 1);
    }
    out.push(el);
  }
  return out;
}

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
  observer = new MutationObserver((records) => {
    bumpDomEpoch();
    recordDirtyTargets(records);
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

/**
 * The topmost mutated subtrees recorded since the last
 * {@link clearDirtyRoots}, limited to the epochs up to `epoch` (the caller's
 * current `getDomEpoch()`). Union of all un-consumed buckets, deduped to
 * topmost elements (a node whose ancestor is also in the result is dropped).
 *
 * Only meaningful while the signal is armed — an unarmed observer records
 * nothing, so callers must fail closed on `!isMutationSignalArmed()`.
 */
export function getDirtyRoots(epoch: number): Element[] {
  const roots: Element[] = [];
  for (const [bucketEpoch, bucket] of dirtyRootsByEpoch) {
    if (bucketEpoch > lastConsumedEpoch && bucketEpoch <= epoch) {
      roots.push(...bucket);
    }
  }
  return dedupeTopmost(roots);
}

/**
 * Mark the dirty roots recorded up to `epoch` as consumed (drop their
 * buckets). Called after every walk — full or partial — so the roots of an
 * observed mutation window are never re-applied to a later walk's splice.
 */
export function clearDirtyRoots(epoch: number): void {
  for (const bucketEpoch of Array.from(dirtyRootsByEpoch.keys())) {
    if (bucketEpoch <= epoch) dirtyRootsByEpoch.delete(bucketEpoch);
  }
  if (epoch > lastConsumedEpoch) lastConsumedEpoch = epoch;
}