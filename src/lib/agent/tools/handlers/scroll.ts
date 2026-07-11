/** `scroll` action handler — smooth-scroll the page up or down by viewport-heights. */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, sleep } from "../constants";
import type { ActionContext } from "./types";

export async function handleScroll(
  _ctx: ActionContext,
  action: Extract<Action, { type: "scroll" }>,
): Promise<ActionResult> {
  const down = action.down !== false;
  const pages = action.pages;
  // 0.85 of a viewport height matches a typical "page down" feel.
  const dy = (down ? 1 : -1) * pages * window.innerHeight * 0.85;
  window.scrollBy({ top: dy, behavior: "smooth" });
  await sleep(TIMINGS.scrollSmooth);
  // Clear the vision elements cache after scroll. The cache stores
  // viewport-relative pixel rects from detect_visual; after scrolling, those
  // rects are stale — a CDP click on [vN] would land at the old position.
  // Best-effort: the SW handler is a no-op if no run is active. We await the
  // response (1-5ms round-trip) so the cache is cleared before the next action
  // in the batch executes — a fire-and-forget would risk a race where the next
  // click reads stale cache before the clear lands.
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    try { await chrome.runtime.sendMessage({ type: "CLEAR_VISION_CACHE" }); }
    catch (err) { console.warn("CLEAR_VISION_CACHE failed; vision cache may be stale (SW may be asleep — non-fatal):", err); }
  }
  return { action, success: true, message: `Scrolled ${down ? "down" : "up"} ${pages} page(s)` };
}
