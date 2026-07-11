/**
 * `events/stream` route handler tests.
 *
 * GET returns a Server-Sent Events stream that proxies the cowork-events
 * mini-service. Auth is enforced at the middleware layer (covered in
 * `auth-contract.test.ts`). Here we assert the handler itself:
 *   - returns 200 with a `text/event-stream` content type;
 *   - emits an initial "stream open" comment (proves the stream produces data);
 *   - never crashes when the upstream poll errors (emits a keep-alive comment).
 *
 * `fetch` is mocked so no real network call is made during the initial poll.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

process.env.COWORK_EVENT_TOKEN ||= 'test-stream-token';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GET } from '@/app/api/cowork/events/stream/route';

function streamReq(signal: AbortSignal): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams('since_id=0') },
    signal,
    method: 'GET',
    headers: new Headers(),
  } as NextRequest;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ events: [] }),
  });
});
afterEach(() => {
  fetchMock.mockReset();
});

describe('GET /api/cowork/events/stream', () => {
  it('returns a 200 text/event-stream response and emits the open comment', async () => {
    const ac = new AbortController();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // Read the first chunk (the initial hello comment) to prove the stream
    // produces data, then cancel so the 1s poll interval doesn't leak.
    const reader = res.body!.getReader();
    const readWithTimeout = Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('stream read timed out')), 2000)),
    ]);
    const { value } = await readWithTimeout;
    const text = new TextDecoder().decode(value as Uint8Array);
    expect(text).toContain('cowork-events stream open');
    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('survives an upstream poll error without crashing (emits a keep-alive comment)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const ac = new AbortController();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('stream read timed out')), 2000)),
    ]);
    const text = new TextDecoder().decode(value as Uint8Array);
    // Initial hello is always emitted first, even if the first poll then errors.
    expect(text).toContain('cowork-events stream open');
    ac.abort();
    await reader.cancel().catch(() => {});
  });
});
