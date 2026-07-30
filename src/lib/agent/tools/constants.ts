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
 *  so untrusted DOM content can't forge log lines or inject fake history. */
export const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g;

/** Bound length and strip control characters from page-derived text that is
 *  reflected into agent-facing messages. Display-only — selection logic and
 *  the CSS-identifier guard are untouched. */
export function sanitizeForLog(value: string, maxLen = 8192): string {
  let v = String(value);
  if (v.length > maxLen) v = v.slice(0, maxLen);
  return v.replace(CONTROL_CHARS_RE, "");
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

/**
 * Character / element truncation limits used by handlers when surfacing text
 * (extracted content, action echoes, search matches, etc.) back to the LLM.
 * Centralized so tuners can find every cap in one place.
 */
export const LIMITS = {
  /** Max chars of body text returned by the `extract` action. */
  extractBodyChars: 12_000,
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
