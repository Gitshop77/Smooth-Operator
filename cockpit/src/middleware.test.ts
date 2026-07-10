import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Import after we set up env stubs — middleware reads process.env at call time.
// Typed as `NextRequest` (F-31) instead of `any` so shape drift in the helper
// is caught by tsc. The object is cast because `NextRequest` carries many
// runtime-only members the tests don't need.
function fakeReq(pathname: string, search = '', headers: Record<string, string> = {}): NextRequest {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return {
    nextUrl: {
      pathname,
      searchParams: new URLSearchParams(search),
    },
    headers: h,
    method: 'GET',
  } as NextRequest;
}

const REAL_TOKEN = 'super-secret-token-abc123';
const PUBLIC = '/api/cowork/agent/manifest';
const PROTECTED = '/api/cowork/tabs';
const SSE = '/api/cowork/events/stream';

const ORIGINAL_ENV = { ...process.env };

describe('middleware token enforcement (F-15 / F-05 / F-42)', () => {
  beforeEach(() => {
    delete process.env.COWORK_EVENT_TOKEN;
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

  it('SSE stream accepts a valid `token` query param (F-42) and keeps the header path working', async () => {
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
