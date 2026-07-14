/** `scroll` action handler — smooth-scroll the page up or down by viewport-heights. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS } from "../constants";
import type { ActionContext } from "./types";

/**
 * Best-effort clear of the vision-elements cache in the service worker.
 *
 * The cache stores viewport-relative pixel rects from detect_visual; after a
 * scroll those rects are stale — a CDP click on [vN] would land at the old
 * position. We await the response (1-5ms round-trip) so the cache is cleared
 * before the next action in the batch executes; a fire-and-forget would risk a
 * race where the next click reads stale cache before the clear lands.
 *
 * The SW may be suspended between calls, so the first attempt can fail even
 * when a run is active. We retry once: a single retry recovers the common
 * "SW just woke up" case without materially slowing the action. If both
 * attempts fail we treat the clear as best-effort-non-fatal (the scroll itself
 * still succeeded) but report the staleness so callers can re-extract vision
 * state before the next [vN] click.
 *
 * @returns true if the cache was cleared (or there is no SW to clear it, e.g.
 * the in-page demo), false if both attempts failed and the vision
 * cache may be stale.
 */
async function clearVisionCache(): Promise<boolean> {
 // No extension runtime — the in-page demo has no SW-managed vision cache, so
 // there is nothing to clear and no staleness to warn about.
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return true;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await chrome.runtime.sendMessage({ type: "CLEAR_VISION_CACHE" });
      return true;
    } catch (err) {
      if (attempt === 1) continue; // retry once for a transiently-asleep SW
      console.warn(
        "CLEAR_VISION_CACHE failed twice; vision cache may be stale " +
          "(SW may be asleep — non-fatal, but a subsequent [vN] click could " +
          "land at a stale coordinate):",
        err,
      );
    }
  }
  return false;
}

export async function handleScroll(
  _ctx: ActionContext,
  action: Extract<Action, { type: "scroll" }>,
): Promise<ActionResult> {
  const down = action.down !== false;
  const pages = action.pages;
 // ~0.85 of a viewport height matches a typical "page down" feel; perturb the
 // per-page factor by a few percent so the scroll distance is not a perfectly
 // deterministic, repeatable fingerprint (humans vary per page too).
  const factor = 0.82 + Math.random() * 0.06;
  const dy = (down ? 1 : -1) * pages * window.innerHeight * factor;
 // Honor prefers-reduced-motion: avoid an animated scroll for users who asked
 // the OS to minimize motion (vestibular/migraine triggers).
  const reduceMotion =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  window.scrollBy({ top: dy, behavior: reduceMotion ? "auto" : "smooth" });
 // Wait for the scroll to actually settle before the next action reads the
 // viewport. Prefer the `scrollend` event (scales with distance) and cap the
 // wait so a non-firing event can't hang the step.
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    window.addEventListener("scrollend", finish, { once: true });
    setTimeout(finish, Math.min(TIMINGS.scrollSmooth * Math.max(pages, 1), 3000));
  });

  const cacheCleared = await clearVisionCache();

 // The scroll itself always succeeds, so we never flip `success` to false for
 // a failed cache clear. But we surface the staleness in the message so the
 // agent loop / UI can re-extract vision state before the next [vN] click
 // rather than silently risking a wrong-coordinate click.
  const base = `Scrolled ${down ? "down" : "up"} ${pages} page(s)`;
  const message = cacheCleared
    ? base
    : `${base} (warning: vision cache clear failed — re-extract vision state before clicking [vN])`;

  return { action, success: true, message };
}
