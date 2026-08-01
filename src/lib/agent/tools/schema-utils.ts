import { z } from "zod";
import { MAX_CUSTOM_TOOL_CODE_LENGTH } from "./registry";
import type { Action } from "./schema";

// ─── Safe boolean coercion ─────────────────────────────────────────────────

const TRUTHY = [true, "true", "True", "TRUE", 1, "1"] as const;
const FALSEY = ["false", "False", "FALSE", "0", 0] as const;
const truthy = new Set<unknown>(TRUTHY);
const falsey = new Set<unknown>(FALSEY);
/**
 * Coerce a flexible boolean-like input to a real boolean (no truthy-string
 * trap). `null`/`undefined` pass through so the field's `.default()` — the
 * documented default — applies; unknown values are still rejected. The output
 * type stays `boolean` (the pre-transform contract); `null` on a field
 * without a default resolves to `undefined` at runtime, which is falsy.
 */
export const flexibleBoolean = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return undefined;
    if (truthy.has(v)) return true;
    if (falsey.has(v)) return false;
    return v;
  },
  z.boolean().optional(),
) as unknown as z.ZodType<boolean>;

// ─── Bounded free-text helpers ───────────────────────────────────────────────

export const MAX_FREE_TEXT_CHARS = 64 * 1024; // 64 KiB
export const MAX_CODE_CHARS = MAX_CUSTOM_TOOL_CODE_LENGTH; // 256 KiB
export const MAX_SHORT_TEXT_CHARS = 8 * 1024; // 8 KiB

/** A free-text field capped to `max` characters after coercion. */
export function boundedText(max: number, msg?: string): z.ZodType<string> {
  return z.coerce.string().max(max, msg ?? `text exceeds ${max} character limit`);
}

// ─── Action metadata (for the prompt + executor) ────────────────────────────

/** Static metadata about an action — used to render the prompt and guide execution. */
interface ActionMeta {
  /** Action name (matches the `type` discriminator). */
  name: string;
  /** Human-readable description for the system prompt. */
  description: string;
  /** Whether executing this action likely changes the page. Consumed ONLY to
   *  render the prompt's "[page-changing — put last]" tag — it does NOT drive
   *  queue-abort prediction (the executor decides aborts per-action via
   *  `result.pageChanged`). */
  pageChanging: boolean;
  /** Whether this action must be the only action in its step. */
  exclusive: boolean;
  /** Parameter signature for the prompt, e.g. `index: number, text: string`. */
  params: string;
}

/** Metadata for every action in the action set. */
export const ACTION_METADATA: Record<string, ActionMeta> = {
  click:              { name: "click",              description: "Click an interactive element by index.",                pageChanging: false, exclusive: false, params: "index: number" },
  input:              { name: "input",              description: "Type text into an input/textarea.",                    pageChanging: false, exclusive: false, params: "index: number, text: string, clear?: boolean (default true = replace)" },
  select_dropdown:    { name: "select_dropdown",    description: "Choose an option in a <select>.",                      pageChanging: false, exclusive: false, params: "index: number, text?: string OR option_index?: number" },
  scroll:             { name: "scroll",             description: "Scroll the page.",                                     pageChanging: false, exclusive: false, params: "down?: boolean (default true), pages?: number (default 1)" },
  send_keys:          { name: "send_keys",          description: "Press a key (Enter, Escape, Tab...).",                 pageChanging: false, exclusive: false, params: "keys: string" },
  navigate:           { name: "navigate",           description: "Go to a URL (optionally new tab).",                    pageChanging: true,  exclusive: false, params: "url: string, new_tab?: boolean (default false)" },
  switch_tab:         { name: "switch_tab",         description: "Switch to another open tab.",                          pageChanging: true,  exclusive: false, params: "tab_id: number" },
  close_tab:          { name: "close_tab",          description: "Close a tab.",                                         pageChanging: true,  exclusive: false, params: "tab_id: number" },
  go_back:            { name: "go_back",            description: "Browser back button.",                                 pageChanging: true,  exclusive: false, params: "(none)" },
  wait:               { name: "wait",               description: "Wait for the page to settle.",                         pageChanging: false, exclusive: false, params: "seconds?: number (default 3)" },
  find_text:          { name: "find_text",          description: "Scroll until text is visible.",                        pageChanging: false, exclusive: false, params: "text: string" },
  extract:            { name: "extract",            description: "Extract info from page text via a query.",             pageChanging: false, exclusive: false, params: "query: string" },
  done:               { name: "done",               description: "Finish the task.",                                     pageChanging: false, exclusive: true,  params: "text: string (summary), success: boolean" },
  search:             { name: "search",             description: "Search the web (DuckDuckGo/Google/Bing).",             pageChanging: true,  exclusive: false, params: "query: string, engine?: 'duckduckgo'|'google'|'bing'|'yahoo'|'baidu'" },
  upload_file:        { name: "upload_file",        description: "Upload a file to a file input.",                       pageChanging: false, exclusive: false, params: "index: number, path: string" },
  screenshot:         { name: "screenshot",         description: "Take a screenshot of the page.",                       pageChanging: false, exclusive: false, params: "file_name?: string" },
  save_as_pdf:        { name: "save_as_pdf",        description: "Save the page as a PDF.",                              pageChanging: false, exclusive: false, params: "file_name?: string" },
  dropdown_options:   { name: "dropdown_options",   description: "List options of a <select>.",                          pageChanging: false, exclusive: false, params: "index: number" },
  search_page:        { name: "search_page",        description: "Search for text/pattern on the page (instant, free).", pageChanging: false, exclusive: false, params: "pattern: string, regex?: boolean, case_sensitive?: boolean" },
  find_elements:      { name: "find_elements",      description: "Find elements by CSS selector (instant, free).",       pageChanging: false, exclusive: false, params: "selector: string, attributes?: string[], max_results?: number" },
  evaluate:           { name: "evaluate",           description: "Execute JavaScript on the page.",                      pageChanging: true,  exclusive: false, params: "code: string" },
  hover:              { name: "hover",              description: "Hover over an element.",                               pageChanging: false, exclusive: false, params: "index: number" },
  press_and_hold:     { name: "press_and_hold",     description: "Press and hold an element (anti-bot widgets).",        pageChanging: true,  exclusive: false, params: "index: number, hold_ms?: number (default 1500), delay_ms?: number (default 0)" },
  ask_human:          { name: "ask_human",          description: "Ask the user a question when stuck.",                  pageChanging: false, exclusive: true,  params: "question: string, mode?: 'input'|'password' (default 'input')" },
  takeover:           { name: "takeover",           description: "Pause for user to act manually.",                      pageChanging: false, exclusive: true,  params: "reason: string" },
  verify:             { name: "verify",             description: "Verify the last action had the expected effect.",       pageChanging: false, exclusive: false, params: "expectation: string" },
  load_skill:         { name: "load_skill",         description: "Load full instructions for a domain skill.",            pageChanging: false, exclusive: false, params: "name: string" },
  alert_accept:       { name: "alert_accept",       description: "Accept the open JS dialog (alert/confirm/prompt).",     pageChanging: false, exclusive: false, params: "(none)" },
  alert_dismiss:      { name: "alert_dismiss",      description: "Dismiss the open JS dialog (alert/confirm/prompt).",    pageChanging: false, exclusive: false, params: "(none)" },
  alert_get_text:     { name: "alert_get_text",     description: "Get the text of the open JS dialog.",                   pageChanging: false, exclusive: false, params: "(none)" },
  alert_send_keys:    { name: "alert_send_keys",    description: "Queue text for the next window.prompt() call (call BEFORE the action that opens the prompt).",             pageChanging: false, exclusive: false, params: "text: string" },
  detect_visual:      { name: "detect_visual",      description: "Run local vision detection to find UI elements not in the DOM (Canvas, WebGL, custom widgets). Returns [v1], [v2] etc. that you can click. Use ONLY when you can see something visually but can't find it in the elements list.",  pageChanging: false, exclusive: true,  params: "query: string" },
};

/**
 * Render the human-readable action list for the system prompt, including
 * parameter signatures + page-changing / exclusive tags.
 */
const actionListCache = new Map<string, string>();

export function actionListForPrompt(maxActions: number, visionMode: "disabled" | "always" | "adaptive" = "disabled"): string {
  const cacheKey = `${maxActions}:${visionMode}`;
  const cached = actionListCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const lines: string[] = [];
  for (const meta of Object.values(ACTION_METADATA)) {
    if (meta.name === "detect_visual" && visionMode !== "adaptive") continue;
    const tag = meta.pageChanging
      ? " [page-changing — put last]"
      : meta.exclusive
        ? " [must be the only action]"
        : "";
    lines.push(`- ${meta.name}${tag} — ${meta.description} | params: { ${meta.params} }`);
  }
  const result = `You may output 1 to ${maxActions} actions per step. Available actions:\n${lines.join("\n")}`;
  actionListCache.set(cacheKey, result);
  return result;
}

// ─── Action equivalence (for early-stop loop detection) ─────────────────────

export function isEquivalentAction(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "click":
    case "hover":
      return a.index === (b as Extract<Action, { type: typeof a.type }>).index;
    case "press_and_hold": {
      const bb = b as Extract<Action, { type: "press_and_hold" }>;
      return a.index === bb.index && (a.hold_ms ?? 1500) === (bb.hold_ms ?? 1500);
    }
    case "input":
      return a.text === (b as Extract<Action, { type: "input" }>).text;
    case "select_dropdown": {
      const bb = b as Extract<Action, { type: "select_dropdown" }>;
      return a.index === bb.index && (a.text ?? "") === (bb.text ?? "") && (a.option_index ?? -1) === (bb.option_index ?? -1);
    }
    case "scroll": {
      const bb = b as Extract<Action, { type: "scroll" }>;
      return (a.down === false ? "up" : "down") === (bb.down === false ? "up" : "down");
    }
    case "send_keys":
      return a.keys === (b as Extract<Action, { type: "send_keys" }>).keys;
    case "navigate":
      return a.url === (b as Extract<Action, { type: "navigate" }>).url;
    case "switch_tab":
    case "close_tab":
      return a.tab_id === (b as Extract<Action, { type: typeof a.type }>).tab_id;
    case "go_back":
    case "wait":
      return true;
    case "find_text":
      return a.text === (b as Extract<Action, { type: "find_text" }>).text;
    case "extract":
      return a.query === (b as Extract<Action, { type: "extract" }>).query;
    case "done": {
      const bb = b as Extract<Action, { type: "done" }>;
      return a.text === bb.text && a.success === bb.success;
    }
    case "search": {
      const bb = b as Extract<Action, { type: "search" }>;
      return a.query === bb.query && (a.engine ?? "duckduckgo") === (bb.engine ?? "duckduckgo");
    }
    case "upload_file":
      return (
        a.index === (b as Extract<Action, { type: "upload_file" }>).index &&
        a.path === (b as Extract<Action, { type: "upload_file" }>).path
      );
    case "screenshot":
    case "save_as_pdf":
      return (a.file_name ?? "") === ((b as Extract<Action, { type: "screenshot" | "save_as_pdf" }>).file_name ?? "");
    case "dropdown_options":
      return a.index === (b as Extract<Action, { type: "dropdown_options" }>).index;
    case "search_page":
      return (
        a.pattern === (b as Extract<Action, { type: "search_page" }>).pattern &&
        a.regex === (b as Extract<Action, { type: "search_page" }>).regex &&
        (a.case_sensitive ?? false) ===
          ((b as Extract<Action, { type: "search_page" }>).case_sensitive ?? false)
      );
    case "find_elements": {
      const bb = b as Extract<Action, { type: "find_elements" }>;
      return (
        a.selector === bb.selector &&
        JSON.stringify(a.attributes ?? []) === JSON.stringify(bb.attributes ?? []) &&
        (a.max_results ?? 50) === (bb.max_results ?? 50)
      );
    }
    case "evaluate":
      return a.code === (b as Extract<Action, { type: "evaluate" }>).code;
    case "ask_human": {
      const bb = b as Extract<Action, { type: "ask_human" }>;
      return a.question === bb.question && (a.mode ?? "input") === (bb.mode ?? "input");
    }
    case "takeover":
      return a.reason === (b as Extract<Action, { type: "takeover" }>).reason;
    case "verify":
      return a.expectation === (b as Extract<Action, { type: "verify" }>).expectation;
    case "load_skill":
      return a.name === (b as Extract<Action, { type: "load_skill" }>).name;
    case "alert_accept":
    case "alert_dismiss":
    case "alert_get_text":
      return true;
    case "alert_send_keys":
      return a.text === (b as Extract<Action, { type: "alert_send_keys" }>).text;
    case "detect_visual":
      return a.query === (b as Extract<Action, { type: "detect_visual" }>).query;
    default: {
      const _exhaustive: never = a;
      void _exhaustive;
      return false;
    }
  }
}

// ── Static guard against catastrophic-backtracking (ReDoS) patterns ──
//
// Relocated here from tools/handlers/search-page-utils so config
// validation (config/schema.ts) can use it without importing from the
// handlers layer.

// Matches an unbounded (or open-bounded) quantifier token `{n,}` / `{n,m}`.
// Shared by the two helpers below so the regex can't drift between them.
const UNBOUNDED_Q = /^\{\d+,\d*\}/;

// A quantifier is "dangerous" when it is unbounded (or open-bounded) repetition:
// `*` or `+`, or `{n,}` / `{n,m}`. `?` and exact `{n}` cannot create the
// ambiguity that produces exponential backtracking, so they are treated as safe.
function atUnboundedQuantifier(src: string, i: number): boolean {
  const c = src[i];
  if (c === "*" || c === "+") return true;
  if (c === "{") return UNBOUNDED_Q.test(src.slice(i));
  return false;
}

// Length of the unbounded-quantifier token starting at `i`, or 0 if `src[i]` is
// not an unbounded quantifier.
function quantifierLengthAt(src: string, i: number): number {
  const c = src[i];
  if (c === "*" || c === "+") return 1;
  if (c === "{") {
    const m = UNBOUNDED_Q.exec(src.slice(i));
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
      // Scan to the REAL class close, honoring backslash escapes. A naive
      // `src.indexOf("]", j)` would stop at an escaped `]` (e.g. the `\]` in
      // `([x\]]+)`, where the first `]` is escaped), making it treat the escaped
      // bracket as the class terminator and the real terminator as a top-level
      // `)` at depth 0 — so `findGroupClose` returns a wrong/early close and the
      // nested-quantifier / ambiguous-alternation ReDoS check can miss a
      // catastrophic pattern. `firstCharSet` already honors escapes; this must
      // match it.
      let k = j + 1;
      while (k < src.length) {
        if (src[k] === "\\") {
          k += 2;
          continue;
        }
        if (src[k] === "]") break;
        k++;
      }
      if (k >= src.length) return -1;
      j = k;
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
      cur += c;
      let j = i + 1;
      if (content[j] === "^") {
        cur += content[j];
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

// Strip a leading non-capturing / named / atomic group prefix from a group's
// inner content so the ReDoS analyzer sees the real alternation instead of the
// prefix characters (e.g. `(?:a|a)` → `a|a`). Returns the content unchanged when
// there is no such prefix. Without this, `(?:a|a)+` and similar shapes slip past
// the ambiguous-alternation check because the `?:` prefix hides the inner
// first-character overlap.
function stripGroupPrefix(content: string): string {
  if (content.length < 2 || content[0] !== "?") return content;
  if (content[1] === ":") return content.slice(2);
  if (content[1] === ">") return content.slice(2);
  if (content[1] === "<") {
    const gt = content.indexOf(">", 2);
    if (gt < 0) return content;
    return content.slice(gt + 1);
  }
  return content;
}

// The set of characters a branch can start with, or the sentinel "ANY" meaning
// it can start with (almost) any character. Used to judge whether two
// alternatives of an alternation can match overlapping input.
type CharSet = Set<string> | "ANY";

// Char sets used by `firstCharSet` to judge branch overlap. Hoisted to
// module-level constants (built once at load) instead of re-allocating a fresh
// Set on every `hasNestedQuantifier` call.
const DIGIT_SET: Set<string> = (() => {
  const s = new Set<string>();
  for (let k = 48; k <= 57; k++) s.add(String.fromCharCode(k));
  return s;
})();
const WORD_SET: Set<string> = (() => {
  const s = new Set<string>();
  for (let k = 48; k <= 57; k++) s.add(String.fromCharCode(k));
  for (let k = 65; k <= 90; k++) s.add(String.fromCharCode(k));
  for (let k = 97; k <= 122; k++) s.add(String.fromCharCode(k));
  s.add("_");
  return s;
})();
const SPACE_SET: Set<string> = new Set<string>([" ", "\t", "\n", "\r", "\f", "\v"]);

// Map a regex escape token to the single literal character it denotes
// (e.g. `\n` → newline, `\x41` → "A", `\u0041` → "A", `\u{41}` → "A"), or
// undefined when it has no such literal meaning. Classifying escapes by their
// REAL character keeps the ambiguity check accurate: `(n|\n)+` is disjoint
// (newline ≠ "n") while `(\x41|A)+` overlaps (both match "A").
function escapedLiteralChar(branch: string, e: string): string | undefined {
  const CTRL_ESCAPES: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    f: "\f",
    v: "\v",
    "0": "\0",
  };
  if (Object.hasOwn(CTRL_ESCAPES, e)) return CTRL_ESCAPES[e];
  if (e === "x" && /^[0-9a-fA-F]{2}/.test(branch.slice(2))) {
    return String.fromCharCode(parseInt(branch.slice(2, 4), 16));
  }
  if (e === "u" && /^[0-9a-fA-F]{4}/.test(branch.slice(2))) {
    return String.fromCodePoint(parseInt(branch.slice(2, 6), 16));
  }
  if (e === "u" && branch[2] === "{") {
    const close = branch.indexOf("}", 3);
    if (close > 3 && /^[0-9a-fA-F]+$/.test(branch.slice(3, close))) {
      return String.fromCodePoint(parseInt(branch.slice(3, close), 16));
    }
  }
  return undefined;
}

function firstCharSet(branch: string): CharSet {
  if (branch === "") return new Set<string>();
  const c = branch[0];
  if (c === "\\") {
    const e = branch[1];
    if (e === "d") return DIGIT_SET;
    if (e === "w") return WORD_SET;
    if (e === "s") return SPACE_SET;
    if (e === "D" || e === "W" || e === "S" || e === "b" || e === "B") return "ANY";
    // `\p{...}` / `\P{...}` unicode property classes match broad char sets —
    // treat as ANY so alternations like `(\p{L}|a)+` are flagged.
    if (e === "p" || e === "P") return "ANY";
    const lit = escapedLiteralChar(branch, e);
    if (lit !== undefined) return new Set<string>([lit]);
    return new Set<string>([e]);
  }
  if (c === "[") {
    let j = 1;
    if (branch[j] === "^") return "ANY";
    const set = new Set<string>();
    while (j < branch.length) {
      if (branch[j] === "\\") {
        if ((branch[j + 1] === "p" || branch[j + 1] === "P") && branch[j + 2] === "{") {
          return "ANY";
        }
        const lit = escapedLiteralChar(branch, branch[j + 1] ?? "");
        set.add(lit ?? (branch[j + 1] ?? ""));
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
  let content = src.slice(openIdx + 1, closeIdx);
  // Strip a leading group prefix so patterns like `(?:a|a)+` are analyzed
  // against their real inner alternation rather than the prefix characters.
  content = stripGroupPrefix(content);
  const branches = splitTopLevelAlternation(content);
  if (!branches) {
    // A single wrapping group (e.g. `((a|a))+` or `(?:a|a)+`) — recurse into it
    // so a nested ambiguous alternation inside the wrapper is still caught.
    if (content.length > 0 && content[0] === "(") {
      const innerClose = findGroupClose(content, 0);
      if (innerClose > 0 && innerClose === content.length - 1) {
        return groupHasAmbiguousAlternation(content, 0, innerClose);
      }
    }
    return false;
  }
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
      // Honor escapes when locating the class close (mirrors `findGroupClose`):
      // an escaped `]` inside the class must not be treated as the terminator.
      let k = j + 1;
      while (k < src.length) {
        if (src[k] === "\\") {
          k += 2;
          continue;
        }
        if (src[k] === "]") break;
        k++;
      }
      if (k >= src.length || k > closeIdx) break;
      j = k;
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
