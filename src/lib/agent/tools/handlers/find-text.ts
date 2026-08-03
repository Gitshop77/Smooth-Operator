/**
 * `find_text` action handler — TreeWalker-based text search; scrolls the
 * first matching text node's parent into view.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { TIMINGS, LIMITS, sleep } from "../constants";
import { isRendered, safeScrollIntoView } from "../helpers";
import type { ActionContext } from "./types";

/** Tag names whose text nodes should never be reported as "visible page text". */
const NON_RENDERED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

export async function handleFindText(
  ctx: ActionContext,
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
  if (!document.body) {
    return { action, success: false, message: "find_text: page has no body" };
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (p && NON_RENDERED_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p) {
        const s = getComputedStyle(p);
        if (s.display === "none" || s.visibility === "hidden") return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  let visits = 0;
  while ((node = walker.nextNode()) && visits < LIMITS.searchPageMaxNodeVisits) {
    visits++;
    const t = node.textContent;
    if (t && t.length >= want.length && t.toLowerCase().includes(want)) {
      // Text nodes inside document.body always have a non-null `parentElement`;
      // if it is somehow missing (detached/oddly-attached node), skip it rather
      // than risking an unsafe `parentNode` cast that could throw in isVisible.
      const parent = node.parentElement;
      if (!parent) continue;
      // Rendered check only (no viewport requirement) — text below the fold
      // is a legitimate match: the handler scrolls it into view, which is
      // exactly the schema contract ("Scroll the page until the given text
      // becomes visible"). Requiring viewport intersection here made
      // below-fold text unreachable ("not found" despite existing).
      if (isRendered(parent)) {
        safeScrollIntoView(parent);
        await sleep(TIMINGS.findTextScroll, ctx.signal);
        return { action, success: true, message: `Found "${action.text}" and scrolled to it` };
      }
    }
  }
  // Distinguish a *genuine* exhaustion (the TreeWalker returned `null`) from
  // hitting the node-visit cap while more text nodes remain. `node` is
  // reassigned on every iteration; if the loop exited because `walker.nextNode()`
  // returned `null`, `node` is `null` and the walk was exhaustive — report a
  // plain "not found". Only when `node` is still truthy did we stop at the cap
  // with nodes left unscanned, and "truncated" is the honest message (the text
  // may exist beyond the budget; `search_page` is regex-capable and can retry).
  if (node !== null) {
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
