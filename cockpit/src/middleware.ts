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

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (PUBLIC_DISCOVERY_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const token = process.env.COWORK_EVENT_TOKEN;

  // F-05: the well-known default `dev-token` is only acceptable with an
  // EXPLICIT opt-in (`COWORK_ALLOW_DEV_TOKEN=1`) — e.g. for a local loopback
  // dev session. `NODE_ENV` is intentionally NOT treated as a safety net: an
  // unset, dev-token, or any non-production token value fails closed with 401
  // unless the operator has consciously opted in to the dev-token. A real
  // secret (anything other than the dev-token) is always required in
  // production. Fail-closed for missing/weak tokens; otherwise verify the
  // presented `X-Cowork-Token` against the configured secret.
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
    return NextResponse.next();
  }

  const received = req.headers.get('x-cowork-token') ?? undefined;
  if (!tokensMatch(received, token)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/cowork/:path*'],
};
