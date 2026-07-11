/**
 * SSRF guard for LLM `baseUrl` values.
 *
 * The Chrome extension's service worker fetches the user's configured LLM
 * endpoint directly (no localhost backend). If a `baseUrl` is attacker-controlled
 * — e.g. via prompt injection that writes `chrome.storage.local`, a malicious
 * settings sync, or a crafted custom-tool payload — the service worker could be
 * made to reach:
 *   - cloud metadata services (`http://169.254.169.254/` — AWS/GCP/Azure),
 *   - loopback / localhost admin surfaces (`http://127.0.0.1`, `http://localhost`),
 *   - RFC1918 / CGNAT internal hosts on the user's network.
 *
 * This module provides a synchronous, DNS-free validator that rejects the
 * dangerous address ranges. It is wired into:
 *   1. `src/extension/provider-config.ts` — user-supplied `baseUrl`,
 *   2. `src/lib/agent/llm/providers/openai-compatible-profile.ts` — user-supplied
 *      `baseURL` when synthesizing a profile,
 *   3. `src/lib/agent/llm/route/transport-http.ts` — defense-in-depth, on the
 *      final fetch URL.
 *
 * So a bad URL fails closed (throws) rather than silently contacting the host.
 *
 * DESIGN NOTE — curated local providers: Ollama (`http://localhost:11434`) and
 * LiteLLM (`http://localhost:4000`) are legitimate, user-selected local LLM
 * servers whose default base URLs ARE loopback. They are exempted from the
 * strict check via `LOCAL_PROVIDER_BASE_URLS` so the guard blocks UNEXPECTED
 * internal/loopback targets (the actual SSRF risk) without breaking the user's
 * own explicitly-chosen local LLM. The strict `validateLlmBaseUrl` function
 * itself still rejects `localhost`/`127.0.0.0/8` etc. — the exemption only
 * applies at the integration/transport layer (see `isAllowedLlmBaseUrl`).
 *
 * We deliberately do NOT perform DNS resolution (keep it synchronous + cheap and
 * avoid a network round-trip during request setup). Only the parsed HOST is
 * inspected: if it is an IP literal in a blocked range we reject; normal
 * public hostname URLs (e.g. `api.openai.com`) are allowed. This means a
 * public hostname that DNS-resolves to an internal IP would NOT be caught here
 * — that is an accepted, documented limitation (out of scope for this guard).
 */

export type SsrfCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Curated local-provider base URLs EXEMPT from the strict transport-layer SSRF
 * check. These are the exact default endpoints for Ollama and LiteLLM — both
 * reachable via `localhost` and `127.0.0.1`. Any OTHER loopback / RFC1918 URL
 * is still rejected.
 */
export const LOCAL_PROVIDER_BASE_URLS: readonly string[] = [
  "http://localhost:11434",
  "http://127.0.0.1:11434",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
];

// ─── IP-literal classification ───────────────────────────────────────────────

/**
 * Returns true if `host` (a URL hostname: no port, no brackets) is an IP
 * literal in a loopback / private / link-local / CGNAT / unspecified range.
 * Hostname-based URLs (e.g. `api.openai.com`) are NOT IP literals, so they
 * return false here and are allowed by the caller (no DNS resolution).
 */
function isPrivateOrLoopbackIp(host: string): boolean {
  if (!host) return false;
  if (host.includes(":")) {
    // IPv6 literal (or IPv4-mapped IPv6).
    return isDangerousIpv6(host);
  }
  return isDangerousIpv4(host);
}

/** Parse a dotted-quad IPv4 string into 4 octets, or null if not a valid v4 literal. */
function parseIPv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * IPv4-literal SSRF classification. Returns true for the blocked ranges:
 *   0.0.0.0/8 (unspecified / "this" network), 10.0.0.0/8, 127.0.0.0/8 (loopback),
 *   172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local / cloud metadata),
 *   100.64.0.0/10 (CGNAT / shared address space).
 * Returns false for non-IPv4-literal hosts (caller treats them as hostnames).
 */
function isDangerousIpv4(host: string): boolean {
  const o = parseIPv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return true;                              // 0.0.0.0/8
  if (a === 10) return true;                             // 10.0.0.0/8
  if (a === 127) return true;                            // 127.0.0.0/8 loopback
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * IPv6-literal SSRF classification. Handles the `::ffff:<ipv4>` mapped form
 * (delegates to the IPv4 check) and pure IPv6 (expanded to 8 groups):
 *   - `::1` loopback,
 *   - `::` unspecified (all-zeros),
 *   - `fc00::/7` unique local addresses (ULA),
 *   - `fe80::/10` link-local.
 * Returns false for non-IPv6-literal hosts.
 */
function isDangerousIpv6(host: string): boolean {
  // IPv4-mapped IPv6. The URL parser canonicalizes `::ffff:127.0.0.1` into the
  // hex form `::ffff:7f00:1` (the IPv4 packed into the last two 16-bit groups),
  // so handle both the dotted and canonical-hex representations.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const g5 = parseInt(mappedHex[1], 16);
    const g6 = parseInt(mappedHex[2], 16);
    const embedded = `${(g5 >> 8) & 0xff}.${g5 & 0xff}.${(g6 >> 8) & 0xff}.${g6 & 0xff}`;
    return isDangerousIpv4(embedded);
  }
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mappedDotted) {
    return isDangerousIpv4(mappedDotted[1]);
  }
  const groups = expandIPv6(host);
  if (!groups) return false; // not a valid IPv6 literal → treat as hostname
  // Unspecified :: (equivalent to 0.0.0.0).
  if (groups.every((g) => g === 0)) return true;
  // Loopback ::1
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return true;
  // ULA fc00::/7 → first 7 bits 1111110 → group0 & 0xFE00 === 0xFC00
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 → group0 & 0xFFC0 === 0xFE80
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  return false;
}

/**
 * Expand an IPv6 literal into 8 unsigned-16-bit groups, handling `::`
 * compression. Returns null if the string is not a valid IPv6 literal (e.g.
 * contains characters other than hex digits and colons, or has the wrong group
 * count). Embedded IPv4 (handled separately above) is expected to be absent
 * here, so any "." in the string makes it invalid for this pure-IPv6 path.
 */
function expandIPv6(host: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(host)) return null; // no dots/other chars allowed here
  const doubleColon = host.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColon === -1) {
    head = host.split(":");
    tail = [];
    if (head.length !== 8) return null;
  } else {
    head = host.slice(0, doubleColon).split(":").filter((x) => x.length > 0);
    tail = host.slice(doubleColon + 2).split(":").filter((x) => x.length > 0);
    if (head.length + tail.length > 8) return null; // too many groups
  }
  const groups: number[] = [];
  for (const g of head) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n > 0xffff) return null;
    groups.push(n);
  }
  if (doubleColon !== -1) {
    const missing = 8 - head.length - tail.length;
    for (let i = 0; i < missing; i++) groups.push(0);
  }
  for (const g of tail) {
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n > 0xffff) return null;
    groups.push(n);
  }
  if (groups.length !== 8) return null;
  return groups;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Validate an LLM `baseUrl` against the SSRF guard.
 *
 * @returns `{ ok: true }` for allowed URLs, or `{ ok: false, reason }`
 *   explaining the rejection for blocked URLs.
 *
 * Blocks:
 *   - non-`http`/`https` schemes (`file:`, `ftp:`, `javascript:`, …),
 *   - `localhost` and `*.localhost`,
 *   - loopback `127.0.0.0/8`, `::1`, `0.0.0.0`,
 *   - link-local `169.254.0.0/16` (cloud metadata) and `fe80::/10`,
 *   - private RFC1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
 *   - CGNAT `100.64.0.0/10`,
 *   - IPv6 ULA `fc00::/7`, plus the `::ffff:<ipv4>` mapped forms.
 *
 * Public hostname-based URLs (`api.openai.com`, etc.) are ALLOWED — the host is
 * only parsed, never DNS-resolved (see module docs). Curated local-provider
 * loopback endpoints are intentionally NOT exempted here; the integration layer
 * uses {@link isAllowedLlmBaseUrl} for that narrow exception.
 */
export function validateLlmBaseUrl(url: string): SsrfCheckResult {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "baseUrl must be a non-empty string" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `scheme "${parsed.protocol}" is not allowed (only http/https): ${url}`,
    };
  }
  const host = parsed.hostname;
  if (!host) {
    return { ok: false, reason: `missing host in URL: ${url}` };
  }
  // URL.hostname already strips IPv6 brackets, but guard anyway.
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  if (normalizedHost === "localhost" || normalizedHost.endsWith(".localhost")) {
    return { ok: false, reason: `localhost is not allowed: ${url}` };
  }
  if (isPrivateOrLoopbackIp(normalizedHost)) {
    return {
      ok: false,
      reason: `host resolves to a private/loopback/link-local address: ${normalizedHost}`,
    };
  }
  return { ok: true };
}

/**
 * Same policy as {@link validateLlmBaseUrl} but WITH the narrow curated-local
 * provider exemption (Ollama / LiteLLM default loopback URLs). Use this at the
 * integration / transport layer so a user's own local LLM keeps working while
 * every other loopback / RFC1918 / metadata URL is still rejected.
 *
 * @returns true if the URL is safe to fetch (or is a curated local endpoint).
 */
export function isAllowedLlmBaseUrl(url: string): boolean {
  const res = validateLlmBaseUrl(url);
  if (res.ok) return true;
  if (LOCAL_PROVIDER_BASE_URLS.some((prefix) => url.startsWith(prefix))) {
    return true;
  }
  return false;
}
