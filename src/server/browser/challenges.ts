/** Deterministic challenge classification from bounded, page-visible evidence. */

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

export interface ChallengeMatch {
  kind: ChallengeKind;
  confidence: "low" | "medium" | "high";
  indicators: string[];
}

export interface ChallengeClassification {
  status: "present" | "absent" | "unknown";
  detected: boolean;
  matches: ChallengeMatch[];
  humanActionRequired: boolean;
}

export interface ChallengeEvidence {
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
// Title/text/HTML retain their established coverage. The remaining aggregate
// budget is reserved evenly for both independently bounded marker lists;
// separators account for the four joins in the compact haystack.
const MAX_LIST_HAYSTACK_CHARS = Math.floor((MAX_EVIDENCE_CHARS - MAX_TITLE_CHARS - MAX_CONTEXT_CHARS - MAX_HTML_CHARS - 4) / 2);
const WIDGET_ONLY_KINDS: ReadonlySet<ChallengeKind> = new Set([
  "cloudflare-turnstile",
  "hcaptcha",
  "recaptcha",
  "arkose",
  "geetest",
  "friendlycaptcha",
  "altcha",
  "recaptcha-enterprise",
  "geetest-v4",
  "openai-turnstile",
  "kaptcha",
  "hcaptcha-enterprise",
]);
const MARKER_REGEX_CACHE = new Map<string, RegExp>();

const RULES: Array<{ kind: ChallengeKind; confidence: ChallengeMatch["confidence"]; needles: string[] }> = [
  // Specific markers must precede their generic substrings. The classifier
  // may retain overlapping evidence, but consumers always see the most
  // specific challenge kind first.
  { kind: "recaptcha-enterprise", confidence: "high", needles: ["recaptcha-enterprise", "g-recaptcha-enterprise"] },
  { kind: "geetest-v4", confidence: "high", needles: ["geetest-v4", "geetest v4", "newverification"] },
  { kind: "openai-turnstile", confidence: "high", needles: ["openai-turnstile", "turnstile-v3"] },
  { kind: "kaptcha", confidence: "high", needles: ["kaptcha", "spring-kaptcha"] },
  { kind: "hcaptcha-enterprise", confidence: "high", needles: ["hcaptcha-enterprise", "h-captcha-enterprise"] },
  { kind: "datadome", confidence: "high", needles: ["datadome"] },
  { kind: "cloudflare-turnstile", confidence: "high", needles: ["cf-turnstile", "challenges.cloudflare.com/turnstile", "turnstile-widget"] },
  { kind: "hcaptcha", confidence: "high", needles: ["hcaptcha", "h-captcha"] },
  { kind: "recaptcha", confidence: "high", needles: ["g-recaptcha", "recaptcha", "google.com/recaptcha"] },
  { kind: "arkose", confidence: "high", needles: ["arkoselabs", "funcaptcha", "arkose"] },
  { kind: "geetest", confidence: "high", needles: ["geetest"] },
  { kind: "friendlycaptcha", confidence: "high", needles: ["friendlycaptcha", "friendly-challenge"] },
  { kind: "altcha", confidence: "high", needles: ["altcha"] },
  { kind: "aws-waf", confidence: "high", needles: ["awswafcaptcha", "aws waf", "amazonaws.com/waf"] },
  { kind: "cloudflare-block", confidence: "medium", needles: ["attention required!", "cf-error-details", "cloudflare ray id", "error 1020"] },
  { kind: "cloudflare-js", confidence: "medium", needles: ["just a moment...", "checking your browser", "/cdn-cgi/challenge-platform", "enable javascript and cookies"] },
  { kind: "rate-limited", confidence: "medium", needles: ["too many requests", "rate limit exceeded", "temporarily blocked", "slow down"] },
  { kind: "generic-challenge", confidence: "low", needles: ["verify you are human", "security check", "please verify", "not a robot", "complete the security verification", "unusual traffic", "automated traffic", "automated queries", "automated access", "robot check", "are you a robot", "access to this site has been denied"] },
  { kind: "auth-wall", confidence: "low", needles: ["sign in to continue", "log in to continue", "authentication required", "access denied"] },
];

interface NormalizedEvidence {
  title: string;
  text: string;
  html: string;
  frameHaystack: string;
  visibleMarkerHaystack: string;
  haystack: string;
}

function normalizedEvidence(evidence: ChallengeEvidence): NormalizedEvidence {
  const title = boundedLower(evidence.title, MAX_TITLE_CHARS);
  const text = boundedLower(evidence.text, MAX_CONTEXT_CHARS);
  const html = boundedLower(evidence.html, MAX_HTML_CHARS);
  // Apply item/count/aggregate limits before joining either list. The full
  // bounded joins are retained for marker matching; the compact haystack uses
  // a fixed slice for each list so every evidence category remains represented.
  const frameSources = boundedList(evidence.frameSources);
  const visibleMarkers = boundedList(evidence.visibleMarkers);
  const frameHaystack = frameSources.join("\n");
  const visibleMarkerHaystack = visibleMarkers.join("\n");
  const haystack = [
    title,
    text,
    html,
    frameHaystack.slice(0, MAX_LIST_HAYSTACK_CHARS),
    visibleMarkerHaystack.slice(0, MAX_LIST_HAYSTACK_CHARS),
  ].join("\n");
  return { title, text, html, frameHaystack, visibleMarkerHaystack, haystack };
}

function hasChallengeContext(haystack: string): boolean {
  return /(?:verify\s+(?:you\s+are\s+)?human|security\s+check|checking\s+your\s+browser|just\s+a\s+moment|access\s+denied|blocked\s+request|please\s+verify|confirm\s+you(?:'re| are)\s+not\s+a\s+robot|complete\s+the\s+(?:security|verification)\s+check|unusual\s+traffic|automated\s+(?:traffic|queries|access)|robot\s+check|are\s+you\s+a\s+robot|access\s+to\s+this\s+site\s+has\s+been\s+denied)/i.test(haystack);
}

function hasAuthContext(haystack: string): boolean {
  return /(?:sign\s*in|log\s*in|login|authentication|required\s+credentials|identity\s+provider|sso)/i.test(haystack);
}

export function classifyChallenge(
  evidence: ChallengeEvidence,
): ChallengeClassification {
  const normalized = normalizedEvidence(evidence);
  const { haystack, html, title, text, frameHaystack, visibleMarkerHaystack } = normalized;
  const markerHaystack = `${frameHaystack}\n${visibleMarkerHaystack}`;
  const visibleContext = hasChallengeContext(`${title}\n${text}`);
  const hasPasswordField = /type\s*=\s*["']password["']|autocomplete\s*=\s*["'][^"']*(?:username|current-password)[^"']*["']/i.test(haystack);
  const explicitRateLimitText = /(?:too many requests|rate limit exceeded|temporarily blocked|slow down)/i.test(`${title}\n${text}`);
  // Compute marker evidence once per challenge snapshot. The previous loop
  // rebuilt the same regular expressions for every rule and repeatedly scanned
  // the same frame/visible-marker arrays.
  const markerInMarkup = new Set<string>();
  const visibleMarkerInMarkup = new Set<string>();
  for (const rule of RULES) {
    for (const needle of rule.needles) {
      if (markerHaystack.includes(needle)) {
        markerInMarkup.add(needle);
      }
      if (visibleMarkerHaystack.includes(needle)) {
        visibleMarkerInMarkup.add(needle);
      }
      let markerRegex = MARKER_REGEX_CACHE.get(needle);
      if (!markerRegex) {
        const escapedNeedle = escapeRegExp(needle);
        markerRegex = new RegExp(`(?:class|id|name|src|data-[a-z0-9_-]+)\\s*=\\s*["'][^"']*${escapedNeedle}`, "i");
        MARKER_REGEX_CACHE.set(needle, markerRegex);
      }
      if (markerRegex.test(html)) {
        markerInMarkup.add(needle);
      }
    }
  }
  const matches: ChallengeMatch[] = [];
  for (const rule of RULES) {
    const indicators = rule.needles.filter((needle) => haystack.includes(needle) || markerHaystack.includes(needle));
    const widgetOnly = WIDGET_ONLY_KINDS.has(rule.kind);
    const genericChallenge = rule.kind === "generic-challenge";
    const authWall = rule.kind === "auth-wall";
    const isRateLimit = rule.kind === "rate-limited";
    const ruleMarkerInMarkup = rule.needles.some((needle) => markerInMarkup.has(needle));
    const ruleVisibleMarkerInMarkup = rule.needles.some((needle) => visibleMarkerInMarkup.has(needle));
    const cloudflareBlockCorroborated = rule.kind !== "cloudflare-block"
      || ruleMarkerInMarkup
      || /(?:cloudflare|cf-error|ray\s*id|error\s+1020)/i.test(title);
    const cloudflareJsCorroborated = rule.kind !== "cloudflare-js"
      || /(?:just\s+a\s+moment|checking\s+your\s+browser)/i.test(title)
      || /(?:cdn-cgi\/challenge-platform|enable\s+javascript\s+and\s+cookies)/i.test(html)
      || (text.length <= 4_000 && visibleContext);
    const corroborated = (genericChallenge
      ? visibleContext
      : !widgetOnly || visibleContext || ruleVisibleMarkerInMarkup)
      && cloudflareBlockCorroborated && cloudflareJsCorroborated;
    const authCorroborated = !authWall || (hasPasswordField && hasAuthContext(haystack));
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
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedLower(value: string | undefined, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit).toLowerCase().slice(0, limit) : "";
}

function boundedList(values: string[] | undefined): string[] {
  const bounded: string[] = [];
  let remaining = MAX_LIST_CHARS;
  for (const value of Array.isArray(values) ? values : []) {
    if (bounded.length >= MAX_LIST_ITEMS || remaining <= 0) {
      break;
    }
    if (typeof value !== "string") {
      continue;
    }
    const itemLimit = Math.min(MAX_LIST_ITEM_CHARS, remaining);
    const item = value.slice(0, itemLimit).toLowerCase().slice(0, itemLimit);
    bounded.push(item);
    remaining -= item.length;
  }
  return bounded;
}
