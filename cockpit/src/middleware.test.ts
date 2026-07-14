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

  it('rejects an over-length token (>1024 chars) before the constant-time compare', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const tooLong = `${REAL_TOKEN}${'x'.repeat(2000)}`;
    const res = middleware(fakeReq(PROTECTED, '', { 'x-cowork-token': tooLong }));
    expect(res.status).toBe(401);
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

  it('does NOT honor the query-token path on non-SSE protected routes', async () => {
    process.env.COWORK_EVENT_TOKEN = REAL_TOKEN;
    const { middleware } = await import('@/middleware');
    const res = middleware(fakeReq(PROTECTED, `token=${REAL_TOKEN}`));
    expect(res.status).toBe(401);
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
