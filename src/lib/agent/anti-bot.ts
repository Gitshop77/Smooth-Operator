/**
 * Anti-bot challenge detection — recognizes when a page is showing a
 * Cloudflare/CAPTCHA/access-denied interstitial instead of the real content.
 *
 * Without this, the agent blindly acts on challenge pages as if they were the
 * real page — clicking "Just a moment…" text and typing into CAPTCHA iframes.
 * This module surfaces the challenge so the orchestrator can wait (for
 * auto-resolving JS challenges) or surface it to the planner (for CAPTCHAs
 * that need human help).
 *
 * Two public functions:
 *   - `detectChallenge(tabId)` — runs the detection script in the tab and
 *     returns the parsed `ChallengeInfo` (or `null` if no challenge).
 *   - `waitForChallengeResolution(tabId, opts)` — polls `detectChallenge`
 *     until the challenge clears or the timeout expires.
 */

/** The kind of anti-bot challenge detected on a page. */
export type ChallengeKind =
  | "cloudflare-js"
  | "cloudflare-block"
  | "cloudflare-turnstile"
  | "hcaptcha"
  | "recaptcha"
  | "blocked"
  | "rate-limited";

/** Information about a detected anti-bot challenge. */
export interface ChallengeInfo {
  /** What type of challenge is present. */
  kind: ChallengeKind;
  /** Human-readable description. */
  message: string;
}

/** Result of waiting for an anti-bot challenge to resolve. */
export interface ChallengeWaitResult {
  /** Whether the challenge cleared within the timeout. */
  resolved: boolean;
  /** The challenge still present (null if resolved). */
  challenge: ChallengeInfo | null;
}

/**
 * Parse the raw result returned by the detection script. The script returns
 * either `null` (no challenge) or `{kind, message}`. Any other shape is
 * treated as "no challenge" so a malformed result never crashes the agent.
 */
function parseChallengeResult(raw: unknown): ChallengeInfo | null {
  if (raw !== null && typeof raw === "object" && "kind" in (raw as Record<string, unknown>)) {
    const obj = raw as { kind: unknown; message: unknown };
    if (typeof obj.kind === "string" && typeof obj.message === "string") {
      return { kind: obj.kind as ChallengeKind, message: obj.message };
    }
  }
  return null;
}

/**
 * Detect whether the current page is showing an anti-bot challenge.
 *
 * Runs the inlined detection script in the tab's MAIN world via
 * `chrome.scripting.executeScript` and parses the result. Returns `null` if
 * no challenge is detected, or if the tab is closed / injection fails (so
 * callers can treat "couldn't check" the same as "no challenge" — the agent
 * proceeds and may re-check on the next step).
 *
 * The script body is inlined inside `func` (rather than referenced from a
 * separate exported constant) because `chrome.scripting.executeScript`
 * serializes `func` via `Function.prototype.toString`, so closed-over
 * constants are not available in the page's MAIN world.
 *
 * @param tabId The tab to check.
 */
export async function detectChallenge(tabId: number): Promise<ChallengeInfo | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const title = (document.title || "").toLowerCase();

        // Cloudflare JS challenge
        if (
          title === "just a moment..." ||
          document.querySelector("#challenge-running, #cf-please-wait, #challenge-form") ||
          title.indexOf("checking your browser") !== -1
        ) {
          return { kind: "cloudflare-js", message: "Cloudflare JS challenge" };
        }

        let body: string | null = null;
        const getBody = (): string => {
          if (body === null) body = (document.body && document.body.textContent) || "";
          return body;
        };

        // Cloudflare block page
        if (
          title.indexOf("attention required") !== -1 ||
          (document.querySelector(".cf-error-details") && getBody().indexOf("blocked") !== -1)
        ) {
          return { kind: "cloudflare-block", message: "Cloudflare block page" };
        }

        // Widget-only challenges (only count when they dominate a sparse page)
        if (
          document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') &&
          getBody().length < 2000
        ) {
          return { kind: "cloudflare-turnstile", message: "Cloudflare Turnstile challenge" };
        }

        if (
          document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]') &&
          getBody().length < 2000
        ) {
          return { kind: "hcaptcha", message: "hCaptcha challenge" };
        }

        if (
          document.querySelector('.g-recaptcha, iframe[src*="google.com/recaptcha"]') &&
          getBody().length < 2000
        ) {
          return { kind: "recaptcha", message: "reCAPTCHA challenge" };
        }

        // Generic access-denied / rate-limit pages
        const b = getBody();
        if (b.length < 5000) {
          if (/access denied|403 forbidden/i.test(title) || /access denied/i.test(b)) {
            return { kind: "blocked", message: "Access denied" };
          }
          if (/\b429\b/i.test(title) || /too many requests|rate limit/i.test(b)) {
            return { kind: "rate-limited", message: "Rate limited" };
          }
        }

        return null;
      },
    });
    const result = results?.[0]?.result;
    return parseChallengeResult(result);
  } catch {
    // Tab closed, permission denied, chrome:// URL, etc. — treat as "no challenge".
    return null;
  }
}

/**
 * Wait for an anti-bot challenge to resolve on its own.
 *
 * Cloudflare JS challenges auto-resolve via navigation (title changes);
 * CAPTCHAs need a human.
 *
 * Polls {@link detectChallenge} every `pollMs` until either the challenge
 * clears (returns `{resolved: true, challenge: null}`) or `timeoutMs` expires
 * (returns `{resolved: false, challenge}` with the still-present challenge).
 *
 * @param tabId The tab to monitor.
 * @param opts.timeoutMs Max wait time (default 15000, clamped 500–120000).
 * @param opts.pollMs Polling interval (default 500, clamped 250–5000).
 */
export async function waitForChallengeResolution(
  tabId: number,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ChallengeWaitResult> {
  const timeout = Math.max(500, Math.min(120000, opts.timeoutMs ?? 15000));
  const poll = Math.max(250, Math.min(5000, opts.pollMs ?? 500));

  const initial = await detectChallenge(tabId);
  if (initial === null) return { resolved: true, challenge: null };

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, poll));
    const current = await detectChallenge(tabId);
    if (current === null) return { resolved: true, challenge: null };
  }

  const final = await detectChallenge(tabId);
  return { resolved: final === null, challenge: final };
}
