/**
 * Auth-contract smoke tests for cockpit API routes.
 *
 * The cockpit enforces `X-Cowork-Token` (or, for the SSE stream, a `?token=`
 * query param) on every `/api/cowork/*` route via `middleware`. These thin
 * tests assert the contract holds for the token-gated data routes:
 * - ai/image (proxy to the image-generation mini-service)
 * - ai/chat (proxy to the chat mini-service)
 * - events/stream (SSE proxy — query-token path, and NEVER logs the raw secret)
 * - security/events (Prisma-backed security event list)
 * - tabs / bookmarks / sessions / workflows / pinboards / workspaces (CRUD)
 * - agents / agents/tasks / history / memory/site / memory/form
 * - extensions / extensions/log
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
  '/api/cowork/ai/chat',
  '/api/cowork/events/stream',
  '/api/cowork/security/events',
  '/api/cowork/tabs',
  '/api/cowork/bookmarks',
  '/api/cowork/sessions',
  '/api/cowork/workflows',
  '/api/cowork/agents',
  '/api/cowork/agents/tasks',
  '/api/cowork/history',
  '/api/cowork/memory/site',
  '/api/cowork/memory/form',
  '/api/cowork/pinboards',
  '/api/cowork/extensions',
  '/api/cowork/extensions/log',
  '/api/cowork/workspaces',
];
const SSE = '/api/cowork/events/stream';

const ORIGINAL_ENV = { ...process.env };

describe('cockpit route auth contract', () => {
  beforeEach(() => {
    delete process.env.COWORK_EVENT_TOKEN;
    delete process.env.COWORK_UI_TOKEN;
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    process.env.COWORK_UI_TOKEN = REAL_TOKEN;
    // Enable the opt-in structured request log (COWORK_REQUEST_LOG=1) so the
    // "raw stream token is NEVER logged" contract test actually exercises a log
    // sink (its sanity assertion requires at least one console call). The log
    // line is path-only, so the token-bearing query string never reaches any
    // console sink — the redaction guarantee is preserved.
    process.env.COWORK_REQUEST_LOG = '1';
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
    // Guard against the token being reflected back into any response header,
    // which would leak the secret to the caller even with clean console sinks.
    for (const value of res.headers.values()) {
      expect(value).not.toContain(REAL_TOKEN);
    }
    // Inspect every argument of every console sink — the "never logged"
    // guarantee covers all console sinks, not just console.log.
    for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(JSON.stringify(arg)).not.toContain(REAL_TOKEN);
        }
      }
    }
    // Sanity: the request log WAS emitted through at least one console sink
    // (so we actually exercised logging), without requiring a specific sink.
    expect(
      [logSpy, warnSpy, errorSpy, infoSpy, debugSpy].some((s) => s.mock.calls.length > 0),
    ).toBe(true);
  });
});
