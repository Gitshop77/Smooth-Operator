/**
 * SSRF guard for LLM `baseUrl` values.
 *
 * The Chrome extension's service worker fetches the user's configured LLM
 * endpoint directly (no localhost backend). If a `baseUrl` is attacker-controlled
 * — e.g. via prompt injection that writes `chrome.storage.local`, a malicious
 * settings sync, or a crafted custom-tool payload — the service worker could be
 * made to reach:
 *   - cloud metadata services (`http://169.254.169.254/` — AWS/GCP/Azure), which
 *     live in link-local `169.254.0.0/16` (and IPv6 `fe80::/10`).
 *
 * Self-hosted model servers (Ollama, LiteLLM, LM Studio, …) legitimately run on
 * loopback (`127.0.0.0/8`, `::1`) or a LAN RFC1918 address
 * (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, IPv6 ULA `fc00::/7`). The
 * user's own infrastructure is NOT an SSRF target, so those ranges are ALLOWED.
 * Only the genuine SSRF sinks remain blocked: cloud-metadata / link-local
 * `169.254.0.0/16` (+ IPv6 `fe80::/10`), unspecified `0.0.0.0/8`, and
 * CGNAT `100.64.0.0/10`.
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
 * servers whose default base URLs ARE loopback. The SSRF guard
 * (`validateLlmBaseUrl`) ALLOWS loopback (`127.0.0.0/8`, `::1`) and RFC1918
 * private ranges (`10/8`, `172.16/12`, `192.168/16`, IPv6 ULA `fc00::/7`) because
 * the user's own Ollama / LiteLLM server is the user's host, not an SSRF target.
 * It STILL blocks the genuine sinks: cloud-metadata / link-local `169.254.0.0/16`
 * (+ IPv6 `fe80::/10`), unspecified `0.0.0.0/8`, and CGNAT `100.64.0.0/10`.
 * `LOCAL_PROVIDER_BASE_URLS` remains as defense-in-depth for the exact default
 * endpoints at the integration / transport layer (see `isAllowedLlmBaseUrl`).
 *
 * The synchronous {@link validateLlmBaseUrl} does NOT perform DNS resolution
 * (keep it cheap and free of a network round-trip during request setup). It
 * inspects only the parsed HOST: if it is an IP literal in a blocked range we
 * reject; normal public hostname URLs (e.g. `api.openai.com`) are allowed. This
 * means a public hostname that DNS-resolves to an internal IP would NOT be
 * caught by the synchronous path — that is an accepted limitation of that
 * function. The async {@link resolveAndValidateLlmBaseUrl} variant closes that
 * gap: when a DNS resolver is available it resolves the hostname and rejects
 * any resolution into the blocked ranges (cloud metadata, RFC1918, loopback),
 * so untrusted `baseUrl` values can be validated against their real target.
 *
 * TRADE-OFF (injected-loopback SSRF): the `LOCAL_PROVIDER_BASE_URLS` exemption
 * in {@link isAllowedLlmBaseUrl} is applied at the transport layer regardless of
 * how the `baseUrl` originated. A `baseUrl` that arrived via an untrusted vector
 * (prompt injection writing `chrome.storage.local`, a malicious settings-sync
 * payload, or a crafted tool call) and happens to equal `http://localhost:11434`
 * will be ALLOWED by the transport guard, reaching the user's local Ollama /
 * LiteLLM server. This is the price of letting users run their own local LLM
 * without a separate allow-list UI. A fully closed fix would require threading a
 * provenance flag (user-configured-vs-injected) from the config UI through to
 * the fetch and only exempting the user-configured path — out of scope for this
 * guard, but tracked as a known risk.
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
 * IPv4-literal SSRF classification. Blocks ONLY the genuine SSRF sinks:
 *   0.0.0.0/8 (unspecified / "this" network),
 *   169.254.0.0/16 (link-local / cloud metadata, e.g. AWS/GCP/Azure IMDS @ 169.254.169.254),
 *   100.64.0.0/10 (CGNAT / shared address space).
 * Self-hosted model infra is explicitly ALLOWED:
 *   loopback `127.0.0.0/8`, and RFC1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
 * A user's Ollama / LiteLLM / LM-Studio server commonly runs on `127.0.0.1` or a LAN
 * private IP — that is the user's own host, not an SSRF target.
 * Returns false for non-IPv4-literal hosts (caller treats them as hostnames).
 */
function isDangerousIpv4(host: string): boolean {
  const o = parseIPv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return true;                              // 0.0.0.0/8 unspecified
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 CGNAT
  return false;                                          // loopback 127/8 + RFC1918 10/8,172.16/12,192.168/16 ALLOWED
}

/**
 * IPv6-literal SSRF classification. Handles the `::ffff:<ipv4>` mapped form
 * (delegates to the IPv4 check) and pure IPv6 (expanded to 8 groups):
 *   - `::` unspecified (all-zeros) — BLOCKED,
 *   - `fe80::/10` link-local — BLOCKED (IPv6 cloud-metadata / IMDS equivalent),
 *   - `::1` loopback — ALLOWED (self-hosted model server),
 *   - `fc00::/7` unique local addresses (ULA) — ALLOWED (IPv6 RFC1918-equiv),
 *   - `::ffff:<dangerous-ipv4>` mapped / NAT64 / IPv4-compatible — BLOCKED when
 *     the embedded IPv4 is in a dangerous range.
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
  // Unspecified :: (equivalent to 0.0.0.0) — still a genuine SSRF sink.
  if (groups.every((g) => g === 0)) return true;
  // Loopback ::1 — IPv6 localhost — ALLOWED (self-hosted model server). Must be
  // checked BEFORE the deprecated IPv4-compatible block below, which would
  // otherwise expand ::1 to embedded 0.0.0.1 (unspecified) and wrongly reject it.
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return false;
  // ULA fc00::/7 is ALLOWED (IPv6 equivalent of RFC1918 private ranges).
  // Link-local fe80::/10 — IPv6 cloud-metadata / IMDS equivalent — BLOCKED.
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // NAT64 (RFC 6052) `64:ff9b::/96` — first 96 bits are the well-known
  // prefix, the last 32 bits embed an IPv4 address that the NAT64 gateway
  // translates. On NAT64-enabled networks `64:ff9b::169.254.169.254` reaches
  // the cloud metadata service and `64:ff9b::127.0.0.1` reaches loopback.
  if (groups[0] === 0x64ff && groups[1] === 0x9b &&
      groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  // Deprecated IPv4-compatible `::a.b.c.d` — all-zero prefix with the IPv4 in
  // the last 32 bits. (Skip `::` / `::1`, which the unspecified/loopback
  // checks above already returned true for.)
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  return false;
}

/**
 * Expand an IPv6 literal into 8 unsigned-16-bit groups, handling `::`
 * compression. Returns null if the string is not a valid IPv6 literal (e.g.
 * contains characters other than hex digits and colons, or has the wrong group
 * count). Embedded IPv4 (handled separately above) is expected to be absent
 * here, so any "." in the string makes it invalid for this pure-IPv6 path.
 */
/**
 * Render the last two 16-bit IPv6 groups as a dotted-quad IPv4 string
 * (e.g. `0xa9fe`, `0xa9fe` → "169.254.169.254"), or return null if either
 * group is out of the 16-bit range.
 */
function groupsToIpv4(g6: number, g7: number): string | null {
  if (g6 < 0 || g6 > 0xffff || g7 < 0 || g7 > 0xffff) return null;
  return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
}

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
 *   - link-local `169.254.0.0/16` (cloud metadata / IMDS) and IPv6 `fe80::/10`,
 *   - unspecified `0.0.0.0/8` and IPv6 `::` (all-zeros),
 *   - CGNAT `100.64.0.0/10`,
 *   - the `::ffff:<dangerous-ipv4>` mapped / NAT64 / IPv4-compatible forms when the
 *     embedded IPv4 is dangerous.
 *
 * ALLOWED (self-hosted model infrastructure — the user's own host, not an SSRF
 * target):
 *   - `localhost` and `*.localhost` hostnames,
 *   - loopback `127.0.0.0/8` and IPv6 `::1`,
 *   - RFC1918 private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
 *   - IPv6 ULA `fc00::/7`,
 *   - public hostname-based URLs (`api.openai.com`, etc.) — parsed, never DNS-resolved.
 *
 * Curated local-provider loopback endpoints are additionally covered by the
 * integration-layer {@link isAllowedLlmBaseUrl} exemption for defense-in-depth.
 */
/**
 * Validate an LLM `baseUrl` AND the IP it actually resolves to (DNS).
 *
 * `validateLlmBaseUrl` only inspects the parsed HOST — for a hostname that
 * DNS-resolves to an internal IP (cloud metadata, RFC1918, loopback) it
 * returns `ok:true`, which is the exact SSRF exfil path this module was
 * written to stop (see module docs). This async variant additionally resolves
 * the hostname (when a DNS API is available) and rejects resolutions into the
 * blocked ranges.
 *
 * When no DNS resolver is available in the current runtime (e.g. an
 * environment without `chrome.dns` or a Node context), it degrades to the
 * synchronous {@link validateLlmBaseUrl} check so callers can always `await`
 * it without special-casing. Wire this into `buildProvider` / the transport
 * layer for untrusted `baseUrl` values.
 *
 * @param allowLocalExemption When true, curated local-provider loopback URLs
 *   (Ollama / LiteLLM) are exempted exactly like {@link isAllowedLlmBaseUrl}.
 *   Pass `false` for a `baseUrl` whose provenance is NOT user-configured
 *   (e.g. injected via prompt injection / settings-sync) so the exemption can
 *   never be abused to reach a local model from an untrusted origin.
 */
export async function resolveAndValidateLlmBaseUrl(
  url: string,
  allowLocalExemption = true,
): Promise<SsrfCheckResult> {
  const base = validateLlmBaseUrl(url);
  if (!base.ok) return base;

  // Apply the curated-local exemption (used only for user-configured URLs).
  if (allowLocalExemption && isAllowedLlmBaseUrl(url)) return { ok: true };

  let host = baseUrlHost(url);
  if (!host) return { ok: false, reason: `missing host in URL: ${url}` };
  host = host.replace(/^\[|\]$/g, "");

  // IP-literal hosts are already classified by validateLlmBaseUrl above; only
  // hostname-based hosts need DNS resolution to catch poisoned-hostname SSRF.
  if (!isLikelyHostname(host)) return { ok: true };

  const resolved = await dnsResolve(host);
  if (resolved === null) {
    // No resolver available (or resolution failed) — fail open to the
    // synchronous result rather than risking a false "blocked" that would
    // break legitimate public hostnames. The transport layer still re-checks
    // the literal URL, and the DNS caveat is documented in the module header.
    return { ok: true };
  }
  for (const ip of resolved) {
    const blocked = isPrivateOrLoopbackIp(ip);
    if (blocked) {
      return {
        ok: false,
        reason: `host ${host} resolves to a private/loopback/link-local address (${ip}): ${url}`,
      };
    }
  }
  return { ok: true };
}

/** Extract just the hostname from a URL (no brackets, no port). */
function baseUrlHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** True for a DNS hostname (contains a dot or is not a pure IP literal). */
function isLikelyHostname(host: string): boolean {
  if (host.includes(":")) return false; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  return true;
}

/**
 * Resolve a hostname to its IP addresses using whatever DNS API is available.
 * Returns null when no resolver exists in this runtime (so callers degrade
 * gracefully to the synchronous check).
 */
async function dnsResolve(hostname: string): Promise<string[] | null> {
  // Chrome extension service worker: chrome.dns.resolve.
  const dnsResolveFn = (globalThis as { chrome?: { dns?: { resolve?: (h: string, cb: (r: { addresses?: string[] }) => void) => void } } }).chrome?.dns?.resolve;
  if (dnsResolveFn) {
    return await new Promise<string[] | null>((resolve) => {
      try {
        dnsResolveFn(hostname, (result) => resolve(result?.addresses ?? null));
      } catch {
        resolve(null);
      }
    });
  }
  // Node.js context (mini-services / tests): dns.promises.lookup with ALL.
  const nodeDns = (globalThis as { require?: (m: string) => unknown }).require;
  if (nodeDns) {
    try {
      const dnsMod = nodeDns("dns") as { promises?: { lookup?: (h: string, opts: unknown) => Promise<{ address: string } | { address: string }[]> } };
      const lookup = dnsMod?.promises?.lookup;
      if (lookup) {
        const r = await lookup(hostname, { all: true });
        const arr = Array.isArray(r) ? r : [r];
        return arr.map((x) => x.address);
      }
    } catch {
      return null;
    }
  }
  return null;
}

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
export function isAllowedLlmBaseUrl(url: string, allowLocalExemption = true): boolean {
  const res = validateLlmBaseUrl(url);
  if (res.ok) return true;
  if (!allowLocalExemption) {
    // A `baseUrl` whose provenance is NOT user-configured (e.g. injected via
    // prompt injection / malicious settings-sync) must NEVER be exempted from
    // the strict check — otherwise an injected `http://localhost:11434` would
    // reach the user's local Ollama / LiteLLM server. Reject it.
    return false;
  }
  // Match on the parsed *origin* (scheme://host:port) rather than a raw
  // substring `startsWith`. A curated entry's host:port pair is the only thing
  // we exempt, so comparing origins is boundary-aware: it rejects malformed
  // over-matches like `http://localhost:11434.attacker.com:9999/` (which fails
  // `new URL` parsing entirely) and never matches a curated origin as a prefix
  // of an unrelated host.
  try {
    const targetOrigin = new URL(url).origin;
    if (
      LOCAL_PROVIDER_BASE_URLS.some(
        (curated) => new URL(curated).origin === targetOrigin,
      )
    ) {
      return true;
    }
  } catch {
    // Invalid URL → not a curated local provider; leave it rejected.
  }
  return false;
}
