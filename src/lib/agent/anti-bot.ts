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
 * - `detectChallengeResult(tabId)` — runs the detection script in the tab and
 * returns a discriminated `DetectChallengeOutcome` (`"challenge"` |
 * `"no-challenge"` | `"error"`) so the orchestrator can tell a failed
 * injection apart from a genuine "no challenge" and choose to retry / pause
 * rather than blindly proceed.
 * - `waitForChallengeResolution(tabId, opts)` — polls `detectChallengeResult`
 * until the challenge clears, the timeout expires, or detection repeatedly
 * fails (errors are treated conservatively as "unresolved").
 */

/** The kind of anti-bot challenge detected on a page. */
type ChallengeKind =
  | "cloudflare-js"
  | "cloudflare-block"
  | "cloudflare-turnstile"
  | "hcaptcha"
  | "recaptcha"
  | "arkose"
  | "geetest"
  | "aws_waf"
  | "friendlycaptcha"
  | "altcha"
  | "datadome"
  | "rate-limited"
  | "auth-wall";

/**
 * Allowed `ChallengeKind` literals, used to validate untrusted parse input at
 * the trust boundary. Stored as a `Set` for an O(1) membership check.
 *
 * NOTE: `"blocked"` was deliberately removed from the union — the content-side
 * classifier refuses to emit block/rate-limit from page content (only the
 * network layer at `background/antibot.ts` may emit `"rate-limited"`), so
 * `"blocked"` was a type no emitter could produce.
 */
const CHALLENGE_KINDS: ReadonlySet<ChallengeKind> = new Set<ChallengeKind>([
  "cloudflare-js",
  "cloudflare-block",
  "cloudflare-turnstile",
  "hcaptcha",
  "recaptcha",
  "arkose",
  "geetest",
  "aws_waf",
  "friendlycaptcha",
  "altcha",
  "datadome",
  "rate-limited",
  "auth-wall",
]);

/** Type guard validating an arbitrary value against {@link CHALLENGE_KINDS}. */
export function isChallengeKind(x: unknown): x is ChallengeKind {
  return typeof x === "string" && CHALLENGE_KINDS.has(x as ChallengeKind);
}

/** Information about a detected anti-bot challenge. */
interface ChallengeInfo {
  /** What type of challenge is present. */
  kind: ChallengeKind;
  /** Human-readable description. */
  message: string;
}

/** Result of waiting for an anti-bot challenge to resolve. */
interface ChallengeWaitResult {
  /** Whether the challenge cleared within the timeout. */
  resolved: boolean;
  /** The challenge still present (null if resolved or undetectable). */
  challenge: ChallengeInfo | null;
}

/**
 * Discriminated outcome of a single challenge-detection attempt.
 *
 * The `"error"` case is important: it means the MAIN-world injection could
 * not be performed (tab closed, permission denied, `chrome://`/extension
 * URL, CSP, a racing navigation, etc.). Previously this was silently treated
 * the same as `"no-challenge"`, so a page that made injection throw could
 * bypass challenge detection and the agent would proceed onto an
 * interstitial. Callers that want to be safe should treat `"error"` as
 * "couldn't verify — pause or retry" rather than "all clear".
 */
type DetectChallengeOutcome =
  | { status: "challenge"; info: ChallengeInfo }
  | { status: "no-challenge" }
  | { status: "error"; error: unknown };

function abortError(signal?: AbortSignal): DOMException {
  return signal?.reason instanceof DOMException
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

/**
 * Chrome scripting promises cannot be actively cancelled. This race still
 * releases the loop immediately and removes its listener; late script results
 * are deliberately ignored so they cannot resume a cancelled run.
 */
function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

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
/**
 * Merged MAIN-world classifier — challenge OR auth wall, ONE injection.
 *
 * This is the ONLY detector passed to `chrome.scripting.executeScript` from
 * {@link detectChallengeResult}: it runs the challenge classifier first, then
 * the auth-wall classifier, and returns the first `{kind,message}` hit (or
 * `null`). Serializing one function halves per-step injections and removes the
 * navigation race between two separate reads (a nav landing between them could
 * otherwise mask a live interstitial from the second detector).
 *
 * MUST stay self-contained: it may reference only `document` (and its own
 * inner functions), never module-scope bindings, or serialization would drop
 * them. `detectChallengeInPage` / `detectAuthWallInPage` delegate here for
 * in-process tests.
 */
export function detectChallengeOrAuthWallInPage(): ChallengeInfo | null {
  const title = (document.title || "").toLowerCase();

  let body: string | null = null;
  const getBody = (): string => {
    if (body === null) body = (document.body && document.body.textContent) || "";
    return body;
  };

  // Cloudflare JS challenge — trust ONLY the cross-origin script src.
  const cfJsScript = document.querySelector(
    'script[src^="https://challenges.cloudflare.com/"]',
  );
  if (cfJsScript !== null) {
    return { kind: "cloudflare-js", message: "Cloudflare JS challenge" };
  }

  // Cloudflare block page — "attention required" title AND "blocked" body.
  const b = getBody();
  if (
    title.indexOf("attention required") !== -1 && b.toLowerCase().indexOf("blocked") !== -1
  ) {
    return { kind: "cloudflare-block", message: "Cloudflare block page" };
  }

  // Widget interstitials. Presence alone is NOT enough: every widget branch is
  // gated by `hasInterstitialCorroboration` (a real #challenge-running marker
  // Cloudflare injects during a genuine challenge, or a near-empty body — a
  // genuine interstitial is a shell, a content page has real text), so a
  // silent v2 checkbox embedded in a content page never stalls the loop.
  const hasInterstitialCorroboration = (): boolean => {
    return (
      document.querySelector("#challenge-running") !== null ||
      getBody().trim().length < 512
    );
  };
  if (
    document.querySelector('.cf-turnstile, iframe[src^="https://challenges.cloudflare.com/"]') &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "cloudflare-turnstile", message: "Cloudflare Turnstile challenge" };
  }

  if (
    document.querySelector('.h-captcha, iframe[src^="https://hcaptcha.com/"]') &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "hcaptcha", message: "hCaptcha challenge" };
  }

  if (
    document.querySelector('.g-recaptcha, iframe[src^="https://www.google.com/recaptcha/"]') &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "recaptcha", message: "reCAPTCHA challenge" };
  }

  // Additional vendor interstitials (Arkose/FunCaptcha, GeeTest, AWS WAF,
  // Friendly Captcha, Altcha, DataDome), all corroboration-gated.
  if (
    document.querySelector('iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha.com"]') &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "arkose", message: "Arkose/FunCaptcha challenge" };
  }

  if (
    document.querySelector(".geetest_holder, .geetest-captcha, .geetest_panel") &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "geetest", message: "GeeTest challenge" };
  }

  if (
    document.querySelector('#aws-waf-captcha, [name="aws-waf-token"], [name="aws-waf-challenge"]') &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "aws_waf", message: "AWS WAF challenge" };
  }

  if (
    document.querySelector('.frc-captcha, [name="frc-captcha-response"]') &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "friendlycaptcha", message: "Friendly Captcha challenge" };
  }

  if (
    document.querySelector("altcha-widget, [name='altcha'], [name='altcha-token']") &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "altcha", message: "Altcha challenge" };
  }

  if (
    document.querySelector('iframe[src*="geo.captcha-delivery.com"]') &&
    hasInterstitialCorroboration()
  ) {
    return { kind: "datadome", message: "DataDome challenge" };
  }

  // Genuine "access denied" / "rate limited" states are derived from the real
  // HTTP response status at the network layer, not from page content. The
  // document title, body text, and CSS classes are all attacker-settable, so
  // classifying a block or rate-limit from them alone lets a hostile page
  // force a false challenge and stall the agent. Do not reintroduce
  // content-only heuristics here; the network status is the authoritative
  // signal for these states.

  // No challenge — check for an auth/login wall (the orchestrator must pause
  // and request human takeover instead of acting on the login form).
  // INLINE auth-wall body (self-contained — see the module-level twin
  // `authWallBody()` for the in-process copy).
  const passwordField = document.querySelector('input[type="password"]');
  if (passwordField !== null) {
    const authHref = (document.location && document.location.href) || "";
    const authUrl = authHref.toLowerCase();
    const loginUrl =
      /(^|\/)(login|signin|sign-in|sign_in|auth|sso|oauth|oidc|authorize|connect\/authorize|account\/login)(\/|\?|#|$)/.test(
        authUrl,
      );

    const form = passwordField.closest("form") as HTMLFormElement | null;
    let loginFormAction = false;
    if (form && form.action) {
      const action = form.action.toLowerCase();
      loginFormAction =
        /(login|signin|sign-in|sign_in|auth|sso|oauth|oidc|authorize|token)/.test(action);
    }

    // Only non-attacker-settable IdP corroborators count (see authWallBody).
    const idpMarker =
      document.querySelector(
        'iframe[src*="okta.com"], iframe[src*="login.microsoftonline.com"], ' +
          'iframe[src*="auth0.com"], iframe[src*="accounts.google.com/o/"], ' +
          'script[src*="okta.com"]',
      ) !== null;

    if (loginUrl || loginFormAction || idpMarker) {
      return { kind: "auth-wall", message: "Authentication required (login page)" };
    }
  }
  return null;
}

/**
 * MAIN-world challenge classifier (in-process twin of the merged detector's
 * challenge section). Returns the detected `{kind, message}` or `null`.
 *
 * SECURITY: `document.title`/body/CSS are attacker-controllable. A title match
 * alone is NEVER sufficient — it must be corroborated by an authoritative
 * selector (or the challenge script) — and content-only block/rate-limit
 * heuristics are deliberately refused. Loosening any of the AND-corroboration
 * re-opens a false-challenge stall vector.
 */
export function detectChallengeInPage(): ChallengeInfo | null {
  const r = detectChallengeOrAuthWallInPage();
  return r !== null && r.kind !== "auth-wall" ? r : null;
}

/**
 * MAIN-world auth-wall sub-classifier. Delegates to the merged classifier
 * {@link detectChallengeOrAuthWallInPage} (the single serialized injection);
 * this export exists for in-process tests and as a named semantic twin.
 *
 * SECURITY: `document.title`/body/CSS are attacker-controllable, so a title or
 * body match alone is NEVER sufficient (the same false-positive stall vector
 * defended against in the challenge classifier). A genuine auth wall is
 * corroborated by a real `input[type=password]` PLUS an authoritative login
 * signal: a login/sign-in/SSO URL, a form action pointing at a login endpoint,
 * or an identity-provider iframe/script. Without that AND-corroboration an
 * arbitrary password field (e.g. an account-recovery or settings form) is NOT
 * treated as an auth wall.
 */
export function detectAuthWallInPage(): ChallengeInfo | null {
  const r = detectChallengeOrAuthWallInPage();
  return r !== null && r.kind === "auth-wall"
    ? { kind: "auth-wall", message: "Authentication required (login page)" }
    : null;
}

/**
 * Short-lived "no challenge" verdict cache. The orchestrator runs the detector
 * at the start of every navigator step; on a static page the answer is
 * unchanged between steps, so a fresh injection round-trip per step is pure
 * overhead. Only *no-challenge* verdicts are cached, keyed by (tabId, URL),
 * and only for {@link DETECTION_CACHE_TTL_MS} — a page that injects a
 * challenge widget mid-session is re-detected at the next cache expiry, and a
 * navigation (URL change) always invalidates the entry. Errors and challenge
 * verdicts are never cached. If the tab URL cannot be verified (no
 * `chrome.tabs` in the calling context), the cache is bypassed entirely
 * (conservative: always re-detect).
 */
const DETECTION_CACHE_TTL_MS = 2000;
const detectionCache = new Map<number, { url: string; at: number }>();

async function isNoChallengeCached(tabId: number): Promise<boolean> {
  const cached = detectionCache.get(tabId);
  if (!cached) return false;
  if (Date.now() - cached.at > DETECTION_CACHE_TTL_MS) {
    detectionCache.delete(tabId);
    return false;
  }
  try {
    const tab = typeof chrome !== "undefined" ? await chrome.tabs?.get?.(tabId) : undefined;
    if (tab?.url !== cached.url) {
      detectionCache.delete(tabId);
      return false;
    }
  } catch {
    // URL unverifiable — treat the cache as stale (conservative re-detect).
    detectionCache.delete(tabId);
    return false;
  }
  return true;
}

async function rememberNoChallenge(tabId: number): Promise<void> {
  try {
    const tab = typeof chrome !== "undefined" ? await chrome.tabs?.get?.(tabId) : undefined;
    if (typeof tab?.url === "string") {
      detectionCache.set(tabId, { url: tab.url, at: Date.now() });
    }
  } catch {
    /* no cache on unverifiable URL — conservative */
  }
}

/** Test hook: drop all cached verdicts (not used in production). */
export function _resetDetectionCacheForTests(): void {
  detectionCache.clear();
}

/**
 * Run the MAIN-world detection script and return a discriminated outcome.
 *
 * This distinguishes a failed injection from a genuine "no challenge": an
 * `executeScript` rejection is reported as `{ status: "error" }` (with a
 * warning logged) so the orchestrator can retry or pause instead of
 * proceeding blindly onto a possibly-injected page.
 *
 * Uses ONE combined injection (challenge classifier + auth-wall classifier)
 * so a navigation cannot race between two reads, and serves recent
 * "no-challenge" verdicts from the cache (see {@link isNoChallengeCached}).
 *
 * @param tabId The tab to check.
 */
export async function detectChallengeResult(
  tabId: number,
  signal?: AbortSignal,
): Promise<DetectChallengeOutcome> {
  if (await isNoChallengeCached(tabId)) return { status: "no-challenge" };
  try {
    const results = await awaitAbortable(chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: detectChallengeOrAuthWallInPage,
    }), signal);
    const info = parseChallengeResult(results?.[0]?.result);
    if (info) {
      // A challenge or auth wall is present — never cache this.
      detectionCache.delete(tabId);
      return { status: "challenge", info };
    }
    await rememberNoChallenge(tabId);
    return { status: "no-challenge" };
  } catch (error) {
    if (signal?.aborted) throw error;
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
 * orchestrator can retry or surface the issue. A transient failure of the
 * INITIAL check (racing navigation, tab mid-load) is treated exactly like a
 * during-poll failure: retry-first — keep polling to the deadline, and only
 * fall back to `{resolved:false}` if every attempt keeps failing.
 *
 * @param tabId The tab to monitor.
 * @param opts.timeoutMs Max wait time (default 15000, clamped 500–120000).
 * @param opts.pollMs Polling interval (default 500, clamped 250–5000).
 */
export async function waitForChallengeResolution(
  tabId: number,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<ChallengeWaitResult> {
  const timeout = Math.max(500, Math.min(120000, opts.timeoutMs ?? 15000));
  const poll = Math.max(250, Math.min(5000, opts.pollMs ?? 500));

  const initial = await detectChallengeResult(tabId, opts.signal);
 // A genuine "no challenge" at the start means there's nothing to wait for.
  if (initial.status === "no-challenge") return { resolved: true, challenge: null };
 // initial "challenge" OR "error": retry-first — a single transient failure
 // (or a challenge that clears right after the probe) must not abandon the
 // window; keep polling to the deadline exactly like during-poll errors.

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await awaitAbortable(new Promise<void>((resolve) => setTimeout(resolve, poll)), opts.signal);
    const current = await detectChallengeResult(tabId, opts.signal);
 // A genuine "no challenge" means the challenge cleared (or the transient
 // failure recovered).
    if (current.status === "no-challenge") return { resolved: true, challenge: null };
 // A failed check can't be treated as "resolved" — keep waiting within the
 // timeout window rather than letting the agent proceed onto an
 // unverified page.
  }

  const final = await detectChallengeResult(tabId, opts.signal);
  if (final.status === "no-challenge") return { resolved: true, challenge: null };
 // Either the challenge is still present, or we couldn't verify it cleared —
 // report unresolved so the orchestrator doesn't proceed blindly.
  return { resolved: false, challenge: final.status === "challenge" ? final.info : null };
}
