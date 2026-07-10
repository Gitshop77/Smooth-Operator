//
// Next.js API routes (and server components) can import `broadcastEvent` to
// fan an event out to every connected WebSocket client of the cowork-events
// mini-service on port 3003. The mini-service records the event in its
// in-memory buffer (last 1000) and emits it on the matching socket.io channel.
//
// Per project rules:
//   • Server-to-server fetches may use `http://localhost:3003` directly (the
//     mini-service is internal and not exposed through Caddy).
//   • The X-Cowork-Token header must match `process.env.COWORK_EVENT_TOKEN`
//     (default `dev-token`).

const COWORK_EVENTS_BASE = process.env.COWORK_EVENTS_BASE_URL || 'http://localhost:3003';
const COWORK_EVENTS_TOKEN = process.env.COWORK_EVENT_TOKEN || 'dev-token';

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
        'X-Cowork-Token': COWORK_EVENTS_TOKEN,
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

export { COWORK_EVENTS_BASE, COWORK_EVENTS_TOKEN };
