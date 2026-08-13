/**
 * Timing + magic-number constants shared by the action executor + handlers.
 *
 * Centralized here so handlers don't repeat magic numbers and so tuners can
 * find every wait/settle duration + truncation limit in one place. All
 * durations are in milliseconds; all character limits are character counts.
 */

import { SearchSchema } from "./schema";

/** Control characters (CR/LF, Unicode line/para separators) stripped from
 *  page-derived text before it is reflected into log lines / agent messages,
 *  so untrusted DOM content can't forge log lines or inject fake history.
 *
 *  DOCUMENTED EXCEPTION: the strip REPLACES each matched character
 *  with a single space rather than deleting it — `sanitizeForLog` is the only
 *  consumer. Deleting would merge words across a newline ("a\nb" → "ab") and
 *  corrupt NBSP-formatted numbers ("1\u00A0234" → "1234"); replacing with a
 *  space keeps word/number separation while the anti-log-forgery property
 *  holds (no CR/LF survives to break a log line). The `+` quantifier collapses
 *  adjacent controls (e.g. CRLF) into ONE space — "foo\r\nbar" → "foo bar",
 *  not "foo  bar". `search-page.ts` deletes (replaces with "") — same output
 *  either way, since adjacent controls delete as one match. */
export const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F\u0085\u00A0\u00AD\u2028\u2029]+/g;

/** Bound length and strip control characters from page-derived text that is
 *  reflected into agent-facing messages. Display-only — selection logic and
 *  the CSS-identifier guard are untouched.
 *
 *  Truncation is code-point-aware: a naive `slice(0, maxLen)` can cut
 *  through a UTF-16 surrogate pair and leave a lone surrogate in the output. */
export function sanitizeForLog(value: string, maxLen = 8192): string {
  let v = String(value);
  if (v.length > maxLen) v = Array.from(v).slice(0, maxLen).join("");
  return v.replace(CONTROL_CHARS_RE, " ");
}

/** All wait/settle durations used by the executor (in milliseconds). */
export const TIMINGS = {
  clickScrollIntoView: 150,
  clickAfterSettle: 250,
  inputScrollIntoView: 120,
  inputAfterType: 80,
  scrollSmooth: 400,
  keyEventAfter: 200,
  navigationBack: 500,
  findTextScroll: 300,
  extractWait: 100,
} as const;

/** Timeout (ms) for SW/CDP RPC responses (new-tab navigate, press-and-hold). */
export const SW_RPC_TIMEOUT_MS = 15000;

/** Default timeout for the wait_for_* actions (in ms) — mirrors the schema's
 *  `timeout_seconds` default of 30 so a hand-built action (bypassing schema
 *  validation) falls back to the same limit as a parsed one. */
export const WAIT_TIMEOUT_MS = 30_000;
/** Base polling interval for the wait_for_* actions (in ms). Each poll runs a
 *  FRESH condition evaluation against the live page — never a snapshot. */
export const WAIT_POLL_MS = 100;
/** wait_for_network_idle: how long the network must be silent (in ms) before
 *  the action reports success. */
export const NETWORK_IDLE_WINDOW_MS = 500;

/**
 * Character / element truncation limits used by handlers when surfacing text
 * (extracted content, action echoes, search matches, etc.) back to the LLM.
 * Centralized so tuners can find every cap in one place.
 */
export const LIMITS = {
  /** Max full-page characters scanned locally by `extract`. The focused result
   * returned to the LLM is independently capped at about 8k characters. */
  extractBodyChars: 200_000,
  /** Max chars of an `evaluate` action's return value surfaced in extractedContent. */
  evaluateResultChars: 2000,
  /** Max chars of the input echo in the `input` action's success message. */
  inputEchoChars: 500,
  /** Max chars of an `ask_human` answer surfaced in extractedContent (password mode redacts the rest). */
  askHumanAnswerChars: 200,
  /** Max chars of an `ask_human` question surfaced in extractedContent. */
  askHumanQuestionChars: 80,
  /** Max chars of a single element's text shown in `find_elements` results. */
  findElementsTextChars: 80,
  /** Max chars of surrounding context shown per `search_page` match. */
  searchPageContextChars: 150,
  /** Max matches returned by `search_page`. */
  searchPageMaxMatches: 25,
  /** Max regex pattern length accepted by `search_page` (DoS guard). */
  searchPageMaxRegexPattern: 500,
  /** Max DOM nodes visited by `search_page` before bailing (DoS guard). */
  searchPageMaxNodeVisits: 5000,
  /** Timeout (ms) for an `evaluate` script that doesn't return promptly. */
  evaluateTimeoutMs: 10_000,
  /** Default chars to slice when truncating an action's text in describe.ts. */
  describeSliceDefault: 60,
  /** Max chars of a `load_skill` body surfaced in extractedContent (context-window guard). */
  loadSkillBodyChars: 16_000,
} as const;

/** Max elements scanned for the fingerprint (keeps the hash fast on huge pages). */
export const FINGERPRINT_MAX_ELEMENTS = 500;
/** FNV-1a offset basis + prime (matches the DOM extractor's hash). */
export const FNV_OFFSET_BASIS = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

/**
 * Map of supported search engines → their query URL prefix.
 *
 * This MUST stay in sync with the `engine` enum in {@link ActionSchema}'s
 * `search` action (see the dev-time guard below). Both the executor
 * (`src/lib/agent/tools/handlers/search.ts`) and the extension's tab-level
 * action handler (`src/extension/background/tab-manager.ts`) import this same
 * map so the agent never falls back to a different engine than the one it
 * requested.
 *
 * Declared `as const` so the keys form a precise literal type and a missing
 * entry fails type-checking at the call site instead of producing an
 * `"undefined?q=..."` navigation URL.
 */
export const SEARCH_ENGINE_URLS = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  yahoo: "https://search.yahoo.com/search?p=",
  baidu: "https://www.baidu.com/s?wd=",
} as const;

/**
 * Resolve a search engine's query URL prefix, or `null` if the engine is
 * unknown. Callers should use this instead of indexing `SEARCH_ENGINE_URLS`
 * directly so a typo'd / drifted engine never yields `undefined + query`.
 */
export function getSearchEngineUrl(engine: string): string | null {
  return (SEARCH_ENGINE_URLS as Record<string, string>)[engine] ?? null;
}

/**
 * Search macros — `@macro_name query` expands to a site-specific URL
 * template (verbatim table from the camofox macro set). The agent can
 * navigate/search directly on a site's own search results page instead of
 * routing through a general engine. Every query is encoded with
 * `encodeURIComponent` uniformly.
 */
export const SEARCH_MACROS = {
  "@google_search": "https://www.google.com/search?q=",
  "@youtube_search": "https://www.youtube.com/results?search_query=",
  "@amazon_search": "https://www.amazon.com/s?k=",
  "@reddit_search": "https://www.reddit.com/search.json?q=",
  "@reddit_subreddit": "https://www.reddit.com/r/",
  "@wikipedia_search": "https://en.wikipedia.org/wiki/Special:Search?search=",
  "@twitter_search": "https://twitter.com/search?q=",
  "@yelp_search": "https://www.yelp.com/search?find_desc=",
  "@spotify_search": "https://open.spotify.com/search/",
  "@netflix_search": "https://www.netflix.com/search?q=",
  "@linkedin_search": "https://www.linkedin.com/search/results/all/?keywords=",
  "@instagram_search": "https://www.instagram.com/explore/tags/",
  "@tiktok_search": "https://www.tiktok.com/search?q=",
  "@twitch_search": "https://www.twitch.tv/search?term=",
} as const;

/** The reddit JSON endpoints append a fixed limit suffix to the query. */
const REDDIT_SEARCH_SUFFIX = "&limit=25";
/** `@reddit_subreddit` falls back to `all` when no subreddit is given. */
const REDDIT_SUBREDDIT_DEFAULT = "all";
const REDDIT_SUBREDDIT_SUFFIX = ".json?limit=25";

/** The list of supported macro names (each starts with `@`). */
export function getSupportedSearchMacros(): readonly string[] {
  return Object.keys(SEARCH_MACROS);
}

/**
 * Expand a macro name + query into a site-specific URL, or `null` when the
 * macro is unknown. Mirrors camofox's `expandMacro` semantics, with uniform
 * encoding for every macro (including wikipedia).
 */
export function expandSearchMacro(
  name: string,
  query: string | null | undefined,
): string | null {
  const base = (SEARCH_MACROS as Record<string, string>)[name];
  if (!base) return null;
  if (name === "@reddit_search") {
    return base + encodeURIComponent(query ?? "") + REDDIT_SEARCH_SUFFIX;
  }
  if (name === "@reddit_subreddit") {
    return base + encodeURIComponent(query || REDDIT_SUBREDDIT_DEFAULT) + REDDIT_SUBREDDIT_SUFFIX;
  }
  return base + encodeURIComponent(query ?? "");
}

/** A macro token matched at the start of a query string. */
export interface SearchMacroMatch {
  /** The matched macro name, e.g. `"@google_search"`. */
  name: string;
  /** The fully expanded URL. */
  url: string;
}

const MACRO_TOKEN_RE = /^(@[A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/;

/**
 * If `text` starts with a supported `@macro` token, expand the token (with
 * the rest of the string as the query) into a URL; otherwise return `null`.
 * Used by the navigate/search action paths to accept `@macro query`.
 */
export function tryExpandSearchMacro(
  text: string | null | undefined,
): SearchMacroMatch | null {
  if (typeof text !== "string") return null;
  const m = MACRO_TOKEN_RE.exec(text.trim());
  if (!m) return null;
  const url = expandSearchMacro(m[1], m[2] ?? "");
  if (!url) return null;
  return { name: m[1], url };
}

/**
 * Dev-time guard: the engine keys MUST stay in sync with the `engine` enum in
 * `schema.ts`'s `SearchSchema`. A mismatch (an engine added to one but not the
 * other) would otherwise produce a `"undefined?q=..."` navigation URL with no
 * compile-time error. The check runs once at module load and only logs when the
 * two sets diverge.
 */
/**
 * The `engine` field is `z.enum([...]).optional().default(...)`, so
 * `SearchSchema.shape.engine` is a `ZodDefault` wrapping a `ZodOptional`
 * wrapping the `ZodEnum`. `.options` lives on the innermost `ZodEnum`, so we
 * unwrap the optional/default layers to reach it. This keeps the dev-time
 * sync guard between the enum and `SEARCH_ENGINE_URLS` working.
 */
function unwrapEnumOptions(schema: unknown): readonly string[] {
  let s = schema as { options?: readonly string[]; _def?: { innerType?: unknown; schema?: unknown } };
  while (s && !Array.isArray(s.options) && (s._def?.innerType || s._def?.schema)) {
    s = (s._def.innerType ?? s._def.schema) as typeof s;
  }
  return Array.isArray(s?.options) ? s.options : [];
}

const searchEngineEnumValues = unwrapEnumOptions(SearchSchema.shape.engine);
const searchEngineUrlKeys = Object.keys(SEARCH_ENGINE_URLS);
const searchEngineMissing = searchEngineEnumValues.filter((k) => !searchEngineUrlKeys.includes(k));
const searchEngineExtra = searchEngineUrlKeys.filter(
  (k) => !(searchEngineEnumValues as readonly string[]).includes(k),
);
if (
  ((typeof process !== "undefined" ? process.env?.NODE_ENV : undefined) ?? "production") !== "production" &&
  (searchEngineMissing.length || searchEngineExtra.length)
) {
  console.error(
    "[tools/constants] SEARCH_ENGINE_URLS is out of sync with the search engine enum in schema.ts:",
    { missingFromMap: searchEngineMissing, extraInMap: searchEngineExtra },
  );
}

/**
 * Sleep helper. When an `AbortSignal` is supplied, the pending sleep rejects
 * with an `AbortError` (and its timer is cleared) if the signal fires — letting
 * a cancellation interrupt an in-flight wait instead of hanging the orchestrator
 * for the full duration. With no signal the behavior is unchanged.
 */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
