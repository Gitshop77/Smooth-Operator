//
// GET /api/cowork/events/stream?since_id=N
//   Returns a Server-Sent Events (SSE) stream that proxies the cowork-events
//   mini-service. Long-running consumers can subscribe to this stream to
//   receive every event the mini-service broadcasts (tab:updated,
//   network:request, security:event, etc.).
//
// Implementation: the mini-service exposes `GET /events?since_id=N` which
// returns the buffered events as a single JSON payload. We poll that endpoint
// every second, emit each new event as an SSE message, and update `since_id`.
// A `:ping` comment is sent every 15s to keep the connection alive through
// proxies.

import type { NextRequest } from 'next/server';
import { COWORK_EVENTS_BASE, getCoworkEventsToken } from '@/lib/cowork/events/client';

interface BufferedEvent {
  id: number;
  channel: string;
  payload: unknown;
  ts: number;
}

const POLL_INTERVAL_MS = 1_000;
const PING_INTERVAL_MS = 15_000;

// Force Node.js runtime — the route uses `setInterval`, `req.signal`, and a
// long-lived `ReadableStream`, none of which are reliable on the Edge runtime.
export const runtime = 'nodejs';
// Disable static optimization — this is a streaming route.
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const sinceIdParam = req.nextUrl.searchParams.get('since_id');
  let sinceId = parseInt(sinceIdParam || '0', 10);
  if (!Number.isFinite(sinceId) || sinceId < 0) sinceId = 0;

  const encoder = new TextEncoder();

  // Lift `closed` + `interval` to the outer scope so BOTH `start()` and
  // `cancel()` can reach them. Previously they lived inside `start()`, which
  // meant `cancel()` (fired when a consumer explicitly cancels the
  // ReadableStream without `req.signal` aborting) couldn't clear the
  // interval — the 1s poll leaked indefinitely.
  let closed = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  // Guard so only one `poll()` runs at a time. `setInterval` does not await the
  // `async` poll, so a slow mini-service could otherwise start a second poll
  // before the first settles — both would query the same `?since_id` and emit
  // duplicate SSE events.
  let inFlight = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastPing = Date.now();

      const safeEnqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Stream is broken — mark closed + clear the interval so the poll
          // closure is released immediately (don't wait for req.signal).
          closed = true;
          if (interval) {
            clearInterval(interval);
            interval = null;
          }
        }
      };

      // Register the abort listener BEFORE the initial `await poll()` so
      // a client disconnect during the first poll (which takes up to 1s
      // against a slow mini-service) is observed. Previously the listener
      // was registered after `await poll()` + `setInterval`, which meant
      // an abort during the initial poll was missed (Node.js AbortSignal
      // does not re-fire `abort` for listeners added after the signal
      // aborted) and the 1s `setInterval` leaked indefinitely, buffering
      // events into a dead stream.
      const onAbort = () => {
        closed = true;
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (req.signal.aborted) {
        onAbort();
        return;
      }
      req.signal.addEventListener('abort', onAbort, { once: true });

      // Initial hello so the client knows the stream is alive.
      safeEnqueue(`: cowork-events stream open since_id=${sinceId}\n\n`);

      const poll = async (): Promise<void> => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          // The cowork-events mini-service requires `X-Cowork-Token` on
          // every route except `/health`. Send the server-side token (NOT
          // the NEXT_PUBLIC_ one — this is a server→server fetch).
          const res = await fetch(
            `${COWORK_EVENTS_BASE}/events?since_id=${sinceId}`,
            {
              cache: 'no-store',
              headers: { 'X-Cowork-Token': getCoworkEventsToken() },
            },
          );
          if (res.ok) {
            const data = (await res.json()) as { events?: BufferedEvent[] };
            const events = Array.isArray(data.events) ? data.events : [];
            for (const evt of events) {
              if (evt.id > sinceId) sinceId = evt.id;
              const sseId = String(evt.id);
              const sseEvent = evt.channel.replace(/[\r\n]/g, ' ');
              const sseData = JSON.stringify({ id: evt.id, channel: evt.channel, payload: evt.payload, ts: evt.ts });
              safeEnqueue(`id: ${sseId}\nevent: ${sseEvent}\ndata: ${sseData}\n\n`);
            }
          }
        } catch {
          // Network hiccup — emit a comment so the client knows we're still alive.
          safeEnqueue(`: poll error at ${new Date().toISOString()}\n\n`);
        } finally {
          // Release the guard so the next interval tick can run a new poll.
          inFlight = false;
        }

        // Throttled keep-alive ping.
        if (Date.now() - lastPing >= PING_INTERVAL_MS) {
          safeEnqueue(`: ping ${new Date().toISOString()}\n\n`);
          lastPing = Date.now();
        }
      };

      // Initial fetch so the client doesn't wait a full interval.
      await poll();

      // Re-check abort after the initial poll — the abort listener may
      // have fired during `await poll()`.
      if (closed || req.signal.aborted) {
        onAbort();
        return;
      }

      interval = setInterval(poll, POLL_INTERVAL_MS);
    },
    cancel() {
      // Consumer explicitly cancelled the stream. Clear the polling interval
      // + mark closed so any in-flight `poll()` early-returns. Without this,
      // a cancel without an `req.signal` abort leaks the 1s `setInterval`.
      closed = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  });

  // The cockpit dashboard is same-origin — it does not need a wildcard
  // `Access-Control-Allow-Origin: '*'` header. Cross-origin EventSource
  // connections could otherwise silently exfiltrate every cockpit event. If
  // a specific cross-origin client must be supported, set
  // `process.env.COWORK_BASE_URL` and reflect it here.
  const allowOrigin = process.env.COWORK_BASE_URL || null;

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx etc.)
      ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    },
  });
}
