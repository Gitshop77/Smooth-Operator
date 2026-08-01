/**
 * URL policy checking — domain allowlist/blocklist enforcement.
 */

import { hostnameMatches } from "./security-hosts";

/** Input to {@link checkUrlAllowed}. */
export interface UrlPolicyConfig {
  /** Optional allowlist — only these domains (+ subdomains) are permitted. */
  allowedDomains?: string[];
  /** Optional blocklist — these domains (+ subdomains) are always rejected. */
  blockedDomains?: string[];
  /**
   * Optional additive phishing/reputation deny-gate. Called with the parsed
   * hostname AFTER the static block/allow checks; a `true` result rejects the
   * URL. It can ONLY add blocks — it is never consulted to grant access, so it
   * cannot relax the allowlist. It fails open: if it throws (reputation source
   * unavailable), the URL is treated as not-flagged rather than blocked.
   */
  reputationDeny?: (hostname: string) => boolean;
}

/** Result of a URL policy check. */
export interface UrlPolicyResult {
  /** Whether the URL is permitted under the given policy. */
  allowed: boolean;
  /** Human-readable reason when `allowed` is false. */
  reason?: string;
}

/**
 * Check if a URL is allowed based on the domain allowlist.
 *
 * - If `allowedDomains` is undefined or empty AND `requireAllowlist` is
 * `false` (the default), ALL domains are allowed (backward-compatible
 * default used by navigate/search).
 * - If `allowedDomains` is undefined or empty AND `requireAllowlist` is
 * `true` (the evaluate/JS-execution path), the function FAILS CLOSED and
 * returns `false` — JS execution must not run on an unconfigured origin.
 * - Otherwise the URL's hostname must equal an entry or be a subdomain of one.
 * - Invalid URLs always return `false`.
 *
 * Only the evaluate/JS-execution path opts into fail-closed via
 * `requireAllowlist`. Non-evaluate paths keep allow-all-by-default so we
 * don't change their behavior.
 */
export function isUrlAllowed(
  url: string,
  allowedDomains: string[] | undefined,
  requireAllowlist = false,
): boolean {
 // Scheme floor: never green-light non-hierarchical schemes (javascript:,
 // data:, file:, blob:) even on the allow-all path. This function is a public
 // export whose documented contract ("non-evaluate paths keep allow-all-by-
 // default") invites direct reuse for navigate/search — without this guard a
 // `javascript:` URL would pass. `checkUrlAllowed` also enforces this floor,
 // so this is defense-in-depth that makes the exported API safe to call
 // directly.
  try {
    const proto = new URL(url).protocol;
    if (proto !== "http:" && proto !== "https:") return false;
  } catch {
    return false;
  }
  if (!allowedDomains || allowedDomains.length === 0) {
 // Fail closed only when the caller explicitly requires an allowlist
 // (evaluate/JS execution). Otherwise allow-all is the historical default.
    return !requireAllowlist;
  }
  try {
    const parsed = new URL(url);
    return allowedDomains.some((domain) => hostnameMatches(parsed.hostname, domain));
  } catch {
    return false;
  }
}

/**
 * Check if a URL is in the blocked domains list.
 * Blocked domains take precedence over allowed domains.
 * Invalid URLs return `true` (fail-closed) — this branch is defensive: the
 * public `checkUrlAllowed` API parses the URL and fails closed BEFORE it
 * delegates to this helper, so the invalid-URL → `true` path here is not
 * reachable through `checkUrlAllowed`. It is retained as a safety net in case
 * `isUrlBlocked` is ever called directly with an unparsed URL.
 */
export function isUrlBlocked(url: string, blockedDomains: string[] | undefined): boolean {
  if (!blockedDomains || blockedDomains.length === 0) return false;
  try {
    const parsed = new URL(url);
    return blockedDomains.some((domain) => hostnameMatches(parsed.hostname, domain));
  } catch {
    return true;
  }
}

/**
 * Combined URL policy check: blocked list takes precedence over allowlist.
 * Returns `{allowed: true}` if the URL passes both checks.
 */
export function checkUrlAllowed(
  url: string,
  config: UrlPolicyConfig,
  requireAllowlist = false,
): UrlPolicyResult {
 // Scheme floor: reject non-hierarchical schemes (javascript:, file:, data:,
 // blob:) regardless of allow/blocklist config. These schemes can execute
 // code or access local files, and hostname-based checks can't gate them
 // (URL.hostname === "" for non-hierarchical URLs).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `URL scheme '${parsed.protocol}' is not allowed (only http/https)` };
  }
  if (isUrlBlocked(url, config.blockedDomains)) {
    return { allowed: false, reason: "URL domain is blocked" };
  }
 // Additive reputation deny-gate: can only reject, never grant. Fail open so an
 // unavailable/throwing reputation source never blocks otherwise-allowed traffic.
  if (config.reputationDeny) {
    let flagged = false;
    try {
      flagged = config.reputationDeny(parsed.hostname);
    } catch {
      flagged = false;
    }
    if (flagged) {
      return { allowed: false, reason: "URL flagged by reputation list" };
    }
  }
  if (!isUrlAllowed(url, config.allowedDomains, requireAllowlist)) {
    return {
      allowed: false,
      reason: requireAllowlist
        ? "JavaScript execution requires a configured domain allowlist; none is set"
        : "URL domain not in allowlist",
    };
  }
  return { allowed: true };
}
