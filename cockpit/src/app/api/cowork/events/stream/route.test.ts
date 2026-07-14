/**
 * `events/stream` route handler tests.
 *
 * GET returns a Server-Sent Events stream that bridges the cowork-events
 * mini-service's realtime socket.io feed. Auth is enforced at the middleware
 * layer (covered in `auth-contract.test.ts`). Here we assert the handler itself:
 * - returns 200 with a `text/event-stream` content type;
 * - emits an initial "stream open" comment (proves the stream produces data);
 * - surfaces an upstream socket.io failure as an observable `: upstream error`
 * comment instead of a silently-dead-but-"alive" stream.
 *
 * `socket.io-client` is mocked so no real socket connection is opened. The mock
 * captures the lifecycle handlers the route registers (`connect_error`, etc.) so
 * a test can drive them directly and assert the resulting SSE output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

process.env.COWORK_EVENT_TOKEN ||= 'test-stream-token';

// A fake socket.io client that records the handlers the route registers via
// `.on(event, cb)` so tests can synchronously fire connection-lifecycle events.
interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  onAny: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emitLifecycle: (event: string, ...args: unknown[]) => void;
}

let lastSocket: FakeSocket | null = null;

// `vi.mock` factories are hoisted above ALL other module-level statements, so a
// factory that closes over a `const ioMock` declared later would hit a temporal
// dead zone (`Cannot access 'ioMock' before initialization`). `vi.hoisted`
// lifts the mock implementation to the very top so it is initialized before the
// factory runs. `lastSocket` is set inside the fake only when it is invoked (at
// test time), well after the module-level `let` below is initialized.
const { ioMock } = vi.hoisted(() => {
  const ioMock = vi.fn((): FakeSocket => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const socket: FakeSocket = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers.set(event, cb);
        return socket;
      }),
      onAny: vi.fn(() => socket),
      removeAllListeners: vi.fn(() => socket),
      disconnect: vi.fn(() => socket),
      emitLifecycle: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    };
    lastSocket = socket;
    return socket;
  });
  return { ioMock };
});

vi.mock('socket.io-client', () => ({ io: ioMock }));

import { GET } from '@/app/api/cowork/events/stream/route';

function streamReq(signal: AbortSignal): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams('since_id=0') },
    signal,
    method: 'GET',
    headers: new Headers(),
  } as NextRequest;
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    reader.read(),
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error('stream read timed out')), 2000);
    }),
  ]).finally(() => clearTimeout(t));
}

beforeEach(() => {
  ioMock.mockClear();
  lastSocket = null;
});
afterEach(() => {
  ioMock.mockClear();
  lastSocket = null;
});

describe('GET /api/cowork/events/stream', () => {
  it('returns a 200 text/event-stream response and emits the open comment', async () => {
    const ac = new AbortController();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

 // Read the first chunk (the initial hello comment) to prove the stream
 // produces data, then cancel so the socket.io client + ping interval don't
 // leak.
    const reader = res.body!.getReader();
    const { value } = await readWithTimeout(reader);
    const text = new TextDecoder().decode(value as Uint8Array);
    expect(text).toContain('cowork-events stream open');
    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('surfaces an upstream socket.io connect error as an observable comment', async () => {
    const ac = new AbortController();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);

 // The route opens a socket.io client and registers a `connect_error`
 // handler; the mock captured it. Drive that failure and assert the stream
 // emits a `: upstream error ...` comment instead of going silently dead.
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(lastSocket).not.toBeNull();

    const reader = res.body!.getReader();
 // Initial hello is always emitted first, before any connection outcome.
    const first = await readWithTimeout(reader);
    expect(new TextDecoder().decode(first.value as Uint8Array)).toContain(
      'cowork-events stream open',
    );

 // Now simulate the upstream socket.io connection failing.
    lastSocket!.emitLifecycle('connect_error', new Error('ECONNREFUSED'));
    const second = await readWithTimeout(reader);
    const text = new TextDecoder().decode(second.value as Uint8Array);
    expect(text).toContain('upstream error');
    expect(text).toContain('ECONNREFUSED');

    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('returns 200 and emits nothing when the request is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);
    // No socket is opened when the request is already aborted.
    expect(ioMock).not.toHaveBeenCalled();
    const reader = res.body!.getReader();
    const { value, done } = await readWithTimeout(reader);
    expect(done).toBe(true);
    expect(value).toBeUndefined();
    await reader.cancel().catch(() => {});
  });
});
