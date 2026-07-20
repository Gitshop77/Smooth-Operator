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
  | "rate-limited"
  | "auth-wall";

/**
 * Allowed `ChallengeKind` literals, used to validate untrusted parse input at
 * the trust boundary. Stored as a `Set` for an O(1) membership check.
 */
const CHALLENGE_KINDS: ReadonlySet<ChallengeKind> = new Set<ChallengeKind>([
  "cloudflare-js",
  "cloudflare-block",
  "cloudflare-turnstile",
  "hcaptcha",
  "recaptcha",
  "blocked",
  "rate-limited",
  "auth-wall",
]);

/** Type guard validating an arbitrary value against {@link CHALLENGE_KINDS}. */
export function isChallengeKind(x: unknown): x is ChallengeKind {
  return typeof x === "string" && CHALLENGE_KINDS.has(x as ChallengeKind);
}

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
export function parseChallengeResult(raw: unknown): ChallengeInfo | null {
  if (raw !== null && typeof raw === "object" && "kind" in (raw as Record<string, unknown>)) {
    const obj = raw as { kind: unknown; message: unknown };
    if (typeof obj.kind === "string" && typeof obj.message === "string") {
 // Validate `kind` against the allowed union at this trust boundary before
 // casting — an unrecognized value would otherwise flow downstream into
 // orchestrator switch statements that may lack a default branch.
      if (isChallengeKind(obj.kind)) {
        return { kind: obj.kind, message: obj.message };
      }
    }
  }
  return null;
}

/**
 * MAIN-world challenge classifier. Runs inside the target page (injected via
 * `chrome.scripting.executeScript`), so it MUST be self-contained: it may
 * reference only `document`, never module-scope bindings, or serialization
 * would drop them. Returns the detected `{kind, message}` or `null`.
 *
 * SECURITY: `document.title`/body/CSS are attacker-controllable. A title match
 * alone is NEVER sufficient — it must be corroborated by an authoritative
 * selector (or the challenge script) — and content-only block/rate-limit
 * heuristics are deliberately refused (see the trailing comment). Loosening any
 * of the AND-corroboration below re-opens a false-challenge stall vector.
 */
export function detectChallengeInPage(): ChallengeInfo | null {
  const title = (document.title || "").toLowerCase();

  let body: string | null = null;
  const getBody = (): string => {
    if (body === null) body = (document.body && document.body.textContent) || "";
    return body;
  };

 // Cloudflare JS challenge.
 // SECURITY: document.title and same-origin IDs/paths are attacker-controllable,
 // so a hostile page could set its title to "Just a moment…" or inject
 // #cf-chl-wrapper to force the agent into a Cloudflare-JS auto-wait stall
 // (false-positive availability vector). A genuine IUAM / "Checking your browser"
 // page loads Cloudflare's challenge script from a Cloudflare-owned origin — that
 // cross-origin script src is the ONLY signal we trust (see below). A title match
 // alone (or any same-origin marker) is NEVER sufficient.
 // The interstitial *must* contain a script tag pointing at Cloudflare's
 // challenge JS hosted on a Cloudflare-owned origin. Trust ONLY that
 // cross-origin signal: the #cf-chl-wrapper / #challenge-running IDs and the
 // /cdn-cgi/ path are attacker-settable in the page's own origin, so a hostile
 // page could inject them to force a false cloudflare-js stall. The title alone
 // is also never sufficient. cfJsSelector (same-origin IDs) is intentionally not
 // used as a trigger.
  const cfJsScript = document.querySelector(
    'script[src^="https://challenges.cloudflare.com/"]',
  );
  if (cfJsScript !== null) {
    return { kind: "cloudflare-js", message: "Cloudflare JS challenge" };
  }

 // Cloudflare block page — require genuine corroboration, NOT the attacker-
 // settable `.cf-error-details` CSS class (a hostile page can add that class to
 // force a false stall). Require the "attention required" title AND the word
 // "blocked" in the body; the authoritative network-layer status is checked
 // upstream, but this content check at least forces the attacker to control
 // both title and body rather than just a single CSS class.
  const b = getBody();
  if (
    title.indexOf("attention required") !== -1 && b.indexOf("blocked") !== -1
  ) {
    return { kind: "cloudflare-block", message: "Cloudflare block page" };
  }

 // Widget-only challenges — only count when the widget iframe is actually
 // present (the authoritative selector); the short-body check is secondary
 // corroboration, not the sole signal.
  if (
    document.querySelector('.cf-turnstile, iframe[src^="https://challenges.cloudflare.com/"]')
  ) {
    return { kind: "cloudflare-turnstile", message: "Cloudflare Turnstile challenge" };
  }

  if (
    document.querySelector('.h-captcha, iframe[src^="https://hcaptcha.com/"]')
  ) {
    return { kind: "hcaptcha", message: "hCaptcha challenge" };
  }

  if (
    document.querySelector('.g-recaptcha, iframe[src^="https://www.google.com/recaptcha/"]')
  ) {
    return { kind: "recaptcha", message: "reCAPTCHA challenge" };
  }

  // Genuine "access denied" / "rate limited" states are derived from the
  // real HTTP response status at the network layer, not from page content.
  // The document title, body text, and CSS classes are all attacker-
  // settable, so classifying a block or rate-limit from them alone lets a
  // hostile page force a false challenge and stall the agent. Do not
  // reintroduce content-only heuristics here; the network status is the
  // authoritative signal for these states.

  return null;
}

/**
 * MAIN-world authentication-wall classifier. Runs inside the target page (in
 * the same injected script as `detectChallengeInPage`), so it MUST be
 * self-contained: it may reference only `document`, never module-scope
 * bindings. Returns `{kind:"auth-wall", message}` or `null`.
 *
 * Unlike the CF/CAPTCHA challenges, an auth wall means the agent has landed on
 * a login/SSO page and must NOT be acted on by the model (typing credentials,
 * clicking "Sign in"). It surfaces as a challenge so the orchestrator pauses
 * and requests human takeover for credential entry.
 *
 * SECURITY: `document.title`/body/CSS are attacker-controllable, so a title or
 * body match alone is NEVER sufficient (the same false-positive stall vector
 * defended against in `detectChallengeInPage`). A genuine auth wall is
 * corroborated by a real `input[type=password]` PLUS an authoritative login
 * signal: a login/sign-in/SSO URL, a form action pointing at a login endpoint,
 * an identity-provider iframe/script, or a sign-in submit control. Without that
 * AND-corroboration an arbitrary password field (e.g. an account-recovery or
 * settings form) is NOT treated as an auth wall.
 */
export function detectAuthWallInPage(): ChallengeInfo | null {
  const passwordField = document.querySelector('input[type="password"]');
  if (passwordField === null) return null;

  const href = (document.location && document.location.href) || "";
  const url = href.toLowerCase();
  const loginUrl =
    /(^|\/)(login|signin|sign-in|sign_in|auth|sso|oauth|oidc|authorize|connect\/authorize|account\/login)(\/|\?|#|$)/.test(
      url,
    );

  const form = passwordField.closest("form") as HTMLFormElement | null;
  let loginFormAction = false;
  if (form && form.action) {
    const action = form.action.toLowerCase();
    loginFormAction =
      /(login|signin|sign-in|sign_in|auth|sso|oauth|oidc|authorize|token)/.test(action);
  }

  const idpMarker =
    document.querySelector(
      'iframe[src*="okta.com"], iframe[src*="login.microsoftonline.com"], ' +
        'iframe[src*="auth0.com"], iframe[src*="accounts.google.com/o/"], ' +
        'script[src*="okta.com"], a[href*="login.microsoftonline.com"]',
    ) !== null;

 // Auth wall requires an authoritative login signal: a login/sign-in/SSO URL,
 // a form `action` pointing at a login endpoint, or an identity-provider
 // iframe/script. A bare password field plus a submit label of "continue"/
 // "verify" is NOT sufficient — arbitrary password+continue forms (account
 // recovery, newsletter signup) would otherwise force an unnecessary
 // human-takeover pause. submitLabel/submitLogin corroboration is intentionally
 // dropped.
  if (loginUrl || loginFormAction || idpMarker) {
    return { kind: "auth-wall", message: "Authentication required (login page)" };
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
      func: detectChallengeInPage,
    });
    const result = results?.[0]?.result;
    const info = parseChallengeResult(result);
    if (info) {
      return { status: "challenge", info };
    }
    // No CF/CAPTCHA challenge — also check for a generic auth/login wall so
    // the orchestrator can pause and request human takeover instead of acting
    // on the login form. Two separate injections keep each detector
    // self-contained; this one only runs when no challenge was found.
    const authResults = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: detectAuthWallInPage,
    });
    const authInfo = parseChallengeResult(authResults?.[0]?.result);
    return authInfo
      ? { status: "challenge", info: authInfo }
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
