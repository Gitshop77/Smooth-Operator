/**
 * `search_page` action handler — regex or substring search across the page's
 * text nodes. Caps pattern length + total node visits to prevent tab freezes
 * from catastrophic-backtracking regex.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS } from "../constants";
import type { ActionContext } from "./types";

export async function handleSearchPage(
  _ctx: ActionContext,
  action: Extract<Action, { type: "search_page" }>,
): Promise<ActionResult> {
  const pattern = action.pattern;
  const flags = action.case_sensitive ? "g" : "gi";
  // Guard against catastrophic-backtracking regex patterns from LLM-supplied
  // or prompt-injection-supplied input. Cap the pattern length and cap the
  // total node visits (not just match count) so a pathological pattern can't
  // synchronously freeze the tab's main thread by walking every text node
  // with a backtracking regex.
  let regex: RegExp | null = null;
  if (action.regex) {
    if (pattern.length > LIMITS.searchPageMaxRegexPattern) {
      return {
        action,
        success: false,
        message: `Regex pattern too long (${pattern.length} > ${LIMITS.searchPageMaxRegexPattern} chars) — rejected to prevent tab freeze`,
      };
    }
    try {
      regex = new RegExp(pattern, flags);
    } catch (e) {
      return {
        action,
        success: false,
        message: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  const results: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let count = 0;
  let visits = 0;
  while ((node = walker.nextNode()) && count < LIMITS.searchPageMaxMatches && visits < LIMITS.searchPageMaxNodeVisits) {
    visits++;
    const text = node.textContent || "";
    // Reset lastIndex for global regexes so repeated test() calls work.
    if (regex) regex.lastIndex = 0;
    const match = regex
      ? regex.test(text)
      : action.case_sensitive
        ? text.includes(pattern)
        : text.toLowerCase().includes(pattern.toLowerCase());
    if (match) {
      const ctx = text.trim().slice(0, LIMITS.searchPageContextChars);
      results.push(`- ${ctx}`);
      count++;
    }
  }
  return {
    action,
    // search_page is a read-only search action. Returning success:false on 0
    // matches would abort the action queue, which is wrong for a read-only
    // query (the search succeeded — it just found nothing). find_elements
    // returns success:true on 0 matches; search_page matches that semantic.
    success: true,
    message: results.length > 0 ? `Found ${results.length} matches` : "No matches found",
    extractedContent: results.length > 0 ? `Search results for "${pattern}":\n${results.join("\n")}` : undefined,
  };
}
