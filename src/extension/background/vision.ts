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
 * A fragment-only change (e.g. navigating to `#section-2`) doesn't change
 * the viewport layout, so cached vision rects remain valid. Query strings
 * ARE included in the comparison (SPA route changes via `?route=...` DO
 * change the layout).
 */
export function stripUrlFragment(url: string): string {
  const hashIdx = url.indexOf("#");
  return hashIdx === -1 ? url : url.slice(0, hashIdx);
}
