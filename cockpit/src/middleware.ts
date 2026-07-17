//
// Cockpit API auth middleware.
//
// Requires an `X-Cowork-Token` header matching `process.env.COWORK_UI_TOKEN`
// (preferred) or, as a fallback, `process.env.COWORK_EVENT_TOKEN` (service-to-
// service only) on every `/api/cowork/*` route, EXCEPT the public agent-
// discovery endpoints
// (bootstrap / manifest / agent / agent/version / skill) — those are
// intentionally public so external LLM agents can discover the cockpit's
// capabilities without first authenticating.
//
// Token rules:
// • If neither `COWORK_UI_TOKEN` nor `COWORK_EVENT_TOKEN` is set: fail-closed
// with 401 (no safe default). `COWORK_UI_TOKEN` is preferred; the
// `COWORK_EVENT_TOKEN` fallback exists only for backward compatibility.
// • If the resolved token equals the well-known `dev-token`: fail-closed
// with 401 UNLESS `COWORK_ALLOW_DEV_TOKEN=1` is explicitly set AND the
// deployment is not production (`NODE_ENV !== 'production'`). This keeps
// the well-known default from ever authenticating the cockpit in prod.
// • If the resolved token is set to a real secret: require the
// `X-Cowork-Token` header to match using a constant-time comparison.
//
// The matcher (below) limits this middleware to `/api/cowork/:path*`. The
// public-discovery routes are bypassed in the function body (not in the
// matcher) so the bypass logic is visible in one place.
//
// NOTE: Uses TextEncoder + manual XOR instead of Node.js `crypto.timingSafeEqual`
// because middleware runs in the Edge Runtime, which does not support the
// Node.js `crypto` module. The manual loop is constant-time (always iterates
// the full normalized length) and uses only Web Platform APIs available in
// Edge Runtime.

import { NextResponse, type NextRequest } from 'next/server';

// Reused across requests so the Edge runtime doesn't reallocate a fresh
// TextEncoder on every `tokensMatch` call (hot path: every protected request).
const encoder = new TextEncoder();

// The server secret (`expected`) is process-constant, so we encode it once per
// distinct value instead of re-encoding it on every protected request.
let cachedExpected: { v: string; b: Uint8Array } | null = null;

// Anchored, ReDoS-safe production-detection pattern, hoisted to module scope
// so it isn't recompiled on every auth check.
const DEV_ENV_RE = /^(development|dev|local|test)$/i;

// Fixed (non-secret-derived) DoS cap on the attacker-controlled token length.
// Sized comfortably above any legitimate operator secret so the configured
// secret always authenticates, while input beyond this fixed floor is rejected
// regardless of the secret's length — preserving the constant-time design (no
// secret-length timing signal). Exported only so the auth test can pin the value.
export const MAX_TOKEN_CHARS = 8192;

// Fixed-window brute-force throttle on failed auth attempts (API4:2023). A
// client IP that exhausts RATE_LIMIT_MAX failed attempts within
// RATE_LIMIT_WINDOW_MS is held at 429 before any further token comparison, so
// the shared secret cannot be brute-forced unthrottled. Exported so the auth
// test can pin the window; the constant-time compare itself is untouched.
export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

// In-memory fixed-window counters, keyed by client IP. Each entry holds the
// window start and the failure count within it; stale windows are lazily reset
// on access (Web Platform APIs only — no Node timers needed).
interface RateBucket {
  start: number;
  count: number;
}
const rateBuckets = new Map<string, RateBucket>();

// Hard cap on the number of distinct IP buckets kept in memory. Without a
// bound, a client that varies its X-Forwarded-For header per request could
// allocate a never-freed Map entry each time and exhaust worker heap. When the
// cap is reached the oldest (first-inserted) bucket is evicted on insert.
const MAX_RATE_BUCKETS = 4096;

// Lazy TTL sweep: every N inserts we drop buckets whose window has fully
// expired, freeing memory that would otherwise linger for the worker's
// lifetime. No Node timers are used (Edge Runtime).
const RATE_BUCKET_SWEEP_EVERY = 1024;
let rateBucketInserts = 0;

function sweepExpiredBuckets(now: number): void {
  rateBucketInserts = 0;
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.start >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(ip);
  }
}

function setBucket(ip: string, bucket: RateBucket, now: number): void {
  if (!rateBuckets.has(ip) && rateBuckets.size >= MAX_RATE_BUCKETS) {
    const oldest = rateBuckets.keys().next().value as string | undefined;
    if (oldest !== undefined) rateBuckets.delete(oldest);
  }
  rateBuckets.set(ip, bucket);
  if (++rateBucketInserts >= RATE_BUCKET_SWEEP_EVERY) sweepExpiredBuckets(now);
}

// Returns true (allowed) when the IP is within its window cap, false (throttled)
// once RATE_LIMIT_MAX failures have accumulated in the current window.
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start >= RATE_LIMIT_WINDOW_MS) {
    setBucket(ip, { start: now, count: 0 }, now);
    return true;
  }
  return bucket.count < RATE_LIMIT_MAX;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket) {
    setBucket(ip, { start: now, count: 1 }, now);
    return;
  }
  bucket.count += 1;
}

// Trusted upstream proxy IPs (comma-separated, e.g. "10.0.0.1,127.0.0.1").
// When set, the brute-force throttle keys on the real client IP as seen by the
// trusted boundary, NOT on the (attacker-controllable) X-Forwarded-For hop. An
// attacker rotating XFF per request can otherwise reset the counter and brute-
// force the shared secret unthrottled. Cached once per process.
let cachedTrustedProxies: Set<string> | null = null;
function trustedProxyIps(): Set<string> {
  if (cachedTrustedProxies) return cachedTrustedProxies;
  const raw = process.env.COWORK_TRUSTED_PROXY_IPS;
  const set = new Set<string>();
  if (raw) {
    for (const p of raw.split(',')) {
      const t = p.trim();
      if (t) set.add(t);
    }
  }
  cachedTrustedProxies = set;
  return set;
}

// Client IP for rate-limit keying.
//
// When `COWORK_TRUSTED_PROXY_IPS` is configured, the REAL client IP is the
// first hop in the X-Forwarded-For chain (walked right-to-left) that is NOT a
// trusted proxy — i.e. the address the trusted boundary appended, not an
// attacker-supplied leftmost value. This prevents an attacker from rotating
// XFF per request to reset the brute-force counter.
//
// When NO trusted-proxy set is configured the deployment is assumed directly
// reachable (or behind a proxy that overwrites XFF), and the leftmost XFF hop
// is used as before. NOTE: a directly-reachable deployment with an attacker-
// controllable XFF still lets the counter be reset per-request — operators
// MUST set `COWORK_TRUSTED_PROXY_IPS` so the throttle keys on the trusted
// proxy's view of the client. The per-process in-memory counter also does not
// span multiple workers/serverless instances; a shared store would be needed
// for a horizontally-scaled deployment (out of scope for this fix).
function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) {
      const trusted = trustedProxyIps();
      if (trusted.size > 0) {
        for (let i = hops.length - 1; i >= 0; i--) {
          if (!trusted.has(hops[i])) return hops[i];
        }
        return hops[hops.length - 1];
      }
      return hops[0];
    }
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}

const PUBLIC_DISCOVERY_PATHS = new Set<string>([
  '/api/cowork/agent/bootstrap',
  '/api/cowork/agent/manifest',
  '/api/cowork/agent',
  '/api/cowork/agent/version',
  '/api/cowork/skill',
]);

// Dev-mode placeholder — NOT a secret.
const DEV_TOKEN = 'dev-token';

// Accept an inbound `x-request-id` only when it is a short, safe correlation
// token. Rejecting CRLF/control characters prevents request-log forging and
// response-header injection when the value is reflected into `x-request-id`.
const REQ_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

// Warn-once helper: each key fires its message at most once per server process.
const warnedOnce = new Set<string>();
function warnOnce(key: string, msg: () => string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(msg());
}

/**
 * Warn at most once when the server-side UI token and the browser-exposed
 * `NEXT_PUBLIC_COWORK_UI_TOKEN` are mismatched (one set, the other not). Such a
 * split yields a silent 401 on every browser request and is easy to misdiagnose
 * as a code bug rather than a config mismatch.
 */
function warnTokenPairingOnce(): void {
  const serverUi = process.env.COWORK_UI_TOKEN;
  const clientUi =
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_COWORK_UI_TOKEN : undefined;
  let msg: string | null = null;
  if (clientUi && !serverUi && !process.env.COWORK_EVENT_TOKEN) {
    msg =
      '[cowork-auth] NEXT_PUBLIC_COWORK_UI_TOKEN is set in the browser bundle but no server-side ' +
      'COWORK_UI_TOKEN (or COWORK_EVENT_TOKEN) is configured — every browser request will 401. ' +
      'Set COWORK_UI_TOKEN to the same value.';
  } else if (serverUi && !clientUi) {
    msg =
      '[cowork-auth] COWORK_UI_TOKEN is configured server-side but NEXT_PUBLIC_COWORK_UI_TOKEN is not ' +
      'set — the browser cannot authenticate. Set NEXT_PUBLIC_COWORK_UI_TOKEN to the matching value.';
  }
  if (msg) warnOnce('pairing', () => msg as string);
}

/**
 * Constant-time string comparison using only Web Platform APIs (TextEncoder).
 *
 * Always iterates the EXPECTED secret's length (never the received input's
 * length), so the iteration count cannot depend on attacker-controlled input
 * and therefore cannot leak the secret's length. A length mismatch is detected
 * but folded in AFTER the loop, avoiding a timing side-channel. Never throws.
 */
export function tokensMatch(received: string | undefined, expected: string): boolean {
  if (typeof received !== 'string' || received.length === 0) return false;
 // Bound the attacker-controlled token size (memory-exhaustion DoS guard). The
 // cap is fixed (never secret-derived), so it introduces no timing signal.
  if (received.length > MAX_TOKEN_CHARS) return false;
  const a = encoder.encode(received);
  if (!cachedExpected || cachedExpected.v !== expected) {
    cachedExpected = { v: expected, b: encoder.encode(expected) };
  }
  const b = cachedExpected.b;
 // Iterate over the EXPECTED secret's length only, so timing cannot reveal the
 // received input's length.
  const len = b.length;
  let diff = 0;
  for (let i = 0; i < len; i++) {
    const x = i < a.length ? a[i] : 0; // pad the shorter side with a fixed byte
    const y = b[i];
    diff |= x ^ y;
  }
 // Fold the length mismatch in AFTER the constant-time loop.
  return diff === 0 && a.length === b.length;
}

/**
 * Authenticate a protected `/api/cowork/*` request.
 *
 * Returns `null` when the request is authorized (caller should `next()`),
 * or a 401 `NextResponse` when it is not. Centralizes the dev-token rule.
 *
 * Token sources (validated with the SAME `tokensMatch`):
 * • the `X-Cowork-Token` request header (all protected routes), and
 * • for the SSE stream `/api/cowork/events/stream` ONLY, a `token` query
 * param. Browser `EventSource` cannot set custom headers, so it MUST use
 * the `?token=` query param to open the stream; the `X-Cowork-Token`
 * header path remains available for non-EventSource clients. The query
 * token is validated against the exact same secret using the exact same
 * constant-time compare — the *auth* is equally strong, only the *transport*
 * (URL vs header) is weaker (see the EXPOSURE TRADE-OFF note at the handler).
 */
function authenticate(req: NextRequest, normalizedPathname: string): NextResponse | null {
 // The browser-facing UI secret is `COWORK_UI_TOKEN` (preferred),
 // falling back to the service-to-service `COWORK_EVENT_TOKEN` for backward
 // compatibility. They are INDEPENDENT secrets — a deployment that only sets
 // `COWORK_EVENT_TOKEN` keeps working (existing tests rely on the fallback),
 // but a deployment that sets `COWORK_UI_TOKEN` uses a distinct UI secret so a
 // leaked browser bundle (which can only ever see `NEXT_PUBLIC_CO*`) cannot
 // unlock the server-to-server `COWORK_EVENT_TOKEN` path.
 // Treat an EMPTY string as unset: `??` only treats `undefined`/`null` as
 // unset, so a `COWORK_UI_TOKEN=` (empty) in an .env would otherwise blank
 // `token` and fail-closed on every request even when a real EVENT_TOKEN is
 // configured. `||` collapses both empty and undefined to the fallback.
  const token = process.env.COWORK_UI_TOKEN || process.env.COWORK_EVENT_TOKEN || undefined;

 // Fail-closed when the browser-facing NEXT_PUBLIC_COWORK_UI_TOKEN equals the
 // service-to-service COWORK_EVENT_TOKEN: the S2S secret would be embedded in the
 // public JS bundle and become an accepted UI credential. Reject regardless of
 // whether COWORK_UI_TOKEN is set.
  const s2s = process.env.COWORK_EVENT_TOKEN;
  const browserUi = process.env.NEXT_PUBLIC_COWORK_UI_TOKEN;
  if (s2s && browserUi && browserUi === s2s) {
    return withSecurityHeaders(
      NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="cowork"' } },
      ),
    );
  }

  if (!process.env.COWORK_UI_TOKEN && process.env.COWORK_EVENT_TOKEN) {
    warnOnce(
      'ui-token',
      () =>
        '[cowork-auth] UI auth is falling back to the service-to-server COWORK_EVENT_TOKEN ' +
        'because COWORK_UI_TOKEN is unset. This risks embedding the S2S secret in the browser ' +
        'bundle (NEXT_PUBLIC_COWORK_UI_TOKEN). Set a distinct COWORK_UI_TOKEN.',
    );
  }

 // The well-known `dev-token` is honored ONLY with an explicit opt-in
 // (`COWORK_ALLOW_DEV_TOKEN=1`) AND when `NODE_ENV` matches a known development
 // environment. Any unrecognized/blank `NODE_ENV` fails closed, so the dev-token
 // can never authenticate in production even if the opt-in is mistakenly set.
  const nodeEnv = (process.env.NODE_ENV ?? '').trim();
  const allowDevToken =
    process.env.COWORK_ALLOW_DEV_TOKEN === '1' &&
    DEV_ENV_RE.test(nodeEnv);

  if (!token || (token === DEV_TOKEN && !allowDevToken)) {
    warnOnce(
      'no-token',
      () =>
        '[cowork-auth] 401 Unauthorized — no token configured, or dev-token used without the COWORK_ALLOW_DEV_TOKEN opt-in (or in production)',
    );
    return withSecurityHeaders(
      NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="cowork"' } },
      ),
    );
  }

  if (token === DEV_TOKEN && allowDevToken) {
 // Opt-in dev-token path — allowed, but logged once so the operator knows
 // the cockpit is running unauthenticated.
    warnOnce('dev-token', () => {
      const devTokenVar =
        process.env.COWORK_UI_TOKEN === DEV_TOKEN
          ? 'COWORK_UI_TOKEN'
          : process.env.COWORK_EVENT_TOKEN === DEV_TOKEN
            ? 'COWORK_EVENT_TOKEN'
            : 'the resolved token';
      return (
        `[cowork-auth] ${devTokenVar} is the dev-token AND COWORK_ALLOW_DEV_TOKEN=1 — allowing the well-known default. NEVER set this in production.`
      );
    });
    return null;
  }

 // Validate the server/browser token pairing exactly once per process so a
 // mis-set pair (silent 401 on every request) is surfaced loudly.
  warnTokenPairingOnce();

  const receivedHeader = req.headers.get('x-cowork-token') ?? undefined;

 // SSE stream — also accept the token via a signed query param because
 // browser EventSource cannot set headers. Restricted to this one path so it
 // cannot be used to bypass header auth elsewhere.
 //
 // EXPOSURE TRADE-OFF (documented): a bearer secret in the URL is recorded in
 // reverse-proxy/access logs, browser history, and `Referer` headers on any
 // cross-origin navigation while the stream is open. The comparison is still
 // constant-time (no auth bypass), but the *transport* is weaker than a header.
 // Mitigations: (1) prefer the `X-Cowork-Token` header where the client can set
 // it; (2) ensure upstream proxies/CDNs strip `?token=` from logs; (3) rotate
 // the token regularly; (4) this middleware logs only `pathname` (never the
 // query string), so the token is not written to our own request log.
  const isSse = normalizedPathname === '/api/cowork/events/stream';
  const receivedQuery = isSse ? (req.nextUrl.searchParams.get('token') ?? undefined) : undefined;

  const received = receivedHeader ?? receivedQuery;

  const ip = clientIp(req);
 // Throttle brute-force before comparing: once an IP burns through its window of
 // failed attempts it gets a 429 instead of another 401, so the secret can't be
 // hammered unthrottled. The constant-time compare below still runs unchanged.
  if (!checkRateLimit(ip)) {
    return withSecurityHeaders(
      NextResponse.json(
        { error: 'Too Many Requests' },
        {
          status: 429,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
          },
        },
      ),
    );
  }

  if (!tokensMatch(received, token)) {
    recordAuthFailure(ip);
    warnOnce(
      'mismatch',
      () => `[cowork-auth] 401 Unauthorized — token mismatch (path: ${req.nextUrl.pathname}, ip: ${ip})`,
    );
    return withSecurityHeaders(
      NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="cowork"' } },
      ),
    );
  }

  return null;
}

/**
 * Generate a request id. Reuses an inbound `x-request-id` when present so that
 * callers can correlate their logs with ours; otherwise mints a fresh UUID.
 * `crypto.randomUUID` is a Web Platform API available in the Edge
 * Runtime.
 */
function newRequestId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Attach `x-request-id` to a response so clients can trace a request. */
function withRequestId(res: NextResponse, requestId: string): NextResponse {
  res.headers.set('x-request-id', requestId);
  return res;
}

/** Attach baseline security response headers. `nosniff` mitigates MIME-sniffing
 * of any user-influenced content; `no-referrer` reduces leakage of the SSE
 * `?token=` bearer into `Referer` headers on cross-origin navigations while a
 * stream is open. These are additive companions to the per-request CSP and do
 * not weaken it. */
function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

/** `NextResponse.next()` that also forwards `x-request-id` to downstream routes
 * (so a route handler can read it via `req.headers` and pass it to
 * `withRouteError`, threading one id end-to-end). */
function nextWithRequestId(req: NextRequest, requestId: string): NextResponse {
  const headers = new Headers(req.headers);
  headers.set('x-request-id', requestId);
  return withSecurityHeaders(withRequestId(NextResponse.next({ request: { headers } }), requestId));
}

/**
 * Attach a strict, per-request-nonce Content-Security-Policy to an HTML page
 * response.
 *
 * Because middleware runs on EVERY request (unlike next.config `headers()`,
 * which is evaluated once at build), the nonce here is genuinely unique per
 * response. Next.js reads the nonce from the request `Content-Security-Policy`
 * / `x-nonce` header and applies the SAME nonce to the inline RSC-flight and
 * hydration `<script>`/`<style>` tags it emits, so a strict policy WITHOUT
 * `'unsafe-inline'` still permits the framework's own inline code.
 *
 * connect-src contract (cross-file — keep in sync with
 * src/hooks/use-websocket.ts): the socket is opened with `io()` and NO URL, so
 * socket.io-client targets `window.location.origin` — the cockpit's own origin.
 * `connect-src 'self'` therefore covers BOTH the websocket and polling
 * transports. If the socket is EVER pointed at a different origin, this
 * directive MUST be updated to allowlist it (e.g. `connect-src 'self'
 * wss://events.example.com`) or the realtime link is silently CSP-blocked.
 */
function pageWithCsp(req: NextRequest, requestId: string): NextResponse {
  const nonce = globalThis.crypto.randomUUID();
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data:`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ');

 // Forward the nonce + CSP to the render pipeline so Next.js applies the nonce
 // to its own inline scripts/styles, then mirror the CSP onto the response.
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  headers.set('x-request-id', requestId);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return withSecurityHeaders(withRequestId(res, requestId));
}

export function middleware(req: NextRequest): NextResponse {
  const start = Date.now();
  const incoming = req.headers.get('x-request-id');
  const requestId = incoming && REQ_ID_RE.test(incoming) ? incoming : newRequestId();

  const { pathname } = req.nextUrl;
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";

 // Non-API (HTML page) requests get the per-request nonce'd CSP and are not
 // token-authenticated (auth applies only to `/api/cowork/*`).
  if (!normalizedPathname.startsWith('/api/cowork')) {
    return pageWithCsp(req, requestId);
  }

  let res: NextResponse;
  if (PUBLIC_DISCOVERY_PATHS.has(normalizedPathname)) {
    res = nextWithRequestId(req, requestId);
  } else {
    const denied = authenticate(req, normalizedPathname);
    res = denied ? withRequestId(denied, requestId) : nextWithRequestId(req, requestId);
  }

 // Structured request log (no secrets — path only, never the body).
 // Gated behind opt-in env so it does not emit a line per request in
 // production by default (intentional, path-only/no-secrets discipline kept).
  if (process.env.COWORK_REQUEST_LOG === '1') {
    const durationMs = Date.now() - start;
    console.warn('[cowork request]', requestId, req.method, pathname, res.status, `${durationMs}ms`);
  }
  return res;
}

export const config = {
  matcher: [
    '/api/cowork/:path*',
   // All page routes (for the per-request CSP nonce), excluding Next.js static
   // assets and the static files served from `public/`.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt).*)',
  ],
};
