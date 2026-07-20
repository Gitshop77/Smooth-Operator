import type { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

/** App-authored, client-facing error.
 *
 * Throwing a `ClientError` is the ONLY way to get a message echoed verbatim to
 * the client; `withRouteError` echoes `ClientError.message` and uses
 * `ClientError.status`, and never falls back to substring sniffing of raw
 * (potentially internal) error text. Use it for expected validation/business
 * failures so the client gets an actionable, leak-free message. */
export class ClientError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
  }
}

/** Maximum request body size we will buffer (256 KiB).
 *
 * Every DB-write route funnels through `bodyJson`, which previously buffered the
 * entire body into memory with no cap — allowing any caller holding the
 * X-Cowork-Token to exhaust server memory. We now read the stream in bounded
 * chunks and reject oversize bodies with 413. */
const MAX_BODY_BYTES = 256 * 1024;

/** Hard ceiling on the number of stream chunks we will consume, independent of
 * the byte cap. Bounds the iteration count so a connection that yields an
 * unbounded number of (tiny) chunks cannot pin a worker via an infinite loop. */
const MAX_BODY_CHUNKS = 1 << 20;

/** Maximum number of consecutive/zero-length chunks before we abort. A
 * zero-length `Uint8Array` is a truthy object with `byteLength === 0`, so it
 * passes the `!value` guard, never advances `total`, and never hits the byte
 * cap — an endless stream of empty chunks would loop forever. Bound them. */
const MAX_BODY_EMPTY_CHUNKS = 1 << 16;

/** Wall-clock deadline for the whole body read. A slow trickle of bytes keeps
 * `await reader.read()` pending indefinitely, pinning a Next.js worker (slow
 * loris / pool exhaustion). The byte cap alone does not bound wall time. */
const MAX_BODY_READ_MS = 60_000;

async function readCappedBody(req: NextRequest): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let chunksRead = 0;
  let emptyReads = 0;
  const chunks: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClientError('request read timeout', 408)), MAX_BODY_READ_MS);
  });
  try {
    for (;;) {
      if (++chunksRead > MAX_BODY_CHUNKS) {
 // Release the underlying body reader so the request socket is not left
 // pinned open (resource hygiene under a flood of oversize requests).
        await reader.cancel().catch(() => {});
        throw new ClientError('request entity too large', 413);
      }
      let result: { done: boolean; value: Uint8Array | undefined };
      try {
        result = await Promise.race([reader.read(), timeout]);
      } catch (err) {
        // The wall-clock timeout won the race. Release the underlying body
        // reader so the slow-loris socket is not left pinned open after the
        // 408 — otherwise the reader keeps consuming (and the worker stays
        // tied up) for the life of the connection.
        await reader.cancel().catch(() => {});
        throw err;
      }
      const { done, value } = result;
      if (done) break;
 // A non-conformant stream can yield `value === undefined` with `done ===
 // false`; skip the empty chunk before accessing `value.byteLength`. A
 // zero-length `Uint8Array` also skips the byte cap, so count it toward a
 // ceiling to prevent a true infinite loop of empty chunks.
      if (!value || value.byteLength === 0) {
        if (++emptyReads > MAX_BODY_EMPTY_CHUNKS) {
 // Release the underlying body reader so an endless stream of empty chunks
 // does not leave the request socket pinned open.
          await reader.cancel().catch(() => {});
          throw new ClientError('request entity too large', 413);
        }
        continue;
      }
      emptyReads = 0;
 // Reject BEFORE the chunk is appended to `chunks` so a single oversized
 // chunk (or a cumulative overflow) can never be buffered into memory.
      if (total + value.byteLength > MAX_BODY_BYTES) {
 // Release the underlying body reader so the request socket/stream is not
 // left unconsumed (resource hygiene under a flood of oversize requests).
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new ClientError('request entity too large', 413);
      }
      total += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

/** Maximum size of an upstream (mini-service) response body we will buffer
 * (20 MiB). The inbound request is already capped by `bodyJson` (256KiB); this
 * bounds the OUTBOUND direction. A misbehaving/compromised internal
 * cowork-events service could otherwise return an arbitrarily large body and
 * exhaust cockpit worker memory before any redaction/parse runs. */
export const MAX_UPSTREAM_BYTES = 20 * 1024 * 1024;

/** See `readCappedBody` for the rationale. These bounds mirror the inbound caps
 * but apply to the OUTBOUND (upstream mini-service response) read path. */
const MAX_UPSTREAM_CHUNKS = 1 << 20;
const MAX_UPSTREAM_EMPTY_CHUNKS = 1 << 16;
const MAX_UPSTREAM_READ_MS = 120_000;

/** Read an upstream `Response` body as text, rejecting (via a `ClientError`,
 * mapped to 502 by `withRouteError`) any payload larger than `maxBytes`. The
 * body is streamed through a byte-counting reader so a single oversized chunk
 * (or cumulative overflow) can never be buffered into memory. Mirrors the
 * inbound `readCappedBody` cap but for responses we proxy from the
 * mini-service. */
export async function readCappedUpstream(
  res: Response,
  maxBytes: number = MAX_UPSTREAM_BYTES,
): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let chunksRead = 0;
  let emptyReads = 0;
  const chunks: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ClientError('upstream response read timeout', 504)), MAX_UPSTREAM_READ_MS);
  });
  try {
    for (;;) {
      if (++chunksRead > MAX_UPSTREAM_CHUNKS) {
 // Release the upstream reader so a slow/compromised mini-service cannot
 // pin the connection after a 502.
        await reader.cancel().catch(() => {});
        throw new ClientError('upstream response too large', 502);
      }
      let result: { done: boolean; value: Uint8Array | undefined };
      try {
        result = await Promise.race([reader.read(), timeout]);
      } catch (err) {
 // The wall-clock timeout won the race. Release the underlying upstream
 // reader so the connection is not left pinned open after the 504.
        await reader.cancel().catch(() => {});
        throw err;
      }
      const { done, value } = result;
      if (done) break;
      if (!value || value.byteLength === 0) {
        if (++emptyReads > MAX_UPSTREAM_EMPTY_CHUNKS) {
          await reader.cancel().catch(() => {});
          throw new ClientError('upstream response too large', 502);
        }
        continue;
      }
      emptyReads = 0;
      if (total + value.byteLength > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new ClientError('upstream response too large', 502);
      }
      total += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

/** Derive a non-secret, stable principal identifier from a token value for
 * audit logging. Returns a truncated SHA-256 hex digest so the raw secret is
 * never written to logs, while still letting operators attribute an action to
 * the token holder that triggered it (AU-3). Stable across calls for a given
 * token value. */
export function tokenPrincipal(token: string): string {
  const digest = createHash('sha256').update(token).digest('hex');
  return `tok_${digest.slice(0, 16)}`;
}

/** Parse JSON request body.
 *
 * Returns `{}` for an empty/absent body so routes that accept optional bodies
 * keep working, but THROWS (a `ClientError`, mapped to 400 by `withRouteError`)
 * on malformed (non-empty) JSON, so a malformed body can no longer silently
 * create a row with defaults. Bodies larger than `MAX_BODY_BYTES` are rejected
 * with 413 before they can exhaust memory. */
export async function bodyJson(req: NextRequest): Promise<Record<string, unknown>> {
  const text = await readCappedBody(req);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
 // A top-level array / string / number / null is not a JSON object, so a
 // route that does `body.field` would silently get `undefined`. Reject it
 // with a clean 400 (mapped via withRouteError) instead of letting a 500 or
 // a defaulted row slip through.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ClientError('Invalid JSON body', 400);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ClientError('Invalid JSON body', 400);
  }
}

/** Tolerant variant of `bodyJson` for routes whose body is OPTIONAL.
 *
 * Swallows malformed/empty JSON and returns `{}` so callers that merely enrich
 * an optional payload keep working, but re-throws `ClientError` (e.g. the 413
 * oversize rejection) so size limits are still enforced. Routes that REQUIRE a
 * body must use `bodyJson`, which throws on malformed JSON. */
export async function bodyJsonOptional(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    return await bodyJson(req);
  } catch (e) {
    if (e instanceof ClientError) throw e;
 // A non-`ClientError` (e.g. a read/abort error) is being swallowed into an
 // empty body. Log it so upload/body failures are observable server-side
 // rather than silently disappearing (defense-in-depth observability).
    console.error(
      '[cowork] bodyJsonOptional swallowed non-ClientError:',
      redactSecrets(e instanceof Error ? e.message : String(e)),
    );
    return {};
  }
}

/** JSON Response helper.
 *
 * All cockpit API responses are authenticated and carry volatile data, so a
 * `no-store` directive is applied by default to prevent shared/proxy caches or
 * the browser back-forward cache from retaining credentials or stale payloads.
 * Callers may override it via the `headers` argument. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/** Plain-text Response helper. */
export function textResponse(
  data: string,
  status = 200,
  contentType = 'text/plain',
  headers: Record<string, string> = {},
): Response {
  return new Response(data, {
    status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store', ...headers },
  });
}

/** Build a 400 response with a structured error. */
export function badRequest(error: string): Response {
  return json({ error }, 400);
}

/** Build a 500 response with a structured error. */
export function serverError(error: string): Response {
  return json({ error }, 500);
}

/** Validate that a URL string uses the http or https protocol.
 * Returns `null` on success, or a 400 Response on failure.
 *
 * SSRF BOUNDARY: this function ONLY checks the URL *scheme*. It deliberately
 * does NOT reject loopback / RFC1918 / link-local / cloud-metadata hosts, so
 * legitimate developer bookmarks such as `http://localhost:3000` or
 * `http://127.0.0.1:8080` keep working. That is correct for *storage* routes
 * where the stored URL is opened client-side in the browser, never fetched
 * server-side — the `tabs` route intentionally stays scheme-only for exactly
 * this reason. The `bookmarks` route, however, additionally applies
 * `isSsrfSafeUrl` at storage time, so it IS SSRF-gated. The separate
 * `isSsrfSafeUrl` guard is reserved for the point where a URL is actually
 * *fetched or launched from the server*. The signature of `validateHttpUrl`
 * is stable. */
export function validateHttpUrl(url: string): Response | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return badRequest('URL must be http or https');
    }
    return null;
  } catch {
    return badRequest('Invalid URL');
  }
}

/**
 * Returns `true` if the host of `url` is safe to fetch/launch *from the server*
 * — i.e. it is NOT a loopback, RFC1918 private, link-local, or cloud-metadata
 * address. Defense-in-depth guard for SSRF that MUST be applied at the moment
 * the server issues an outbound request or launches a URL.
 *
 * IMPORTANT: this guard is intentionally NOT applied at *storage* time (e.g.
 * tabs/bookmarks persistence), because stored URLs are only opened client-side
 * in the browser and a developer's localhost bookmark must stay valid. Storage
 * routes should use `validateHttpUrl` (scheme-only) instead. Only call
 * `isSsrfSafeUrl` for genuine server-side outbound fetches/launches.
 *
 * The host is classified in its *resolved* form: this covers IPv4-mapped IPv6
 * literals (`:ffff:127.0.0.1`), decimal (`2130706433`), octal (`0177.0.0.1`),
 * and hex (`0x7f.0.0.1`) encodings, all of which a real HTTP client resolves to
 * the same (possibly private) address. */
export function isSsrfSafeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  let host = parsed.hostname.toLowerCase();
 // Strip IPv6 bracket notation (`[:1]`) so comparisons below work.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
 // Collapse a trailing dot on a registered name (e.g. `localhost.`) to its
 // bare form — the URL parser strips trailing dots only for IP literals, so a
 // trailing dot on a reg-name would otherwise slip past the loopback block.
  if (host.endsWith('.')) host = host.slice(0, -1);
 // Bare loopback / unspecified addresses.
  if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0') return false;
 // A bare single-label host (no dot) resolves via the server's DNS search
 // domain to an internal service, and a private/mDNS TLD (.local/.internal/
 // .lan/.home) resolves via mDNS/LLMNR to one — both are classic SSRF
 // targets, so reject them the same as a private IP.
  if (!host.includes('.')) return false;
  if (/\.(local|internal|lan|home)$/.test(host)) return false;
 // Any loopback / RFC1918 / link-local / CGNAT host (in resolved form) is unsafe.
  if (isRestrictedHost(host)) return false;
  return true;
}

/** Pure-JS stand-in for Node's `net.isIP`, so this module can be bundled into
 * client components without pulling the `node:net` builtin into the browser
 * bundle. Returns 4 for a standard dotted-decimal IPv4 literal, 6 for any
 * address containing a `:` (IPv6 literals always do), and 0 otherwise.
 *
 * Routing every `:`-containing host to the IPv6 branch preserves the SSRF
 * guard's `fe80:/10` / `fc00:/7` classification; invalid `:` hosts simply fail
 * the IPv6 checks and are rejected. Dotted-decimal IPv4 octets are bounded to
 * 0–255, matching `net.isIP`'s literal form (encoded octal/hex forms still fall
 * through to `normalizeEncodedIpv4`). */
function ipVersion(host: string): 0 | 4 | 6 {
  if (host.includes(':')) return 6;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    for (let i = 1; i <= 4; i++) {
      if (Number(m[i]) > 255) return 0;
    }
    return 4;
  }
  return 0;
}

/** True when `host` resolves to a loopback / private / link-local / CGNAT
 * address in any of the forms an HTTP client would accept: standard IPv4,
 * standard IPv6, IPv4-mapped IPv6, or the various integer encodings of an IPv4
 * address (decimal, octal, hex, and inet_aton shorthand). */
function isRestrictedHost(host: string): boolean {
 // A zone-id (`fe80:1%eth0`) makes the host an invalid bare IP, so `isIP`
 // returns 0 and the value would otherwise fall through to `normalizeEncodedIpv4`
 // and be treated as a public/safe host. Zone-scoped link-local addresses are
 // still link-local — reject any `%` in the host outright.
  if (host.includes('%')) return true;
 // NAT64 well-known prefix (64:ff9b::/96) embeds a 32-bit IPv4 address in the
 // host's low 32 bits — e.g. 64:ff9b::a9fe:a9fe == 169.254.169.254 (cloud
 // metadata) and 64:ff9b::7f00:1 == 127.0.0.1 (loopback). On a network with a
 // NAT64 gateway a real HTTP client resolves these to the embedded private /
 // metadata address, so they must be rejected the same as the plain IPv4.
 // Caught here (independent of the isIP IPv6 branch) so both the two-hextet
 // form (64:ff9b::WWXX:YYZZ) and the dotted form (64:ff9b::a.b.c.d) are blocked.
 if (host.startsWith('64:ff9b:')) {
   let rest = host.slice('64:ff9b:'.length);
   if (rest.startsWith(':')) rest = rest.slice(1);
   let dotted = rest;
   if (!rest.includes('.')) {
     const tailParts = rest.split(':');
     if (tailParts.length >= 2) {
       const hi = parseInt(tailParts[tailParts.length - 2], 16);
       const lo = parseInt(tailParts[tailParts.length - 1], 16);
       if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
         dotted = `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
       }
     }
   } else if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) {
     dotted = '';
   }
   if (dotted && isRestrictedHost(dotted)) return true;
 }
 // IPv6 literal.
  if (ipVersion(host) === 6) {
 // IPv4-mapped IPv6 (`:ffff:a.b.c.d` or `::ffff:WWXX:YYZZ`) — classify the
 // embedded address. The two-hextet form (`WWXX:YYZZ`) is a valid encoding of
 // an IPv4 address and must be normalized to dotted decimal before classification,
 // otherwise the embedded value parses as NaN and slips through as "safe".
    if (host.startsWith('::ffff:')) {
      const embedded = host.slice('::ffff:'.length);
      let dotted = embedded;
      if (embedded.includes(':')) {
        const parts = embedded.split(':');
        if (parts.length === 2) {
          const hi = parseInt(parts[0], 16);
          const lo = parseInt(parts[1], 16);
          if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
            dotted = `${(hi >>> 8) & 0xff}.${(hi & 0xff)}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
          }
        }
      }
      if (isRestrictedHost(dotted)) return true;
    }
 // Fully-expanded IPv4-mapped IPv6 form: `0:0:0:0:0:ffff:WWXX:YYZZ`
 // (e.g. `0:0:0:0:0:ffff:a9fe:a9fe` === ::ffff:169.254.169.254, the cloud
 // metadata address). The abbreviated `::ffff:` prefix check above misses it
 // because the leading zeros are written out, so the embedded IPv4 is
 // classified here. A real HTTP client resolves these to loopback / private /
 // metadata, so they must be rejected too.
    const mapped = /^0(?::0){4}:ffff:([0-9a-f]+):([0-9a-f]+)$/i.exec(host);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const dotted = `${(hi >>> 8) & 0xff}.${(hi & 0xff)}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
        if (isRestrictedHost(dotted)) return true;
      }
    }
 // IPv6 link-local (fe80:/10) and unique-local (fc00:/7). Classify by the
 // first hextet's bitmask rather than by string prefixes, so the WHOLE
 // fe80:/10 link-local range (fe80: … febf:) is blocked — not just fe80:,
 // and fc00:/7 (fc00 … fdff) is covered without a fragile startsWith.
    const firstHextet = parseInt(host.split(':')[0], 16);
    if (!Number.isNaN(firstHextet)) {
 // Link-local: fe80:/10 → (firstHextet & 0xffc0) === 0xfe80
      if ((firstHextet & 0xffc0) === 0xfe80) return true;
 // Unique-local: fc00:/7 → (firstHextet & 0xfe00) === 0xfc00
      if ((firstHextet & 0xfe00) === 0xfc00) return true;
    }
    return false;
  }
 // Standard IPv4 literal.
  if (ipVersion(host) === 4) return isPrivateIpv4(host);
 // Non-standard encodings (decimal / octal / hex / inet_aton shorthand) that an
 // HTTP client resolves to the same address. Normalize to dotted IPv4 first.
  const normalized = normalizeEncodedIpv4(host);
  if (normalized) return isPrivateIpv4(normalized);
  return false;
}

/** Attempt to interpret `host` as an integer-encoded IPv4 address and return it
 * in dotted-decimal form, or `null` if it is not an IP-encoding at all.
 *
 * Handles:
 * • pure decimal `2130706433` -> 127.0.0.1
 * • dotted, each octet decimal/octal/hex with inet_aton shorthand
 * `0177.0.0.1` -> 127.0.0.1
 * `0x7f.0.0.1` -> 127.0.0.1
 * `127.1` -> 127.0.0.1
 * A genuine DNS hostname (e.g. `example.com`) returns `null` and is treated as
 * public. */
function normalizeEncodedIpv4(host: string): string | null {
 // Pure decimal integer form (e.g. 2130706433).
  if (/^\d{1,10}$/.test(host)) {
    const n = Number(host);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [
        (n >>> 24) & 0xff,
        (n >>> 16) & 0xff,
        (n >>> 8) & 0xff,
        n & 0xff,
      ].join('.');
    }
    return null;
  }
 // Dotted form with 1-4 parts, each decimal / octal (0-prefix) / hex (0x-prefix).
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const raw of parts) {
    const s = raw.toLowerCase();
    let v: number;
    if (s.startsWith('0x')) v = parseInt(s.slice(2), 16);
    else if (s.startsWith('0')) v = parseInt(s, 8);
    else v = parseInt(s, 10);
    if (!Number.isFinite(v) || v < 0 || v > 0xffffffff) return null;
    nums.push(v);
  }
  let value: number;
  if (nums.length === 1) value = nums[0];
  else if (nums.length === 2) value = nums[0] * 0x1000000 + (nums[1] & 0xffffff);
  else if (nums.length === 3) value = nums[0] * 0x1000000 + nums[1] * 0x10000 + (nums[2] & 0xffff);
  else value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3];
  if (value < 0 || value > 0xffffffff) return null;
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

function isPrivateIpv4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
 // 0.0.0.0/8 — "this network" / unspecified. Encoded forms (`0`, `0x0.0.0.0`,
 // `00.0.0.0`, …) all normalize to `0.0.0.0` and must be blocked exactly like
 // loopback, otherwise a server-side fetch/launch can reach the unspecified
 // address and bypass the guard's intent.
  if (a === 0) return true;
 // 10.0.0.0/8
  if (a === 10) return true;
 // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
 // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
 // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
 // 169.254.0.0/16 (link-local, incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
 // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Parse a `limit` query param with a default + max cap. */
export function parseLimit(req: NextRequest, defaultValue = 100, max = 200): number {
  const raw = req.nextUrl.searchParams.get("limit");
  const parsed = raw !== null ? parseInt(raw, 10) : NaN;
  const value = Number.isFinite(parsed) && parsed !== 0 ? parsed : defaultValue;
  return Math.max(1, Math.min(value, max));
}

/** Shared cursor-id validation for `after` pagination (cuid/uuid tokens). */
export const CURSOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `e` is Prisma's "record not found" (P2025) error. Structured
 * check (code + error name) — avoids fragile message-substring sniffing. */
export function isPrismaRecordNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; name?: unknown };
  return err.code === 'P2025' && err.name === 'PrismaClientKnownRequestError';
}

/** True when `e` is Prisma's foreign-key constraint (P2003) error — e.g. an
 * attempt to delete a row still referenced by a child relation. Structured
 * check (code + error name) — avoids fragile message-substring sniffing. */
export function isPrismaForeignKeyConstraint(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; name?: unknown };
  return err.code === 'P2003' && err.name === 'PrismaClientKnownRequestError';
}

/** Parse and validate the optional `agentId` query param.
 *
 * Returns `undefined` when the param is absent or empty (the "no filter"
 * contract), and throws a `ClientError` (400) for a present value that is
 * longer than 128 chars or contains whitespace/control characters. The error
 * message and bounds match the route-local guard that this consolidates. */
export function parseAgentId(req: NextRequest): string | undefined {
  const raw = req.nextUrl.searchParams.get('agentId');
  if (raw === null || raw === '') return undefined;
  const hasBadChar =
    /\s/.test(raw) ||
    [...raw].some((ch) => {
      const c = ch.charCodeAt(0);
      return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
    });
  if (raw.length > 128 || hasBadChar) {
    throw new ClientError('Invalid agentId; must be 1-128 chars with no control/whitespace characters', 400);
  }
  return raw;
}

/** Sanitize a caller-supplied `x-request-id` header for use as a correlation
 * id / upstream trace header.
 *
 * Only printable ASCII (space through tilde) up to 64 chars is accepted;
 * anything else (control/CRLF bytes, over-length) returns `undefined` so it is
 * never forwarded to logs or the upstream service. This is the single source of
 * truth for the request-id validation shared by the chat POST/DELETE and image
 * POST handlers, preventing the log-injection guard from drifting between them. */
export function sanitizeRequestId(raw: string | null): string | undefined {
  return raw && /^[ -~]{1,64}$/.test(raw) ? raw : undefined;
}

/** Maximum length for user-supplied free-text fields. These mirror the bounds
 * other cowork resources apply (names ≤ 64, userAgent ≤ 512, descriptions ≤
 * 2000) so bookmarks/tabs can't store unbounded strings that bloat DB rows or
 * amplify response sizes. */
export const MAX_NAME_LEN = 256;
export const MAX_TITLE_LEN = 512;
export const MAX_URL_LEN = 2048;
export const MAX_SOURCE_LEN = 64;

/** Coerce a user-supplied field to a bounded, type-safe string.
 *
 * Unlike a bare `String(body.x || fallback)` — which silently turns an object
 * into `"[object Object]"` and persists it — this REJECTS non-string input with
 * a 400 and truncates legitimate strings to `maxLen`. A present `undefined` /
 * `null` falls back to `fallback` (also capped). All DB-write routes should
 * funnel free-text through this instead of raw `String()` coercion, so stored
 * invariants (type safety + max length) stay consistent across resources. */
export function boundedString(value: unknown, maxLen: number, fallback?: string): string {
  if (value === undefined || value === null) {
    return (fallback ?? '').slice(0, maxLen);
  }
  if (typeof value !== 'string') {
    throw new ClientError('field must be a string');
  }
  return value.slice(0, maxLen);
}

function newCorrelationId(): string {
  try {
 // crypto.randomUUID is available in Node 19+ and the Edge runtime.
    return globalThis.crypto.randomUUID();
  } catch {
    return `err-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Redact obvious secret shapes from a loggable string so server-side error
 * logging does not capture credentials. Covers:
 * • credentials embedded in URLs (http(s)://user:pass@host)
 * • secret-bearing `key=value` pairs (password / token / secret / api_key / …)
 * • JSON-shaped secrets (`"password": "…"`, `"api_key": "…"`)
 * • `Bearer` tokens
 * • the configured COWORK_EVENT_TOKEN itself (if set and non-dev)
 *
 * Applied to `Error.message` text today (defense-in-depth on potential secret
 * leakage in error strings); the patterns are intentionally broad and can be
 * reused to scrub request bodies/headers if a caller passes them.
 *
 * This is the canonical implementation — import it where needed (e.g. the log
 * route) rather than maintaining a divergent copy. */
export function redactSecrets(text: string): string {
  let out = text;
 // Credentials in URLs: scheme://user:pass@host -> scheme://***@host.
 // Any scheme (postgres://, mysql://, mongodb://, redis://, amqp://, …) is
 // covered — not just http(s) — so DB connection-string secrets don't survive
 // into server error logs. The capturing group preserves the scheme.
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, "$1***@");
 // Secret-bearing key=value pairs in URLs / bodies / headers.
  out = out.replace(
    /(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation|private[_-]?key|passphrase|cvv|otp|ssn|pin)=[^&\s"'<>]+/gi,
    "$1=***",
  );
 // JSON-shaped secrets: `"password": "secret"` / `"api_key": "..."`. A value
  // shaped like `Bearer <token>` / `Basic <b64>` keeps its scheme word so the
  // redacted form (`"Bearer ***"`) still signals the auth scheme without
  // leaking the secret.
  out = out.replace(
    /"(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation|private[_-]?key|passphrase|cvv|otp|ssn|pin)"\s*:\s*"([^"]*)"/gi,
    (_m, key: string, val: string) => {
      const scheme = /^(Bearer|Basic)\s+[A-Za-z0-9._-]+$/i.exec(val);
      const inner = scheme ? `${scheme[1].trim()} ***` : "***";
      return `"${key}":"${inner}"`;
    },
  );
 // Bearer tokens.
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***");
 // HTTP Basic credentials: `Authorization: Basic <base64>` (colon-space, no `=`).
 // Short base64 (e.g. `dXNlcjpwA==`, ~11 chars) escapes the 20+ entropy
 // fallback, so it is masked explicitly here.
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic ***");
 // Well-known standalone credential literals that show up in logs without a
 // key=/Bearer prefix: Groq (gsk-), Slack (xox[baprs]-), AWS (AKIA…), plus
 // OpenAI/Anthropic keys, Google API keys, and JWTs.
  out = out.replace(
    /\b(gsk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20})\b/g,
    "***",
  );
 // The configured token value itself (avoid echoing the real secret).
  const configured = process.env.COWORK_EVENT_TOKEN;
  if (configured && configured.length > 0 && configured !== "dev-token") {
    out = out.split(configured).join("***");
  }
 // The browser/UI secret is independent of the service-to-service secret (the
 // preferred one when distinct). Redact it too, or a leaked distinct UI token
 // would survive `redactSecrets` and show up in error strings/logs.
  const uiToken = process.env.COWORK_UI_TOKEN;
  if (uiToken && uiToken.length > 0 && uiToken !== "dev-token") {
    out = out.split(uiToken).join("***");
  }
  // Additive, bounded fallback for bare high-entropy scalars (no key=/Bearer/
  // provider-literal prefix) that would otherwise reach server error logs
  // unredacted — the EchoLeak-class gap. The alphabet deliberately EXCLUDES `/`
  // so a benign URL path such as `3000/api/cowork/tabs` is never mistaken for a
  // secret.
  out = out.replace(
    /(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{20,}(?![A-Za-z0-9+_-])(?!"\s*:)/g,
    "***",
  );
  return out;
}

/** Map an error message to a stable, secret-free code for server logs. */
function stableErrorCode(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("not found")) return "NOT_FOUND";
  if (lower.includes("not implemented")) return "NOT_IMPLEMENTED";
  if (lower.includes("unauthorized") || lower.includes("forbidden")) return "FORBIDDEN";
  if (lower.includes("required") || lower.includes("must be"))
    return "BAD_REQUEST";
  return "INTERNAL";
}

/**
 * Wrap an async route handler with try/catch that produces a JSON error.
 *
 * @param fn The route handler.
 * @param requestId Optional request id propagated from middleware. When
 * provided it is reused as the `correlationId` so server error
 * logs and the client-facing error share one traceable id.
 *
 * ERROR-LEAK CONTRACT (fail-closed):
 *
 * The ONLY messages echoed verbatim to the client are those carried by an
 * app-authored `ClientError`. Its `message`/`status` are taken directly.
 *
 * Every other (internal) error — Prisma constraint/p2025 messages, driver
 * frames, filesystem paths, etc. — is WITHHELD from the client and replaced with
 * the generic `internal_error` key (HTTP 500) so operators can trace it via the
 * server-log `correlationId`. We do NOT do substring sniffing of raw internal
 * text, and we never echo a non-`ClientError` message, because phrases like
 * "required" / "must be" / "not found" appear in internal DB/driver strings and
 * would leak implementation details. Validation/business failures that the
 * client should see MUST be raised as `ClientError`. */
export async function withRouteError(
  fn: () => Promise<Response>,
  requestId?: string,
): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const correlationId = sanitizeRequestId(requestId ?? null) ?? newCorrelationId();
    const message = e instanceof Error ? e.message : 'Internal server error';
 // Prefer a stable error code + correlation id over dumping the raw
 // stack/message (which may leak filesystem paths, table names, or tokens).
 // What we do log is redacted of known secret shapes.
    console.error(
      '[cowork route error]',
      correlationId,
      stableErrorCode(message),
      redactSecrets(message),
    );

 // App-authored `ClientError`s are the only messages safe to echo verbatim;
 // their status is taken from the error itself. Any other (internal) error is
 // withheld from the client and mapped to a generic, leak-free 500.
    if (e instanceof ClientError) {
      return json({ error: e.message, correlationId }, e.status);
    }

 // Fail-closed: internal errors never reach the client as raw text.
    return json({ error: 'internal_error', correlationId }, 500);
  }
}

/**
 * Record a browsing-history visit, upserting on `url`. `HistoryEntry.url` is
 * `@unique`, so a revisit MUST call `upsert` (not a raw `create`) or it throws
 * P2002. This is the single shared write path the history route and the
 * extension sync must use, so the P2002 regression can be guarded in one place.
 */
export async function upsertHistoryEntry(
  prisma: {
    historyEntry: {
      upsert: (args: Prisma.HistoryEntryUpsertArgs) => Promise<unknown>;
    };
  },
  url: string,
  title: string,
): Promise<unknown> {
  return prisma.historyEntry.upsert({
    where: { url },
    create: { url, title },
    update: {
      title,
      visitCount: { increment: 1 },
      lastVisitedAt: new Date(),
    },
  });
}
