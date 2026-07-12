/**
 * background/vision.ts — self-contained vision helper extracted from
 * `run-helpers.ts`.
 *
 * This file holds ONLY the pure vision code that has no dependency on the
 * module-level vision singleton state owned by `run-helpers.ts`
 * (`globalVisionAssistant`, `visionInitPromise`, `visionInitFailed`,
 * `visionElementsCache`, `visionCacheUrl`, `lastKnownDpr`,
 * `adaptiveVisionLastUsedStep`, `adaptiveVisionCurrentStep`). That singleton
 * cluster is intentionally left in `run-helpers.ts` because the functions
 * share mutable state and must not be fragmented — moving any of them would
 * require exporting cross-module mutable state and risk behavior changes.
 *
 * `stripUrlFragment` is the single safe, side-effect-free helper that can be
 * isolated without touching shared state.
 */

/**
 * Strip the fragment (`#...`) from a URL for cache-freshness comparison.
 *
 * A plain *anchor* fragment (e.g. navigating to `#section-2`) does not change
 * the viewport layout, so cached vision rects remain valid and the fragment can
 * be dropped from the cache key.
 *
 * HOWEVER, many SPAs route via the fragment (e.g. `https://app.example.com/#/settings`
 * vs `#/billing`). For those, a fragment change DOES change the visible
 * content/layout, so cached vision rects would be stale and cause misclicks if
 * the fragment were stripped. We therefore keep any fragment that looks like a
 * client-side route (begins with `#/` or `#!` — the two common hash-route
 * prefixes) in the cache key, and only drop plain anchors.
 *
 * Query strings ARE always included in the comparison (SPA route changes via
 * `?route=...` DO change the layout).
 */
export function stripUrlFragment(url: string): string {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) return url;
  const fragment = url.slice(hashIdx);
 // Hash-routing SPA segment (`#/...`) or hashbang (`#!...`): treat as a route
 // change, so keep the fragment in the cache key to force a fresh vision pass.
  if (fragment.startsWith("#/") || fragment.startsWith("#!")) return url;
 // Plain anchor: safe to drop for cache-freshness comparison.
  return url.slice(0, hashIdx);
}
