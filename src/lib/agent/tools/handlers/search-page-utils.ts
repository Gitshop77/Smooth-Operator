// Per-node text length handed to the regex. Catastrophic-backtracking cost
// scales with input length, so capping each text node bounds the worst case for
// any pattern that slips past the static ReDoS check.
export const SEARCH_PAGE_NODE_TEXT_CAP = 1024;

// Hard wall-clock budget for the whole search. A pattern that slips past the
// static ReDoS check can still spend real time backtracking; capping total
// elapsed time bounds the freeze across nodes. This is checked *between*
// per-node match attempts — a single `test()` call remains uninterruptible from
// JS, but SEARCH_PAGE_NODE_TEXT_CAP bounds that one call's input while this
// budget bounds the aggregate. Together they cap the worst-case main-thread
// stall to roughly this many milliseconds plus one capped-input match.
export const SEARCH_PAGE_TIME_BUDGET_MS = 1000;

// The static ReDoS analyzer (`hasNestedQuantifier` + helpers) lives in
// `tools/schema-utils.ts` (shared with config validation); this module
// imports it (for `checkRedos`).

import { hasNestedQuantifier } from "../schema-utils";

// True when the pattern contains a backreference escape — a backslash followed
// by a digit 1–9. Backreferences make a match depend on previously captured
// text, which can drive catastrophic backtracking that the structural checks in
// `hasNestedQuantifier` don't model (e.g. `\b(\w+)\b\s+\1\b`, `(a)\1+`,
// `(.+?)\1+`). Such patterns are rare for page-text search and are exactly the
// risky ones, so they are rejected fail-closed. A literal backslash in the
// regex source is a single '\' character; we advance past the escaped char so
// an escaped backslash (`\\`) is never mistaken for a backreference.
export function hasBackreference(pattern: string): boolean {
  for (let i = 0; i < pattern.length - 1; i++) {
    if (pattern[i] === "\\") {
      const d = pattern.charCodeAt(i + 1);
      if (d >= 49 && d <= 57) return true; // '1'..'9' numeric backreference
      // Named backreferences come in three JS-accepted forms: `\k<name>`,
      // `\k{name}`, and `\k'name'`. Detect all three so the static ReDoS guard's
      // coverage is consistent (the RegExp constructor would reject the `{`/`'`
      // variants anyway, but we want to catch them before we ever call it).
      if (d === 107) {
        const c2 = pattern[i + 2];
        if (c2 === "<" || c2 === "{" || c2 === "'") return true;
      }
      i++;
    }
  }
  return false;
}

// Locate the first match of the search in `text`, returning its start index and
// length, or null when there is no match. Shared so the match can be located on
// both the raw node text (detection) and the redacted text (snippet centering)
// with identical semantics.
export function locateMatch(
  text: string,
  regex: RegExp | null,
  pattern: string,
  needle: string,
  caseSensitive: boolean,
): { idx: number; len: number } | null {
  if (regex) {
    regex.lastIndex = 0;
    const m = regex.exec(text);
    return m ? { idx: m.index, len: m[0].length } : null;
  }
  if (caseSensitive) {
    const idx = text.indexOf(pattern);
    return idx >= 0 ? { idx, len: pattern.length } : null;
  }
  const lower = text.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return null;
  // Lowercasing can change string length for some scripts (e.g. "ß" → "ss"),
  // which would make the lowercased `idx`/`len` point at the wrong place in the
  // ORIGINAL `text`. When the length is preserved the offset is valid; otherwise
  // walk the original text case-insensitively to recover the real start index.
  if (lower.length === text.length) {
    return { idx, len: needle.length };
  }
  for (let i = 0; i + needle.length <= text.length; i++) {
    if (text.slice(i, i + needle.length).toLowerCase() === needle) {
      return { idx: i, len: needle.length };
    }
  }
  return null;
}

// Cache ReDoS check results per pattern string to skip re-analysis on repeated searches.
const redosCheckCache = new Map<string, { nested: boolean; backref: boolean }>();

export function checkRedos(pattern: string): { nested: boolean; backref: boolean } {
  let cached = redosCheckCache.get(pattern);
  if (!cached) {
    cached = { nested: hasNestedQuantifier(pattern), backref: hasBackreference(pattern) };
    if (redosCheckCache.size > 256) redosCheckCache.clear();
    redosCheckCache.set(pattern, cached);
  }
  return cached;
}
