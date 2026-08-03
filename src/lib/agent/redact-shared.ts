/**
 * UI-surface key-leak redaction — the canonical home of `redactKeyLeak`.
 *
 * The agent engine (callbacks.ts) and the extension UI surfaces (options
 * test-connection, side-panel log / thinking renderers) must all mask
 * provider error strings without the engine depending on the extension UI
 * layer. This module lives in `lib/agent` and depends only on
 * `key-shape-redact`; the extension's `shared.ts` re-exports it and
 * registers provider-catalog-derived key prefixes via
 * {@link setRedactKeyLeakProviderPatterns}.
 */

import { redactKeyShapes } from "./key-shape-redact";

/** Base key patterns not derivable from a single catalog placeholder. */
const BASE_KEY_PATTERNS = [
  "sk-ant-[A-Za-z0-9_-]+",
  "sk-[A-Za-z0-9_-]+",
  "AIza[A-Za-z0-9_-]+",
  "ya29\\.[A-Za-z0-9_-]+",
  "ghp_[A-Za-z0-9_-]+",
  "gho_[A-Za-z0-9_-]+",
  "ghu_[A-Za-z0-9_-]+",
  "ghs_[A-Za-z0-9_-]+",
  "ghr_[A-Za-z0-9_-]+",
  "github_pat_[A-Za-z0-9_-]+",
  "glpat-[A-Za-z0-9_-]+",
  "gsk_[A-Za-z0-9_-]+",
  "xoxb-[A-Za-z0-9_-]+",
  "xoxp-[A-Za-z0-9_-]+",
  "xoxa-[A-Za-z0-9_-]+",
  "xoxs-[A-Za-z0-9_-]+",
  "AKIA[0-9A-Z]{16}",
  // JWT: mask the ENTIRE token (header.payload.signature), not just the header.
  "eyJ[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*",
];

/**
 * Register provider-catalog-derived key prefixes (e.g. `sk-ant-api03-...` →
 * `sk-ant-`). Called by the extension UI layer (`shared.ts`) once at startup;
 * rebuilding the compiled matcher on the next use keeps registration
 * idempotent and order-independent.
 */
let providerKeyPatterns: string[] = [];
export function setRedactKeyLeakProviderPatterns(patterns: string[]): void {
  providerKeyPatterns = patterns;
  KEY_RE = null;
}

/** Lazy-compiled key regex (provider prefixes + base patterns). Built once on first use. */
let KEY_RE: RegExp | null = null;

function keyRe(): RegExp {
  if (!KEY_RE) {
    KEY_RE = new RegExp(
      "(" + [...providerKeyPatterns, ...BASE_KEY_PATTERNS].join("|") + ")",
      "g",
    );
  }
  return KEY_RE;
}

/** Bearer token redaction — used only with `.replace()`, safe to hoist. */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]+/g;

/** JSON secret-key value redaction — used only with `.replace()`, safe to hoist. */
const JSON_SECRET_RE =
  /("(?:password|passwd|api[_-]?key|apikey|secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token)"\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi;

/** Generic high-entropy quoted scalar redaction — used only with `.replace()`, safe to hoist. */
const HIGH_ENTROPY_RE = /"([^"]+)"/g;

/**
 * Heuristic: does a quoted/bare scalar look like a high-entropy secret rather
 * than ordinary prose, a URL, or a short label? Additive mask only — it never
 * weakens the prefix matchers above. Conservative on length and requires mixed
 * character classes so normal words and structured text survive, while
 * EchoLeak-class secrets with no known key prefix are still caught.
 */
function looksLikeSecret(v: string): boolean {
  const t = v.trim();
  if (t.length < 16) return false;
  if (/\s/.test(t)) return false;
  if (t.includes("://")) return false; // leave URLs intact
  const hasLower = /[a-z]/.test(t);
  const hasUpper = /[A-Z]/.test(t);
  const hasDigit = /[0-9]/.test(t);
  const hasSpecial = /[^A-Za-z0-9]/.test(t);
  const classes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  // Very long (single-class or otherwise) scalars are masked even past the old
  // 512-char ceiling — closing the oversized-token EchoLeak gap.
  if (t.length > 512) return true;
  // Ordinary multi-class secrets (e.g. a base64 blob).
  if (classes >= 2) return true;
  // High-entropy single-class secrets (pure-numeric / pure-alpha / pure-special
  // tokens of 16+ chars) — prefix-less EchoLeak-class tokens that the prior
  // 32-char floor let through.
  if (classes === 1 && t.length >= 16) return true;
  return false;
}

/**
 * Mask common API-key prefixes that may leak into provider error text before
 * the message is shown in the UI. The allowlist is derived from the provider
 * catalog (registered via {@link setRedactKeyLeakProviderPatterns}) so a new
 * or custom provider's key prefix is covered automatically, plus a base set
 * of well-known global prefixes. Non-key text is returned unchanged.
 * Over-redaction in a debug log is safe; leaking the key is not.
 */
export function redactKeyLeak(s: string): string {
  let out = s.replace(keyRe(), (m) => {
    const dash = m.indexOf("-");
    const prefix = dash > 0 ? m.slice(0, dash + 1) : m.slice(0, 4);
    return `${prefix}[REDACTED]`;
  });

  out = out.replace(BEARER_RE, "Bearer [REDACTED]");

  out = out.replace(
    JSON_SECRET_RE,
    (_, keyPart: string, valPart: string) => {
      const q = valPart[0];
      return `${keyPart}${q}[REDACTED]${q}`;
    },
  );

  out = out.replace(HIGH_ENTROPY_RE, (full, inner: string) =>
    looksLikeSecret(inner) ? `"[REDACTED]"` : full,
  );

  return redactKeyShapes(out);
}
