/**
 * `search_page` action handler — regex or substring search across the page's
 * text nodes.
 *
 * Freeze protection on the page main thread: a single catastrophic-backtracking
 * regex run against ONE large text node can block the main thread inside a
 * single `regex.test(text)` call, so a node-visit / match cap alone is not
 * enough — the visit counter is only consulted between `test()` calls, never
 * mid-call. We defend in three layers:
 *   1. Cap the pattern length (LIMITS.searchPageMaxRegexPattern).
 *   2. Statically reject patterns whose source contains a *nested* unbounded
 *      quantifier (the classic `(a+)+`, `(a*)*`, `(a+)*` shape) — that is the
 *      structural cause of exponential backtracking.
 *   3. Truncate each text node before matching (SEARCH_PAGE_NODE_TEXT_CAP) so
 *      even a pattern we don't statically reject operates on bounded input, and
 *      cap total node visits (LIMITS.searchPageMaxNodeVisits).
 * Together these make a single pathological LLM- or prompt-injection-supplied
 * pattern unable to synchronously freeze the tab.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS } from "../constants";
import type { ActionContext } from "./types";

// Per-node text length handed to the regex. Catastrophic-backtracking cost
// scales with input length, so capping each text node bounds the worst case for
// any pattern that slips past the static nested-quantifier check.
const SEARCH_PAGE_NODE_TEXT_CAP = 4096;

// ── Static guard against nested-quantifier (catastrophic-backtracking) patterns ──

// A quantifier is "dangerous" when it is unbounded (or open-bounded) repetition:
// `*` or `+`, or `{n,}` / `{n,m}`. `?` and exact `{n}` cannot create the
// ambiguity that produces exponential backtracking, so they are treated as safe.
function isDangerousQuantifier(src: string, i: number): boolean {
  const c = src[i];
  if (c === "*" || c === "+") return true;
  if (c === "{") {
    // {n,} or {n,m} (comma present) — NOT exact {n}.
    return /^\{\d+,\d*\}/.test(src.slice(i));
  }
  return false;
}

// True when the group opened at `openIdx` contains a dangerous quantifier at its
// own nesting level (not inside a nested sub-group). Escapes and character
// classes are skipped so a literal `*`/`+`/`{` inside them is not mistaken for a
// quantifier.
function groupHasDangerousQuantifier(src: string, openIdx: number): boolean {
  let depth = 0;
  for (let j = openIdx; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "[") {
      const close = src.indexOf("]", j + 1);
      if (close < 0) return false;
      j = close;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      if (depth === 0) return false; // unmatched close (malformed) — stop
      depth--;
      if (depth === 0) return false; // matched the opening close — no danger inside
      continue;
    }
    if (depth >= 1 && isDangerousQuantifier(src, j)) return true;
  }
  return false;
}

// Find the `(` that opens the group a quantifier at `quantIdx` applies to.
// Returns -1 when the preceding atom is not a (balanced) group.
function precedingGroupOpen(src: string, quantIdx: number): number {
  let j = quantIdx - 1;
  // A backslash immediately before `)` means a literal `)` (escaped), not a
  // group close.
  if (j >= 0 && src[j] === "\\") return -1;
  if (j < 0 || src[j] !== ")") return -1;
  let depth = 0;
  for (; j >= 0; j--) {
    const c = src[j];
    if (c === "\\") {
      j--;
      continue;
    }
    if (c === ")") {
      depth++;
      continue;
    }
    if (c === "(") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// Reject patterns that quantify a group which itself contains an unbounded
// quantifier — the structural signature of catastrophic backtracking
// (e.g. `(a+)+`, `(a*)*`, `(a+)*`, `(a{2,})+`). The outer quantifying operator
// must itself be a repetition (`*`, `+`, `{n,}`, `{n,m}`); `?` cannot cause the
// ambiguity, so it is not treated as a trigger.
export function hasNestedQuantifier(pattern: string): boolean {
  const n = pattern.length;
  for (let i = 0; i < n; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      i = (close < 0 ? n : close) - 1; // loop's i++ lands just past `]`
      continue;
    }
    if (c === "*" || c === "+" || c === "{") {
      if (c === "{" && !/^\{\d+(,\d*)?\}/.test(pattern.slice(i))) {
        // A `{` that is not a quantifier token (e.g. a literal in some grammars).
        continue;
      }
      const open = precedingGroupOpen(pattern, i);
      if (open >= 0 && groupHasDangerousQuantifier(pattern, open)) return true;
    }
  }
  return false;
}

export async function handleSearchPage(
  _ctx: ActionContext,
  action: Extract<Action, { type: "search_page" }>,
): Promise<ActionResult> {
  const pattern = action.pattern;
  const flags = action.case_sensitive ? "g" : "gi";
  let regex: RegExp | null = null;
  if (action.regex) {
    if (pattern.length > LIMITS.searchPageMaxRegexPattern) {
      return {
        action,
        success: false,
        message: `Regex pattern too long (${pattern.length} > ${LIMITS.searchPageMaxRegexPattern} chars) — rejected to prevent tab freeze`,
      };
    }
    // Reject patterns whose source nests an unbounded quantifier inside a
    // quantified group. This is the structural root cause of catastrophic
    // backtracking; a short pattern of this shape run against one large text
    // node would otherwise block the main thread inside a single `test()` call.
    if (hasNestedQuantifier(pattern)) {
      return {
        action,
        success: false,
        message: `Regex pattern rejected: nested/overlapping quantifiers (e.g. "(a+)+") can cause catastrophic backtracking and freeze the tab`,
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
    let text = node.textContent || "";
    // Cap the per-node text handed to the regex so any pattern we didn't
    // statically reject still operates on bounded input (backtracking cost
    // grows with input length). Substring search is linear and needs no cap.
    if (regex && text.length > SEARCH_PAGE_NODE_TEXT_CAP) {
      text = text.slice(0, SEARCH_PAGE_NODE_TEXT_CAP);
    }
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
