/**
 * `ai/image` route handler tests.
 *
 * POST proxies to the cowork-events image-generation mini-service. We mock the
 * upstream `fetch` (no real network) and assert:
 *   - a well-formed prompt is forwarded and the upstream JSON is returned (200);
 *   - a non-OK upstream surfaces a sane 500 error envelope;
 *   - a missing/empty/oversized prompt is rejected with a 400 (badRequest);
 *   - an invalid size is rejected with a 400;
 *   - GET returns route metadata.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.COWORK_EVENT_TOKEN ||= 'test-image-token';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { POST, GET } from '@/app/api/cowork/ai/image/route';

function jsonReq(body: unknown): any {
  return {
    json: async () => body,
    nextUrl: { searchParams: new URLSearchParams() },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  fetchMock.mockReset();
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
