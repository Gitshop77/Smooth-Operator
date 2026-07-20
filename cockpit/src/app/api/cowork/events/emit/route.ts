//
// POST /api/cowork/events/emit
// Body: { channel: string, payload: unknown }
// Forwards to the cowork-events mini-service at http://localhost:3003/emit
// which records the event in its in-memory buffer (last 1000) and emits it
// on the matching socket.io channel to all connected clients.
//
// This route is for external HTTP callers (e.g. the browser extension) that
// need to broadcast events via the cockpit's API surface. For direct
// server-side use within Next.js API routes, prefer the `broadcastEvent`
// helper from `@/lib/cowork/events/client` to avoid the extra HTTP hop.

import type { NextRequest } from 'next/server';
import { json, badRequest, serverError, withRouteError, bodyJson, redactSecrets } from '@/lib/cowork/api/http';
import { broadcastEvent } from '@/lib/cowork/events/client';
import { tokensMatch } from '@/proxy';

interface EmitBody {
  channel?: string;
  payload?: unknown;
}

// Channels the cockpit mini-service reserves for server-originated events.
// The mini-service's *socket* emit ingress (mini-services/cowork-events/index.ts)
// rejects these for client sockets; this HTTP ingress must enforce the SAME
// boundary so any caller holding a valid `X-Cowork-Token` cannot impersonate
// server status/chat streams via the API. Keep this set in sync with the
// `SERVER_OWNED_CHANNELS` deny-list in the mini-service.
const SERVER_OWNED_CHANNELS = new Set<string>([
  'system:status',
  'events:replay',
  'chat:message',
  'chat:done',
  'chat:error',
]);

// Cap serialized payload size (see the size check below).
const PAYLOAD_MAX_BYTES = 64 * 1024; // 64KB

/**
 * Require a valid `X-Cowork-Token` header. This route previously relied on a
 * middleware that does not exist, so any caller could broadcast events. Resolve
 * the expected secret the same way the shared cockpit auth does:
 * COWORK_UI_TOKEN (preferred) → COWORK_EVENT_TOKEN → the well-known `dev-token`
 * in zero-config mode. Uses the constant-time `tokensMatch` compare.
 */
function requireCoworkToken(req: NextRequest): Response | null {
  const header = req.headers.get("X-Cowork-Token") ?? undefined;
  const uiToken =
    process.env.COWORK_UI_TOKEN && process.env.COWORK_UI_TOKEN.length > 0
      ? process.env.COWORK_UI_TOKEN
      : undefined;
  const eventToken =
    process.env.COWORK_EVENT_TOKEN && process.env.COWORK_EVENT_TOKEN.length > 0
      ? process.env.COWORK_EVENT_TOKEN
      : undefined;
  const expected = uiToken ?? eventToken ?? "dev-token";
  if (!tokensMatch(header, expected)) {
    return json(
      { error: "Unauthorized" },
      401,
      { "WWW-Authenticate": 'Bearer realm="cowork"' },
    );
  }
  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  return withRouteError(async () => {
 // Authenticate before doing any work (this route previously had no auth).
    const authFailure = requireCoworkToken(req);
    if (authFailure) return authFailure;
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
 // Screen control/null bytes so a crafted channel can't forge log lines
 // or confuse downstream socket.io channel routing.
    if (/[\x00-\x1f\x7f]/.test(body.channel)) {
      return badRequest('channel contains invalid characters');
    }
 // Enforce the same character-set whitelist the mini-service's /emit ingress
 // applies (CHANNEL_PATTERN=[A-Za-z0-9:_-]). Rejecting dot/space/etc. here
 // gives the caller a clear 400 instead of forwarding to the mini-service
 // which 400s and yields a generic "event broadcast failed". Keep this in
 // sync with the mini-service boundary.
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(body.channel)) {
      return badRequest('channel must match [A-Za-z0-9:_-] and be 1-128 chars');
    }
 // Reject server-owned channels so a token holder cannot impersonate
 // server-originated status/chat streams (mirrors the socket ingress guard).
    if (SERVER_OWNED_CHANNELS.has(body.channel)) {
      return badRequest('channel is reserved for server-originated events');
    }
 // Cap serialized payload size so an authenticated caller can't
 // broadcast multi-MB payloads to every connected WebSocket client
 // (which could OOM browser tabs or the mini-service's in-memory buffer).
    let serialized: string;
    try {
 // A payload with a circular reference or a BigInt makes `JSON.stringify`
 // throw synchronously; surfacing that as a clean 400 (instead of an
 // opaque 500) also closes the 64KB size-gate bypass the throw would
 // otherwise cause.
      serialized = JSON.stringify(body.payload ?? null);
    } catch {
      return badRequest('payload is not JSON-serializable');
    }
 // Measure UTF-8 byte length, not UTF-16 code-unit count: a payload of
 // CJK/emoji text is 1 code unit but 3-4 UTF-8 bytes, so counting `.length`
 // (code units) would over-permit the real serialized size by ~3x.
    if (Buffer.byteLength(serialized, 'utf8') > PAYLOAD_MAX_BYTES) {
      return badRequest(`payload must be at most ${PAYLOAD_MAX_BYTES} bytes when serialized`);
    }
    const safePayload = JSON.parse(redactSecrets(serialized));
    const result = await broadcastEvent(body.channel, safePayload);
    if (!result.ok) {
 // `result.error` originates from the separate mini-service and may contain
 // internal detail or secret-shaped text from an upstream failure body; log
 // it server-side (redacted) and return a generic message rather than
 // echoing it to the client (consistent with withRouteError policy).
      console.error('[cowork] emit broadcast failed', {
        error: redactSecrets(typeof result.error === 'string' ? result.error : ''),
      });
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
