/**
 * Host validation helpers for domain allowlist/blocklist enforcement.
 * Used by security-url-policy.ts.
 */

/**
 * Strip surrounding `[`/`]` (IPv6 brackets), trailing dots (so a FQDN
 * `example.com.` can't bypass an `example.com` allow/block entry), and
 * lowercase a host — for use in hostname comparison.
 */
function normalizeHost(h: string): string {
  return h
    .replace(/^\[/, "")
    .replace(/\](?::\d+)?$/, "")
    .replace(/%[0-9a-z]+$/i, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

/**
 * Normalize a domain input from an allow/block-list entry.
 *
 * Returns `null` for rejected inputs (empty, wildcard, whitespace, single-label
 * non-IP) and the cleaned string otherwise. Accepts leading-dot (`.example.com`)
 * and leading-wildcard (`*.example.com`) conventions, strips trailing `:port`
 * for non-IPv6, and lowercases.
 */
function normalizeDomainInput(raw: string): string | null {
  let d = normalizeHost(raw).trim();
  if (!d) return null;
  d = d.replace(/^\.+/, "");
  d = d.replace(/^\*\./, "");
  // Strip trailing :port only for non-IPv6 addresses.
  if (!d.includes(":") || d.includes("]:")) {
    d = d.replace(/:\d+$/, "");
  } else if (d.startsWith("[") && d.includes("]:")) {
    d = d.replace(/^\[(.+)\]:\d+$/, "$1");
  }
  if (!d || d.includes("*") || /\s/.test(d)) return null;
  d = d.replace(/\.+$/, "");
  if (!d) return null;
  // Reject single-label non-IP entries (e.g. "com", "org").
  const looksLikeIp = /^[0-9.]+$/.test(d) || d.includes(":");
  if (!d.includes(".") && !looksLikeIp) return null;
  return d;
}

/**
 * Test whether `hostname` matches `domain` (exact match or subdomain).
 * Pre-sorted by length is unnecessary — both checks are O(domain.length).
 *
 * IPv6 hostnames are returned by `URL.hostname` wrapped in brackets
 * (`[:1]`). Strip the brackets on both sides so callers can specify the
 * bare IPv6 address in the allow/block list (`":1"`).
 */
export function hostnameMatches(hostname: string, domain: string): boolean {
  const h = normalizeHost(hostname);
  const d = normalizeDomainInput(domain);
  if (d === null) return false;
  // IP literals have no real subdomains — only an exact host match is allowed.
  const looksLikeIp = /^[0-9.]+$/.test(d) || d.includes(":");
  if (looksLikeIp) return h === d;
  return h === d || h.endsWith(`.${d}`);
}
