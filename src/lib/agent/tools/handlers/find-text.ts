/**
 * `find_text` action handler — TreeWalker-based text search; scrolls the
 * first matching text node's parent into view.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, LIMITS, sleep } from "../constants";
import { isVisible, safeScrollIntoView } from "../helpers";
import type { ActionContext } from "./types";

export async function handleFindText(
  _ctx: ActionContext,
  action: Extract<Action, { type: "find_text" }>,
): Promise<ActionResult> {
  // Use TreeWalker to find a matching text node, then scroll its parent into view.
  // Guard against empty search text — `"".includes("")` = true, so an empty
  // `find_text` would match the first visible text node. The schema should
  // enforce `.min(1)` but defense-in-depth here too.
  const want = action.text.toLowerCase().trim();
  if (!want) {
    return { action, success: false, message: "find_text requires non-empty text" };
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let visits = 0;
  while ((node = walker.nextNode()) && visits < LIMITS.searchPageMaxNodeVisits) {
    visits++;
    if (node.textContent && node.textContent.toLowerCase().includes(want)) {
      const parent = (node.parentElement || (node.parentNode as HTMLElement)) as HTMLElement;
      if (parent && isVisible(parent)) {
        safeScrollIntoView(parent);
        await sleep(TIMINGS.findTextScroll);
        return { action, success: true, message: `Found "${action.text}" and scrolled to it` };
      }
    }
  }
  return { action, success: false, message: `"${action.text}" not found on page` };
}
