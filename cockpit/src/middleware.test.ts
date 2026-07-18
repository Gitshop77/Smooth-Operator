import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// Import after we set up env stubs — middleware reads process.env at call time.
// Typed as `NextRequest` instead of `any` so shape drift in the helper
// is caught by tsc. The object is cast because `NextRequest` carries many
// runtime-only members the tests don't need.
//
// `method` is parameterized (default GET) so protected non-GET routes
// (POST/DELETE) can be exercised — the middleware enforces the token on every
// method, so this proves the gate is not accidentally GET-only.
function fakeReq(
  pathname: string,
  search = '',
  headers: Record<string, string> = {},
  method = 'GET',
): NextRequest {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return {
    nextUrl: {
      pathname,
      searchParams: new URLSearchParams(search),
    },
    headers: h,
    method,
  } as NextRequest;
}

const REAL_TOKEN = 'super-secret-token-abc123';
const PUBLIC = '/api/cowork/agent/manifest';
const PROTECTED = '/api/cowork/tabs';
const SSE = '/api/cowork/events/stream';

const ORIGINAL_ENV = { ...process.env };

describe('middleware token enforcement', () => {
  beforeEach(() => {
 // Reset the module registry so the middleware's module-level warn-once
 // guards (devTokenWarned, uiTokenWarned, noTokenWarned, mismatchWarned,
 // pairingWarned) start fresh per test and cannot leak state across tests.
    vi.resetModules();
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('fails closed (401) when COWORK_EVENT_TOKEN is unset', async () => {
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('fails closed (401) on the well-known dev-token without explicit opt-in', async () => {
    process.env.COWORK_EVENT_TOKEN = 'dev-token';
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('allows the dev-token ONLY when COWORK_ALLOW_DEV_TOKEN=1', async () => {
    process.env.COWORK_EVENT_TOKEN = 'dev-token';
    process.env.COWORK_ALLOW_DEV_TOKEN = '1';
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(200);
  });

  it('fails closed (401) when COWORK_ALLOW_DEV_TOKEN is "true" (not exact "1")', async () => {
    process.env.COWORK_EVENT_TOKEN = 'dev-token';
    process.env.COWORK_ALLOW_DEV_TOKEN = 'true';
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('fails closed (401) when COWORK_ALLOW_DEV_TOKEN is "yes" (not exact "1")', async () => {
    process.env.COWORK_EVENT_TOKEN = 'dev-token';
    process.env.COWORK_ALLOW_DEV_TOKEN = 'yes';
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('returns 401 when a real token is set but no header is presented', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('returns 200 when the X-Cowork-Token header matches (constant-time path)', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': REAL_TOKEN }));
    expect(res.status).toBe(200);
  });

  it('returns 401 when the presented token is wrong', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': 'wrong-token' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when the presented token is a strict PREFIX of the real token', async () => {
 // A shorter received value that byte-matches the start of the secret must
 // still fail: the constant-time compare folds the length mismatch in.
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const prefix = REAL_TOKEN.slice(0, REAL_TOKEN.length - 1);
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': prefix }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when the presented token is the real token plus extra trailing bytes (over-length)', async () => {
 // A received value longer than the secret that shares every secret byte
 // must still fail — the extra bytes beyond the secret length are not
 // silently ignored into a false match.
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const overLength = `${REAL_TOKEN}extra`;
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': overLength }));
    expect(res.status).toBe(401);
  });

  it('rejects an over-length token (beyond the fixed cap) before the constant-time compare', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const tooLong = `${REAL_TOKEN}${'x'.repeat(9000)}`;
    expect(tooLong.length).toBeGreaterThan(8192);
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': tooLong }));
    expect(res.status).toBe(401);
  });

  it('still authenticates a legitimately configured secret under the fixed cap', async () => {
    // A legitimately configured operator secret (here >1024 chars, still well
    // under the fixed MAX_TOKEN_CHARS cap) must authenticate; the cap only
    // rejects attacker input beyond the fixed floor, never the legit secret.
    const longSecret = `${REAL_TOKEN}${'y'.repeat(1200)}`;
    expect(longSecret.length).toBeGreaterThan(1024);
    expect(longSecret.length).toBeLessThanOrEqual(8192);
    process.env.COWORK_EVENT_TOKEN = longSecret;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': longSecret }));
    expect(res.status).toBe(200);
  });

  it('returns 401 when the presented token is an empty string', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': '' }));
    expect(res.status).toBe(401);
  });

  it('fails closed (401) on the dev-token even with opt-in when NODE_ENV=production', async () => {
 // The second fail-closed layer: a mis-set opt-in in production must NOT
 // authenticate the well-known dev-token.
    process.env.COWORK_EVENT_TOKEN = 'dev-token';
    process.env.COWORK_ALLOW_DEV_TOKEN = '1';
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('fails closed (401) on the dev-token even with opt-in when NODE_ENV is blank/unset', async () => {
    // A blank/unset NODE_ENV must fail closed with 401 even when the dev-token
    // opt-in is set (the `nodeEnv.length > 0` guard in middleware.ts).
    process.env.COWORK_EVENT_TOKEN = 'dev-token';
    process.env.COWORK_ALLOW_DEV_TOKEN = '1';
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('fails closed (401) on the dev-token with opt-in when NODE_ENV is an unrecognized value (e.g. staging)', async () => {
    // The dev-token is honored ONLY when NODE_ENV matches the explicit
    // development allowlist (development|dev|local|test). Any other value —
    // such as `staging` — must fail closed with 401 even with the opt-in set.
    process.env.COWORK_EVENT_TOKEN = 'dev-token';
    process.env.COWORK_ALLOW_DEV_TOKEN = '1';
    (process.env as Record<string, string | undefined>).NODE_ENV = 'staging';
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('falls back to COWORK_EVENT_TOKEN when COWORK_UI_TOKEN is empty/unset', async () => {
 // Prefer the explicit UI secret when set, but when it is empty/undefined the
 // legacy COWORK_EVENT_TOKEN must still authenticate (backward compat).
    process.env.COWORK_UI_TOKEN = '';
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': REAL_TOKEN }));
    expect(res.status).toBe(200);
  });

  it('enforces the token on non-GET protected routes (POST with valid token → 200)', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(
      fakeReq(PROTECTED, '', { 'x-cowork-token': REAL_TOKEN }, 'POST'),
    );
    expect(res.status).toBe(200);
  });

  it('enforces the token on non-GET protected routes (DELETE without token → 401)', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', {}, 'DELETE'));
    expect(res.status).toBe(401);
  });

  it('bypasses auth for public-discovery routes regardless of token', async () => {
    delete process.env.COWORK_EVENT_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PUBLIC));
    expect(res.status).toBe(200);
  });

  it('bypasses auth for public-discovery routes with a trailing slash (normalized)', async () => {
    delete process.env.COWORK_EVENT_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PUBLIC + '/'));
    expect(res.status).toBe(200);
  });

  it('still 401s unknown paths that merely resemble discovery routes', async () => {
    delete process.env.COWORK_EVENT_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PUBLIC + '/sub'));
    expect(res.status).toBe(401);
  });

  it('fails closed (401) on uppercase-spoofed public-discovery paths', async () => {
    delete process.env.COWORK_EVENT_TOKEN;
    const { middleware } = await import('@/middleware');
    expect(middleware(fakeReq('/api/cowork/AGENT/manifest')).status).toBe(401);
    expect(middleware(fakeReq('/api/cowork/Agent/Manifest')).status).toBe(401);
  });

  it('SSE stream 401s from a browser EventSource (no header, no query token)', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(SSE));
    expect(res.status).toBe(401);
  });

  it('SSE stream accepts a valid `token` query param and keeps the header path working', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
 // query-param path
    const viaQuery = middleware(fakeReq(SSE, `token=${REAL_TOKEN}`));
    expect(viaQuery.status).toBe(200);
 // header path still works for SSE
    const viaHeader = middleware(fakeReq(SSE, '', { 'x-cowork-token': REAL_TOKEN }));
    expect(viaHeader.status).toBe(200);
 // wrong query token → 401
    const badQuery = middleware(fakeReq(SSE, 'token=nope'));
    expect(badQuery.status).toBe(401);
  });

  it('SSE stream honors a trailing-slash normalized path with ?token=', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
 // trailing slash appended by a proxy/base-path must not break ?token= auth
    const ok = middleware(fakeReq(SSE + '/', `token=${REAL_TOKEN}`));
    expect(ok.status).toBe(200);
    const bad = middleware(fakeReq(SSE + '/', 'token=nope'));
    expect(bad.status).toBe(401);
  });

  it('does NOT honor the query-token path on non-SSE protected routes', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, `token=${REAL_TOKEN}`));
    expect(res.status).toBe(401);
  });
});

describe('middleware request logging never leaks the SSE bearer token', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    // The structured request log is opt-in (gated behind COWORK_REQUEST_LOG=1)
    // so it does not emit a line per request in production by default. Enable it
    // here so the logging assertions below actually exercise the log path —
    // the log line is path-only (never the token-bearing query string), so the
    // "token never leaks" guarantee is preserved.
    process.env.COWORK_REQUEST_LOG = '1';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('never writes the ?token= bearer secret to the request log for an authorized SSE request', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = middleware(fakeReq(SSE, `token=${REAL_TOKEN}`));
      expect(res.status).toBe(200);
      const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).not.toContain(REAL_TOKEN);
      expect(logged).toContain(SSE);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs only the pathname (not the query string) for a protected request carrying ?token=', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      middleware(fakeReq(PROTECTED, `token=${REAL_TOKEN}`));
      const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).not.toContain(REAL_TOKEN);
      expect(logged).toContain(PROTECTED);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('middleware x-request-id reflection and sanitization', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('echoes a valid inbound x-request-id back on an authorized response', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(
      fakeReq(PROTECTED, '', { 'x-cowork-token': REAL_TOKEN, 'x-request-id': 'abc-123' }),
    );
    expect(res.headers.get('x-request-id')).toBe('abc-123');
  });

  it('replaces a malicious inbound x-request-id with a freshly minted id', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
 // Header value with spaces (rejected by the correlation-id allowlist) — not
 // raw CRLF, which the test's own Headers.set would throw on.
    const malicious = 'bad injected value';
    const res = middleware(
      fakeReq(PROTECTED, '', { 'x-cowork-token': REAL_TOKEN, 'x-request-id': malicious }),
    );
    const reflected = res.headers.get('x-request-id');
    expect(reflected).not.toBe(malicious);
    expect(reflected).toBeTruthy();
  });

  it('replaces an over-length inbound x-request-id with a freshly minted id', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const tooLong = 'a'.repeat(200);
    const res = middleware(
      fakeReq(PROTECTED, '', { 'x-cowork-token': REAL_TOKEN, 'x-request-id': tooLong }),
    );
    expect(res.headers.get('x-request-id')).not.toBe(tooLong);
  });
});

describe('middleware UI token: COWORK_UI_TOKEN is preferred and independent', () => {
 // A distinct value from REAL_TOKEN so we can prove the UI secret is NOT the
 // service-to-service COWORK_EVENT_TOKEN.
  const UI_TOKEN = 'ui-only-secret-token-xyz789';

  beforeEach(() => {
    vi.resetModules();
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('fails closed (401) when only COWORK_UI_TOKEN is unset', async () => {
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
  });

  it('accepts a matching X-Cowork-Token when COWORK_UI_TOKEN is set (COWORK_EVENT_TOKEN unset)', async () => {
    process.env.COWORK_UI_TOKEN = UI_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': UI_TOKEN }));
    expect(res.status).toBe(200);
  });

  it('rejects a wrong header when COWORK_UI_TOKEN is set', async () => {
    process.env.COWORK_UI_TOKEN = UI_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': 'wrong' }));
    expect(res.status).toBe(401);
  });

  it('treats a leaked COWORK_EVENT_TOKEN as useless when COWORK_UI_TOKEN is set (independence)', async () => {
    process.env.COWORK_UI_TOKEN = UI_TOKEN;
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN; // a leaked S2S token
    const { middleware } = await import('@/middleware');
 // Presenting the service-to-service token on the UI surface must NOT auth.
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': REAL_TOKEN }));
    expect(res.status).toBe(401);
 // The real UI token still works.
    const ok = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': UI_TOKEN }));
    expect(ok.status).toBe(200);
  });

  it('fails closed (401) when COWORK_UI_TOKEN === COWORK_EVENT_TOKEN (both set equal, S2S secret in bundle)', async () => {
    process.env.COWORK_UI_TOKEN = REAL_TOKEN;
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    process.env.NEXT_PUBLIC_COWORK_UI_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': REAL_TOKEN }));
    expect(res.status).toBe(401);
    const sse = middleware(fakeReq(SSE, `token=${REAL_TOKEN}`));
    expect(sse.status).toBe(401);
  });

  it('SSE stream honors COWORK_UI_TOKEN via header and ?token= query param', async () => {
    process.env.COWORK_UI_TOKEN = UI_TOKEN;
    const { middleware } = await import('@/middleware');
 // header path
    const viaHeader = middleware(fakeReq(SSE, '', { 'x-cowork-token': UI_TOKEN }));
    expect(viaHeader.status).toBe(200);
 // query-param path (browser EventSource cannot send headers)
    const viaQuery = middleware(fakeReq(SSE, `token=${UI_TOKEN}`));
    expect(viaQuery.status).toBe(200);
 // wrong query token → 401
    const badQuery = middleware(fakeReq(SSE, 'token=nope'));
    expect(badQuery.status).toBe(401);
  });
});

describe('tokensMatch constant-time cap invariant', () => {
  it('gates rejection only on the fixed cap, never on the secret length', async () => {
    const { tokensMatch, MAX_TOKEN_CHARS } = await import('@/middleware');
    // Pin the cap so the no-secret-length-early-return fix cannot be silently
    // reverted to a secret-dependent branch.
    expect(MAX_TOKEN_CHARS).toBe(8192);

    const secret = 'a'.repeat(40);
    // The constant-time loop always runs for input within the cap: a received
    // value one byte shorter, an exact-length wrong byte, or one byte longer
    // than the secret never throws and is never rejected on a secret-length
    // condition — it is decided solely by the loop + length fold.
    expect(tokensMatch('a'.repeat(39), secret)).toBe(false); // N-1 (prefix, wrong)
    expect(tokensMatch('b'.repeat(40), secret)).toBe(false); // N (wrong bytes)
    expect(tokensMatch('a'.repeat(41), secret)).toBe(false); // N+1 (over-length)
    expect(tokensMatch('a'.repeat(40), secret)).toBe(true); // exact match

    // Rejection beyond the fixed cap is independent of the secret length:
    // identical behavior for a short secret and a longer (but still capped)
    // secret proves the gate is the fixed floor, not the secret's length.
    const longSecret = 'a'.repeat(2000); // >1024, still under the cap
    expect(longSecret.length).toBeGreaterThan(1024);
    expect(longSecret.length).toBeLessThanOrEqual(MAX_TOKEN_CHARS);

    const atCap = 'x'.repeat(MAX_TOKEN_CHARS);
    const overCap = 'x'.repeat(MAX_TOKEN_CHARS + 1);
    expect(tokensMatch(atCap, secret)).toBe(false);
    expect(tokensMatch(overCap, secret)).toBe(false);
    expect(tokensMatch(atCap, longSecret)).toBe(false);
    expect(tokensMatch(overCap, longSecret)).toBe(false);
  });
});

describe('middleware per-request CSP nonce on HTML page responses (G10 guard)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('emits a per-request content-security-policy with a nonce and connect-src self on a page response', async () => {
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq('/some-page'));
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain('nonce-');
    expect(csp).toContain("connect-src 'self'");
  });

  it('mints a fresh nonce per page response (no nonce reuse across requests)', async () => {
    const { middleware } = await import('@/middleware');
    const first = middleware(fakeReq('/some-page')).headers.get('content-security-policy') ?? '';
    const second = middleware(fakeReq('/some-page')).headers.get('content-security-policy') ?? '';
    const firstNonce = (first.match(/nonce-([a-f0-9-]+)/) || [])[1];
    const secondNonce = (second.match(/nonce-([a-f0-9-]+)/) || [])[1];
    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
  });
});

describe('middleware baseline security response headers', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('includes nosniff and no-referrer on a 401 response', async () => {
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED));
    expect(res.status).toBe(401);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('includes nosniff and no-referrer on a page response', async () => {
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq('/some-page'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('middleware brute-force throttle (checkRateLimit via the middleware path)', () => {
  // `checkRateLimit` is module-private but is exercised on every failed auth
  // through `middleware` (it runs before the constant-time compare). We probe it
  // via the integration path so no application SOURCE is modified. Each test
  // uses `vi.resetModules()` + `await import` to get a FRESH module instance,
  // which also gives a fresh module-level `rateBuckets` Map — this isolates the
  // fixed-window counter between tests without needing a source-side reset hook
  // (the throttle state would otherwise leak across files; see MASTER #617).
  beforeEach(() => {
    vi.resetModules();
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });

  it('returns 429 only after RATE_LIMIT_MAX failed attempts from one IP, and still serves a different IP', async () => {
    const { middleware, RATE_LIMIT_MAX } = await import('@/middleware');
    const ip = '203.0.113.9'; // TEST-NET-3 — deterministic, does not collide with other tests
    const headers = { 'x-cowork-token': 'wrong', 'x-forwarded-for': ip };
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = middleware(fakeReq(PROTECTED, '', headers));
      expect(res.status).toBe(401); // allowed through the throttle, rejected on the token
    }
    // The (MAX+1)-th failed attempt from the SAME ip is throttled.
    const throttled = middleware(fakeReq(PROTECTED, '', headers));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBeTruthy();
    // A distinct IP gets its own bucket and is NOT throttled (fails only on token).
    const other = middleware(
      fakeReq(PROTECTED, '', { 'x-cowork-token': 'wrong', 'x-forwarded-for': '198.51.100.7' }),
    );
    expect(other.status).toBe(401);
  });

  it('resets the failure window after RATE_LIMIT_WINDOW_MS so the throttle is not permanent', async () => {
    const { middleware, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } = await import('@/middleware');
    const ip = '203.0.113.10';
    const headers = { 'x-cowork-token': 'wrong', 'x-forwarded-for': ip };
    vi.useFakeTimers();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      middleware(fakeReq(PROTECTED, '', headers));
    }
    expect(middleware(fakeReq(PROTECTED, '', headers)).status).toBe(429);
    // Advance past the fixed window; the bucket must reset to a fresh window.
    vi.setSystemTime(new Date(t0.getTime() + RATE_LIMIT_WINDOW_MS + 1000));
    const after = middleware(fakeReq(PROTECTED, '', headers));
    expect(after.status).toBe(401); // allowed again, then fails on the token
  });
});

describe('public-discovery routes do not reflect secrets', () => {
  // These 5 paths are intentionally exempt from the X-Cowork-Token gate so
  // external LLM agents can discover the cockpit. They MUST NOT reflect any
  // COWORK_* secret, DATABASE_URL, or per-user data in their responses. The
  // route handlers themselves were manually reviewed and contain no references
  // to process.env secrets or DATABASE_URL; this contract test pins the
  // middleware passthrough so a future regression that injects secrets into the
  // bypass response is caught.
  const PUBLIC = [
    '/api/cowork/agent/bootstrap',
    '/api/cowork/agent/manifest',
    '/api/cowork/agent',
    '/api/cowork/agent/version',
    '/api/cowork/skill',
  ];
  const SENTINEL_TOKEN = 'm11-sentinel-secret-do-not-leak';
  const SENTINEL_DB = 'postgres://m11:supersecret@db.internal:5432/cockpit';

  beforeEach(() => {
    vi.resetModules();
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    // Stamp known secrets so a leak would be observable in the response.
    process.env.COWORK_UI_TOKEN = SENTINEL_TOKEN;
    process.env.COWORK_EVENT_TOKEN = SENTINEL_TOKEN;
    process.env.DATABASE_URL = SENTINEL_DB;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  for (const path of PUBLIC) {
    it(`bypasses auth on ${path} and reflects no COWORK_* secret or DATABASE_URL`, async () => {
      const { middleware } = await import('@/middleware');
      const res = middleware(fakeReq(path));
      expect(res.status).toBe(200);
      for (const value of res.headers.values()) {
        expect(value).not.toContain(SENTINEL_TOKEN);
        expect(value).not.toContain(SENTINEL_DB);
      }
      // The bypass must not echo a token back via an injected header.
      expect(res.headers.get('x-cowork-token')).toBeNull();
    });
  }

  it('keeps the singular /api/cowork/agent public but plural /api/cowork/agents protected', async () => {
    const { middleware } = await import('@/middleware');
    expect(middleware(fakeReq('/api/cowork/agent')).status).toBe(200);
    expect(middleware(fakeReq('/api/cowork/agents')).status).toBe(401);
    expect(
      middleware(fakeReq('/api/cowork/agents', '', { 'x-cowork-token': SENTINEL_TOKEN })).status,
    ).toBe(200);
  });
});
