/**
 * Auth-contract smoke tests for cockpit API routes.
 *
 * The cockpit enforces `X-Cowork-Token` (or, for the SSE stream, a `?token=`
 * query param) on every `/api/cowork/*` route via `middleware`. These thin
 * tests assert the contract holds for the previously-untested routes:
 * - ai/image (proxy to the image-generation mini-service)
 * - events/stream (SSE proxy — query-token path, and NEVER logs the raw secret)
 * - security/events (Prisma-backed security event list)
 * - tabs / bookmarks (CRUD) — 401 without token, 200 with token.
 *
 * Pattern mirrors `src/middleware.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

function fakeReq(pathname: string, search = '', headers: Record<string, string> = {}): NextRequest {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return {
    nextUrl: { pathname, searchParams: new URLSearchParams(search) },
    headers: h,
    method: 'GET',
  } as NextRequest;
}

const REAL_TOKEN = 'contract-test-secret-token-xyz';
const ROUTES = [
  '/api/cowork/ai/image',
  '/api/cowork/events/stream',
  '/api/cowork/security/events',
  '/api/cowork/tabs',
  '/api/cowork/bookmarks',
];
const SSE = '/api/cowork/events/stream';

const ORIGINAL_ENV = { ...process.env };

describe('cockpit route auth contract', () => {
  beforeEach(() => {
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    process.env.COWORK_UI_TOKEN = REAL_TOKEN;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  for (const route of ROUTES) {
    it(`401s on ${route} without a token (fail-closed)`, async () => {
      expect(middleware(fakeReq(route)).status).toBe(401);
    });

    it(`200s on ${route} with a matching X-Cowork-Token header`, async () => {
      const res = middleware(fakeReq(route, '', { 'x-cowork-token': REAL_TOKEN }));
      expect(res.status).toBe(200);
    });
  }

  it('events/stream accepts a valid ?token= query param', async () => {
    expect(middleware(fakeReq(SSE, `token=${REAL_TOKEN}`)).status).toBe(200);
  });

  it('events/stream 401s on a wrong ?token= query param', async () => {
    expect(middleware(fakeReq(SSE, 'token=wrong')).status).toBe(401);
  });

  it('the raw stream token is NEVER logged in cleartext (redacted at log time)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Cover all console sinks so a leak through info/debug is also caught.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const res = middleware(fakeReq(SSE, `token=${REAL_TOKEN}`));
    expect(res.status).toBe(200);
    // Inspect every argument of every console sink — the "never logged"
    // guarantee covers all console sinks, not just console.log.
    for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(JSON.stringify(arg)).not.toContain(REAL_TOKEN);
        }
      }
    }
    // Sanity: the request log WAS emitted (so we actually exercised logging).
    expect(logSpy).toHaveBeenCalled();
  });
});
