//
// Next.js API routes (and server components) can import `broadcastEvent` to
// fan an event out to every connected WebSocket client of the cowork-events
// mini-service on port 3003. The mini-service records the event in its
// in-memory buffer (last 1000) and emits it on the matching socket.io channel.
//
// Per project rules:
//   • Server-to-server fetches may use `http://localhost:3003` directly (the
//     mini-service is internal and not exposed through Caddy).
//   • The X-Cowork-Token header must match `process.env.COWORK_EVENT_TOKEN`.

const COWORK_EVENTS_BASE = process.env.COWORK_EVENTS_BASE_URL || 'http://localhost:3003';

// F-14: fail closed. The cockpit must NOT silently authenticate to the
// cowork-events mini-service with the well-known `dev-token` when the operator
// forgot to set a real secret. If COWORK_EVENT_TOKEN is unset/empty we refuse to
// relay instead of sending `dev-token`. The `dev-token` fallback is removed
// entirely.
//
// The check is deferred to CALL time (not module load) so that importing a
// route that references this module — during `next build`, prerender, or a
// unit test — does not crash the whole module graph. The throw fires only when
// a relay is actually attempted, where it is caught by the route's error
// wrapper and surfaced as a 500. This is equally fail-closed, without the
// import-time fragility of an IIFE.
function getCoworkEventsToken(): string {
  const token = process.env.COWORK_EVENT_TOKEN;
  if (!token || token.length === 0) {
    throw new Error(
      'COWORK_EVENT_TOKEN is not set — refusing to broadcast/relay events to the ' +
        'cowork-events mini-service (fail-closed). Set a real secret.',
    );
  }
  return token;
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
 * @param channel  One of the documented channels (e.g. 'tab:updated',
 *                 'agent:task-updated', 'network:request', etc.).
 * @param payload  Arbitrary JSON-serializable payload.
 * @returns        The mini-service's acknowledgement ({ ok, id, channel }).
 */
export async function broadcastEvent(
  channel: string,
  payload: unknown,
): Promise<BroadcastResult> {
  try {
    const res = await fetch(`${COWORK_EVENTS_BASE}/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cowork-Token': getCoworkEventsToken(),
      },
      body: JSON.stringify({ channel, payload }),
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
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, channel, error: msg };
  }
}

export { COWORK_EVENTS_BASE, getCoworkEventsToken };
