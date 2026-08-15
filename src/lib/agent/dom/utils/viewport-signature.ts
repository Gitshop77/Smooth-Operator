/**
 * Compact viewport + scroll signature for DOM-cache keying.
 *
 * `getBoundingClientRect` values are scroll-relative: a pure scroll — with an
 * otherwise identical DOM — invalidates every cached rect, and a window resize
 * re-flows the whole viewport. Two caches key on this:
 *
 * - the shared per-epoch read cache (`../utils/read-cache`) — the epoch alone
 *   doesn't move on scroll, so cached rects would go stale while a walk is
 *   being served from them;
 * - the background's vision cache freshness check (`run-helpers-utils`) — a
 *   pre-scroll detection set becomes mislocalized after the page scrolls.
 *
 * Deliberately NOT folded into `domFingerprint` (tools/helpers/dom-fingerprint):
 * that signature drives pageChanged semantics (action-batch breaking, loop
 * detector resets, go-back/evaluate success detection), where a scroll must
 * NOT look like a page change.
 */
export function viewportSignature(): string {
  return `${window.scrollX}:${window.scrollY}:${window.innerWidth}:${window.innerHeight}`;
}