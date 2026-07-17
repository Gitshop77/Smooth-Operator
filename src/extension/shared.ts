/**
 * shared.ts — DOM helpers shared by options.ts and sidepanel.ts.
 *
 * Keeping these in one module avoids two divergent copies and lets both pages
 * use the same `$` (throw on missing) + `escapeHtml` semantics. Also hosts
 * the cockpit URL configuration (used by the "Open Cowork Cockpit" button
 * in the side panel and the matching settings field in the options page), and
 * the `redactKeyLeak` secret-masking primitive used by both the options
 * test-connection path and the live side-panel log / thinking renderers.
 */

import { PROVIDER_META } from "./options/providers";

/**
 * Get an element by id, throwing if missing (dev-time safety).
 * Generic param `T` lets callers narrow to e.g. `HTMLInputElement`.
 */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

/**
 * Escape user-supplied text for safe interpolation inside `innerHTML`.
 * Replaces the five significant XML characters: & < > " ', plus `/` (so the
 * output can never prematurely close an attribute or inject a path). Escaping
 * `/` is harmless in normal text — it renders identically — but closes a
 * latent cross-context injection hole.
 */
export function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(
    /[&<>"'/]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        "/": "&#47;",
      })[c]!,
  );
}

// ─── Secret redaction ─────────────────────────────────────────────────────
//
// A provider error string can embed the user's API key (e.g. `401: Invalid
// API key: sk-ant-api03-...`). The same key-masking primitive is reused by the
// options test-connection path AND the live side-panel log / thinking renderers
// so a provider error surfaced through the agent loop is never shown verbatim.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/** Derive concrete key prefixes from provider placeholders (e.g. `sk-ant-api03-...` → `sk-ant-`). */
function providerKeyPrefixes(): string[] {
  const out = new Set<string>();
  for (const p of Object.values(PROVIDER_META)) {
    const ph = p.keyPlaceholder;
    if (!ph || ph === "...") continue;
    const m = /^[A-Za-z0-9_-]+/.exec(ph);
    if (!m) continue;
    const prefix = m[0];
    // Skip obviously non-secret placeholders (provider labels, not keys).
    if (prefix === "ollama" || prefix === "your-opencode-key") continue;
    out.add(escapeRegex(prefix) + "[A-Za-z0-9_-]+");
  }
  return [...out];
}

/**
 * Mask common API-key prefixes that may leak into provider error text before
 * the message is shown in the UI. The allowlist is derived from the provider
 * catalog (`PROVIDER_META`) so a new or custom provider's key prefix is covered
 * automatically, plus a base set of well-known global prefixes. Non-key text is
 * returned unchanged. Over-redaction in a debug log is safe; leaking the key is
 * not.
 */
/**
 * Heuristic: does a quoted/bare scalar look like a high-entropy secret rather
 * than ordinary prose, a URL, or a short label? Additive mask only — it never
 * weakens the prefix matchers above. Conservative on length and requires mixed
 * character classes so normal words and structured text survive, while
 * EchoLeak-class secrets with no known key prefix are still caught.
 */
function looksLikeSecret(v: string): boolean {
  const t = v.trim();
  if (t.length < 16 || t.length > 512) return false;
  if (/\s/.test(t)) return false;
  if (t.includes("://")) return false; // leave URLs intact
  const hasLower = /[a-z]/.test(t);
  const hasUpper = /[A-Z]/.test(t);
  const hasDigit = /[0-9]/.test(t);
  const hasSpecial = /[^A-Za-z0-9]/.test(t);
  const classes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  return classes >= 2;
}

export function redactKeyLeak(s: string): string {
  // Build the matcher per-call so no shared mutable `lastIndex` survives between
  // invocations (a module-level `g`-flag regex is a latent re-entrancy footgun
  // for any concurrent call site).
  const keyRe = new RegExp(
    "(" + [...providerKeyPrefixes(), ...BASE_KEY_PATTERNS].join("|") + ")",
    "g",
  );
  let out = s.replace(keyRe, (m) => {
    const dash = m.indexOf("-");
    const prefix = dash > 0 ? m.slice(0, dash + 1) : m.slice(0, 4);
    return `${prefix}[REDACTED]`;
  });

  // Additive pass: mask `Bearer <token>` authorization headers a provider may
  // echo back verbatim inside an error (these carry no key prefix to match).
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/g, "Bearer [REDACTED]");

  // Additive pass: mask the values of known JSON secret keys (e.g.
  // `"password": "..."`, `"apiKey": "..."`), regardless of key prefix. Quote
  // style of the value is preserved.
  out = out.replace(
    /("(?:password|passwd|api[_-]?key|apikey|secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token)"\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gi,
    (_, keyPart: string, valPart: string) => {
      const q = valPart[0];
      return `${keyPart}${q}[REDACTED]${q}`;
    },
  );

  // Additive pass: mask generic high-entropy quoted scalars (tool/page output,
  // JSON blobs) that have no recognisable key prefix. Bounded and conservative
  // — over-redaction in a debug log is safe; leakage is not.
  out = out.replace(/"([^"]+)"/g, (full, inner: string) =>
    looksLikeSecret(inner) ? `"[REDACTED]"` : full,
  );

  return out;
}

// ─── Cockpit URL ──────────────────────────────────────────────────────────
//
// The Cowork Cockpit is a Next.js dashboard that lives outside the
// extension (dev: http://localhost:3000, prod: a deployed URL). The side
// panel's "Open Cowork Cockpit" button opens this URL in a new tab. The
// user must configure it in Settings — there is no baked-in default, so a
// production install never silently targets a plaintext localhost origin.
// An empty string means "not configured": the UI should prompt the user to
// set a real (preferably https) cockpit URL rather than opening localhost.

/**
 * Default cockpit URL. Intentionally empty so production artifacts never ship
 * a plaintext `http://localhost:3000` fallback. Callers should treat "" as
 * "unconfigured" and gate the "Open Cockpit" action until the user supplies a
 * real, https-validated URL. A developer running the cockpit locally can set
 * the URL in Settings (or via the COCKPIT_URL storage key).
 */
export const DEFAULT_COCKPIT_URL = "";
export const COCKPIT_URL_STORAGE_KEY = "coworkCockpitUrl";

/**
 * Read the configured cockpit URL from chrome.storage.local, falling back to
 * DEFAULT_COCKPIT_URL (empty = "not configured") if unset or empty.
 */
export async function getCockpitUrl(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(COCKPIT_URL_STORAGE_KEY);
    const stored = result[COCKPIT_URL_STORAGE_KEY];
    const candidate = typeof stored === "string" && stored.trim() ? stored.trim() : DEFAULT_COCKPIT_URL;
 // Reject non-http(s) schemes (javascript:, data:, blob:, file:, …). A
 // corrupt or attacker-controlled stored value must never be opened in a
 // new tab as an executable scheme — fall back to the safe default.
    if (!candidate) return candidate; // empty = explicitly "not configured"
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return DEFAULT_COCKPIT_URL;
      }
    } catch {
      return DEFAULT_COCKPIT_URL;
    }
    return candidate;
  } catch {
 // chrome.storage may be unavailable in tests / non-extension contexts.
    return DEFAULT_COCKPIT_URL;
  }
}
