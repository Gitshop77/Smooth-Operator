/**
 * `search_page` action handler — regex or substring search across the page's
 * text nodes.
 *
 * ReDoS / freeze protection on the page main thread
 * ------------------------------------------------
 * A single catastrophic-backtracking regex run against ONE large text node can
 * block the main thread inside a single `regex.test(text)` call. That call
 * cannot be interrupted from JavaScript, so a node-visit / match cap is only
 * consulted *between* `test()` calls — it bounds the number of matches but not
 * the cost of any single one. We therefore defend in layers:
 * 1. Cap the pattern length (LIMITS.searchPageMaxRegexPattern) so the source
 * itself can't be a giant pathological expression.
 * 2. Statically reject patterns that are KNOWN catastrophic-backtracking
 * (ReDoS) shapes — a *nested* unbounded quantifier such as `(a+)+`,
 * `(a*)*`, `(a+)*`, or `(a{2,})+`, and *ambiguous alternation* under an
 * unbounded quantifier such as `(a|a)+`, `(a|ab)+`, `(a|a|a)+$`. These are
 * the structural signatures of exponential backtracking. This is the
 * primary safeguard: any pattern that slips past it can still, in
 * principle, hang the thread (the static check is conservative and can't
 * model every engine's optimizer), so it is intentionally biased toward
 * rejection. See `hasNestedQuantifier` below.
 * 3. Truncate each text node before matching (SEARCH_PAGE_NODE_TEXT_CAP) so
 * even a pattern we don't statically reject operates on bounded input
 * (backtracking cost grows with input length), and cap total node visits
 * (LIMITS.searchPageMaxNodeVisits).
 * Together these make the common pathological cases unable to freeze the tab.
 * A pattern that evades the static analyzer could still block the main thread
 * inside one `test()` call — the visit cap does not help there — but layers 1
 * and 3 keep both the source and the per-node input bounded.
 */

import type { ActionResult } from "../../types";
import type { Action } from "../schema";
import { LIMITS } from "../constants";
import type { ActionContext } from "./types";

// Per-node text length handed to the regex. Catastrophic-backtracking cost
// scales with input length, so capping each text node bounds the worst case for
// any pattern that slips past the static ReDoS check.
const SEARCH_PAGE_NODE_TEXT_CAP = 4096;

// Hard wall-clock budget for the whole search. A pattern that slips past the
// static ReDoS check can still spend real time backtracking; capping total
// elapsed time bounds the freeze across nodes. This is checked *between*
// per-node match attempts — a single `test()` call remains uninterruptible from
// JS, but SEARCH_PAGE_NODE_TEXT_CAP bounds that one call's input while this
// budget bounds the aggregate. Together they cap the worst-case main-thread
// stall to roughly this many milliseconds plus one capped-input match.
const SEARCH_PAGE_TIME_BUDGET_MS = 1000;

// ── Static guard against catastrophic-backtracking (ReDoS) patterns ──

// A quantifier is "dangerous" when it is unbounded (or open-bounded) repetition:
// `*` or `+`, or `{n,}` / `{n,m}`. `?` and exact `{n}` cannot create the
// ambiguity that produces exponential backtracking, so they are treated as safe.
function atUnboundedQuantifier(src: string, i: number): boolean {
  const c = src[i];
  if (c === "*" || c === "+") return true;
  if (c === "{") return /^\{\d+,\d*\}/.test(src.slice(i));
  return false;
}

// Length of the unbounded-quantifier token starting at `i`, or 0 if `src[i]` is
// not an unbounded quantifier.
function quantifierLengthAt(src: string, i: number): number {
  const c = src[i];
  if (c === "*" || c === "+") return 1;
  if (c === "{") {
    const m = /^\{\d+,\d*\}/.exec(src.slice(i));
    if (m) return m[0].length;
  }
  return 0;
}

// Index of the `)` that closes the group opened at `openIdx`, honoring nesting,
// escapes and character classes. Returns -1 if the source is malformed.
function findGroupClose(src: string, openIdx: number): number {
 // Start scanning AFTER the opening paren so `depth` counts only *nested*
 // groups. The matching close is the first `)` seen at depth 0. (Counting the
 // opener itself would leave depth at 1 when the matching `)` is reached, so
 // the function would fall through and return -1 — silently disabling the
 // ReDoS guard for every parenthesized pattern.)
  let depth = 0;
  for (let j = openIdx + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "[") {
      const close = src.indexOf("]", j + 1);
      if (close < 0) return -1;
      j = close;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

// True when the group opened at `openIdx` is a zero-width lookaround assertion
// (`(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)`). Quantifying a lookaround is linear and
// not a ReDoS vector, so such groups are ignored by the analyzer.
function groupPrefixIsLookaround(src: string, openIdx: number): boolean {
  if (src[openIdx] !== "(" || src[openIdx + 1] !== "?") return false;
  const t = src[openIdx + 2];
  if (t === "=" || t === "!") return true;
  if (t === "<" && (src[openIdx + 3] === "=" || src[openIdx + 3] === "!")) return true;
  return false;
}

// Split a group's CONTENT into its top-level alternation branches (separated by
// an unescaped `|` that is not nested inside a subgroup or character class).
// Returns null when the content has no such alternation.
function splitTopLevelAlternation(content: string): string[] | null {
  const branches: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "\\") {
      cur += c + (content[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (content[j] === "^") {
        cur += c + content[j];
        j++;
      }
      while (j < content.length) {
        if (content[j] === "\\") {
          cur += content[j] + (content[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (content[j] === "]") break;
        cur += content[j];
        j++;
      }
      cur += "]";
      i = j;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")") {
      depth--;
      cur += c;
      continue;
    }
    if (c === "|" && depth === 0) {
      branches.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  branches.push(cur);
  return branches.length >= 2 ? branches : null;
}

// The set of characters a branch can start with, or the sentinel "ANY" meaning
// it can start with (almost) any character. Used to judge whether two
// alternatives of an alternation can match overlapping input.
type CharSet = Set<string> | "ANY";

function digitSet(): Set<string> {
  const s = new Set<string>();
  for (let k = 48; k <= 57; k++) s.add(String.fromCharCode(k));
  return s;
}
function wordSet(): Set<string> {
  const s = new Set<string>();
  for (let k = 48; k <= 57; k++) s.add(String.fromCharCode(k));
  for (let k = 65; k <= 90; k++) s.add(String.fromCharCode(k));
  for (let k = 97; k <= 122; k++) s.add(String.fromCharCode(k));
  s.add("_");
  return s;
}
function spaceSet(): Set<string> {
  return new Set<string>([" ", "\t", "\n", "\r", "\f", "\v"]);
}

function firstCharSet(branch: string): CharSet {
  if (branch === "") return new Set<string>();
  const c = branch[0];
  if (c === "\\") {
    const e = branch[1];
    if (e === "d") return digitSet();
    if (e === "w") return wordSet();
    if (e === "s") return spaceSet();
    if (e === "D" || e === "W" || e === "S" || e === "b" || e === "B") return "ANY";
    return new Set<string>([e]);
  }
  if (c === "[") {
    let j = 1;
    if (branch[j] === "^") return "ANY";
    const set = new Set<string>();
    while (j < branch.length) {
      if (branch[j] === "\\") {
        set.add(branch[j + 1] ?? "");
        j += 2;
        continue;
      }
      if (branch[j] === "]") break;
      if (j + 2 < branch.length && branch[j + 1] === "-") {
        const lo = branch[j].charCodeAt(0);
        const hi = branch[j + 2].charCodeAt(0);
        for (let k = lo; k <= hi; k++) set.add(String.fromCharCode(k));
        j += 3;
        continue;
      }
      set.add(branch[j]);
      j++;
    }
    return set;
  }
  if (c === ".") return "ANY";
  if (c === "(") {
 // Lookarounds are zero-width and treated conservatively as "ANY".
    if (branch[1] === "?") {
      const t = branch[2];
      if (t === "=" || t === "!" || (t === "<" && (branch[3] === "=" || branch[3] === "!"))) {
        return "ANY";
      }
    }
    const close = findGroupClose(branch, 0);
    if (close < 0) return "ANY";
    let start = 1;
    if (branch[1] === "?") {
      let p = 2;
      while (p < branch.length && branch[p] !== ">") p++;
      start = p + 1;
    }
    const innerContent = branch.slice(start, close);
    const inner = splitTopLevelAlternation(innerContent);
    if (inner) {
      const union = new Set<string>();
      let any = false;
      for (const b of inner) {
        const s = firstCharSet(b);
        if (s === "ANY") any = true;
        else for (const ch of s) union.add(ch);
      }
      return any ? "ANY" : union;
    }
    return firstCharSet(innerContent);
  }
  if (c === "^" || c === "$") return "ANY";
  return new Set<string>([c]);
}

function charSetsOverlap(a: CharSet, b: CharSet): boolean {
  if (a === "ANY" || b === "ANY") return true;
  for (const ch of a) if (b.has(ch)) return true;
  return false;
}

// True when a group that is directly quantified by an unbounded quantifier
// contains an ambiguous top-level alternation — the structural signature of
// alternation-based ReDoS (e.g. `(a|a)+`, `(a|ab)+`, `(a|a|a)+$`). Ambiguity is
// judged by overlapping first-character sets between branches, or by one branch
// being a prefix of another. Disjoint alternatives (e.g. `(abc|def)+`) and
// non-overlapping single chars (e.g. `(a|b|c)+`) are treated as safe.
function groupHasAmbiguousAlternation(src: string, openIdx: number, closeIdx: number): boolean {
  const content = src.slice(openIdx + 1, closeIdx);
  const branches = splitTopLevelAlternation(content);
  if (!branches) return false;
  if (branches.some((b) => b === "")) return true; // empty alternative ⇒ ambiguity
  const sets = branches.map(firstCharSet);
  for (let x = 0; x < sets.length; x++) {
    for (let y = x + 1; y < sets.length; y++) {
      if (charSetsOverlap(sets[x], sets[y])) return true;
    }
  }
  for (let x = 0; x < branches.length; x++) {
    for (let y = 0; y < branches.length; y++) {
      if (x !== y && branches[x] !== "" && branches[y].startsWith(branches[x])) return true;
    }
  }
  return false;
}

// True when the group opened at `openIdx` (closed at `closeIdx`) itself contains
// an unbounded quantifier at a nesting level strictly inside it — i.e. the group
// is something like `(a+)`, `([a-z]+)`, `(a*)` — which makes quantifying the
// whole group a nested-quantifier ReDoS (e.g. `(a+)+`).
function groupHasDangerousNestedQuantifier(src: string, openIdx: number, closeIdx: number): boolean {
  let depth = 0;
  for (let j = openIdx; j <= closeIdx; j++) {
    const c = src[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "[") {
      const close = src.indexOf("]", j + 1);
      if (close < 0 || close > closeIdx) break;
      j = close;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      if (depth === 0) break;
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth >= 1 && atUnboundedQuantifier(src, j)) return true;
  }
  return false;
}

// Reject patterns that are KNOWN catastrophic-backtracking (ReDoS) shapes:
// • a group containing an unbounded quantifier, itself quantified by an
// unbounded quantifier — e.g. `(a+)+`, `(a*)*`, `(a+)*`, `(a{2,})+`,
// `([a-z]+)+$`;
// • a group with an ambiguous top-level alternation, quantified by an unbounded
// quantifier — e.g. `(a|a)+`, `(a|ab)+`, `(a|a|a)+$`, `((a|b)+)+`.
// Lookaround groups are ignored (quantifying them is linear). `?` and exact
// `{n}` repetitions are not triggers. The check is conservative: it may reject a
// handful of patterns an engine could optimize, but erring toward rejection is
// the safer choice for a handler driven by LLM / prompt-injection-supplied input.
export function hasNestedQuantifier(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close < 0) break;
      i = close;
      continue;
    }
    if (c === "(") {
      if (groupPrefixIsLookaround(pattern, i)) continue;
      const close = findGroupClose(pattern, i);
      if (close < 0) continue; // malformed — leave to the RegExp constructor
 // Only a group immediately followed by an unbounded quantifier can be a
 // ReDoS vector of these shapes.
      if (quantifierLengthAt(pattern, close + 1) > 0) {
        if (groupHasDangerousNestedQuantifier(pattern, i, close)) return true;
        if (groupHasAmbiguousAlternation(pattern, i, close)) return true;
      }
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
 // Reject patterns whose source is a known catastrophic-backtracking (ReDoS)
 // shape: a nested unbounded quantifier (e.g. `(a+)+`) or an ambiguous
 // alternation under an unbounded quantifier (e.g. `(a|a)+`). This is the
 // structural root cause of exponential backtracking; a short pattern of this
 // shape run against one large text node would otherwise block the main
 // thread inside a single `test()` call that cannot be interrupted.
    if (hasNestedQuantifier(pattern)) {
      return {
        action,
        success: false,
        message: `Regex pattern rejected: nested quantifiers or ambiguous alternation (e.g. "(a+)+" or "(a|a)+") can cause catastrophic backtracking and freeze the tab`,
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
  const deadline = Date.now() + SEARCH_PAGE_TIME_BUDGET_MS;
  while ((node = walker.nextNode()) && count < LIMITS.searchPageMaxMatches && visits < LIMITS.searchPageMaxNodeVisits) {
 // Hard wall-clock cap: stop searching once the budget is exhausted so a
 // slow-but-not-statically-rejected pattern can't stall the tab indefinitely
 // across many nodes. Results found so far are still returned.
    if (Date.now() > deadline) break;
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
