//
// POST /api/cowork/events/emit
//   Body: { channel: string, payload: unknown }
//   Forwards to the cowork-events mini-service at http://localhost:3003/emit
//   which records the event in its in-memory buffer (last 1000) and emits it
//   on the matching socket.io channel to all connected clients.
//
// This route is for external HTTP callers (e.g. the browser extension) that
// need to broadcast events via the cockpit's API surface. For direct
// server-side use within Next.js API routes, prefer the `broadcastEvent`
// helper from `@/lib/cowork/events/client` to avoid the extra HTTP hop.

import type { NextRequest } from 'next/server';
import { json, badRequest, serverError, withRouteError, bodyJson } from '@/lib/cowork/api/http';
import { broadcastEvent } from '@/lib/cowork/events/client';

interface EmitBody {
  channel?: string;
  payload?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
    // `bodyJson` caps the raw body at MAX_BODY_BYTES (256KB) and rejects
    // oversize bodies with 413 *before* buffering — `req.json()` would read
    // the entire body into memory unbounded (memory-exhaustion DoS).
    const body = (await bodyJson(req)) as EmitBody;
    if (!body.channel || typeof body.channel !== 'string') {
      return badRequest('channel required (string)');
    }
    if (body.channel.length > 128) {
      return badRequest('channel must be at most 128 chars');
    }
    // Cap serialized payload size so an authenticated caller can't
    // broadcast multi-MB payloads to every connected WebSocket client
    // (which could OOM browser tabs or the mini-service's in-memory buffer).
    const PAYLOAD_MAX_BYTES = 64 * 1024; // 64KB
    const serialized = JSON.stringify(body.payload ?? null);
    if (serialized.length > PAYLOAD_MAX_BYTES) {
      return badRequest(`payload must be at most ${PAYLOAD_MAX_BYTES} bytes when serialized`);
    }
    const result = await broadcastEvent(body.channel, body.payload);
    if (!result.ok) {
      // `result.error` originates from the separate mini-service and may contain
      // internal detail; log it server-side and return a generic message rather
      // than echoing it to the client (consistent with withRouteError policy).
      console.error('[cowork] emit broadcast failed', { error: result.error });
      return serverError('event broadcast failed');
    }
    return json(result);
  });
}

export async function GET(): Promise<Response> {
  return json({
    route: '/api/cowork/events/emit',
    method: 'POST',
    body: { channel: 'string (required)', payload: 'any JSON (optional)' },
    response: '{ ok, id, channel }',
    note: 'For server-side callers, prefer importing broadcastEvent from @/lib/cowork/events/client directly.',
  });
}
