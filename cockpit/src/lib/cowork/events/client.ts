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
//     (falling back to `process.env.COWORK_UI_TOKEN` if the former is unset).

const COWORK_EVENTS_BASE = process.env.COWORK_EVENTS_BASE_URL || 'http://localhost:3003';

// Fail closed. The cockpit must NOT silently authenticate to the
// cowork-events mini-service with the well-known `dev-token` when the operator
// forgot to set a real secret. If COWORK_EVENT_TOKEN is unset/empty we refuse to
// relay instead of sending `dev-token`. The `dev-token` fallback is removed
// entirely.
//
// The check is deferred to CALL time (not module load) so that importing a
// route that references this module — during `next build`, prerender, or a
// unit test — does not crash the whole module graph. The throw fires only when
// a relay is actually attempted. `broadcastEvent` wraps this in its own
// try/catch and converts the failure into a `{ ok: false, error }` result
// (see below) — callers MUST check `result.ok`. The `/api/cowork/events/emit`
// route does exactly that and surfaces the failure as a 500, so the fail-closed
// behavior is preserved end-to-end for that path. This is equally fail-closed,
// without the import-time fragility of an IIFE.
function getCoworkEventsToken(): string {
  // Preferred server-to-server secret.
  const token = process.env.COWORK_EVENT_TOKEN;
  if (token && token.length > 0) {
    return token;
  }
  // Fall back to the UI token. Operators may configure only COWORK_UI_TOKEN
  // (the preferred browser secret per the auth middleware) and expect
  // server-to-server relays to work end-to-end with a single configured secret.
  // This still fails closed if BOTH are unset/empty — we never silently relay
  // with the well-known dev-token.
  //
  // SECURITY WARNING: if COWORK_UI_TOKEN is mirrored into
  // NEXT_PUBLIC_COWORK_UI_TOKEN (as the auth middleware reads it from the
  // browser), this server-to-server relay would be using a secret that is
  // shipped in the client bundle. Surface that fact so operators notice the
  // unsafe default rather than it silently "working".
  const uiToken = process.env.COWORK_UI_TOKEN;
  if (uiToken && uiToken.length > 0) {
    console.warn(
      "[cowork] COWORK_EVENT_TOKEN is unset — relaying to the cowork-events " +
        "mini-service with COWORK_UI_TOKEN. If COWORK_UI_TOKEN is also exposed via " +
        "NEXT_PUBLIC_COWORK_UI_TOKEN, the server-to-server secret is embedded in the " +
        "shipped browser bundle. Prefer setting COWORK_EVENT_TOKEN for relays.",
    );
    return uiToken;
  }
  throw new Error(
    'COWORK_EVENT_TOKEN (or COWORK_UI_TOKEN) is not set — refusing to broadcast/relay events to the ' +
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
