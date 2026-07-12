import type { NextRequest } from 'next/server';
import { isIP } from 'node:net';

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

async function readCappedBody(req: NextRequest): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
 // Reject BEFORE the chunk is appended to `text` so a single oversized
 // chunk (or a cumulative overflow) can never be buffered into memory.
    if (total + value.byteLength > MAX_BODY_BYTES) {
 // Release the underlying body reader so the request socket/stream is not
 // left unconsumed (resource hygiene under a flood of oversize requests).
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new ClientError('request entity too large', 413);
    }
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
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
    return JSON.parse(text) as Record<string, unknown>;
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
      e instanceof Error ? e.message : String(e),
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
export function textResponse(data: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(data, { status, headers: { 'content-type': contentType } });
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
 * `http://127.0.0.1:8080` keep working. That is correct for *storage* routes:
 * stored URLs are opened client-side in the browser, never fetched
 * server-side, so they cannot become an SSRF sink. The separate
 * `isSsrfSafeUrl` guard is reserved for the point where a URL is actually
 * *fetched or launched from the server* (storage routes must NOT call it).
 * The signature of `validateHttpUrl` is stable. */
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
 // Bare loopback / unspecified addresses.
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
 // Any loopback / RFC1918 / link-local / CGNAT host (in resolved form) is unsafe.
  if (isRestrictedHost(host)) return false;
  return true;
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
 // IPv6 literal.
  if (isIP(host) === 6) {
 // IPv4-mapped IPv6 (`:ffff:a.b.c.d`) — classify the embedded address.
    if (host.startsWith('::ffff:')) {
      const embedded = host.slice('::ffff:'.length);
      if (isRestrictedHost(embedded)) return true;
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
  if (isIP(host) === 4) return isPrivateIpv4(host);
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
  else if (nums.length === 2) value = (nums[0] << 24) | (nums[1] & 0xffffff);
  else if (nums.length === 3) value = (nums[0] << 24) | (nums[1] << 16) | (nums[2] & 0xffff);
  else value = (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3];
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
  return Math.max(1, Math.min(parseInt(req.nextUrl.searchParams.get('limit') || String(defaultValue), 10) || defaultValue, max));
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
 // Credentials in URLs: http(s)://user:pass@host -> http(s)://***@host
  out = out.replace(/https?:\/\/[^@\s/]+@/gi, (m) =>
    m.replace(/\/\/[^@\s/]+@/, "//***@"),
  );
 // Secret-bearing key=value pairs in URLs / bodies / headers.
  out = out.replace(
    /(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation)=[^&\s"'<>]+/gi,
    "$1=***",
  );
 // JSON-shaped secrets: `"password": "secret"` / `"api_key": "..."`.
  out = out.replace(
    /"(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation)"\s*:\s*"[^"]*"/gi,
    '"$1":"***"',
  );
 // Bearer tokens.
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***");
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
    const correlationId = requestId || newCorrelationId();
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
