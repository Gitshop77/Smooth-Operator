/**
 * Loop constants — extracted from orchestrator.ts (Phase 1).
 *
 * Single source of truth for every loop-level tuning constant. Re-exported
 * from `orchestrator.ts` for backward compatibility.
 */

/** Max parse retries before giving up on a single navigator call. */
export const MAX_PARSE_RETRIES = 2;
/** Budget-warning threshold (fraction of `maxSteps`). */
export const BUDGET_WARNING_FRACTION = 0.75;
/** Consecutive failures before the replan nudge fires (default 3). */
export const REPLAN_NUDGE_FAILURES = 3;
/** Navigator steps without a plan before the exploration nudge fires (default 5). */
export const EXPLORATION_NUDGE_STEPS = 5;
/** URL substrings that suggest a captcha is being shown. */
export const CAPTCHA_URL_HINTS = ["recaptcha", "hcaptcha", "captcha", "cf-chl", "challenge"];
/** URL substrings / file extensions that suggest a download is in progress. */
export const DOWNLOAD_URL_HINTS = [".pdf", ".zip", ".tar", ".gz", ".docx", ".xlsx", ".csv", "download"];
/** Boundary-aware download-URL detector, derived from {@link DOWNLOAD_URL_HINTS}. */
const DOWNLOAD_EXT = DOWNLOAD_URL_HINTS.map((e) => e.replace(/^\./, ""));
export const DOWNLOAD_RE = new RegExp(`\\.(${DOWNLOAD_EXT.join("|")})(?:[?#/]|$)`, "i");
/** Tab-level action types that the extension background worker must handle. */
export const TAB_LEVEL_ACTIONS = new Set(["switch_tab", "close_tab", "navigate", "search"]);
/** How long to wait for the user to click "Resume" after a `takeover` action
 * before giving up (5 minutes). */
export const TAKEOVER_TIMEOUT_MS = 5 * 60 * 1000;
