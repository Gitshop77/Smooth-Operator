/**
 * Deterministic challenge classification shared by the browser runtime and
 * tests. This module only recognizes evidence exposed by the page; solving or
 * bypassing is opt-in and reported via `bypassAttempted` on the classification.
 */

export type ChallengeKind =
  | "cloudflare-js"
  | "cloudflare-block"
  | "cloudflare-turnstile"
  | "hcaptcha"
  | "recaptcha"
  | "arkose"
  | "geetest"
  | "aws-waf"
  | "friendlycaptcha"
  | "altcha"
  | "recaptcha-enterprise"
  | "geetest-v4"
  | "openai-turnstile"
  | "kaptcha"
  | "hcaptcha-enterprise"
  | "datadome"
  | "rate-limited"
  | "auth-wall"
  | "generic-challenge";

interface ChallengeMatch {
  kind: ChallengeKind;
  confidence: "low" | "medium" | "high";
  indicators: string[];
}

interface ChallengeClassification {
  status: "present" | "absent" | "unknown";
  detected: boolean;
  matches: ChallengeMatch[];
  humanActionRequired: boolean;
  bypassAttempted: boolean;
}

interface ChallengeEvidence {
  title?: string;
  text?: string;
  html?: string;
  frameSources?: string[];
  visibleMarkers?: string[];
  status?: number;
}

const MAX_EVIDENCE_CHARS = 700_000;
const MAX_TITLE_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 100_000;
const MAX_HTML_CHARS = 500_000;
const MAX_LIST_CHARS = 100_000;
const MAX_LIST_ITEMS = 200;
const MAX_LIST_ITEM_CHARS = 4_000;

const RULES: Array<{ kind: ChallengeKind; confidence: ChallengeMatch["confidence"]; needles: string[] }> = [
  { kind: "cloudflare-turnstile", confidence: "high", needles: ["cf-turnstile", "challenges.cloudflare.com/turnstile", "turnstile-widget"] },
  { kind: "hcaptcha", confidence: "high", needles: ["hcaptcha", "h-captcha"] },
  { kind: "recaptcha", confidence: "high", needles: ["g-recaptcha", "recaptcha", "google.com/recaptcha"] },
  { kind: "arkose", confidence: "high", needles: ["arkoselabs", "funcaptcha", "arkose"] },
  { kind: "geetest", confidence: "high", needles: ["geetest"] },
  { kind: "friendlycaptcha", confidence: "high", needles: ["friendlycaptcha", "friendly-challenge"] },
  { kind: "altcha", confidence: "high", needles: ["altcha"] },
  { kind: "recaptcha-enterprise", confidence: "high", needles: ["recaptcha-enterprise", "g-recaptcha-enterprise"] },
  { kind: "geetest-v4", confidence: "high", needles: ["geetest-v4", "geetest v4", "newverification"] },
  { kind: "openai-turnstile", confidence: "high", needles: ["openai-turnstile", "turnstile-v3"] },
  { kind: "kaptcha", confidence: "high", needles: ["kaptcha", "spring-kaptcha"] },
  { kind: "hcaptcha-enterprise", confidence: "high", needles: ["hcaptcha-enterprise", "h-captcha-enterprise"] },
  { kind: "datadome", confidence: "high", needles: ["datadome"] },
  { kind: "aws-waf", confidence: "high", needles: ["awswafcaptcha", "aws waf", "amazonaws.com/waf"] },
  { kind: "cloudflare-block", confidence: "medium", needles: ["attention required!", "cf-error-details", "cloudflare ray id", "error 1020"] },
  { kind: "cloudflare-js", confidence: "medium", needles: ["just a moment...", "checking your browser", "/cdn-cgi/challenge-platform", "enable javascript and cookies"] },
  { kind: "rate-limited", confidence: "medium", needles: ["too many requests", "rate limit exceeded", "temporarily blocked", "slow down"] },
  { kind: "generic-challenge", confidence: "low", needles: ["verify you are human", "security check", "please verify", "not a robot", "complete the security verification", "unusual traffic", "automated traffic", "automated queries", "automated access", "robot check", "are you a robot", "access to this site has been denied"] },
  { kind: "auth-wall", confidence: "low", needles: ["sign in to continue", "log in to continue", "authentication required", "access denied"] },
];

function normalizedEvidence(evidence: ChallengeEvidence): string {
  let remaining = MAX_EVIDENCE_CHARS;
  const bounded: string[] = [];
  const append = (value: unknown, limit = remaining): void => {
    if (remaining <= 0 || typeof value !== "string") {
      return;
    }
    const part = value.slice(0, Math.min(remaining, limit));
    bounded.push(part);
    remaining -= part.length;
  };
  // Keep each evidence field represented. A hostile page title must not fill
  // the aggregate budget and hide later body/widget signals.
  append(evidence.title, MAX_TITLE_CHARS);
  append(evidence.text, MAX_CONTEXT_CHARS);
  append(evidence.html, MAX_HTML_CHARS);
  for (const values of [evidence.frameSources, evidence.visibleMarkers]) {
    let count = 0;
    for (const value of values ?? []) {
      if (count >= MAX_LIST_ITEMS || remaining <= 0) {
        break;
      }
      append(value);
      count += 1;
    }
  }
  return bounded.join("\n").toLowerCase();
}

function hasChallengeContext(haystack: string): boolean {
  return /(?:verify\s+(?:you\s+are\s+)?human|security\s+check|checking\s+your\s+browser|just\s+a\s+moment|access\s+denied|blocked\s+request|please\s+verify|confirm\s+you(?:'re| are)\s+not\s+a\s+robot|complete\s+the\s+(?:security|verification)\s+check|unusual\s+traffic|automated\s+(?:traffic|queries|access)|robot\s+check|are\s+you\s+a\s+robot|access\s+to\s+this\s+site\s+has\s+been\s+denied)/i.test(haystack);
}

function hasAuthContext(haystack: string): boolean {
  return /(?:sign\s*in|log\s*in|login|authentication|required\s+credentials|identity\s+provider|sso)/i.test(haystack);
}

export function classifyChallenge(
  evidence: ChallengeEvidence,
  options?: { bypassAttempted?: boolean },
): ChallengeClassification {
  const haystack = normalizedEvidence(evidence);
  const visibleContext = hasChallengeContext([boundedLower(evidence.title, MAX_TITLE_CHARS), boundedLower(evidence.text, MAX_CONTEXT_CHARS)].filter(Boolean).join("\n"));
  const html = boundedLower(evidence.html, MAX_HTML_CHARS);
  const title = boundedLower(evidence.title, MAX_TITLE_CHARS);
  const text = boundedLower(evidence.text, MAX_CONTEXT_CHARS);
  const frameSources = boundedList(evidence.frameSources);
  const visibleMarkers = boundedList(evidence.visibleMarkers);
  const matches: ChallengeMatch[] = [];
  for (const rule of RULES) {
    const indicators = rule.needles.filter((needle) => haystack.includes(needle));
    const widgetOnly = ["cloudflare-turnstile", "hcaptcha", "recaptcha", "arkose", "geetest", "friendlycaptcha", "altcha", "recaptcha-enterprise", "geetest-v4", "openai-turnstile", "kaptcha", "hcaptcha-enterprise"].includes(rule.kind);
    const genericChallenge = rule.kind === "generic-challenge";
    const authWall = rule.kind === "auth-wall";
    const hasPasswordField = /type\s*=\s*["']password["']|autocomplete\s*=\s*["'][^"']*(?:username|current-password)[^"']*["']/i.test(haystack);
    const isRateLimit = rule.kind === "rate-limited";
    const markerInMarkup = rule.needles.some((needle) => {
      const escapedNeedle = escapeRegExp(needle);
      return frameSources.some((source) => source.includes(needle))
        || visibleMarkers.some((marker) => marker.includes(needle))
        || new RegExp(`(?:class|id|name|src|data-[a-z0-9_-]+)\\s*=\\s*["'][^"']*${escapedNeedle}`, "i").test(html);
    });
    const visibleMarkerInMarkup = rule.needles.some((needle) => visibleMarkers.some((marker) => marker.includes(needle)));
    const cloudflareBlockCorroborated = rule.kind !== "cloudflare-block"
      || markerInMarkup
      || /(?:cloudflare|cf-error|ray\s*id|error\s+1020)/i.test(title);
    const cloudflareJsCorroborated = rule.kind !== "cloudflare-js"
      || /(?:just\s+a\s+moment|checking\s+your\s+browser)/i.test(title)
      || /(?:cdn-cgi\/challenge-platform|enable\s+javascript\s+and\s+cookies)/i.test(html)
      || (text.length <= 4_000 && visibleContext);
    const corroborated = (genericChallenge ? visibleContext : !widgetOnly || visibleContext || visibleMarkerInMarkup) && cloudflareBlockCorroborated && cloudflareJsCorroborated;
    const authCorroborated = !authWall || (hasPasswordField && hasAuthContext(haystack));
    const explicitRateLimitText = /(?:too many requests|rate limit exceeded|temporarily blocked|slow down)/i.test(`${title}\n${text}`);
    const rateCorroborated = !isRateLimit || evidence.status === 429 || (evidence.status === 503 && explicitRateLimitText);
    if (indicators.length > 0 && corroborated && authCorroborated && rateCorroborated) {
      matches.push({ kind: rule.kind, confidence: rule.confidence, indicators: indicators.slice(0, 4) });
    }
  }

  if (typeof evidence.status === "number" && evidence.status === 429 && !matches.some((match) => match.kind === "rate-limited")) {
    matches.push({ kind: "rate-limited", confidence: "high", indicators: [`http-status-${evidence.status}`] });
  }

  return {
    status: matches.length > 0 ? "present" : "absent",
    detected: matches.length > 0,
    matches,
    humanActionRequired: matches.length > 0,
    bypassAttempted: options?.bypassAttempted ?? false,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedLower(value: string | undefined, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit).toLowerCase() : "";
}

function boundedList(values: string[] | undefined): string[] {
  const bounded: string[] = [];
  let remaining = MAX_LIST_CHARS;
  for (const value of values ?? []) {
    if (bounded.length >= MAX_LIST_ITEMS || remaining <= 0) {
      break;
    }
    if (typeof value !== "string") {
      continue;
    }
    const item = value.slice(0, Math.min(MAX_LIST_ITEM_CHARS, remaining)).toLowerCase();
    bounded.push(item);
    remaining -= item.length;
  }
  return bounded;
}
