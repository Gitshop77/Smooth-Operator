//
// Next.js API routes (and server components) can import `broadcastEvent` to
// fan an event out to every connected WebSocket client of the cowork-events
// mini-service on port 3003. The mini-service records the event in its
// in-memory buffer (last 1000) and emits it on the matching socket.io channel.
//
// Per project rules:
// • Server-to-server fetches may use `http://localhost:3003` directly (the
// mini-service is internal and not exposed through Caddy).
// • The X-Cowork-Token header must match `process.env.COWORK_UI_TOKEN`
// (preferred) or, as a fallback, `process.env.COWORK_EVENT_TOKEN`.
//
// Token resolution order is CANONICAL and MUST match the auth middleware
// (`middleware.ts`), which also prefers `COWORK_UI_TOKEN` then falls back to
// `COWORK_EVENT_TOKEN`. If the relay sent a different secret than the API
// accepts, every event would authenticate with the wrong secret and fail
// closed (events silently dropped / 500 on `/api/cowork/events/emit`). Keeping
// the two modules in lock-step on this order is security-critical.
//
// NOTE on the SSE stream: `/api/cowork/events/stream` additionally accepts the
// token via a `?token=` query parameter (an `EventSource` cannot set headers).
// That is the same `COWORK_UI_TOKEN` (constant-time-compared, so not a weaker
// crypto path), but placing a secret in a URL means it can land in reverse-
// proxy / CDN / browser access logs. This transport is acceptable for a
// loopback-only deployment; if the cockpit is ever exposed beyond localhost,
// prefer a short-lived stream ticket and ensure proxies strip the query param
// from logged URLs. (Documented for manifest consumers in `agent-bootstrap.ts`.)

const COWORK_EVENTS_BASE = process.env.COWORK_EVENTS_BASE_URL || 'http://localhost:3003';

// How long to wait for the cowork-events mini-service before giving up on a
// relay. A stalled :3003 would otherwise tie up the awaiting Next.js route
// handler indefinitely and amplify into request-queue exhaustion.
const BROADCAST_TIMEOUT_MS = 5000;

// Fail closed. The cockpit must NOT silently authenticate to the
// cowork-events mini-service with the well-known `dev-token` when the operator
// forgot to set a real secret. If both COWORK_UI_TOKEN and COWORK_EVENT_TOKEN
// are unset/empty we refuse to relay instead of sending `dev-token`. The
// `dev-token` fallback is removed entirely.
//
// The check is deferred to CALL time (not module load) so that importing a
// route that references this module — during `next build`, prerender, or a
// unit test — does not crash the whole module graph. The throw fires only when
// a relay is actually attempted.
//
// Resolution order (CANONICAL, must match `middleware.ts`): prefer
// COWORK_UI_TOKEN, falling back to COWORK_EVENT_TOKEN. See the module header
// for why the two must agree.
function getCoworkEventsToken(): string {
 // Preferred browser-facing secret (also what the API accepts first).
  const uiToken = process.env.COWORK_UI_TOKEN;
  if (uiToken && uiToken.length > 0) {
 // SECURITY WARNING: if COWORK_UI_TOKEN is mirrored into
 // NEXT_PUBLIC_COWORK_UI_TOKEN (as the auth middleware reads it from the
 // browser), this server-to-server relay would be using a secret that is
 // shipped in the client bundle. Surface that fact so operators notice the
 // unsafe default rather than it silently "working". We only warn when the
 // dedicated service-to-service token is not also configured.
    if (!process.env.COWORK_EVENT_TOKEN) {
      console.warn(
        '[cowork] COWORK_EVENT_TOKEN is unset — relaying to the cowork-events ' +
          'mini-service with COWORK_UI_TOKEN. If COWORK_UI_TOKEN is also exposed via ' +
          'NEXT_PUBLIC_COWORK_UI_TOKEN, the server-to-server secret is embedded in the ' +
          'shipped browser bundle. Prefer setting COWORK_EVENT_TOKEN for relays.',
      );
    }
    return uiToken;
  }
 // Service-to-server fallback. Operators that set only COWORK_EVENT_TOKEN
 // (legacy) still get end-to-end relay with a single configured secret.
  const token = process.env.COWORK_EVENT_TOKEN;
  if (token && token.length > 0) {
    return token;
  }
  throw new Error(
    'COWORK_UI_TOKEN (or COWORK_EVENT_TOKEN) is not set — refusing to broadcast/relay events to the ' +
      'cowork-events mini-service (fail-closed). Set a real secret.',
  );
}

export interface BroadcastResult {
  ok: boolean;
  id?: number;
  channel: string;
  error?: string;
}

/**
 * Broadcast an event to all connected cowork-events WebSocket clients.
 *
 * @param channel One of the documented channels (e.g. 'tab:updated',
 * 'agent:task-updated', 'network:request', etc.).
 * @param payload Arbitrary JSON-serializable payload.
 * @returns The mini-service's acknowledgement ({ ok, id, channel }).
 *
 * Fail-closed on a missing secret: `getCoworkEventsToken()` is read BEFORE the
 * try/catch so its throw escapes `broadcastEvent` (instead of being swallowed
 * into `{ ok: false }`). Callers that ignore the return value — e.g.
 * fire-and-forget emitters — therefore fail loud, and the
 * `/api/cowork/events/emit` route (which wraps `broadcastEvent` in
 * `withRouteError`) surfaces it as a 500, preserving end-to-end fail-closed
 * behavior. The fetch is bounded by an `AbortSignal.timeout`; a stalled relay
 * returns `{ ok: false, error: 'timeout' }` rather than blocking the route.
 */
export async function broadcastEvent(
  channel: string,
  payload: unknown,
): Promise<BroadcastResult> {
 // Read the token outside the try so an unset secret throws out (fail-closed)
 // rather than being silently converted to `{ ok: false }`.
  const token = getCoworkEventsToken();
  try {
    const res = await fetch(`${COWORK_EVENTS_BASE}/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cowork-Token': token,
      },
      body: JSON.stringify({ channel, payload }),
      signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, channel, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as { ok?: boolean; id?: number; channel?: string };
    return {
      ok: Boolean(data.ok),
      id: typeof data.id === 'number' ? data.id : undefined,
      channel: typeof data.channel === 'string' ? data.channel : channel,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, channel, error: 'timeout' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, channel, error: msg };
  }
}

export { COWORK_EVENTS_BASE, getCoworkEventsToken };
