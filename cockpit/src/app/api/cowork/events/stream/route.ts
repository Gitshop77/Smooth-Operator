//
// GET /api/cowork/events/stream?since_id=N
// Returns a Server-Sent Events (SSE) stream that proxies the cowork-events
// mini-service. Long-running consumers can subscribe to this stream to
// receive every event the mini-service broadcasts (tab:updated,
// network:request, security:event, etc.).
//
// Implementation: the mini-service already runs a realtime socket.io server
// (`mini-services/cowork-events/index.ts`) that pushes events the instant they
// are recorded. This route opens a server-side socket.io client to that
// service and bridges every pushed event straight into the SSE `ReadableStream`
// — true push, with no polling loop and no per-second fetch/JSON-parse waste.
//
// A `:ping` comment is still sent every 15s to keep the SSE connection alive
// through idle periods (proxies), and a `: upstream error ...` comment is
// emitted whenever the socket.io connection fails (auth error, mini-service
// down, etc.) so a misconfiguration is observable instead of producing a
// silently-dead-but-"alive" stream.

import type { NextRequest } from 'next/server';
import { io as ioClient, type Socket } from 'socket.io-client';
import { getCoworkEventsToken, getValidatedEventsBase } from '@/lib/cowork/events/client';
import { redactSecrets } from '@/lib/cowork/api/http';

interface BufferedEvent {
  id: number;
  channel: string;
  payload: unknown;
  ts: number;
}

// Keep-alive ping cadence (idle SSE connections get closed by proxies otherwise).
const PING_INTERVAL_MS = 15_000;

// socket.io event names that are transport/reserved and must NEVER be forwarded
// as business SSE events. `system:status` is the mini-service's 15s heartbeat
// (excluded from the buffered replay history upstream) and `events:replay` is
// handled separately as a hydration batch — neither belongs in the live SSE feed.
const RESERVED_EVENTS = new Set<string>([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
  'ping',
  'pong',
  'error',
  'reconnect',
  'reconnect_attempt',
  'reconnect_error',
  'reconnect_failed',
  'reconnecting',
  'flush',
  'drain',
  'system:status',
  'events:replay',
]);

// Force Node.js runtime — the route holds a long-lived socket.io client, a
// long-lived `ReadableStream`, and `req.signal`, none of which are reliable on
// the Edge runtime.
export const runtime = 'nodejs';
// Disable static optimization — this is a streaming route.
export const dynamic = 'force-dynamic';

// Bound concurrent SSE streams so a single authenticated caller (or a stolen
// token) cannot open an unbounded number of long-lived socket.io clients plus
// 15s keep-alive timers, exhausting mini-service socket slots, cockpit memory,
// and file descriptors. Mirrors the per-token concurrency cap (R014 F7).
const MAX_CONCURRENT_STREAMS = 50;
let activeStreams = 0;

export async function GET(req: NextRequest): Promise<Response> {
  const sinceIdParam = req.nextUrl.searchParams.get('since_id');
  let sinceId = parseInt(sinceIdParam || '0', 10);
  if (!Number.isFinite(sinceId) || sinceId < 0) sinceId = 0;

 // Fail closed on a misconfigured relay target. `getValidatedEventsBase`
 // refuses non-http(s) / credentialed / secret-shaped bases and returns ''
 // for them. A bad base would otherwise point the socket.io client at an
 // unexpected host — refuse rather than leaking the handshake token there.
  const eventsBase = getValidatedEventsBase();
  if (!eventsBase) {
    return new Response('event relay base misconfigured', {
      status: 502,
      headers: { 'Retry-After': '5' },
    });
  }

  // Atomic check-then-increment: bump the counter first and reject (and roll
  // back) only if we've exceeded the cap. This closes the TOCTOU window where a
  // concurrent request could read `activeStreams` before our increment and both
  // pass the `<` check. The matching decrement lives in `teardown()`.
  if (++activeStreams > MAX_CONCURRENT_STREAMS) {
    activeStreams -= 1;
    return new Response('too many concurrent streams', {
      status: 503,
      headers: { 'Retry-After': '5' },
    });
  }

  const encoder = new TextEncoder();

 // Lift `closed` + `socket` + `pingInterval` to the outer scope so BOTH
 // `start()` and `cancel()` can reach them and tear the interval/socket down
 // (otherwise a consumer-cancelled stream leaks the 1s poll and socket.io client).
  let closed = false;
  let released = false;
  let socket: Socket | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  // Backpressure: when the SSE consumer reads slower than the upstream emits,
  // hold chunks here and only flush them on `pull()`, instead of letting the
  // stream's internal queue grow without bound. The buffer is bounded so a
  // stalled consumer cannot grow cockpit memory without limit.
  const MAX_PENDING_CHUNKS = 1024;
  let pendingChunks: string[] = [];
  let drainResolve: (() => void) | null = null;
  let drainWaiter: Promise<void> | null = null;

 // Release every long-lived resource this stream owns. Hoisted to the GET scope
 // so BOTH `start()` and `cancel()` tear down identically. Also detaches the
 // `req.signal` abort listener so it doesn't linger after teardown.
  const teardown = (): void => {
    if (released) return;
    released = true;
    activeStreams = Math.max(0, activeStreams - 1);
    closed = true;
    req.signal.removeEventListener('abort', onAbort);
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    if (drainResolve) {
      const r = drainResolve;
      drainResolve = null;
      drainWaiter = null;
      r();
    }
  };

 // Client disconnect (or explicit cancel) handler.
  const onAbort = (): void => {
    teardown();
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
    async start(ctrl) {
      controller = ctrl;
 // Resolve the server-side token WITHOUT letting a missing secret throw
 // out of `start()` (which would crash the whole stream before any bytes
 // are sent). If unset, `token` stays `''` and the connect attempt will
 // surface a `connect_error` below — observable, not silent.
      let token = '';
      try {
        token = getCoworkEventsToken();
      } catch {
        token = '';
      }

      const safeEnqueue = async (chunk: string): Promise<void> => {
        if (closed) return;
        const ctrl = controller;
        if (ctrl && ctrl.desiredSize !== null && ctrl.desiredSize <= 0) {
          // Consumer is behind: hold the chunk under backpressure rather than
          // growing the stream's internal queue without bound, and wait for
          // `pull()` to flush it.
          pendingChunks.push(chunk);
          if (pendingChunks.length > MAX_PENDING_CHUNKS) {
            // Hard overflow — the consumer is not keeping up and the buffer
            // would grow without limit. Terminate the stream; the client can
            // reconnect with ?since_id= to resume the sequence.
            closed = true;
            teardown();
            try {
              ctrl.error(new Error('events/stream backpressure overflow'));
            } catch {
              /* already closed/errored */
            }
            return;
          }
          if (!drainResolve) {
            drainWaiter = new Promise<void>((resolve) => {
              drainResolve = resolve;
            });
          }
          await drainWaiter;
          return;
        }
        try {
          controller?.enqueue(encoder.encode(chunk));
        } catch {
 // Stream is broken — mark closed + release the socket + ping timer so
 // the socket.io client is torn down immediately (don't wait for
 // req.signal). Also terminate the ReadableStream explicitly so it does
 // not linger "silently-dead-but-alive" if `req.signal` abort never
 // fires.
          closed = true;
          teardown();
          try {
            controller?.error(new Error('events/stream broken transport'));
          } catch {
            /* already closed/errored */
          }
        }
      };

 // Register the abort listener BEFORE opening the socket so a client
 // disconnect is observed even if it happens during the (async) handshake.
      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener('abort', onAbort, { once: true });

 // Initial hello so the client knows the stream is alive.
      safeEnqueue(`: cowork-events stream open since_id=${sinceId}\nretry: 3000\n\n`);

 // Emit a single buffered event as an SSE message, but ONLY if its id is
 // strictly greater than the cursor. This guards against the upstream
 // contract ever becoming inclusive-at-boundary or replaying buffered
 // events: without the guard, the same event would be re-emitted on every
 // hydration and surface as duplicate SSE messages to consumers.
      const emitEvent = (evt: BufferedEvent): void => {
        if (typeof evt?.id !== 'number' || !Number.isFinite(evt.id)) return;
        if (evt.id <= sinceId) return;
        sinceId = evt.id;
        const sseId = String(evt.id);
        const sseEvent = String(evt.channel).replace(/[\r\n]/g, ' ');
        const redactedPayload = JSON.parse(redactSecrets(JSON.stringify(evt.payload ?? null)));
        const sseData = JSON.stringify({
          id: evt.id,
          channel: evt.channel,
          payload: redactedPayload,
          ts: typeof evt.ts === 'number' ? evt.ts : Date.now(),
        });
        safeEnqueue(`id: ${sseId}\nevent: ${sseEvent}\ndata: ${sseData}\n\n`);
      };

 // Hydration: the mini-service sends the last 50 buffered events as a
 // single `events:replay` batch on connect. Forward only those past the
 // cursor (handles resume via `?since_id=`).
      const forwardReplay = (events: unknown): void => {
        if (!Array.isArray(events)) return;
        for (const evt of events as BufferedEvent[]) {
          emitEvent(evt);
        }
      };

 // Connect to the mini-service's socket.io server. The server authenticates
 // the handshake with `COWORK_UI_TOKEN` / `COWORK_EVENT_TOKEN` (the same
 // secret `getCoworkEventsToken()` resolves), passed via the handshake
 // `auth` and `query` so a failed token produces a `connect_error` here
 // (and NOT a silent dead stream). `path: '/'` MUST match the mini-service's
 // hardcoded socket.io path. socket.io auto-reconnects with exponential
 // backoff, which also satisfies the "back off before the next attempt"
 // guidance for a broken upstream.
      socket = ioClient(eventsBase, {
        path: '/',
        auth: { token },
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 5_000,
        transports: ['websocket', 'polling'],
      });

 // Connection lifecycle observability.
      socket.on('connect', () => {
        console.warn('[cowork] events/stream connected to cowork-events service');
      });
      socket.on('connect_error', (err: Error) => {
 // Surface the failure: log server-side AND emit a comment so the client
 // can see the stream is unhealthy (misconfigured token, mini-service
 // down, etc.) instead of a perpetually-empty-but-"alive" stream. Redact
 // the upstream message so handshake/URL/secret-shaped text never lands in
 // server logs or the client stream.
        const msg = redactSecrets(String(err?.message || 'unknown')).replace(/[\r\n]/g, ' ');
        console.error(`[cowork] events/stream socket connect_error: ${msg}`);
        safeEnqueue(`: upstream error ${new Date().toISOString()} ${msg}\n\n`);
      });
      socket.on('disconnect', (reason: string) => {
 // A mid-session disconnect is expected during mini-service restarts;
 // socket.io will reconnect. Log at warn so it's visible but not noise.
        if (!closed) {
          console.warn(`[cowork] events/stream socket disconnected: ${reason}`);
        }
      });
      socket.on('error', (err: Error) => {
        console.error(`[cowork] events/stream socket error: ${redactSecrets(String(err?.message || 'unknown'))}`);
      });

 // Hydration batch.
      socket.on('events:replay', forwardReplay);

 // Catch-all forwarder. The mini-service emits
 // `io.emit(channel, payload, { id, ts })`; socket.io-client delivers that
 // as `(payload, meta)` where `meta = { id, ts }`. Forward every business
 // channel as an SSE message, skipping reserved/transport events and the
 // heartbeat/replay channels handled above.
      socket.onAny((event: string, ...args: unknown[]) => {
        if (RESERVED_EVENTS.has(event)) return;
 // The mini-service broadcasts as `io.emit(channel, payload, { id, ts })`,
 // so the sequence id lives in the second argument (`meta`), never in the
 // business payload. Rely solely on `meta.id`: a payload may itself carry
 // an `id` field (e.g. a tab/agent id) that is NOT the event-sequence id,
 // and forwarding it as the SSE `id:` would corrupt resume ordering.
        const meta = args[1] as { id?: number; ts?: number } | undefined;
        if (typeof meta?.id !== 'number') return; // can't order/forward without an id
        const payload = args[0];
        const ts = typeof meta.ts === 'number' ? meta.ts : Date.now();
        emitEvent({ id: meta.id, channel: event, payload, ts });
      });

 // Throttled keep-alive ping so proxies don't time out an idle stream.
      pingInterval = setInterval(() => {
        if (closed) return;
        safeEnqueue(`: ping ${new Date().toISOString()}\n\n`);
      }, PING_INTERVAL_MS);
    },
    pull() {
      // Consumer wants more data: flush anything buffered under backpressure,
      // then release the waiters so their held chunks flow through.
      if (pendingChunks.length > 0) {
        const batch = pendingChunks;
        pendingChunks = [];
        for (const c of batch) {
          if (closed) break;
          try {
            controller?.enqueue(encoder.encode(c));
          } catch {
            closed = true;
            teardown();
            try {
              controller?.error(new Error('events/stream broken transport'));
            } catch {
              /* already closed/errored */
            }
            break;
          }
        }
      }
      if (drainResolve) {
        const resolve = drainResolve;
        drainResolve = null;
        drainWaiter = null;
        resolve();
      }
    },
    cancel() {
 // Consumer explicitly cancelled the stream. Tear down the socket.io client
 // + ping timer so no resource leaks after the consumer goes away.
      teardown();
    },
    },
    // Allow a few chunks to buffer before applying backpressure, so a briefly
    // slow consumer doesn't trip the overflow path on every burst.
    { highWaterMark: 64 },
  );

 // The cockpit dashboard is same-origin — it does not need a wildcard
 // `Access-Control-Allow-Origin: '*'` header. Cross-origin EventSource
 // connections could otherwise silently exfiltrate every cockpit event. If
 // a specific cross-origin client must be supported, set
 // `process.env.COWORK_BASE_URL` and reflect it here.
 //
 // Only reflect a *real* origin: reject '*' (would widen the auth-gated
 // stream cross-origin) and any non-origin URL. Restrict to https, while
 // still permitting a plain http://localhost origin so local dev CORS keeps
 // working without disabling CORS entirely. Anything else reflects `null`,
 // so no `Access-Control-Allow-Origin` header is emitted.
  const allowOrigin = (() => {
    const v = process.env.COWORK_BASE_URL;
    if (!v || v === '*') return null;
    try {
      const u = new URL(v);
      const isLocalhost =
        u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocalhost)) {
        return u.origin;
      }
      return null;
    } catch {
      return null;
    }
  })();

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx etc.)
      'Vary': 'Origin',
      ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    },
  });
}
