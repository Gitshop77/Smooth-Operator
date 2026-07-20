/**
 * SSRF guard for LLM `baseUrl` values.
 *
 * The Chrome extension's service worker fetches the user's configured LLM
 * endpoint directly (no localhost backend). If a `baseUrl` is attacker-controlled
 * — e.g. via prompt injection that writes `chrome.storage.local`, a malicious
 * settings sync, or a crafted custom-tool payload — the service worker could be
 * made to reach:
 * - cloud metadata services (`http://169.254.169.254/` — AWS/GCP/Azure), which
 * live in link-local `169.254.0.0/16` (and IPv6 `fe80:/10`).
 *
 * Self-hosted model servers (Ollama, LiteLLM, LM Studio, …) legitimately run on
 * loopback (`127.0.0.0/8`, `:1`) or a LAN RFC1918 address
 * (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, IPv6 ULA `fc00:/7`). The
 * user's own infrastructure is NOT an SSRF target, so those ranges are ALLOWED.
 * Only the genuine SSRF sinks remain blocked: cloud-metadata / link-local
 * `169.254.0.0/16` (+ IPv6 `fe80:/10`), unspecified `0.0.0.0/8`, and
 * CGNAT `100.64.0.0/10`.
 *
 * This module provides a synchronous, DNS-free validator that rejects the
 * dangerous address ranges. It is wired into:
 * 1. `src/extension/provider-config.ts` — user-supplied `baseUrl`,
 * 2. `src/lib/agent/llm/providers/openai-compatible-profile.ts` — user-supplied
 * `baseURL` when synthesizing a profile,
 * 3. `src/lib/agent/llm/route/transport-http.ts` — defense-in-depth, on the
 * final fetch URL.
 *
 * So a bad URL fails closed (throws) rather than silently contacting the host.
 *
 * DESIGN NOTE — curated local providers: Ollama (`http://localhost:11434`) and
 * LiteLLM (`http://localhost:4000`) are legitimate, user-selected local LLM
 * servers whose default base URLs ARE loopback. The SSRF guard
 * (`validateLlmBaseUrl`) ALLOWS loopback (`127.0.0.0/8`, `:1`) and RFC1918
 * private ranges (`10/8`, `172.16/12`, `192.168/16`, IPv6 ULA `fc00:/7`) because
 * the user's own Ollama / LiteLLM server is the user's host, not an SSRF target.
 * It STILL blocks the genuine sinks: cloud-metadata / link-local `169.254.0.0/16`
 * (+ IPv6 `fe80:/10`), unspecified `0.0.0.0/8`, and CGNAT `100.64.0.0/10`.
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
 * Origin provenance of an LLM `baseUrl`. Threaded through the SSRF validators so
 * the curated-local (loopback) exemption is granted ONLY for a `baseUrl` the
 * USER configured — never for one that arrived via an untrusted vector (prompt
 * injection writing `chrome.storage.local`, a malicious settings-sync payload, a
 * crafted tool call). When `provenance` is supplied it is AUTHORITATIVE over the
 * `allowLocalExemption` boolean; when absent the boolean keeps its historical
 * default (true) so existing callers stay behavior-compatible.
 */
export type SsrfProvenance = "user-configured" | "untrusted";

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

/** Origins of the curated local providers (Ollama / LiteLLM), precomputed once. */
const CURATED_LOCAL_ORIGINS: ReadonlySet<string> = new Set(
  LOCAL_PROVIDER_BASE_URLS.flatMap((u) => {
    try {
      return [new URL(u).origin];
    } catch {
      return [];
    }
  }),
);

/** True iff `url`'s origin exactly matches a curated local-provider endpoint. */
export function isCuratedLocalOrigin(url: string): boolean {
  try {
    return CURATED_LOCAL_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

// ─── IP-literal classification ───────────────────────────────────────────────

/**
 * Returns true if `host` (a URL hostname: no port, no brackets) is an IP
 * literal in a DANGEROUS SSRF-sink range — unspecified `0.0.0.0/8`,
 * link-local `169.254.0.0/16` (cloud metadata / IMDS), or CGNAT
 * `100.64.0.0/10` (and their IPv6 equivalents). Loopback `127.0.0.0/8`,
 * RFC1918 private ranges, and IPv6 ULA return false here — those are the
 * user's own self-hosted model infra and are ALLOWED by the caller.
 * Hostname-based URLs (e.g. `api.openai.com`) are NOT IP literals, so they
 * return false here and are allowed by the caller (no DNS resolution).
 */
function isDangerousSinkIp(host: string): boolean {
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
 * 0.0.0.0/8 (unspecified / "this" network),
 * 169.254.0.0/16 (link-local / cloud metadata, e.g. AWS/GCP/Azure IMDS @ 169.254.169.254),
 * 100.64.0.0/10 (CGNAT / shared address space).
 * Self-hosted model infra is explicitly ALLOWED:
 * loopback `127.0.0.0/8`, and RFC1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
 * A user's Ollama / LiteLLM / LM-Studio server commonly runs on `127.0.0.1` or a LAN
 * private IP — that is the user's own host, not an SSRF target.
 * Returns false for non-IPv4-literal hosts (caller treats them as hostnames).
 */
/** True iff `(a, b)` octets are in a genuine SSRF-sink IPv4 range. */
function isSsrfSinkIpv4(a: number, b: number): boolean {
  if (a === 0) return true;                              // 0.0.0.0/8 unspecified
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 CGNAT
  return false;
}

/** True iff `(a, b)` octets are in an RFC1918 private IPv4 range. */
function isRfc1918Ipv4(a: number, b: number): boolean {
  if (a === 10) return true;                             // RFC1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;      // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true;               // RFC1918 192.168.0.0/16
  return false;
}

function isDangerousIpv4(host: string): boolean {
  const o = parseIPv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  return isSsrfSinkIpv4(a, b);                           // loopback 127/8 + RFC1918 ALLOWED
}

/**
 * True if `host` is a hostname that always refers to the local machine
 * (`localhost` / `*.localhost`). Used by the strict provenance check so a
 * non-user-configured `baseUrl` cannot reach a local model server by name.
 */
function isLocalHostname(host: string): boolean {
  // Strip a trailing dot so a `localhost.` FQDN cannot bypass the strict
  // provenance gate (which only allows a user-configured `localhost`).
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

/**
 * True if `host` is an IP literal in a user-local range that the DEFAULT policy
 * ALLOWS (loopback `127.0.0.0/8` & `:1`, RFC1918 `10/8`·`172.16/12`·`192.168/16`,
 * IPv6 ULA `fc00:/7`). The strict provenance check ({@link validateLlmBaseUrl}
 * with `allowLocalExemption=false`) additionally rejects these so an injected
 * `baseUrl` can never reach the user's own local model server.
 */
function isUserLocalIp(host: string): boolean {
  if (!host) return false;
  if (host.includes(":")) return isLocalIpv6(host);
  return isLocalIpv4(host);
}

function isLocalIpv4(host: string): boolean {
  const o = parseIPv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 127) return true;                         // loopback 127.0.0.0/8
  return isRfc1918Ipv4(a, b);
}

function isLocalIpv6(host: string): boolean {
  const emb = parseMappedIpv4(host);
  if (emb !== null) return isLocalIpv4(emb);
  const groups = expandIPv6(host);
  if (!groups) return false;
 // ::ffff:0:0/96 three-group mapped form — the last 32 bits are a native
 // IPv4 address the stack reaches directly. The WHATWG URL parser
 // canonicalizes `::ffff:0:<ipv4>` to this three-group form, which the
 // 2-group parseMappedIpv4 above misses, so decompose it like
 // isDangerousIpv6 and delegate the embedded IPv4 to isLocalIpv4.
  if (groups[4] === 0xffff && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
 // NAT64 (RFC 6052) 64:ff9b::/96 — the last 32 bits embed an IPv4 address
 // (e.g. 64:ff9b:192.168.1.1 reaches an RFC1918 host on NAT64 networks).
  if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
      groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
 // Teredo (RFC 4380) 2001::/32 — the last 32 bits embed an IPv4 address.
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
 // 6to4 (RFC 3056) 2002::/16 — groups[1]:groups[2] embed an IPv4 address.
  if (groups[0] === 0x2002) {
    const embedded = groupsToIpv4(groups[1], groups[2]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
 // Deprecated IPv4-compatible ::a.b.c.d — all-zero prefix with the IPv4 in
 // the last 32 bits (skip :: and :1, caught by loopback below).
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isLocalIpv4(embedded)) return true;
  }
 //  1 loopback.
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return true;
 // ULA fc00:/7 (matches fc00:/8 and fd00:/8).
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  return false;
}

/**
 * IPv6-literal SSRF classification. Handles the `:ffff:<ipv4>` mapped form
 * (delegates to the IPv4 check) and pure IPv6 (expanded to 8 groups):
 * - `:` unspecified (all-zeros) — BLOCKED,
 * - `fe80:/10` link-local — BLOCKED (IPv6 cloud-metadata / IMDS equivalent),
 * - `:1` loopback — ALLOWED (self-hosted model server),
 * - `fc00:/7` unique local addresses (ULA) — ALLOWED (IPv6 RFC1918-equiv),
 * - `:ffff:<dangerous-ipv4>` mapped / NAT64 / IPv4-compatible — BLOCKED when
 * the embedded IPv4 is in a dangerous range.
 * Returns false for non-IPv6-literal hosts.
 */
function isDangerousIpv6(host: string): boolean {
 // IPv4-mapped IPv6. The URL parser canonicalizes `:ffff:127.0.0.1` into the
 // hex form `:ffff:7f00:1` (the IPv4 packed into the last two 16-bit groups),
 // so handle both the dotted and canonical-hex representations.
  const emb = parseMappedIpv4(host);
  if (emb !== null) return isDangerousIpv4(emb);
  const groups = expandIPv6(host);
  if (!groups) return false; // not a valid IPv6 literal → treat as hostname
 // IPv4-mapped /96 prefix (::ffff:0:0/96): the last 32 bits are a native IPv4
 // address the stack reaches directly. The WHATWG URL parser canonicalizes
 // `::ffff:0:<ipv4>` to the three-group form `::ffff:0:WWXX:YYZZ`, which the
 // 2-group parseMappedIpv4 above misses, so detect it here and block when the
 // embedded IPv4 is dangerous (e.g. 169.254.169.254 cloud metadata).
  if (groups[4] === 0xffff && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
 // Unspecified : (equivalent to 0.0.0.0) — still a genuine SSRF sink.
  if (groups.every((g) => g === 0)) return true;
 // Loopback :1 — IPv6 localhost — ALLOWED (self-hosted model server). Must be
 // checked BEFORE the deprecated IPv4-compatible block below, which would
 // otherwise expand :1 to embedded 0.0.0.1 (unspecified) and wrongly reject it.
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return false;
 // ULA fc00:/7 is ALLOWED (IPv6 equivalent of RFC1918 private ranges).
 // Link-local fe80:/10 — IPv6 cloud-metadata / IMDS equivalent — BLOCKED.
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
 // NAT64 (RFC 6052) `64:ff9b:/96` — first 96 bits are the well-known
 // prefix, the last 32 bits embed an IPv4 address that the NAT64 gateway
 // translates. On NAT64-enabled networks `64:ff9b:169.254.169.254` reaches
 // the cloud metadata service and `64:ff9b:127.0.0.1` reaches loopback.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
      groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  // Teredo (RFC 4380) 2001::/32 — the last 32 bits embed an IPv4 address (the
  // Teredo client endpoint). 2001::a9fe:a9fe encodes 169.254.169.254 (link-local
  // cloud-metadata), so block it like the other embedded forms. Pin both leading
  // groups: 2001::/32 means groups[0]===0x2001 AND groups[1]===0x0000; matching
  // only the /16 over-blocks legitimate global-unicast 2001:xxxx:: addresses.
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  // 6to4 (RFC 3056) 2002::/16 — groups[1]:groups[2] embed an IPv4 address.
  // 2002:a9fe:a9fe:: encodes 169.254.169.254 and must be blocked.
  if (groups[0] === 0x2002) {
    const embedded = groupsToIpv4(groups[1], groups[2]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
 // Deprecated IPv4-compatible `:a.b.c.d` — all-zero prefix with the IPv4 in
 // the last 32 bits. (Skip `:` / `:1`, which the unspecified/loopback
 // checks above already returned true for.)
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isDangerousIpv4(embedded)) return true;
  }
  return false;
}

/**
 * Expand an IPv6 literal into 8 unsigned-16-bit groups, handling `:`
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

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 literal
 * (`::ffff:<ipv4>` in either dotted or canonical-hex form). Returns the
 * dotted-quad IPv4 string, or `null` when the host is not a mapped form.
 * Shared by the three IPv6 classifiers so the decomposition isn't duplicated.
 */
function parseMappedIpv4(host: string): string | null {
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const g5 = parseInt(mappedHex[1], 16);
    const g6 = parseInt(mappedHex[2], 16);
    return `${(g5 >> 8) & 0xff}.${g5 & 0xff}.${(g6 >> 8) & 0xff}.${g6 & 0xff}`;
  }
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mappedDotted) return mappedDotted[1];
  return null;
}

function expandIPv6(host: string): number[] | null {
  // Drop an IPv6 zone-id (`fe80::1%eth0`); the `%` and what follows are not part
  // of the address and would otherwise make the literal unparseable.
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) host = host.slice(0, zoneIdx);
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
 * explaining the rejection for blocked URLs.
 *
 * Blocks:
 * - non-`http`/`https` schemes (`file:`, `ftp:`, `javascript:`, …),
 * - link-local `169.254.0.0/16` (cloud metadata / IMDS) and IPv6 `fe80:/10`,
 * - unspecified `0.0.0.0/8` and IPv6 `:` (all-zeros),
 * - CGNAT `100.64.0.0/10`,
 * - the `:ffff:<dangerous-ipv4>` mapped / NAT64 / IPv4-compatible forms when the
 * embedded IPv4 is dangerous.
 *
 * ALLOWED (self-hosted model infrastructure — the user's own host, not an SSRF
 * target):
 * - `localhost` and `*.localhost` hostnames,
 * - loopback `127.0.0.0/8` and IPv6 `:1`,
 * - RFC1918 private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
 * - IPv6 ULA `fc00:/7`,
 * - public hostname-based URLs (`api.openai.com`, etc.) — parsed, never DNS-resolved.
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
 * (Ollama / LiteLLM) are exempted exactly like {@link isAllowedLlmBaseUrl}.
 * Pass `false` for a `baseUrl` whose provenance is NOT user-configured
 * (e.g. injected via prompt injection / settings-sync) so the exemption can
 * never be abused to reach a local model from an untrusted origin.
 */
export async function resolveAndValidateLlmBaseUrl(
  url: string,
  allowLocalExemption = false,
  provenance?: SsrfProvenance,
): Promise<SsrfCheckResult> {
 // `provenance` is authoritative when present; otherwise the historical
 // `allowLocalExemption` boolean is used.
  const exempt = provenance === "untrusted"
    ? false
    : provenance === "user-configured"
      ? true
      : allowLocalExemption;
  const base = validateLlmBaseUrl(url, exempt, provenance);
  if (!base.ok) return base;

 // Fast-path ONLY the curated local-provider origins we already trust
 // (Ollama / LiteLLM loopback). Every other URL — including public hostnames —
 // proceeds to DNS resolution below so a hostname that rebinds to a
 // cloud-metadata / link-local / CGNAT address at fetch time is rejected. The
 // previous short-circuit (`isAllowedLlmBaseUrl(url)`) returned early for ALL
 // public hostnames, which skipped DNS entirely; narrowing it to the
 // curated-local origins forces DNS validation for every other host.
 //
 // RESIDUAL RISK (DNS-rebinding TOCTOU): this validation resolves DNS
 // independently of the subsequent `fetch`, which does its OWN lookup. An
 // attacker controlling DNS (fast-flux) can answer with a safe IP here and an
 // SSRF-sink IP at connect time, so this NARROWS but does not fully CLOSE the
 // rebinding window. In a Node/mini-service runtime the address can be pinned
 // via a fixed-lookup undici Dispatcher so `fetch` reuses the validated IP; in
 // the extension service worker `fetch` cannot be pinned, so the per-fetch
 // re-validation in transport-http.ts is defense-in-depth only, not a guarantee.
  if (exempt && isCuratedLocalOrigin(url)) return { ok: true };

  let host = baseUrlHost(url);
  if (!host) return { ok: false, reason: `missing host in URL: ${redactUrl(url)}` };
  host = host.replace(/^\[|\]$/g, "");

 // IP-literal hosts are already classified by validateLlmBaseUrl above; only
 // hostname-based hosts need DNS resolution to catch poisoned-hostname SSRF.
  if (!isLikelyHostname(host)) return { ok: true };

  const outcome = await dnsResolve(host);
  if (outcome.kind === "unavailable") {
 // No DNS resolver exists in this runtime (e.g. a Node context without the
 // `dns` module). FAIL CLOSED unconditionally, regardless of `exempt`: without
 // a resolver we cannot verify the real target IP, so a hostname that resolves
 // to a cloud-metadata / internal address would be a live SSRF exfil path. The
 // curated local-provider origins (Ollama / LiteLLM loopback) already
 // short-circuit earlier (see `isCuratedLocalOrigin` above) and are unaffected
 // by this change — only outside a Chrome extension service worker (which
 // always has `chrome.dns.resolve`) is this path reachable, and there refusing
 // is the safe default. The transport-layer guard still re-checks the literal
 // URL.
    console.warn(
      `[ssrf] dnsResolve unavailable — refusing ${redactUrl(url)} (fail-closed SSRF ` +
        `guard). Without a resolver we cannot verify the real target IP; a ` +
        `hostname that resolves to a cloud-metadata / internal address would be a ` +
        `live SSRF exfil path.`,
    );
    return {
      ok: false,
      reason: `DNS resolver unavailable; refusing ${redactUrl(url)} (fail-closed SSRF guard).`,
    };
  }
  if (outcome.kind === "error") {
 // A resolver was available but the lookup FAILED. FAIL CLOSED unconditionally,
 // regardless of `exempt` — without a verified target IP we must not risk
 // reaching an internal / metadata host on an unverifiable URL. The curated
 // local-provider origins short-circuit earlier and are unaffected. The
 // transport-layer guard still re-checks the literal URL.
    console.warn(
      `[ssrf] dnsResolve errored for ${redactUrl(url)} — refusing (fail-closed SSRF ` +
        `guard). Verify the transport-layer guard still blocks unauthorized targets.`,
    );
    return {
      ok: false,
      reason: `DNS resolution for ${host} failed; refusing ${redactUrl(url)} (fail-closed SSRF guard).`,
    };
  }
  for (const ip of outcome.ips) {
    const alwaysBlocked = ip.includes(":") ? isDangerousIpv6(ip) : isDangerousIpv4(ip);
    const localUntrusted = !exempt && isUserLocalIp(ip);
    if (alwaysBlocked || localUntrusted) {
      return {
        ok: false,
        reason: `host ${host} resolves to a private/loopback/link-local address (${ip}): ${redactUrl(url)}`,
      };
    }
  }
  return { ok: true };
}

/** Extract just the hostname from a URL (no brackets, no port). */
function baseUrlHost(url: string): string {
  const parsed = parseBaseUrl(url);
  return parsed ? parsed.hostname : "";
}

/** True for a DNS hostname (contains a dot or is not a pure IP literal). */
function isLikelyHostname(host: string): boolean {
  if (host.includes(":")) return false; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  return true;
}

/**
 * Resolution outcome, distinguishing the three cases a DNS lookup can hit:
 * - `resolved` : a resolver answered (possibly with an empty IP list).
 * - `error` : a resolver existed but the lookup threw / returned an error
 * (fail CLOSED on this — see the caller).
 * - `unavailable`: no DNS resolver API exists in this runtime at all (degrade
 * to fail-open with a warning — only reachable outside a
 * Chrome extension SW, which always has `chrome.dns`).
 */
type DnsOutcome =
  | { kind: "resolved"; ips: string[] }
  | { kind: "error" }
  | { kind: "unavailable" };

/**
 * Resolve a hostname to its IP addresses using whatever DNS API is available.
 * Never returns null — it distinguishes "no resolver" from "resolver error"
 * so the caller can FAIL CLOSED on a genuine lookup failure while still
 * degrading (with a warning) when no resolver exists at all.
 */
async function dnsResolve(hostname: string): Promise<DnsOutcome> {
 // Chrome extension service worker: chrome.dns.resolve.
  const dnsResolveFn = (globalThis as { chrome?: { dns?: { resolve?: (h: string, cb: (r: { addresses?: string[] }) => void) => void } } }).chrome?.dns?.resolve;
  if (dnsResolveFn) {
    return await new Promise<DnsOutcome>((resolve) => {
      try {
        dnsResolveFn(hostname, (result) => {
          if (chrome.runtime.lastError) {
            resolve({ kind: "error" });
            return;
          }
          resolve({ kind: "resolved", ips: result?.addresses ?? [] });
        });
      } catch {
        resolve({ kind: "error" });
      }
    });
  }
 // Node.js context (mini-services / tests): resolve via dynamic import so DNS
 // resolution works in ESM runtimes. `globalThis.require` is undefined in ESM,
 // which previously made the require-based branch unreachable and force-failed
 // every hostname URL — switching to `import("node:dns/promises")` restores
 // real resolution while still failing closed (error) on any lookup failure.
  try {
    const dns = await import("node:dns/promises");
    const r = await dns.lookup(hostname, { all: true });
    const arr = Array.isArray(r) ? r : [r];
    return { kind: "resolved", ips: arr.map((x) => x.address) };
  } catch {
    return { kind: "error" };
  }
}

/**
 * @param allowLocalExemption When `true` (default — preserves the historical
 * policy for user-configured URLs), loopback / RFC1918 / ULA and `localhost`
 * are ALLOWED (self-hosted model infra). When `false` (provenance is NOT
 * user-configured), those user-local endpoints are additionally REJECTED so an
 * injected `baseUrl` can never reach the user's own local model server.
 */
/**
 * Parse a `baseUrl` into a {@link URL}, repairing a common IPv6-literal typo
 * where `::` was written as a single `:` inside the brackets
 * (e.g. `[:1]` → `[::1]`, `[fc00:1]` → `[fc00::1]`,
 * `[:ffff:127.0.0.1]` → `[::ffff:127.0.0.1]`). The repair runs ONLY when the
 * original string is not a valid URL, so legitimate URLs are never altered and
 * the SSRF classification below still applies in full. Returns null for any URL
 * that cannot be parsed even after the repair attempt.
 */
/**
 * Redact credentials and trailing query/fragment from a URL string before it
 * is embedded into a `reason`/`Error` message or log line. Mirrors the
 * `redactUrl`/`redactUrlForLog` helpers used elsewhere in the LLM transport so
 * the SSRF layer consistently avoids leaking an embedded `user:pass@` (or
 * `?#`-borne secrets) into error output.
 */
function redactUrl(u: string): string {
  return u.replace(/\/\/[^@/]*@/, "//").replace(/[?#].*$/, "");
}

function parseBaseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    const m = /^([^[\]]*)\[([^\]]+)\](.*)$/.exec(url);
    if (m) {
      const repairedHost = m[2].replace(/:(?!:)/, "::");
      try {
        return new URL(`${m[1]}[${repairedHost}]${m[3]}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function validateLlmBaseUrl(
  url: string,
  allowLocalExemption = true,
  provenance?: SsrfProvenance,
): SsrfCheckResult {
 // `provenance` is authoritative when present: an untrusted `baseUrl` (e.g.
 // injected) may NEVER use the curated-local loopback exemption, while a
 // user-configured one may. When absent we preserve the historical
 // `allowLocalExemption` default (true).
  const exempt = provenance === "untrusted"
    ? false
    : provenance === "user-configured"
      ? true
      : allowLocalExemption;
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "baseUrl must be a non-empty string" };
  }
  const parsed = parseBaseUrl(url);
  if (!parsed) {
    return { ok: false, reason: `invalid URL: ${redactUrl(url)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `scheme "${parsed.protocol}" is not allowed (only http/https): ${redactUrl(url)}`,
    };
  }
  const host = parsed.hostname;
  if (!host) {
    return { ok: false, reason: `missing host in URL: ${redactUrl(url)}` };
  }
 // URL.hostname already strips IPv6 brackets, but guard anyway.
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  if (isDangerousSinkIp(normalizedHost)) {
    return {
      ok: false,
      reason: `host resolves to a private/loopback/link-local address: ${normalizedHost}`,
    };
  }
 // Cloud-metadata / internal hostnames (e.g. `metadata.google.internal`, which
 // resolves to 169.254.169.254) are never legitimate LLM endpoints and are not
 // caught by the IP-literal checks above. Reject them unconditionally.
  if (normalizedHost.toLowerCase().replace(/\.$/, "").endsWith(".internal")) {
    return {
      ok: false,
      reason: `host is a cloud-metadata/internal endpoint not allowed: ${redactUrl(url)}`,
    };
  }
 // Provenance gate: when the baseUrl is NOT user-configured, also reject
 // user-local endpoints (localhost / loopback / RFC1918 / ULA) so an injected
 // baseUrl (prompt injection, malicious settings-sync, crafted tool call)
 // cannot reach the user's own local model server.
  if (
    !exempt &&
    (isLocalHostname(normalizedHost) || isUserLocalIp(normalizedHost))
  ) {
    return {
      ok: false,
      reason: `host "${normalizedHost}" is a local endpoint not allowed for a non-user-configured baseUrl: ${redactUrl(url)}`,
    };
  }
  return { ok: true };
}

/**
 * Validate a user-configured completion-webhook URL.
 *
 * A webhook is an external notification endpoint (Slack / Discord / custom)
 * that receives task text on completion. It must never point at an internal
 * host (exfiltration / SSRF), but it MAY be a loopback endpoint — e.g. a
 * self-hosted notification relay in dev (`http://localhost:8080/hook`) — so
 * loopback is permitted while the genuine sinks remain blocked:
 * - non-`http`/`https` schemes (`javascript:`/`data:`/`file:`/…),
 * - cloud-metadata / link-local `169.254.0.0/16` and IPv6 `fe80:/10`
 * (AWS/GCP/Azure IMDS),
 * - unspecified `0.0.0.0/8` / `:`,
 * - CGNAT `100.64.0.0/10`,
 * - RFC1918 private ranges `10/8`, `172.16/12`, `192.168/16` and IPv6 ULA
 * `fc00:/7` (a webhook should reach a real internet endpoint, not a LAN
 * host).
 * Public hostname URLs and loopback (`127.0.0.0/8`, `:1`, `localhost`) are
 * allowed.
 */
export function validateWebhookUrl(url: string): SsrfCheckResult {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "webhookUrl must be a non-empty string" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${redactUrl(url)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `scheme "${parsed.protocol}" is not allowed (only http/https): ${redactUrl(url)}`,
    };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    return { ok: false, reason: `missing host in URL: ${redactUrl(url)}` };
  }
  if (isBlockedWebhookHost(host)) {
    return {
      ok: false,
      reason: `host resolves to a private/metadata/link-local address: ${host}`,
    };
  }
  return { ok: true };
}

/**
 * Validate a webhook URL AND the IP it actually resolves to (DNS).
 *
 * `validateWebhookUrl` only inspects the parsed HOST — for a hostname that
 * DNS-resolves to an internal IP (cloud metadata, RFC1918, loopback) it returns
 * `ok:true`, which is a DNS-rebind SSRF exfil path: the webhook URL is settable
 * through the (untrusted) settings-sync vector and is POSTed with task text by
 * `task-queue.ts`. This async variant additionally resolves the hostname (when
 * a DNS API is available) and rejects resolutions into the blocked ranges
 * (cloud-metadata / link-local / unspecified / CGNAT / RFC1918 / IPv6 ULA).
 *
 * When no DNS resolver is available in the current runtime it degrades to the
 * synchronous `validateWebhookUrl` check (fail-open with a warning) so a
 * self-hosted relay webhook (e.g. `localhost`) keeps working where DNS
 * resolution is unavailable. When a resolver IS available but the lookup fails
 * (transient error / timeout) it FAILS CLOSED rather than risk reaching an
 * internal / metadata host. The literal-host checks in `validateWebhookUrl`
 * (incl. `isBlockedWebhookHost`) are never weakened.
 */
export async function resolveAndValidateWebhookUrl(
  url: string,
): Promise<SsrfCheckResult> {
  const base = validateWebhookUrl(url);
  if (!base.ok) return base;

  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return { ok: false, reason: `invalid URL: ${redactUrl(url)}` };
  }
  if (!host) return { ok: false, reason: `missing host in URL: ${redactUrl(url)}` };

  // IP-literal hosts are already classified by validateWebhookUrl above; only
  // hostname-based hosts need DNS resolution to catch poisoned-hostname SSRF.
  if (!isLikelyHostname(host)) return { ok: true };

  const outcome = await dnsResolve(host);
  if (outcome.kind === "unavailable") {
    // No DNS resolver exists in this runtime (e.g. a Node context without the
    // `dns` module). FAIL CLOSED: a webhook URL is settable through an
    // (untrusted) settings-sync vector and POSTed with task text by
    // task-queue.ts, so degrading to the synchronous check here is a genuine
    // exfil path — a public hostname that rebinds to an internal address at
    // fetch time would otherwise be reachable. In a Chrome extension service
    // worker `chrome.dns.resolve` IS available, so this path is effectively
    // unreachable in production; the literal-host guard (isBlockedWebhookHost)
    // still blocks .internal / .local / single-label hostnames.
    console.warn(
      `[ssrf] dnsResolve unavailable — refusing ${redactUrl(url)} webhook (fail-closed ` +
        `SSRF guard). A hostname that rebinds to an internal address would be a ` +
        `live exfil path.`,
    );
    return {
      ok: false,
      reason: `DNS resolver unavailable; refusing ${redactUrl(url)} webhook (fail-closed SSRF guard).`,
    };
  }
  if (outcome.kind === "error") {
    // A resolver was available but the lookup FAILED. FAIL CLOSED rather than
    // risk reaching an internal / metadata host on an unverifiable webhook URL.
    return {
      ok: false,
      reason: `DNS resolution for ${host} failed; refusing ${redactUrl(url)} (fail-closed SSRF guard).`,
    };
  }
  for (const ip of outcome.ips) {
    if (isBlockedWebhookHost(ip)) {
      return {
        ok: false,
        reason: `host ${host} resolves to a private/loopback/link-local address (${ip}): ${redactUrl(url)}`,
      };
    }
  }
  return { ok: true };
}

/** True if `host` is an IP literal (or hostname) that a webhook must NOT reach. */
function isBlockedWebhookHost(host: string): boolean {
 // Reject internal/metadata hostnames that the IP-range checks can't see:
 // cloud-metadata zones, mDNS/local zones, and single-label names (which can
 // resolve to unexpected local targets). `localhost` stays allowed per the
 // module doc (a self-hosted notification relay in dev).
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h.endsWith(".lan") ||
    h.endsWith(".home") ||
    (!h.includes(".") && !h.includes(":"))
  ) {
    return true;
  }
  if (h.includes(":")) return isBlockedWebhookIpv6(host);
  return isBlockedWebhookIpv4(host);
}

function isBlockedWebhookIpv4(host: string): boolean {
  const o = parseIPv4Octets(host);
  if (!o) return false; // not an IPv4 literal → hostname, allowed
  const [a, b] = o;
  return isSsrfSinkIpv4(a, b) || isRfc1918Ipv4(a, b);    // loopback 127/8 + public ALLOWED
}

function isBlockedWebhookIpv6(host: string): boolean {
  const emb = parseMappedIpv4(host);
  if (emb !== null) return isBlockedWebhookIpv4(emb);
  const groups = expandIPv6(host);
  if (!groups) return false; // not a valid IPv6 literal → hostname, allowed
 // IPv4-mapped /96 prefix (::ffff:0:0/96): the last 32 bits are a native IPv4
 // address reachable directly. The WHATWG URL parser canonicalizes
 // `::ffff:0:<ipv4>` to `::ffff:0:WWXX:YYZZ`, which parseMappedIpv4 misses,
 // so detect it here and block when the embedded IPv4 is dangerous.
  if (groups[4] === 0xffff && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  if (groups.every((g) => g === 0)) return true;          //  unspecified
  if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return false; //  1 loopback allowed
  if ((groups[0] & 0xffc0) === 0xfe80) return true;       // fe80:/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true;       // fc00:/7 ULA private
 // NAT64 (RFC 6052) / deprecated IPv4-compatible embedded dangerous IPv4.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
      groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  // Teredo (RFC 4380) 2001::/32 — the last 32 bits embed an IPv4 address (the
  // Teredo client endpoint). 2001::a9fe:a9fe encodes 169.254.169.254 (link-local
  // cloud-metadata), so block it like the other embedded forms. Pin both leading
  // groups: 2001::/32 means groups[0]===0x2001 AND groups[1]===0x0000; matching
  // only the /16 over-blocks legitimate global-unicast 2001:xxxx:: addresses.
  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    const embedded = groupsToIpv4(groups[6], groups[7]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  // 6to4 (RFC 3056) 2002::/16 — groups[1]:groups[2] embed an IPv4 address.
  // 2002:a9fe:a9fe:: encodes 169.254.169.254 and must be blocked.
  if (groups[0] === 0x2002) {
    const embedded = groupsToIpv4(groups[1], groups[2]);
    if (embedded && isBlockedWebhookIpv4(embedded)) return true;
  }
  return false;
}

/**
 * Same policy as {@link validateLlmBaseUrl} but WITH the narrow curated-local
 * provider exemption (Ollama / LiteLLM default loopback URLs). Use this at the
 * integration / transport layer so a user's own local LLM keeps working while
 * every other loopback / RFC1918 / metadata URL is still rejected.
 *
 * @returns true if the URL is safe to fetch (or is a curated local endpoint).
 */
export function isAllowedLlmBaseUrl(
  url: string,
  allowLocalExemption = true,
  provenance?: SsrfProvenance,
): boolean {
 // `provenance` is authoritative when present; otherwise the historical
 // `allowLocalExemption` boolean is used.
  const exempt = provenance === "untrusted"
    ? false
    : provenance === "user-configured"
      ? true
      : allowLocalExemption;
 // Strict base check (provenance=false): rejects the genuine SSRF sinks AND
 // every user-local endpoint (localhost / loopback / RFC1918 / ULA). This is
 // what makes the provenance gate real — the curated-list exemption below is
 // the ONLY path by which a local endpoint is ever re-allowed, and only for a
 // user-configured baseUrl.
  const res = validateLlmBaseUrl(url, false);
  if (res.ok) return true;
  if (!exempt) {
 // A `baseUrl` whose provenance is NOT user-configured (e.g. injected via
 // prompt injection / malicious settings-sync) must NEVER be exempted from
 // the strict check — otherwise an injected `http://localhost:11434` would
 // reach the user's local Ollama / LiteLLM server. Reject it.
    return false;
  }
 // User-configured: re-allow ONLY the curated local-provider origins. Match on
 // the parsed *origin* (scheme://host:port) rather than a raw substring
 // `startsWith`. A curated entry's host:port pair is the only thing we exempt,
 // so comparing origins is boundary-aware: it rejects malformed over-matches
 // like `http://localhost:11434.attacker.com:9999/` (which fails `new URL`
 // parsing entirely) and never matches a curated origin as a prefix of an
 // unrelated host.
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
 // Allow the deprecated IPv4-compatible form (`::a.b.c.d`, canonicalized by
 // the URL parser to the hex `::xxxx:xxxx`) ONLY when it embeds a loopback
 // IPv4 (self-hosted infra). Native IPv6 loopback (::1), ULA (fc00::/7) and
 // mapped forms stay rejected per the transport-layer parity contract (every
 // IPv6 variant is rejected so an IPv6 SSRF sink can't slip through to
 // `fetch`). Genuine sinks (cloud-metadata / link-local / CGNAT / unspecified)
 // are never reached here because `validateLlmBaseUrl` already rejected them
 // above.
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const groups = expandIPv6(host);
    if (groups && groups.slice(0, 6).every((g) => g === 0)) {
      const embedded = groupsToIpv4(groups[6], groups[7]);
      if (embedded && /^127\./.test(embedded)) return true;
    }
  } catch {
 // Invalid URL → leave it rejected.
  }
  return false;
}
