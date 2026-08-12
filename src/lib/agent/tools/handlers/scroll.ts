/** `scroll` action handler — smooth-scroll the page up or down by viewport-heights. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, sleep } from "../constants";
import { type ActionContext, isExtensionContext } from "./types";
import { throwIfAborted } from "./abort";
import { swRpc } from "./sw-rpc";

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
async function clearVisionCache(ctx: ActionContext): Promise<boolean> {
  // No extension runtime — the in-page demo has no SW-managed vision cache, so
  // there is nothing to clear and no staleness to warn about.
  if (!isExtensionContext()) return true;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      throwIfAborted(ctx.signal);
      const response = await swRpc<{ ok?: boolean; error?: string }>({
        type: "CLEAR_VISION_CACHE",
        ...(ctx.dispatchToken ? { token: ctx.dispatchToken } : {}),
      }, "CLEAR_VISION_CACHE", ctx.signal);
      throwIfAborted(ctx.signal);
      if (!response?.ok) throw new Error(response?.error || "vision cache clear rejected");
      return true;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
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
  ctx: ActionContext,
  action: Extract<Action, { type: "scroll" }>,
): Promise<ActionResult> {
  throwIfAborted(ctx.signal);
  const down = action.down !== false;
  const pages = action.pages ?? 1;
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
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        window.removeEventListener("scrollend", finish);
        ctx.signal?.removeEventListener("abort", abort);
        resolve();
      }
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      window.removeEventListener("scrollend", finish);
      reject(ctx.signal?.reason instanceof Error ? ctx.signal.reason : new DOMException("Aborted", "AbortError"));
    };
    window.addEventListener("scrollend", finish, { once: true });
    ctx.signal?.addEventListener("abort", abort, { once: true });
    const t = setTimeout(finish, Math.min(TIMINGS.scrollSmooth * Math.max(pages, 1), 3000));
    if (ctx.signal?.aborted) abort();
  });

  const cacheCleared = await clearVisionCache(ctx);
  throwIfAborted(ctx.signal);

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

/**
 * `scroll_to_bottom` action handler — scroll the page to the very bottom in
 * viewport-sized steps, waiting for lazy content after each step, then restore
 * the viewport to the top so the next step's screenshot shows the page from a
 * known position.
 *
 * The loop terminates when a scroll no longer changes the position (the
 * bottom was reached, possibly with a "already at the bottom" first step).
 * Each wait honors the abort signal, so a cancelled run aborts mid-loop with
 * an AbortError instead of hanging (same contract as `wait`).
 */
export async function handleScrollToBottom(
  ctx: ActionContext,
  action: Extract<Action, { type: "scroll_to_bottom" }>,
): Promise<ActionResult> {
  const delayMs = Math.round((action.delay_seconds ?? 0.4) * 1000);
  const { signal } = ctx;
  let steps = 0;
  let lastY = window.scrollY;
  for (;;) {
    throwIfAborted(signal);
    window.scrollBy({ top: window.innerHeight });
    // Wait for lazy-loaded content to extend the page before checking whether
    // the viewport can still move.
    await sleep(delayMs, signal);
    const y = window.scrollY;
    if (y === lastY) break; // viewport stopped moving — bottom reached
    lastY = y;
    steps++;
  }
  // Restore the viewport to the top (matches the spec: scroll down, then back
  // to the top) so the next action starts from a known position.
  throwIfAborted(signal);
  window.scrollTo(0, 0);

  const cacheCleared = await clearVisionCache(ctx);
  throwIfAborted(signal);
  const base = `Scrolled to bottom (${steps} steps) and restored the viewport to the top`;
  const message = cacheCleared
    ? base
    : `${base} (warning: vision cache clear failed — re-extract vision state before clicking [vN])`;

  return { action, success: true, message };
}
