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
 * Public API:
 * - `detectChallenge(tabId)` — runs the detection script in the tab and
 * returns the parsed `ChallengeInfo` (or `null` if no challenge). This is
 * the backward-compatible convenience wrapper used by callers that only
 * care about a binary "challenge vs. not".
 * - `detectChallengeResult(tabId)` — the same detection, but returns a
 * discriminated `DetectChallengeOutcome` (`"challenge"` | `"no-challenge"`
 * | `"error"`) so the orchestrator can tell a failed injection apart from
 * a genuine "no challenge" and choose to retry / pause rather than blindly
 * proceed.
 * - `waitForChallengeResolution(tabId, opts)` — polls `detectChallengeResult`
 * until the challenge clears, the timeout expires, or detection repeatedly
 * fails (errors are treated conservatively as "unresolved").
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

/** Allowed `ChallengeKind` literals, used to validate untrusted parse input. */
const CHALLENGE_KINDS: readonly ChallengeKind[] = [
  "cloudflare-js",
  "cloudflare-block",
  "cloudflare-turnstile",
  "hcaptcha",
  "recaptcha",
  "blocked",
  "rate-limited",
];

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
  /** The challenge still present (null if resolved or undetectable). */
  challenge: ChallengeInfo | null;
}

/**
 * Discriminated outcome of a single challenge-detection attempt.
 *
 * `detectChallenge` collapses this to `ChallengeInfo | null`, but the
 * `"error"` case is important: it means the MAIN-world injection could not be
 * performed (tab closed, permission denied, `chrome://`/extension URL, CSP, a
 * racing navigation, etc.). Previously this was silently treated the same as
 * `"no-challenge"`, so a page that made injection throw could bypass challenge
 * detection and the agent would proceed onto an interstitial. Callers that
 * want to be safe should treat `"error"` as "couldn't verify — pause or
 * retry" rather than "all clear".
 */
export type DetectChallengeOutcome =
  | { status: "challenge"; info: ChallengeInfo }
  | { status: "no-challenge" }
  | { status: "error"; error: unknown };

/**
 * Parse the raw result returned by the detection script. The script returns
 * either `null` (no challenge) or `{kind, message}`. Any other shape is
 * treated as "no challenge" so a malformed result never crashes the agent.
 */
function parseChallengeResult(raw: unknown): ChallengeInfo | null {
  if (raw !== null && typeof raw === "object" && "kind" in (raw as Record<string, unknown>)) {
    const obj = raw as { kind: unknown; message: unknown };
    if (typeof obj.kind === "string" && typeof obj.message === "string") {
 // Validate `kind` against the allowed union at this trust boundary before
 // casting — an unrecognized value would otherwise flow downstream into
 // orchestrator switch statements that may lack a default branch.
      const kind = obj.kind as ChallengeKind;
      if ((CHALLENGE_KINDS as readonly string[]).includes(kind)) {
        return { kind, message: obj.message };
      }
    }
  }
  return null;
}

/**
 * Run the MAIN-world detection script and return a discriminated outcome.
 *
 * Unlike `detectChallenge`, this distinguishes a failed injection from a
 * genuine "no challenge": an `executeScript` rejection is reported as
 * `{ status: "error" }` (with a warning logged) so the orchestrator can retry
 * or pause instead of proceeding blindly onto a possibly-injected page.
 *
 * @param tabId The tab to check.
 */
export async function detectChallengeResult(
  tabId: number,
): Promise<DetectChallengeOutcome> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const title = (document.title || "").toLowerCase();

        let body: string | null = null;
        const getBody = (): string => {
          if (body === null) body = (document.body && document.body.textContent) || "";
          return body;
        };

 // Cloudflare JS challenge.
 // SECURITY: document.title is attacker-controllable, so a hostile page
 // could set its title to "Just a moment..." to force the agent into a
 // Cloudflare-JS auto-wait stall (false-positive availability vector).
 // A genuine IUAM / "Checking your browser" page carries a real CF JS
 // selector — treat the selector as the authoritative signal. A title
 // match alone is NEVER sufficient: it must be corroborated by that
 // selector OR by a *short interstitial-style body AND* the page actually
 // loading the challenge script, never by body length alone (a short
 // attacker page would otherwise trivially false-positive).
        const cfJsTitle =
          title === "just a moment..." ||
          title.indexOf("checking your browser") !== -1;
        const cfJsSelector = document.querySelector(
          "#challenge-running, #cf-please-wait, #challenge-form, #cf-chl-wrapper",
        );
 // The interstitial *must* contain a script tag pointing at Cloudflare's
 // challenge JS — a far stronger corroborator than a short body.
        const cfJsScript = document.querySelector(
          'script[src*="challenges.cloudflare.com"], script[src*="/cdn-cgi/"]',
        );
        if (
          cfJsSelector !== null ||
          (cfJsTitle && cfJsScript !== null)
        ) {
          return { kind: "cloudflare-js", message: "Cloudflare JS challenge" };
        }

 // Cloudflare block page — require the CF error block selector OR both a
 // title mentioning "attention required" AND the word "blocked" in the
 // body. A title-only match is spoofable and is no longer accepted.
        const cfBlockSelector = document.querySelector(".cf-error-details");
        const b = getBody();
        if (
          cfBlockSelector !== null ||
          (title.indexOf("attention required") !== -1 && b.indexOf("blocked") !== -1)
        ) {
          return { kind: "cloudflare-block", message: "Cloudflare block page" };
        }

 // Widget-only challenges — only count when the widget iframe is actually
 // present (the authoritative selector); the short-body check is secondary
 // corroboration, not the sole signal.
        if (
          document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]')
        ) {
          return { kind: "cloudflare-turnstile", message: "Cloudflare Turnstile challenge" };
        }

        if (
          document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]')
        ) {
          return { kind: "hcaptcha", message: "hCaptcha challenge" };
        }

        if (
          document.querySelector('.g-recaptcha, iframe[src*="google.com/recaptcha"]')
        ) {
          return { kind: "recaptcha", message: "reCAPTCHA challenge" };
        }

 // Generic access-denied / rate-limit pages. The title is attacker-
 // controllable, so a title-only match is rejected: require a selector OR
 // title+body corroboration. This prevents a hostile page from stalling
 // the agent by merely setting <title>429</title>.
        const bodyText = getBody();
        if (bodyText.length < 5000) {
          const accessDeniedBody = /access denied/i.test(bodyText);
          const rateLimitBody = /too many requests|rate limit/i.test(bodyText);
          if (
            (document.querySelector('[class*="forbidden"], [class*="denied"]') &&
              /403|forbidden/i.test(title)) ||
            (/access denied|403 forbidden/i.test(title) && accessDeniedBody) ||
            accessDeniedBody
          ) {
            return { kind: "blocked", message: "Access denied" };
          }
          if (
            (/\b429\b/i.test(title) && rateLimitBody) ||
            rateLimitBody
          ) {
            return { kind: "rate-limited", message: "Rate limited" };
          }
        }

        return null;
      },
    });
    const result = results?.[0]?.result;
    const info = parseChallengeResult(result);
    return info
      ? { status: "challenge", info }
      : { status: "no-challenge" };
  } catch (error) {
 // Tab closed, permission denied, chrome:// URL, CSP, a racing navigation,
 // or any other injection failure. This is NOT the same as "no challenge":
 // log it so the orchestrator can observe the failure and choose to retry or
 // pause rather than proceed onto a possibly-injected page.
    console.warn(
      `[anti-bot] challenge detection injection failed for tab ${tabId}; ` +
        `treating as unverifiable (agent should not blindly proceed):`,
      error,
    );
    return { status: "error", error };
  }
}

/**
 * Detect whether the current page is showing an anti-bot challenge.
 *
 * Convenience wrapper around {@link detectChallengeResult} that collapses the
 * discriminated outcome to `ChallengeInfo | null` for callers that only need
 * the binary signal. Injection failures are collapsed to `null` here (matching
 * the historical contract) — callers that need to distinguish a failed check
 * from a genuine "no challenge" should use `detectChallengeResult` directly.
 *
 * @param tabId The tab to check.
 */
export async function detectChallenge(tabId: number): Promise<ChallengeInfo | null> {
  const outcome = await detectChallengeResult(tabId);
  return outcome.status === "challenge" ? outcome.info : null;
}

/**
 * Wait for an anti-bot challenge to resolve on its own.
 *
 * Cloudflare JS challenges auto-resolve via navigation (title changes);
 * CAPTCHAs need a human.
 *
 * Polls {@link detectChallengeResult} every `pollMs` until either the
 * challenge clears (returns `{resolved: true, challenge: null}`) or `timeoutMs`
 * expires (returns `{resolved: false, challenge}` with the still-present
 * challenge). If detection itself fails during polling, the failure is treated
 * conservatively: we do not report the challenge as resolved (which would let
 * the agent proceed blindly) — instead the wait reports unresolved so the
 * orchestrator can retry or surface the issue.
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

  const initial = await detectChallengeResult(tabId);
 // A genuine "no challenge" at the start means there's nothing to wait for.
  if (initial.status === "no-challenge") return { resolved: true, challenge: null };
 // A failed initial check can't be treated as "already resolved" — be
 // conservative and let the orchestrator retry / pause.
  if (initial.status === "error") return { resolved: false, challenge: null };
 // initial.status === "challenge": fall through and wait for it to clear.

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, poll));
    const current = await detectChallengeResult(tabId);
 // A genuine "no challenge" means the challenge cleared.
    if (current.status === "no-challenge") return { resolved: true, challenge: null };
 // A failed check can't be treated as "resolved" — keep waiting within the
 // timeout window rather than letting the agent proceed onto an
 // unverified page.
  }

  const final = await detectChallengeResult(tabId);
  if (final.status === "no-challenge") return { resolved: true, challenge: null };
 // Either the challenge is still present, or we couldn't verify it cleared —
 // report unresolved so the orchestrator doesn't proceed blindly.
  return { resolved: false, challenge: final.status === "challenge" ? final.info : null };
}
