/**
 * Timing + magic-number constants shared by the action executor + handlers.
 *
 * Centralized here so handlers don't repeat magic numbers and so tuners can
 * find every wait/settle duration + truncation limit in one place. All
 * durations are in milliseconds; all character limits are character counts.
 */

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
 * `search` action. Both the executor (`src/lib/agent/tools/handlers/search.ts`)
 * and the extension's tab-level action handler
 * (`src/extension/background/tab-manager.ts`) import this same map so the
 * agent never falls back to a different engine than the one it requested.
 */
export const SEARCH_ENGINE_URLS: Record<string, string> = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  yahoo: "https://search.yahoo.com/search?p=",
  baidu: "https://www.baidu.com/s?wd=",
};

/** Sleep helper. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
