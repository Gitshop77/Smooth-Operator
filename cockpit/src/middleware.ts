//
// Cockpit API auth middleware.
//
// Requires an `X-Cowork-Token` header matching `process.env.COWORK_EVENT_TOKEN`
// on every `/api/cowork/*` route, EXCEPT the public agent-discovery endpoints
// (bootstrap / manifest / agent / agent/version / skill) — those are
// intentionally public so external LLM agents can discover the cockpit's
// capabilities without first authenticating.
//
// Token rules:
//   • If `COWORK_EVENT_TOKEN` is unset: fail-closed with 401 (no safe default).
//   • If `COWORK_EVENT_TOKEN` equals the well-known `dev-token`: fail-closed
//     with 401 UNLESS `COWORK_ALLOW_DEV_TOKEN=1` is explicitly set (local
//     loopback dev only — never in production). `NODE_ENV` is NOT a safety net.
//   • If `COWORK_EVENT_TOKEN` is set to a real secret: require the
//     `X-Cowork-Token` header to match using a constant-time comparison.
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

const PUBLIC_DISCOVERY_PATHS = new Set<string>([
  '/api/cowork/agent/bootstrap',
  '/api/cowork/agent/manifest',
  '/api/cowork/agent',
  '/api/cowork/agent/version',
  '/api/cowork/skill',
]);

// Dev-mode placeholder — NOT a secret.
const DEV_TOKEN = 'dev-token';

/**
 * Module-level guard so the dev-token opt-in warning fires at most once per
 * server process. The message is identical on every request, so repeating it
 * adds no signal.
 */
let devTokenWarned = false;

/**
 * Constant-time string comparison using only Web Platform APIs (TextEncoder).
 *
 * F-15: previously this returned `false` the instant the byte lengths differed
 * (`if (a.length !== b.length) return false`), which is observable via timing
 * and could leak the expected token's length. Now, when the lengths differ, we
 * still run a full constant-time loop over the LONGER buffer (the shorter side
 * is padded with a fixed zero byte via the bounds check `i < x.length ? x[i] : 0`).
 * The `false` for a genuine length mismatch is computed AFTER the loop, so it
 * does not create a timing side-channel. Never throws.
 */
function tokensMatch(received: string | undefined, expected: string): boolean {
  if (typeof received !== 'string' || received.length === 0) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(received);
  const b = encoder.encode(expected);
  const len = Math.max(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    const x = i < a.length ? a[i] : 0; // pad the shorter side with a fixed byte
    const y = i < b.length ? b[i] : 0;
    diff |= x ^ y;
  }
  // Fold the length mismatch in AFTER the constant-time loop.
  return diff === 0 && a.length === b.length;
}

/**
 * Authenticate a protected `/api/cowork/*` request.
 *
 * Returns `null` when the request is authorized (caller should `next()`),
 * or a 401 `NextResponse` when it is not. Centralizes the dev-token rule
 * (F-05) and the constant-time token comparison (F-15).
 *
 * Token sources (validated with the SAME `tokensMatch`):
 *   • the `X-Cowork-Token` request header (all protected routes), and
 *   • for the SSE stream `/api/cowork/events/stream` ONLY, a `token` query
 *     param (F-42). Browser `EventSource` cannot send custom headers, so it
 *     always 401s on the header path; the query param lets a trusted browser
 *     (or server-to-server client) open the stream. The header path still
 *     works. The query token is validated against the exact same secret using
 *     the exact same constant-time compare — it is not a weaker path.
 */
function authenticate(req: NextRequest): NextResponse | null {
  const token = process.env.COWORK_EVENT_TOKEN;

  // F-05: the well-known default `dev-token` is only acceptable with an
  // EXPLICIT opt-in (`COWORK_ALLOW_DEV_TOKEN=1`) — e.g. for a local loopback
  // dev session. `NODE_ENV` is intentionally NOT treated as a safety net: an
  // unset, dev-token, or any non-production token value fails closed with 401
  // unless the operator has consciously opted in to the dev-token. A real
  // secret (anything other than the dev-token) is always required in
  // production.
  const allowDevToken = process.env.COWORK_ALLOW_DEV_TOKEN === '1';

  if (!token || (token === DEV_TOKEN && !allowDevToken)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  if (token === DEV_TOKEN && allowDevToken) {
    // Opt-in dev-token path — allowed, but logged once so the operator knows
    // the cockpit is running unauthenticated.
    if (!devTokenWarned) {
      devTokenWarned = true;
      console.warn(
        `[cowork-auth] COWORK_EVENT_TOKEN is the dev-token AND COWORK_ALLOW_DEV_TOKEN=1 — allowing the well-known default. NEVER set this in production.`,
      );
    }
    return null;
  }

  const receivedHeader = req.headers.get('x-cowork-token') ?? undefined;

  // F-42: SSE stream — also accept the token via a signed query param because
  // browser EventSource cannot set headers. Restricted to this one path so it
  // cannot be used to bypass header auth elsewhere.
  const isSse = req.nextUrl.pathname === '/api/cowork/events/stream';
  const receivedQuery = isSse ? (req.nextUrl.searchParams.get('token') ?? undefined) : undefined;

  const received = receivedHeader ?? receivedQuery;
  if (!tokensMatch(received, token)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  return null;
}

/**
 * Generate a request id. Reuses an inbound `x-request-id` when present so that
 * callers can correlate their logs with ours; otherwise mints a fresh UUID
 * (F-17). `crypto.randomUUID` is a Web Platform API available in the Edge
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

/** `NextResponse.next()` that also forwards `x-request-id` to downstream routes
 *  (so a route handler can read it via `req.headers` and pass it to
 *  `withRouteError`, threading one id end-to-end — F-17). */
function nextWithRequestId(req: NextRequest, requestId: string): NextResponse {
  const headers = new Headers(req.headers);
  headers.set('x-request-id', requestId);
  return withRequestId(NextResponse.next({ request: { headers } }), requestId);
}

export function middleware(req: NextRequest): NextResponse {
  const start = Date.now();
  const incoming = req.headers.get('x-request-id');
  const requestId = incoming && incoming.length > 0 ? incoming : newRequestId();

  const { pathname } = req.nextUrl;
  let res: NextResponse;
  if (PUBLIC_DISCOVERY_PATHS.has(pathname)) {
    res = nextWithRequestId(req, requestId);
  } else {
    const denied = authenticate(req);
    res = denied ? withRequestId(denied, requestId) : nextWithRequestId(req, requestId);
  }

  // F-17: structured request log (no secrets — path only, never the body).
  const durationMs = Date.now() - start;
  console.log('[cowork request]', requestId, req.method, pathname, res.status, `${durationMs}ms`);
  return res;
}

export const config = {
  matcher: ['/api/cowork/:path*'],
};
