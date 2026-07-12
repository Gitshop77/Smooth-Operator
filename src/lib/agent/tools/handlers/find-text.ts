/**
 * `find_text` action handler — TreeWalker-based text search; scrolls the
 * first matching text node's parent into view.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, LIMITS, sleep } from "../constants";
import { isVisible, safeScrollIntoView } from "../helpers";
import type { ActionContext } from "./types";

/** Tag names whose text nodes should never be reported as "visible page text". */
const NON_RENDERED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

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
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
 // Skip text inside non-rendered containers (script/style/noscript/template):
 // those text nodes are not user-visible but would otherwise pass the
 // visibility gate (their computed `display` is not `none`).
    acceptNode(node) {
      const p = node.parentElement;
      if (p && NON_RENDERED_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  let visits = 0;
  while ((node = walker.nextNode()) && visits < LIMITS.searchPageMaxNodeVisits) {
    visits++;
    if (node.textContent && node.textContent.toLowerCase().includes(want)) {
 // Text nodes inside document.body always have a non-null `parentElement`;
 // if it is somehow missing (detached/oddly-attached node), skip it rather
 // than risking an unsafe `parentNode` cast that could throw in isVisible.
      const parent = node.parentElement;
      if (!parent) continue;
      if (isVisible(parent)) {
        safeScrollIntoView(parent);
        await sleep(TIMINGS.findTextScroll);
        return { action, success: true, message: `Found "${action.text}" and scrolled to it` };
      }
    }
  }
 // If we bailed out at the node-visit cap, say so explicitly: the text may
 // genuinely exist beyond the 5000-node budget, and the agent can retry via
 // `search_page` (which is regex-capable) instead of giving up.
  if (visits >= LIMITS.searchPageMaxNodeVisits) {
    return {
      action,
      success: false,
      message:
        `"${action.text}" not found on page (search truncated after ${visits} text ` +
        `nodes — try the \`search_page\` action for a regex scan)`,
    };
  }
  return { action, success: false, message: `"${action.text}" not found on page` };
}
