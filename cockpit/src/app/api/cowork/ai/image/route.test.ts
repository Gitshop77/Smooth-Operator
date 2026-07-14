/**
 * `ai/image` route handler tests.
 *
 * POST proxies to the cowork-events image-generation mini-service. We mock the
 * upstream `fetch` (no real network) and assert:
 * - a well-formed prompt is forwarded and the upstream JSON is returned (200);
 * - a non-OK upstream surfaces a sane 500 error envelope;
 * - a missing/empty/oversized prompt is rejected with a 400 (badRequest);
 * - an invalid size is rejected with a 400;
 * - GET returns route metadata.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `getCoworkEventsToken()` prefers COWORK_UI_TOKEN and only falls back to
// COWORK_EVENT_TOKEN. Delete the UI token so the service-to-service token below
// is the one actually forwarded (otherwise a stray COWORK_UI_TOKEN in the
// environment would shadow it and break the `X-Cowork-Token` assertion).
// `getCoworkEventsToken()` prefers COWORK_UI_TOKEN and only falls back to
// COWORK_EVENT_TOKEN. Stub the UI token empty so the service-to-service token
// below is the one actually forwarded (otherwise a stray COWORK_UI_TOKEN in the
// environment would shadow it and break the `X-Cowork-Token` assertion).
// Scoped via vi.stubEnv so it is restored after the suite and does not leak
// into other test files.
vi.stubEnv('COWORK_UI_TOKEN', '');
vi.stubEnv('COWORK_EVENT_TOKEN', 'test-image-token');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { POST, GET } from '@/app/api/cowork/ai/image/route';

// The route reads the body via `bodyJson(req)` (which consumes `req.body` as a
// ReadableStream, not `req.json()`) and reads `req.headers.get('x-request-id')`
// both inside the handler and as the `withRouteError` correlation id — so the
// mock request MUST expose a real `body` stream and a `headers.get`.
function jsonReq(body: unknown, headers: Record<string, string> = {}): any {
  const text = JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams() },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
});

describe('POST /api/cowork/ai/image', () => {
  it('forwards a valid prompt and returns the upstream payload', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, base64: 'AAAA', prompt: 'a cat', size: '1024x1024', bytes: 3 }),
    });
    const res = await POST(jsonReq({ prompt: 'a cat' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.base64).toBe('AAAA');
 // The upstream fetch must have been called with the server-to-server token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/image');
    expect(init.headers['X-Cowork-Token']).toBe('test-image-token');
    expect(JSON.parse(init.body).prompt).toBe('a cat');
  });

  it('returns 400 when the prompt is missing/empty', async () => {
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('prompt required');
  });

  it('returns 400 when the prompt exceeds 4000 chars', async () => {
    const res = await POST(jsonReq({ prompt: 'x'.repeat(4001) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('4000');
  });

  it('returns 400 for an unsupported size', async () => {
    const res = await POST(jsonReq({ prompt: 'ok', size: '999x999' as never }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('size must be one of');
  });

  it('forwards a valid size in the upstream body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, base64: 'AAAA', prompt: 'a cat', size: '768x1344', bytes: 3 }),
    });
    const res = await POST(jsonReq({ prompt: 'a cat', size: '768x1344' }));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/image');
    expect(JSON.parse(init.body).size).toBe('768x1344');
  });

  it('returns a 500 error envelope on a non-OK upstream', async () => {
 // A long upstream detail (>200 chars) to prove the route does NOT echo it
 // verbatim — it is truncated via `.slice(0, 200)` in the serverError.
    const longDetail = 'upstream image service failure detail ' + 'x'.repeat(500);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => longDetail,
    });
    const res = await POST(jsonReq({ prompt: 'a cat' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('503');
 // The error envelope is bounded — the full upstream detail is truncated,
 // not echoed whole to the client.
    expect(body.error.length).toBeLessThan(longDetail.length);
    expect(body.error).not.toContain('x'.repeat(500));
  });

  it('returns a 500 error envelope when the upstream is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await POST(jsonReq({ prompt: 'a cat' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('cowork-events unreachable');
  });
});

describe('GET /api/cowork/ai/image', () => {
  it('returns route metadata', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.route).toBe('/api/cowork/ai/image');
    expect(body.method).toBe('POST');
    expect(body.body.prompt).toBeDefined();
  });
});
