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
// Token resolution order (see `getCoworkEventsToken`) MUST match the auth
// middleware or every event authenticates with the wrong secret and fails closed.
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

// Validate the relay target with the same fail-closed rules applied to
// COWORK_BASE_URL in agent-bootstrap.ts: http(s) scheme only, no embedded
// credentials, and no secret-shaped query. We deliberately do NOT apply
// isSsrfSafeUrl here — the cowork-events mini-service legitimately runs on
// http://localhost:3003, so SSRF-gating the base would break the relay. A
// misconfigured (attacker-controlled) base fails closed to '' so broadcastEvent
// refuses to relay the X-Cowork-Token to it, instead of leaking the
// service-to-service secret to an unexpected host.
const EVENTS_BASE_SECRET_QUERY_RE =
  /[?&](api[_-]?key|token|access[_-]?token|secret|password|auth(entication|orization)?|client[_-]?secret|bearer|session[_-]?id)=/i;

let warnedBadEventsBase = false;

function getValidatedEventsBase(base: string = COWORK_EVENTS_BASE): string {
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('non-http(s) scheme');
    }
    if (parsed.username || parsed.password) {
      throw new Error('embedded credentials');
    }
    if (parsed.search && EVENTS_BASE_SECRET_QUERY_RE.test(parsed.search)) {
      throw new Error('secret-shaped query');
    }
  } catch (err) {
    if (!warnedBadEventsBase) {
      warnedBadEventsBase = true;
      console.error(
        '[cowork] COWORK_EVENTS_BASE_URL is not a safe relay target (' +
          `${err instanceof Error ? err.message : 'invalid'}) — refusing to relay ` +
          'the X-Cowork-Token there. Set it to an http(s) origin without embedded ' +
          'credentials or a secret-shaped query.',
      );
    }
    return '';
  }
  return base;
}


// Emit the missing-event-token warning at most once per process so a burst of
// broadcasts doesn't flood the logs with the identical message.
let warnedMissingEventToken = false;

// Surface relay failures (non-200, timeout, network error) at most once per
// process so a fire-and-forget caller that ignores the return value still has
// one observable signal that events are being dropped — without flooding logs.
let warnedRelayFailure = false;

// How long to wait for the cowork-events mini-service before giving up on a
// relay. A stalled :3003 would otherwise tie up the awaiting Next.js route
// handler indefinitely and amplify into request-queue exhaustion.
const BROADCAST_TIMEOUT_MS = 5000;

// Resolution order (CANONICAL, must match `middleware.ts`): the server-side
// mini-service accepts EITHER COWORK_UI_TOKEN or COWORK_EVENT_TOKEN as its
// SOCKET_SECRET, so for this service-to-service relay the dedicated S2S secret
// (COWORK_EVENT_TOKEN) is preferred, falling back to COWORK_UI_TOKEN only when
// the S2S secret is unset. Resolved at CALL time (not module load) so importing
// this module during build/prerender/tests can't crash the module graph. No
// `dev-token` fallback: when neither secret is set the relay sends an empty token
// and the upstream 401 surfaces as a 500 (see below).
function getCoworkEventsToken(): string {
 // Preferred service-to-service secret (NEVER shipped in the client bundle).
  const eventToken = process.env.COWORK_EVENT_TOKEN;
  if (eventToken && eventToken.length > 0) {
    return eventToken;
  }
 // Browser-facing fallback.
  const uiToken = process.env.COWORK_UI_TOKEN;
  if (uiToken && uiToken.length > 0) {
 // SECURITY WARNING: if COWORK_UI_TOKEN is also mirrored into
 // NEXT_PUBLIC_COWORK_UI_TOKEN, this S2S relay uses a secret shipped in the
 // client bundle. Warn only when the dedicated S2S token is not configured.
    if (!process.env.COWORK_EVENT_TOKEN) {
      if (!warnedMissingEventToken) {
        warnedMissingEventToken = true;
        console.warn(
          '[cowork] COWORK_EVENT_TOKEN is unset — relaying to the cowork-events ' +
            'mini-service with COWORK_UI_TOKEN. If COWORK_UI_TOKEN is also exposed via ' +
            'NEXT_PUBLIC_COWORK_UI_TOKEN, the server-to-server secret is embedded in the ' +
            'shipped browser bundle. Prefer setting COWORK_EVENT_TOKEN for relays.',
        );
      }
    }
    return uiToken;
  }
 // (COWORK_EVENT_TOKEN is already returned above when set; when we reach here
  // it is empty, so this branch is intentionally omitted to preserve the
  // "neither secret configured" warning below.)
 // Neither secret is configured: warn once and let the relay proceed with an
 // empty token. The upstream rejects it with 401, surfaced as a 500 by the route.
  if (!warnedMissingEventToken) {
    warnedMissingEventToken = true;
    console.warn(
      '[cowork] Neither COWORK_UI_TOKEN nor COWORK_EVENT_TOKEN is set — relaying ' +
        'to the cowork-events mini-service with an empty X-Cowork-Token. The upstream ' +
        'will reject it with 401 (surfaced as a 500 by the emitting route). Set ' +
        'COWORK_UI_TOKEN (or COWORK_EVENT_TOKEN) to enable event relay.',
    );
  }
  return uiToken ?? '';
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
 * The token and validated base are read BEFORE the try/catch so a
 * misconfiguration fails closed rather than being swallowed into `{ ok: false }`.
 * The fetch is bounded by an `AbortSignal.timeout`; a stalled relay returns
 * `{ ok: false, error: 'timeout' }` rather than blocking the route.
 */
export async function broadcastEvent(
  channel: string,
  payload: unknown,
): Promise<BroadcastResult> {
 // Read the token outside the try so an unset secret throws out (fail-closed)
 // rather than being silently converted to `{ ok: false }`.
  const token = getCoworkEventsToken();
  const eventsBase = getValidatedEventsBase();
  if (!eventsBase) {
    return { ok: false, channel, error: 'misconfigured event relay base url' };
  }
  try {
    const res = await fetch(`${eventsBase}/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cowork-Token': token,
      },
      body: JSON.stringify({ channel, payload }),
      signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (!warnedRelayFailure) {
        warnedRelayFailure = true;
        console.warn(`[cowork] event relay failed: ${channel} HTTP ${res.status}`);
      }
      return { ok: false, channel, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    let data: { ok?: boolean; id?: number; channel?: string } = {};
    try {
      data = (await res.json()) as { ok?: boolean; id?: number; channel?: string };
    } catch {
   // 200 with an unparseable/empty body — the upstream already accepted the
   // event, so report success rather than letting the throw fall into the outer
   // catch and surface a false `{ ok: false }`.
      return { ok: true, channel };
    }
    return {
      ok: Boolean(data.ok),
      id: typeof data.id === 'number' ? data.id : undefined,
      channel: typeof data.channel === 'string' ? data.channel : channel,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, channel, error: 'timeout' };
    }
    const detail = err instanceof Error ? err.message : String(err);
    if (!warnedRelayFailure) {
      warnedRelayFailure = true;
      console.warn(`[cowork] event relay failed: ${channel} ${detail}`);
    }
    // Never leak transport-level detail (e.g. ECONNREFUSED with host:port) to
    // the caller; log it server-side and return a generic message instead.
    return { ok: false, channel, error: 'event relay failed' };
  }
}

export { COWORK_EVENTS_BASE, getCoworkEventsToken, getValidatedEventsBase };
