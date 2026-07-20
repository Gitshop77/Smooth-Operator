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
  emitAny: (event: string, ...args: unknown[]) => void;
}

let lastSocket: FakeSocket | null = null;

// Track every stream the test opens so `afterEach` can guarantee teardown even
// if a test returns before calling `ac.abort()`/`reader.cancel()`. This closes
// the SSE response + its underlying socket.io client + 15s keep-alive interval
// so no real handle is left open (the root cause of the open-handle warnings).
const openAcs: AbortController[] = [];
const openReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];

function makeAc(): AbortController {
  const ac = new AbortController();
  openAcs.push(ac);
  return ac;
}

// `vi.mock` factories are hoisted above ALL other module-level statements, so a
// factory that closes over a `const ioMock` declared later would hit a temporal
// dead zone (`Cannot access 'ioMock' before initialization`). `vi.hoisted`
// lifts the mock implementation to the very top so it is initialized before the
// factory runs. `lastSocket` is set inside the fake only when it is invoked (at
// test time), well after the module-level `let` below is initialized.
const { ioMock } = vi.hoisted(() => {
  const ioMock = vi.fn((): FakeSocket => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let anyHandler: ((event: string, ...args: unknown[]) => void) | null = null;
    const socket: FakeSocket = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers.set(event, cb);
        return socket;
      }),
      onAny: vi.fn((cb: (event: string, ...args: unknown[]) => void) => {
        anyHandler = cb;
        return socket;
      }),
      removeAllListeners: vi.fn(() => socket),
      disconnect: vi.fn(() => socket),
      emitLifecycle: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
      emitAny: (event: string, ...args: unknown[]) => anyHandler?.(event, ...args),
    };
    lastSocket = socket;
    return socket;
  });
  return { ioMock };
});

vi.mock('socket.io-client', () => ({ io: ioMock }));

import { GET } from '@/app/api/cowork/events/stream/route';

function streamReq(signal: AbortSignal, sinceId = '0'): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(`since_id=${sinceId}`) },
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

// Narrow the (nullable) Response body / captured socket without a non-null
// assertion, throwing a clear message if the invariant is somehow violated.
function bodyReader(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error('expected a streaming response body');
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  openReaders.push(reader);
  return reader;
}
function requireSocket(): FakeSocket {
  if (!lastSocket) throw new Error('expected socket.io client to have been opened');
  return lastSocket;
}

beforeEach(() => {
  // Fake the clock so the route's 15s keep-alive `setInterval` becomes a fake
  // timer — no real handles that could leak between tests. `setTimeout` /
  // `clearTimeout` are intentionally LEFT REAL (excluded from `toFake`) so the
  // test's own 2s `readWithTimeout` safety timer can actually fire and surface a
  // clear failure instead of being frozen by the fake clock. `Date` is
  // intentionally left real so timestamp assertions in the SSE output still work.
  vi.useFakeTimers({
    toFake: ['setInterval', 'setImmediate', 'clearInterval', 'clearImmediate'],
  });
  ioMock.mockClear();
  lastSocket = null;
  openAcs.length = 0;
  openReaders.length = 0;
});
afterEach(() => {
  // Close any stream/response the test didn't already tear down, so no real
  // socket.io client or 15s keep-alive interval is left open. Order: cancel the
  // reader (drains/errors the stream → teardown) then abort the request signal.
  for (const r of openReaders) void r.cancel().catch(() => {});
  for (const ac of openAcs) ac.abort();
  openReaders.length = 0;
  openAcs.length = 0;
  ioMock.mockClear();
  lastSocket = null;
  // Discard any pending fake timers; restore the real clock for the next test.
  vi.useRealTimers();
});

describe('GET /api/cowork/events/stream', () => {
  it('returns a 200 text/event-stream response and emits the open comment', async () => {
    const ac = makeAc();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

 // Read the first chunk (the initial hello comment) to prove the stream
 // produces data, then cancel so the socket.io client + ping interval don't
 // leak.
    const reader = bodyReader(res);
    const { value } = await readWithTimeout(reader);
    const text = new TextDecoder().decode(value as Uint8Array);
    expect(text).toContain('cowork-events stream open');
    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('surfaces an upstream socket.io connect error as an observable comment', async () => {
    const ac = makeAc();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);

 // The route opens a socket.io client and registers a `connect_error`
 // handler; the mock captured it. Drive that failure and assert the stream
 // emits a `: upstream error ...` comment instead of going silently dead.
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(lastSocket).not.toBeNull();

    const reader = bodyReader(res);
 // Initial hello is always emitted first, before any connection outcome.
    const first = await readWithTimeout(reader);
    expect(new TextDecoder().decode(first.value as Uint8Array)).toContain(
      'cowork-events stream open',
    );

 // Now simulate the upstream socket.io connection failing.
    requireSocket().emitLifecycle('connect_error', new Error('ECONNREFUSED'));
    const second = await readWithTimeout(reader);
    const text = new TextDecoder().decode(second.value as Uint8Array);
    expect(text).toContain('upstream error');
    expect(text).toContain('ECONNREFUSED');

    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('returns 200 and emits nothing when the request is already aborted', async () => {
    const ac = makeAc();
    ac.abort();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);
    // No socket is opened when the request is already aborted.
    expect(ioMock).not.toHaveBeenCalled();
    const reader = bodyReader(res);
    const { value, done } = await readWithTimeout(reader);
    expect(done).toBe(true);
    expect(value).toBeUndefined();
    await reader.cancel().catch(() => {});
  });

  it('drops replayed events at/below since_id and forwards those strictly above', async () => {
    const ac = makeAc();
    const res = await GET(streamReq(ac.signal, '10'));
    expect(res.status).toBe(200);
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(lastSocket).not.toBeNull();

    const reader = bodyReader(res);
    // Initial hello is always emitted first. It echoes the cursor so we can
    // prove since_id=10 was parsed (not the default 0).
    const first = await readWithTimeout(reader);
    expect(new TextDecoder().decode(first.value as Uint8Array)).toContain(
      'cowork-events stream open since_id=10',
    );

    // Hydrate a batch spanning the cursor: id 5 must be suppressed (<= 10),
    // id 11 must be forwarded (strictly greater).
    requireSocket().emitLifecycle('events:replay', [
      { id: 5, channel: 'tab:updated', payload: {} },
      { id: 11, channel: 'tab:updated', payload: {} },
    ]);
    const second = await readWithTimeout(reader);
    const text = new TextDecoder().decode(second.value as Uint8Array);
    expect(text).not.toContain('id: 5');
    expect(text).toContain('id: 11');

    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('treats a non-numeric since_id as 0 and forwards id 1', async () => {
    const ac = makeAc();
    const res = await GET(streamReq(ac.signal, 'abc'));
    expect(res.status).toBe(200);

    const reader = bodyReader(res);
    const first = await readWithTimeout(reader);
    expect(new TextDecoder().decode(first.value as Uint8Array)).toContain(
      'cowork-events stream open since_id=0',
    );

    requireSocket().emitLifecycle('events:replay', [
      { id: 1, channel: 'tab:updated', payload: {} },
    ]);
    const second = await readWithTimeout(reader);
    const text = new TextDecoder().decode(second.value as Uint8Array);
    expect(text).toContain('id: 1');

    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('redacts secret-shaped payloads on live-forwarded events', async () => {
    const ac = makeAc();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);
    expect(lastSocket).not.toBeNull();

    const reader = bodyReader(res);
    // Drain the initial hello comment first.
    await readWithTimeout(reader);

    // A live business event whose payload carries a Bearer token. The
    // mini-service delivers `(payload, meta)`; the sequence id lives in meta.
    requireSocket().emitAny(
      'security:event',
      { note: 'Authorization: Bearer sekritTokenValue' },
      { id: 7, ts: 123 },
    );
    const evt = await readWithTimeout(reader);
    const text = new TextDecoder().decode(evt.value as Uint8Array);
    expect(text).toContain('***');
    expect(text).not.toContain('sekritTokenValue');

    ac.abort();
    await reader.cancel().catch(() => {});
  });

  it('returns 503 with Retry-After once the concurrent-stream cap is reached', async () => {
    const MAX = 50;
    const controllers: AbortController[] = [];
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < MAX; i += 1) {
      const ac = makeAc();
      controllers.push(ac);
      const res = await GET(streamReq(ac.signal));
      expect(res.status).toBe(200);
      readers.push(bodyReader(res));
    }

    // The next stream is over the cap: rejected without opening a socket.
    const overAc = makeAc();
    const over = await GET(streamReq(overAc.signal));
    expect(over.status).toBe(503);
    expect(over.headers.get('Retry-After')).toBe('5');

    // Release the held streams so the module-level counter resets for other tests.
    for (const ac of controllers) ac.abort();
    for (const r of readers) await r.cancel().catch(() => {});
  });

  it('errors the stream when the backpressure buffer overflows', async () => {
    const ac = makeAc();
    const res = await GET(streamReq(ac.signal));
    expect(res.status).toBe(200);
    expect(lastSocket).not.toBeNull();

    // Never read: the internal queue fills, desiredSize drops to <=0, and every
    // further chunk is held in the bounded pending buffer. Emit well past the
    // 1024-chunk cap to trip the hard-overflow termination.
    const reader = bodyReader(res);
    for (let i = 1; i <= 1200; i += 1) {
      requireSocket().emitAny('tab:updated', { n: i }, { id: i, ts: 1 });
    }

    let overflowed = false;
    try {
      for (;;) {
        const { done } = await readWithTimeout(reader);
        if (done) break;
      }
    } catch (err) {
      overflowed = true;
      expect(String((err as Error).message)).toContain('backpressure overflow');
    }
    expect(overflowed).toBe(true);

    ac.abort();
    await reader.cancel().catch(() => {});
  });
});
