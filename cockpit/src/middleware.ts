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
//   • If neither `COWORK_UI_TOKEN` nor `COWORK_EVENT_TOKEN` is set: fail-closed
//     with 401 (no safe default). `COWORK_UI_TOKEN` is preferred; the
//     `COWORK_EVENT_TOKEN` fallback exists only for backward compatibility.
//   • If the resolved token equals the well-known `dev-token`: fail-closed
//     with 401 UNLESS `COWORK_ALLOW_DEV_TOKEN=1` is explicitly set AND the
//     deployment is not production (`NODE_ENV !== 'production'`). This keeps
//     the well-known default from ever authenticating the cockpit in prod.
//   • If the resolved token is set to a real secret: require the
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
 * Module-level guard so the S2S-secret UI-auth fallback warning fires at most
 * once per server process.
 */
let uiTokenWarned = false;

/**
 * Constant-time string comparison using only Web Platform APIs (TextEncoder).
 *
 * Always iterates the EXPECTED secret's length (never the received input's
 * length), so the iteration count cannot depend on attacker-controlled input
 * and therefore cannot leak the secret's length. A length mismatch is detected
 * but folded in AFTER the loop, avoiding a timing side-channel. Never throws.
 */
function tokensMatch(received: string | undefined, expected: string): boolean {
  if (typeof received !== 'string' || received.length === 0) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(received);
  const b = encoder.encode(expected);
  // Iterate over the EXPECTED secret's length only — never over the
  // attacker-controlled input length — so timing cannot reveal the secret's
  // byte length. A longer received input is simply ignored beyond `b.length`
  // (it can never equal the secret anyway).
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
 *   • the `X-Cowork-Token` request header (all protected routes), and
 *   • for the SSE stream `/api/cowork/events/stream` ONLY, a `token` query
 *     param. Browser `EventSource` cannot set custom headers, so it MUST use
 *     the `?token=` query param to open the stream; the `X-Cowork-Token`
 *     header path remains available for non-EventSource clients. The query
 *     token is validated against the exact same secret using the exact same
 *     constant-time compare — the *auth* is equally strong, only the *transport*
 *     (URL vs header) is weaker (see the EXPOSURE TRADE-OFF note at the handler).
 */
function authenticate(req: NextRequest): NextResponse | null {
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

  // Deprecation/risk guard: a deployment that sets only the service-to-service
  // `COWORK_EVENT_TOKEN` (and mirrors it into `NEXT_PUBLIC_COWORK_UI_TOKEN` so
  // the browser can authenticate) silently runs the UI on the S2S secret. If
  // that `NEXT_PUBLIC_*` mirror ever ships, the S2S secret is embedded in the
  // browser bundle. Warn once so operators learn to set a DISTINCT
  // `COWORK_UI_TOKEN`.
  if (!process.env.COWORK_UI_TOKEN && process.env.COWORK_EVENT_TOKEN && !uiTokenWarned) {
    uiTokenWarned = true;
    console.warn(
      '[cowork-auth] UI auth is falling back to the service-to-server COWORK_EVENT_TOKEN ' +
        'because COWORK_UI_TOKEN is unset. This risks embedding the S2S secret in the browser ' +
        'bundle (NEXT_PUBLIC_COWORK_UI_TOKEN). Set a distinct COWORK_UI_TOKEN.',
    );
  }

  // The well-known default `dev-token` is only acceptable with an
  // EXPLICIT opt-in (`COWORK_ALLOW_DEV_TOKEN=1`) — and ONLY when not running in
  // production (`NODE_ENV !== 'production'`). This adds a second, fail-closed
  // layer: even if an operator mistakenly sets the opt-in in a production
  // deployment, the publicly-documented dev-token still fails closed with 401.
  // A real secret (anything other than the dev-token) is always required in
  // production.
  // Explicit, fail-closed production determination: only the exact string
  // `'production'` counts as production. The dev-token opt-in is honored ONLY
  // outside production — in production the well-known default always fails
  // closed with 401, even if the opt-in is set.
  const isProduction = process.env.NODE_ENV === 'production';
  const allowDevToken =
    process.env.COWORK_ALLOW_DEV_TOKEN === '1' && !isProduction;

  if (!token || (token === DEV_TOKEN && !allowDevToken)) {
    console.warn(
      '[cowork-auth] 401 Unauthorized — no token configured, or dev-token used without the COWORK_ALLOW_DEV_TOKEN opt-in (or in production)',
      { path: req.nextUrl.pathname },
    );
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
      const devTokenVar =
        process.env.COWORK_UI_TOKEN === DEV_TOKEN
          ? 'COWORK_UI_TOKEN'
          : process.env.COWORK_EVENT_TOKEN === DEV_TOKEN
            ? 'COWORK_EVENT_TOKEN'
            : 'the resolved token';
      console.warn(
        `[cowork-auth] ${devTokenVar} is the dev-token AND COWORK_ALLOW_DEV_TOKEN=1 — allowing the well-known default. NEVER set this in production.`,
      );
    }
    return null;
  }

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
  const isSse = req.nextUrl.pathname === '/api/cowork/events/stream';
  const receivedQuery = isSse ? (req.nextUrl.searchParams.get('token') ?? undefined) : undefined;

  const received = receivedHeader ?? receivedQuery;
  if (!tokensMatch(received, token)) {
    console.warn('[cowork-auth] 401 Unauthorized — token mismatch', {
      path: req.nextUrl.pathname,
      ip: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown',
    });
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 },
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

/** `NextResponse.next()` that also forwards `x-request-id` to downstream routes
 *  (so a route handler can read it via `req.headers` and pass it to
 *  `withRouteError`, threading one id end-to-end). */
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

  // Structured request log (no secrets — path only, never the body).
  const durationMs = Date.now() - start;
  console.log('[cowork request]', requestId, req.method, pathname, res.status, `${durationMs}ms`);
  return res;
}

export const config = {
  matcher: ['/api/cowork/:path*'],
};
