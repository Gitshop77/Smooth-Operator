// Cowork Web Cockpit WebSocket mini-service — replaces Electron IPC with socket.io.
// It:
// • Broadcasts real-time browser/agent events to all connected web clients
// • Buffers the last 1000 events for replay on reconnect
// • Exposes POST /emit so Next.js API routes can fan out events
// • Exposes POST /chat (z-ai-web-dev-sdk streaming chat) and POST /image (image gen)
//
// PORT IS HARDCODED to 3003 per project rules. Do NOT read from env.
// Emits ONLY real events — there is no synthetic event simulator.

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import ZAI from 'z-ai-web-dev-sdk';

// Re-exported so consumers + tests can import the security primitives from a
// single entry point.
export { tokenMatches, applyCorsHeaders, shouldRefuseStart, evaluateChatJoin, DEV_TOKEN } from './security';
import { tokenMatches, applyCorsHeaders, shouldRefuseStart, evaluateChatJoin, DEV_TOKEN } from './security';

// Redact likely-secret material from free-form error / SDK messages before they
// reach logs — API keys, bearer/basic tokens, credential-bearing URLs, and any
// value equal to one of this service's own configured secrets.
export function redactSecrets(input: string): string {
  let out = input;
  // Standalone credential literals (min-lengths mirror the cockpit redactor).
  out = out.replace(/(sk-ant-)[A-Za-z0-9_-]{20,}/g, '$1***');
  out = out.replace(/(sk-)[A-Za-z0-9_-]{20,}/g, '$1***');
  out = out.replace(/(AIza)[0-9A-Za-z_-]{35}/g, '$1***');
  out = out.replace(/(gsk_)[0-9A-Za-z_-]{8,}/g, '$1***');
  out = out.replace(/(xox[baprs]-)[0-9A-Za-z-]{8,}/g, '$1***');
  out = out.replace(/(AKIA)[0-9A-Z]{8,}/g, '$1***');
  out = out.replace(/(ghp_)[A-Za-z0-9]{8,}/g, '$1***');
  out = out.replace(/(glpat-)[A-Za-z0-9_-]{8,}/g, '$1***');
  out = out.replace(/(ASIA)[A-Za-z0-9]{8,}/g, '$1***');
  out = out.replace(/(ya29)[A-Za-z0-9_-]{8,}/g, '$1***');
  // Authorization Bearer tokens embedded in SDK/error messages.
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***');
  // HTTP Basic credentials: `Authorization: Basic <base64>` (colon-space, no `=`).
  // Short base64 escapes the 20+ entropy fallback below, so it is masked explicitly.
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic ***');
  // JSON-shaped credential fields.
  out = out.replace(/"((?:password|apiKey|api_key|secret|token))"\s*:\s*"[^"]+"/g, '"$1":"***"');
  // Connection URLs that can carry credentials inline.
  out = out.replace(
    /\b(mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|https?):\/\/[^\s:@/]+:[^\s:@/]+@/g,
    '$1://***:***@',
  );
  // Bounded fallback for bare high-entropy scalars (no prefix) — only 20+ char
  // runs of the token alphabet, so short words / `***` markers are untouched.
  out = out.replace(
    /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{20,}(?![A-Za-z0-9+/=_-])/g,
    '***',
  );
  // Mask this service's own configured secrets that appear verbatim. Skip the
  // dev-token fallback so a loopback dev setup doesn't redact the default.
  for (const secret of [SHARED_SECRET, SOCKET_SECRET]) {
    if (secret && secret.length > 3 && secret !== DEV_TOKEN && out.includes(secret)) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = 3003; // Hardcoded per project rules — do NOT use env.PORT
const EVENT_BUFFER_MAX = 1000;
// Server-to-server secret — authenticates the cockpit's HTTP proxy
// (`X-Cowork-Token`); must NEVER reach the browser bundle.
const SHARED_SECRET = process.env.COWORK_EVENT_TOKEN || DEV_TOKEN;
// Browser-facing secret — authenticates the real-time socket handshake. Kept
// distinct from `SHARED_SECRET` so the browser bundle (a `NEXT_PUBLIC_*` value)
// never embeds the S2S credential. Falls back to the S2S secret only for
// single-secret dev setups.
const SOCKET_SECRET = process.env.COWORK_UI_TOKEN || process.env.COWORK_EVENT_TOKEN || DEV_TOKEN;

// Warn when SOCKET_SECRET collapsed onto the S2S secret (or dev-token) because
// COWORK_UI_TOKEN is unset — a leaked browser bundle could then unlock the S2S path.
if (!process.env.COWORK_UI_TOKEN) {
  console.warn(
    '[cowork-events] WARNING: COWORK_UI_TOKEN is unset — SOCKET_SECRET fell ' +
      'back to COWORK_EVENT_TOKEN (or the dev-token). Set a COWORK_UI_TOKEN ' +
      'that differs from COWORK_EVENT_TOKEN so the browser socket secret is ' +
      'distinct from the service-to-service secret.',
  );
}
const STATUS_INTERVAL_MS = 15_000;
// Maximum request body size — 1 MiB — for all POST routes. Enforced via the
// `content-length` header (pre-read) and inside `readJson` (defensive, for
// missing/spoofed headers).
const MAX_BODY_BYTES = 1_048_576; // 1 MB
// Idle bound between body-read chunks. `httpServer.requestTimeout` is disabled
// (0) so engine.io long-polls aren't force-closed, which also removes the
// per-body-read bound — this timer restores it, defeating slowloris-style
// trickled bodies without touching engine.io's reader.
const BODY_READ_IDLE_MS = 30_000;
// Per-IP rate limit on the proxy routes: RATE_LIMIT_MAX requests per window, 429
// beyond that.
//
// SINGLE-INSTANCE REQUIREMENT: the rate-limit map and replay buffer are
// in-memory and process-local — lost on restart and per-replica if scaled
// horizontally. This deployment targets a single operator on loopback; move
// this state to a shared store (e.g. Redis) before running multiple replicas.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
// Max chat rooms a single socket may join. Without a cap an authenticated client
// could join unbounded distinct sessionIds and OOM the in-memory room map. The
// socket's own id room is excluded from this count.
const MAX_SOCKET_ROOMS = 32;
// Max concurrent engine.io connections (pre-auth inclusive). Without a ceiling
// an unauthenticated client could loop handshakes and exhaust fds/memory before
// the token check drops each one; `io.use()` (below) rejects new handshakes past
// this ceiling.
const MAX_CONCURRENT_CONNECTIONS = 256;
// Explicit engine.io max HTTP buffer size (the 1 MiB default) so a single
// oversized packet can't exceed the intended bound.
const MAX_HTTP_BUFFER_SIZE = 1_048_576; // 1 MiB
// CORS allowlist — default to the cockpit origin so a hostile tab can't
// `fetch('http://localhost:3003/...')` and read the response. Override via
// `COWORK_CORS_ORIGIN`.
const DEFAULT_CORS_ORIGIN = 'http://localhost:3000';
let CORS_ORIGIN = process.env.COWORK_CORS_ORIGIN || DEFAULT_CORS_ORIGIN;

// Refuse a wildcard origin: `applyCorsHeaders` only mirrors an exact match (so
// '*' blocks all HTTP CORS) while socket.io treats '*' as a true wildcard
// (permitting ANY origin). The two would disagree, leaving socket.io wide open —
// clamp '*' back to the safe default.
if (CORS_ORIGIN === '*') {
  console.error(
    '[cowork-events] ERROR: COWORK_CORS_ORIGIN="*" is not supported — the ' +
      'HTTP layer would block all cross-origin reads while socket.io would ' +
      'permit ANY origin. Refusing the wildcard and falling back to the safe ' +
      `default (${DEFAULT_CORS_ORIGIN}). Set a concrete origin to override.`,
  );
  CORS_ORIGIN = DEFAULT_CORS_ORIGIN;
}

// Timestamp (ms) when `main()` bound the server — surfaced to reconnecting
// clients so the dashboard can detect an event-bus restart. Set in `main()` only.
let serverStartedAt: number | undefined;
let statusTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// Per-IP in-memory rate limiter
// ---------------------------------------------------------------------------
//
// Fixed-window counter keyed by remote IP (not a sliding window — a burst of
// RATE_LIMIT_MAX is possible at each window boundary). Expired entries are GC'd
// opportunistically on each check.

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms when the window resets
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Proxy IPs trusted to supply an accurate client address via `X-Real-IP` /
// `X-Forwarded-For`. Those headers are attacker-controllable unless the TCP peer
// is a trusted proxy that OVERWRITES (never appends) them. Empty by default (the
// service binds to loopback); populate ONLY when a hardened reverse proxy sits
// in front.
const TRUSTED_PROXY_IPS = new Set<string>();

function clientIp(req: IncomingMessage): string {
  // Key on the real TCP peer unless it is a configured trusted proxy.
  const sock = req.socket as { remoteAddress?: string };
  const peer = sock.remoteAddress || 'unknown';
  if (peer !== 'unknown' && !TRUSTED_PROXY_IPS.has(peer)) return peer;

 // Trusted-proxy path: the real client IP is only available via a
 // proxy-supplied header, which is safe ONLY if the proxy (Caddy) overwrites
 // `X-Forwarded-For` / `X-Real-IP` rather than appending. Prefer `X-Real-IP`,
 // then the leftmost `X-Forwarded-For` entry.
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
 // `x-forwarded-for` may also arrive as an array (Node splits duplicate headers).
  if (Array.isArray(xff) && xff.length > 0) {
    const first = xff[0].split(',')[0].trim();
    if (first) return first;
  }
  return peer;
}

function rateLimitCheck(ip: string): { allowed: boolean; resetAt: number; remaining: number } {
  const now = Date.now();
 // Opportunistic GC so the Map can't grow unbounded.
  if (rateLimitMap.size > 0) {
    for (const [key, entry] of rateLimitMap) {
      if (entry.resetAt <= now) rateLimitMap.delete(key);
    }
  }
  const existing = rateLimitMap.get(ip);
  if (existing && existing.resetAt > now) {
    if (existing.count >= RATE_LIMIT_MAX) {
      return { allowed: false, resetAt: existing.resetAt, remaining: 0 };
    }
    existing.count += 1;
    return { allowed: true, resetAt: existing.resetAt, remaining: RATE_LIMIT_MAX - existing.count };
  }
  const resetAt = now + RATE_LIMIT_WINDOW_MS;
  rateLimitMap.set(ip, { count: 1, resetAt });
  return { allowed: true, resetAt, remaining: RATE_LIMIT_MAX - 1 };
}

// Extract the first non-empty handshake token from `auth.token` / `query.token`
// (coercing a string[] query to its first element, else ''). Shared by the
// connection and `emit` handlers so the logic can't drift.
function extractHandshakeToken(hs: Socket['handshake']): string {
  const authTok = (hs.auth as { token?: unknown } | undefined)?.token;
  const queryTok = (hs.query as Record<string, unknown> | undefined)?.token;
  return (
    (typeof authTok === 'string' ? authTok : '') ||
    (typeof queryTok === 'string' ? queryTok : '') ||
    (Array.isArray(queryTok) && typeof queryTok[0] === 'string' ? queryTok[0] : '') ||
    ''
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BufferedEvent {
  id: number;
  channel: string;
  payload: unknown;
  ts: number;
}

interface ChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  systemPrompt?: string;
  sessionId?: string;
  stream?: boolean;
  thinking?: 'enabled' | 'disabled';
}

interface ImageRequest {
  prompt: string;
  size?: '1024x1024' | '768x1344' | '864x1152' | '1344x768' | '1152x864' | '1440x720' | '720x1440';
}

// ---------------------------------------------------------------------------
// Shared validation constants (kept in sync with the cockpit event proxy)
// ---------------------------------------------------------------------------

// `sessionId` charset enforced on `chat:join` (see `evaluateChatJoin`). The HTTP
// `/chat` route validates the SAME pattern so the room it emits to is joinable.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Channel name cap — mirrors the cockpit events/emit proxy.
const MAX_CHANNEL_LENGTH = 128;

// Safe charset for client-supplied channel names — keeps CR/LF and other control
// characters out of the audit log (log-injection defense) while covering every
// namespaced channel this service uses (e.g. `tab:updated`).
const CHANNEL_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

// Payload cap for client-broadcast events (HTTP `/emit` + socket `emit`),
// matching the cockpit proxy's 64 KB limit (MAX_BODY_BYTES bounds the raw POST).
const MAX_EMIT_PAYLOAD_BYTES = 64 * 1024;

// The seven image sizes the z-ai SDK accepts. Validated at the boundary so an
// invalid size yields a 400 instead of a wasted upstream round-trip.
const ALLOWED_IMAGE_SIZES = [
  '1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440',
] as const;

// Channels the SERVER owns — a client `emit` of these would let it impersonate
// server status / replay / streamed chat to every connected dashboard.
const SERVER_OWNED_CHANNELS = new Set([
  'system:status', 'events:replay', 'chat:message', 'chat:done', 'chat:error',
]);

// Max wait for a single chunk from the upstream LLM stream before treating the
// connection as stalled — otherwise a hung upstream leaves the HTTP request and
// socket.io room open forever.
const CHAT_STREAM_CHUNK_TIMEOUT_MS = 30_000;

// Bound on a single non-streaming upstream SDK call (auth, the initial
// `create({stream:true})`, the non-streaming completion, image generation).
// `requestTimeout` is 0 to protect long-polls and `headersTimeout` only bounds
// the header phase, so without this a stalled upstream would hang the socket
// forever. `withUpstreamTimeout` races the await against a timer.
const UPSTREAM_CALL_TIMEOUT_MS = 30_000;

// Consecutive empty-room ticks (after a listener was seen) before the chat
// stream is aborted. Hysteresis so a transient blip (tab switch / momentary
// disconnect) doesn't truncate the stream into a partial HTTP 200.
const EMPTY_ROOM_ABORT_TICKS = 5;

// Cap on the accumulated upstream response. A runaway upstream with a joined
// listener would otherwise grow `finalText` without bound in RAM; truncate past
// this cap and flag the result.
const MAX_CHAT_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB

// Server-pinned per-request completion token ceiling, resolved from THIS
// service's environment (never the request body), so an authenticated caller
// can't raise it. Override via WINGMAN_MAX_TOKENS.
const WINGMAN_MAX_TOKENS = (() => {
  const n = Number(process.env.WINGMAN_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8192;
})();

// True when no socket is currently joined to `sessionId`. Used to stop paying
// for (and emitting to) an upstream chat stream that nobody is listening to.
function roomIsEmpty(sessionId: string): boolean {
  return (io.sockets.adapter.rooms.get(sessionId)?.size ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// In-memory event store
// ---------------------------------------------------------------------------

const eventBuffer: BufferedEvent[] = [];
let eventCounter = 0;

function recordEvent(channel: string, payload: unknown): BufferedEvent {
  // Skip the replay buffer for `system:status` — the 15s broadcaster would
  // otherwise fill it with status ticks and evict real events.
  if (channel === 'system:status') {
    eventCounter += 1;
    return { id: eventCounter, channel, payload, ts: Date.now() };
  }
  eventCounter += 1;
  const evt: BufferedEvent = { id: eventCounter, channel, payload, ts: Date.now() };
  eventBuffer.push(evt);
  if (eventBuffer.length > EVENT_BUFFER_MAX) {
    eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_MAX);
  }
  return evt;
}

function getRecentEvents(sinceId: number): BufferedEvent[] {
  if (sinceId <= 0) return eventBuffer.slice();
  const idx = eventBuffer.findIndex((e) => e.id > sinceId);
  if (idx === -1) return [];
  return eventBuffer.slice(idx);
}

// ---------------------------------------------------------------------------
// Z-AI SDK lazy singleton
// ---------------------------------------------------------------------------

let zaiPromise: Promise<ZAI> | null = null;

async function getZai(): Promise<ZAI> {
  if (!zaiPromise) {
    zaiPromise = withUpstreamTimeout(ZAI.create(), UPSTREAM_CALL_TIMEOUT_MS).catch((err) => {
 // Reset so the next attempt can retry — auth issues may be transient.
      zaiPromise = null;
      throw err;
    });
  }
  return zaiPromise;
}

// Per-sessionId in-flight chat lock: the first POST /chat owns the stream for a
// sessionId; a concurrent duplicate is rejected with 409 (otherwise both would
// open independent upstream streams and double-bill).
const inflightChat = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// HTTP server (low-level so we can attach socket.io + REST on the same port)
// ---------------------------------------------------------------------------

async function httpRequestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
 // Capture the forwarded correlation id so logs can be tied to the originating
 // cockpit request. Strip control chars to prevent log injection.
  const rawRequestId =
    typeof req.headers['x-request-id'] === 'string' ? (req.headers['x-request-id'] as string) : undefined;
  const requestId = rawRequestId ? rawRequestId.replace(/[\r\n\x00-\x1f]/g, '') : undefined;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
 // Only advertise CORS method/header permissions when the origin matched.
  const corsAllowed = applyCorsHeaders(res, origin, CORS_ORIGIN);
  if (corsAllowed) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cowork-Token');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = (req.url || '/').split('?')[0];

 // Resolve the client IP once per request (reused for auth-failure log, rate
 // limit, and audit log). Strip control chars — the IP is attacker-controllable
 // via forwarded headers behind a trusted proxy (log-injection defense).
  const ip = clientIp(req).replace(/[\r\n\x00-\x1f]/g, '');

  try {
 // `/health` is the only unauthenticated route, and returns ONLY `{ ok: true }`
 // so a probe can't leak client count / buffer size / uptime / port. Every
 // other route requires the `X-Cowork-Token` header.
    if (url === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

 // Per-IP rate limit on the proxy routes BEFORE the token check, so an
 // unauthenticated client can't bypass the throttle by never supplying a valid
 // token. /health and OPTIONS are excluded.
    if (
      req.method === 'POST' &&
      (url === '/emit' || url === '/chat' || url === '/image')
    ) {
 // CSRF/drive-by guard, before the rate limit: a browser always sends `Origin`
 // on cross-origin POSTs, so reject a non-allowlisted Origin before it can burn
 // the shared loopback rate-limit bucket. The cockpit's server-side fetch sends
 // no Origin (or the allowlisted one) and is unaffected.
      if (origin !== null && !corsAllowed) {
        sendJson(res, 403, { error: 'Cross-origin request forbidden' });
        return;
      }
      {
        const rl = rateLimitCheck(ip);
        if (!rl.allowed) {
          res.setHeader('Retry-After', String(Math.ceil((rl.resetAt - Date.now()) / 1000)));
          sendJson(res, 429, { error: 'Rate limit exceeded. Try again later.', resetAt: rl.resetAt });
          return;
        }
      }
    }

 // All other routes require the shared-secret token. These HTTP proxy routes
 // are SERVICE-TO-SERVICE only and accept ONLY the S2S `SHARED_SECRET` — the
 // browser-facing `SOCKET_SECRET` must NOT unlock these paid LLM/image/erasure
 // proxies, or a leaked browser bundle could bill upstream on the operator's
 // account. (SOCKET_SECRET remains accepted on the realtime socket only.)
    if (!tokenMatches(req.headers['x-cowork-token'] as string | undefined, SHARED_SECRET)) {
 // Log failed auth with source IP — NEVER the token itself.
      console.warn(`[cowork-events] 401 Unauthorized (invalid X-Cowork-Token) from ${ip}`);
      sendJson(res, 401, { error: 'Invalid X-Cowork-Token' });
      return;
    }

    if (url === '/' && req.method === 'GET') {
      sendJson(res, 200, {
        service: 'cowork-events',
        port: PORT,
        channels: [
          'tab:updated', 'tab:opened', 'tab:closed',
          'workspace:updated',
          'agent:task-updated', 'agent:handoff',
          'network:request',
          'devtools:log',
          'security:event',
          'snapshot:captured',
          'chat:message', 'chat:done', 'chat:error',
          'system:status',
        ],
        endpoints: ['/', '/health', '/emit', '/chat', '/image', '/events'],
      });
      return;
    }

    if (url === '/emit' && req.method === 'POST') {
 // Pre-read body-size check (readJson still catches chunked bodies without
 // content-length).
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'Request body too large (max 1 MB)' });
        return;
      }
      const body = await readJson<Record<string, unknown>>(req);
      const channel = typeof body.channel === 'string' ? body.channel : '';
      if (!channel) {
        sendJson(res, 400, { error: 'channel required' });
        return;
      }
      if (channel.length > MAX_CHANNEL_LENGTH) {
        sendJson(res, 400, { error: 'channel too long (max 128 chars)' });
        return;
      }
 // Restrict the channel charset (log-injection defense).
      if (!CHANNEL_PATTERN.test(channel)) {
        sendJson(res, 400, { error: 'invalid channel (allowed A-Za-z0-9:_- 1-128 chars)' });
        return;
      }
      const payload = body.payload ?? null;
 // Serialize once, reused for the 64 KB cap check and the audit log.
      const payloadJson = JSON.stringify(payload);
      if (payloadJson.length > MAX_EMIT_PAYLOAD_BYTES) {
        sendJson(res, 413, { error: 'payload too large (max 64 KB)' });
        return;
      }
 // A client must never impersonate a server-owned channel (same guard as the
 // socket `emit` path).
      if (SERVER_OWNED_CHANNELS.has(channel)) {
        sendJson(res, 400, { error: 'channel not allowed on client emit' });
        return;
      }
      const evt = recordEvent(channel, payload);
      io.emit(channel, evt.payload, { id: evt.id, ts: evt.ts });
      console.info(
        `[/emit] ok channel=${channel} from=${ip} payloadBytes=${payloadJson.length} id=${evt.id}` +
          (requestId ? ` requestId=${requestId}` : ''),
      );
      sendJson(res, 200, { ok: true, id: evt.id, channel });
      return;
    }

    if (url === '/chat' && req.method === 'POST') {
 // Pre-read body-size check.
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'Request body too large (max 1 MB)' });
        return;
      }
      const body = await readJson<ChatRequest>(req);
 // Validate sessionId against the SAME pattern chat:join enforces, so we never
 // emit to a room the client could never join.
      if (body.sessionId !== undefined && !SESSION_ID_PATTERN.test(body.sessionId)) {
        sendJson(res, 400, { error: 'Invalid sessionId (allowed: A-Za-z0-9_- , 1-128 chars)' });
        return;
      }
      const sessionId = body.sessionId || `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const wantStream = body.stream !== false; // default: stream via socket.io

      const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
      if (body.systemPrompt) {
        messages.unshift({ role: 'system', content: body.systemPrompt });
      }
      if (messages.length === 0) {
        sendJson(res, 400, { error: 'messages required' });
        return;
      }

 // Serialize concurrent /chat per sessionId so a duplicate can't open a second
 // upstream stream and double-bill. A random default sessionId never collides.
      if (inflightChat.has(sessionId)) {
        sendJson(res, 409, { error: 'Chat already in progress for this sessionId' });
        return;
      }
      const chatRun = (async () => {
      try {
        const zai = await getZai();
        let finalText = '';
        let truncated = false;

        if (wantStream) {
 // With `stream: true` the SDK returns a raw `ReadableStream<Uint8Array>`
 // (the fetch response.body); parse the SSE manually — each event is a
 // `data:` line block separated by `\n\n`, terminated by `data: [DONE]`.
          const stream = (await withUpstreamTimeout(
            zai.chat.completions.create({
              messages,
              stream: true,
              thinking: { type: body.thinking === 'enabled' ? 'enabled' : 'disabled' },
              max_tokens: WINGMAN_MAX_TOKENS,
            }),
            UPSTREAM_CALL_TIMEOUT_MS,
          )) as ReadableStream<Uint8Array> | null;

          let sawListener = false;
          let emptyStreak = 0;
          if (stream && typeof stream.getReader === 'function') {
            const reader = stream.getReader();
            const decoder = new TextDecoder('utf-8');
            let sseBuffer = '';
 // Always tear down the upstream stream on exit (including error paths) so a
 // failed emit/parse doesn't leak the upstream socket. `cancel()` is idempotent.
            try {
              streamLoop: while (true) {
                const { done, value } = await readWithTimeout(reader, CHAT_STREAM_CHUNK_TIMEOUT_MS);
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                let sepIdx: number;
                while ((sepIdx = sseBuffer.indexOf('\n\n')) !== -1) {
                  const rawEvent = sseBuffer.slice(0, sepIdx);
                  sseBuffer = sseBuffer.slice(sepIdx + 2);
                  for (const line of rawEvent.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                      const parsed = JSON.parse(data) as {
                        choices?: Array<{ delta?: { content?: string } }>;
                      };
                      const token = parsed?.choices?.[0]?.delta?.content || '';
                      if (token) {
                        finalText += token;
                        if (finalText.length > MAX_CHAT_RESPONSE_BYTES) {
                          truncated = true;
                          break streamLoop;
                        }
                        if (roomIsEmpty(sessionId)) {
 // Only abort on an empty room after a listener was seen — otherwise a client
 // that hasn't joined yet would truncate the first token. Hysteresis: tolerate
 // a transient blip and only abort after a sustained empty window.
                          if (sawListener) {
                            emptyStreak += 1;
                            if (emptyStreak >= EMPTY_ROOM_ABORT_TICKS) {
                              truncated = true;
                              break streamLoop;
                            }
                          }
                        } else {
                          sawListener = true;
                          emptyStreak = 0;
                          io.to(sessionId).emit('chat:message', { sessionId, token, ts: Date.now() });
                        }
                      }
                    } catch {
 // Skip malformed event lines.
                    }
                  }
                }
              }
            } finally {
              reader.cancel().catch(() => {});
            }
          } else {
 // Fallback: some SDK versions return an async iterable. Guard against a null
 // stream first (auth failure / upstream error) — emit done to the room only
 // (never leak sessionId to other clients) and return the empty result.
            if (!stream) {
              io.to(sessionId).emit('chat:done', { sessionId, ts: Date.now() });
              sendJson(res, 200, { ok: true, sessionId, content: finalText, streamed: wantStream });
              return;
            }
            const chatIter = (stream as unknown as AsyncIterable<{
              choices?: Array<{ delta?: { content?: string } }>;
            }>)[Symbol.asyncIterator]();
            while (true) {
              const { value: chunk, done } = await chatIter.next();
              if (done) break;
              const token = chunk?.choices?.[0]?.delta?.content || '';
              if (token) {
                finalText += token;
                if (finalText.length > MAX_CHAT_RESPONSE_BYTES) {
                  truncated = true;
                  await chatIter.return?.();
                  break;
                }
                if (roomIsEmpty(sessionId)) {
                  if (sawListener) {
 // Hysteresis, mirrors the ReadableStream branch above.
                    emptyStreak += 1;
                    if (emptyStreak >= EMPTY_ROOM_ABORT_TICKS) {
                      truncated = true;
                      await chatIter.return?.();
                      break;
                    }
                  }
                } else {
                  sawListener = true;
                  emptyStreak = 0;
                  io.to(sessionId).emit('chat:message', { sessionId, token, ts: Date.now() });
                }
              }
            }
          }
          io.to(sessionId).emit('chat:done', { sessionId, ts: Date.now(), truncated });
 // Room-scoped only — a global `io.emit` would leak sessionId to other sessions.
        } else {
          const completion = await withUpstreamTimeout(
            zai.chat.completions.create({
              messages,
              thinking: { type: body.thinking === 'enabled' ? 'enabled' : 'disabled' },
              max_tokens: WINGMAN_MAX_TOKENS,
            }),
            UPSTREAM_CALL_TIMEOUT_MS,
          );
          finalText = completion?.choices?.[0]?.message?.content || '';
          if (finalText.length > MAX_CHAT_RESPONSE_BYTES) {
            truncated = true;
            finalText = finalText.slice(0, MAX_CHAT_RESPONSE_BYTES);
          }
 // Surface the completed message to the session room for parity with the
 // streaming branch. MUST stay in the non-streaming branch only — the streaming
 // branch already emits per-token, so emitting here too would double-deliver.
 // Room-scoped only (never a global `io.emit`, which would leak sessionId).
          io.to(sessionId).emit('chat:message', { sessionId, token: finalText, ts: Date.now() });
          io.to(sessionId).emit('chat:done', { sessionId, ts: Date.now(), truncated });
        }

 // Success-path audit log (paid external LLM — cost attribution / abuse).
        console.info(
          `[/chat] ok sessionId=${sessionId} from=${ip} ` +
            `messages=${messages.length} streamed=${wantStream} contentBytes=${finalText.length}` +
            (requestId ? ` requestId=${requestId}` : ''),
        );
        sendJson(res, 200, { ok: true, sessionId, content: finalText, streamed: wantStream, truncated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[/chat] error:', redactSecrets(msg), requestId ? { requestId } : '');
        io.to(sessionId).emit('chat:error', { sessionId, error: redactSecrets(msg), ts: Date.now() });
 // Terminator so a client keyed on chat:done doesn't hang on a mid-stream
 // failure (chat:error already carries the failure state).
        io.to(sessionId).emit('chat:done', { sessionId, ts: Date.now() });
 // 500 (not 200 with `{ok:false}`) so callers that only check `res.ok` can
 // distinguish an SDK failure from an empty-but-successful response.
        sendJson(res, 500, { ok: false, sessionId, content: '', error: redactSecrets(msg) });
      }
      })();
      inflightChat.set(sessionId, chatRun);
      try {
        await chatRun;
      } finally {
        inflightChat.delete(sessionId);
      }
      return;
    }

    if (url === '/chat' && req.method === 'DELETE') {
 // GDPR Art.17 erasure proxy. This service holds no persistent chat rows (state
 // is room-scoped/ephemeral), so a compliant response is a clean ack plus a
 // room-scoped chat:done. `confirm:true` gate mirrors the cockpit proxy.
      const body = await readJson<{ sessionId?: string; all?: boolean; confirm?: boolean }>(req);
      if (body.confirm !== true) {
        sendJson(res, 400, { error: 'confirm:true required' });
        return;
      }
      if (body.sessionId !== undefined) {
 // Validate against the chat:join pattern; room-scoped chat:done only (never a
 // global io.emit that would leak sessionId to other sessions).
        if (!SESSION_ID_PATTERN.test(body.sessionId)) {
          sendJson(res, 400, { error: 'Invalid sessionId (allowed: A-Za-z0-9_- , 1-128 chars)' });
          return;
        }
        io.to(body.sessionId).emit('chat:done', { sessionId: body.sessionId, ts: Date.now() });
      } else if (body.all !== true) {
        sendJson(res, 400, { error: 'sessionId or all:true required' });
        return;
      }
      console.info(`[/chat] delete ok from=${ip} sessionId=${body.sessionId ?? 'all'}` + (requestId ? ` requestId=${requestId}` : ''));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url === '/image' && req.method === 'POST') {
 // Pre-read body-size check.
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'Request body too large (max 1 MB)' });
        return;
      }
      const body = await readJson<ImageRequest>(req);
      if (!body.prompt || typeof body.prompt !== 'string') {
        sendJson(res, 400, { error: 'prompt required' });
        return;
      }
      const size = body.size || '1024x1024';
 // Validate size at the boundary so an invalid value yields a 400, not a wasted
 // upstream round-trip.
      if (body.size && !ALLOWED_IMAGE_SIZES.includes(body.size as (typeof ALLOWED_IMAGE_SIZES)[number])) {
        sendJson(res, 400, { error: 'Invalid size (must be one of the allowed dimensions)' });
        return;
      }
      try {
        const zai = await getZai();
        const response = await withUpstreamTimeout(
          zai.images.generations.create({ prompt: body.prompt, size }),
          UPSTREAM_CALL_TIMEOUT_MS,
        );
        const base64 = response?.data?.[0]?.base64 || '';
 // Record only (no live `io.emit`): the HTTP response already returns the
 // result to the requester, and broadcasting would push the prompt to every
 // connected client. The recorded event deliberately OMITS the prompt (possible
 // PII) so it isn't persisted into the replay buffer.
        recordEvent('snapshot:captured', { kind: 'ai-image', size, bytes: base64.length });
 // Success-path audit log (paid external image API). Prompt not logged (PII).
        console.info(
          `[/image] ok from=${ip} size=${size} bytes=${base64.length} promptBytes=${body.prompt.length}` +
            (requestId ? ` requestId=${requestId}` : ''),
        );
        sendJson(res, 200, { ok: true, base64, prompt: body.prompt, size, bytes: base64.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[/image] error:', redactSecrets(msg), requestId ? { requestId } : '');
 // 500 on SDK throw — same rationale as the /chat catch block above.
        sendJson(res, 500, { ok: false, error: redactSecrets(msg) });
      }
      return;
    }

    if (url === '/events' && req.method === 'GET') {
 // Replay the buffered events as JSON.
      const sinceId = parseInt(parseQuery(req.url || '').since_id || '0', 10) || 0;
      // Redact any secret shapes in user-supplied payloads before they leave.
      const events = getRecentEvents(sinceId).map((e) => {
        try {
          return JSON.parse(redactSecrets(JSON.stringify(e)));
        } catch {
          return e;
        }
      });
      sendJson(res, 200, { events });
      return;
    }

    sendJson(res, 404, { error: 'Not found', url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[http] error:', redactSecrets(msg));
 // Map the typed body-read errors to 413 / 408 rather than a generic 500.
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: msg });
      return;
    }
    if (err instanceof BodyReadTimeoutError) {
      sendJson(res, 408, { error: msg });
      return;
    }
    sendJson(res, 500, { error: msg });
  }
}

const httpServer = createServer(httpRequestHandler);
// Cap the header phase so a client can't trickle bytes to hold a connection open
// (slowloris). Disable the raw `requestTimeout` — engine.io's long-polls would
// otherwise be force-closed, causing spurious realtime disconnects; engine.io
// bounds its own connection liveness.
httpServer.headersTimeout = 15_000;
httpServer.requestTimeout = 0;
// Exported so the test suite can drive a real HTTP server on a random port
// without invoking `main()`.
export { httpServer };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
 // `Access-Control-Allow-Origin` is set per-request by `applyCorsHeaders`; no
 // wildcard here.
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

// Typed errors so the HTTP handler can map them by CLASS (413 / 408) rather than
// by substring-matching a message.
class BodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body too large (max ${maxBytes} bytes)`);
    this.name = 'BodyTooLargeError';
  }
}

class BodyReadTimeoutError extends Error {
  constructor(public readonly idleMs: number) {
    super(`Request body read timed out after ${idleMs} ms idle`);
    this.name = 'BodyReadTimeoutError';
  }
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;
    // Idle guard: reject if no chunk arrives within BODY_READ_IDLE_MS (the only
    // bound on a stalled body read, since `requestTimeout` is disabled).
    const idleTimer = setTimeout(() => {
      if (!aborted) {
        aborted = true;
        req.destroy();
        reject(new BodyReadTimeoutError(BODY_READ_IDLE_MS));
      }
    }, BODY_READ_IDLE_MS);
    const resetIdle = () => {
      if (aborted) return;
      idleTimer.refresh();
    };
    req.on('data', (c: Buffer) => {
 // Defensive size limit for missing/spoofed `content-length`: abort once we've
 // buffered more than MAX_BODY_BYTES and destroy the socket.
      totalBytes += c.length;
      if (totalBytes > MAX_BODY_BYTES) {
        if (!aborted) {
          aborted = true;
          clearTimeout(idleTimer);
          req.destroy();
          reject(new BodyTooLargeError(MAX_BODY_BYTES));
        }
        return;
      }
      chunks.push(c);
      resetIdle();
    });
    req.on('end', () => {
      if (aborted) return; // already rejected in 'data'
      clearTimeout(idleTimer);
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({} as T);
      try {
        resolve(JSON.parse(text) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', (err) => {
      if (!aborted) {
        clearTimeout(idleTimer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

function parseQuery(url: string): Record<string, string> {
  const q = url.split('?')[1];
  if (!q) return {};
  const out: Record<string, string> = {};
  for (const pair of q.split('&')) {
    const eq = pair.indexOf("="); const k = eq >= 0 ? pair.slice(0, eq) : pair; const v = eq >= 0 ? pair.slice(eq + 1) : "";
    if (k) {
 // `decodeURIComponent` throws `URIError` on malformed percent-escapes; decode
 // key and value independently so a malformed value falls back to its raw form
 // rather than crashing the request or dropping the entry.
      let dk: string;
      try {
        dk = decodeURIComponent(k);
      } catch {
        continue;
      }
      let dv: string;
      try {
        dv = decodeURIComponent(v || '');
      } catch {
        dv = v || '';
      }
      if (dk === '__proto__' || dk === 'constructor' || dk === 'prototype') {
        continue;
      }
      out[dk] = dv;
    }
  }
  return out;
}

// Race an upstream SDK await against a timeout so a stalled provider can't hang
// the HTTP handler forever. On expiry the promise rejects and the caller's
// try/catch returns an error response.
//
// The z-ai SDK has no `signal` abort hook, so an op that resolves AFTER the
// timeout fired must be torn down here: a streaming `create` resolves to a live
// `ReadableStream` which would leak the upstream socket if abandoned, so cancel
// it via its reader. Non-stream ops resolve to non-cancelable values.
function withUpstreamTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timedOut = false;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('upstream call stalled (timeout)'));
    }, ms);
    op.then(
      (v) => {
        clearTimeout(timer);
        if (timedOut) {
          // Op resolved AFTER the timeout fired. The caller has already taken
          // the error path; tear down any cancelable resource so it doesn't
          // leak. Only streaming creates return a live ReadableStream.
          const streamish = v as { getReader?: unknown };
          if (streamish && typeof streamish.getReader === 'function') {
            try {
              (streamish as ReadableStream<Uint8Array>).getReader().cancel().catch(() => {
                /* stream may already be released/errored */
              });
            } catch {
              /* not a real stream in practice; nothing to clean up */
            }
          }
          return;
        }
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
 // On timeout, cancel the reader so the upstream socket is torn down instead of
 // leaking (the pending `reader.read()` rejects and is swallowed).
      reader.cancel(new Error('upstream stream stalled (chunk timeout)')).catch(() => {
        /* reader may already be released/errored — nothing to clean up */
      });
      reject(new Error('upstream stream stalled (chunk timeout)'));
    }, ms);
    reader
      .read()
      .then((r) => {
        clearTimeout(timer);
        resolve(r);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

// ---------------------------------------------------------------------------
// Socket.IO server
// ---------------------------------------------------------------------------
//
// `path: '/'` is required so the frontend can connect via
// `io('/?XTransformPort=3003', ...)`. But engine.io's `attach()` registers a
// `request` listener that matches every URL when `path === '/'`, intercepting
// our HTTP routes. The re-wrap block below replaces that listener with a
// dispatcher: HTTP routes go to `httpRequestHandler`, engine.io URLs (containing
// `EIO=` or `transport=`) fall through to socket.io.

// Exported so the test suite can call `io.close()` before teardown.
const io = new SocketIOServer(httpServer, {
  path: '/', // MUST be '/' — Caddy uses this to route via XTransformPort
 // Restrict CORS to the configured cockpit origin; a wildcard would let any
 // hostile site connect and read every broadcast event.
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60_000,
  pingInterval: 25_000,
  // Explicit engine.io max HTTP buffer size (see MAX_HTTP_BUFFER_SIZE above).
  maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
});
export { io };

// Pre-auth engine.io gate: reject unauthenticated handshakes BEFORE a Socket is
// established and enforce the concurrent-connection ceiling. The connection-level
// check in `io.on('connection')` fires only after a transport is allocated, so
// without this an unauthenticated client could loop handshakes and exhaust
// resources. Accepts SOCKET_SECRET like the connection handler (the S2S/UI split
// is enforced on the HTTP proxy routes, not here).
io.use((socket, next) => {
  // Concurrent-connection ceiling (includes handshakes still in flight).
  if (io.engine.clientsCount > MAX_CONCURRENT_CONNECTIONS) {
    console.warn(
      `[cowork-events] socket handshake REJECTED (connection cap ` +
        `${MAX_CONCURRENT_CONNECTIONS} exceeded) from ${socketClientIp(socket)}`,
    );
    next(new Error('connection limit exceeded'));
    return;
  }
  const hsToken = extractHandshakeToken(socket.handshake);
  if (!tokenMatches(hsToken, SOCKET_SECRET)) {
    // Log the failed handshake auth with source IP — NEVER the token — then drop.
    console.warn(
      `[cowork-events] socket handshake auth FAILED from ${socketClientIp(socket)} — dropping connection`,
    );
    next(new Error('unauthorized'));
    return;
  }
  next();
});

// Re-wrap request listeners: HTTP routes first, socket.io for the rest.
{
 // Capture socket.io's wrapper (the only listener currently registered).
  const wrappedListeners = httpServer.listeners('request').slice(0);
  httpServer.removeAllListeners('request');
  httpServer.on('request', (req, res) => {
    const url = req.url || '/';
 // Engine.io handshake/polling URLs contain `EIO=` and/or `transport=`.
    const isEngineIo = url.includes('EIO=') || url.includes('transport=');
    if (!isEngineIo) {
 // Catch + log + 500 so a rejection escaping the handler (e.g. a sync throw
 // before the first await) is observable instead of hanging the client.
 // `res.headersSent` guards against double-writing.
      httpRequestHandler(req, res).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[http] uncaught handler error:', redactSecrets(msg));
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { error: 'Internal server error' });
          } catch {
            try { res.end(); } catch { /* socket already destroyed */ }
          }
        }
      });
      return;
    }
    for (const fn of wrappedListeners) {
      fn.call(httpServer, req, res);
    }
  });
}

// Derive the client IP for a socket.io connection, reusing `clientIp` for
// consistency across layers.
function socketClientIp(socket: Socket): string {
  // Strip control chars — the header-derived IP is attacker-controllable (log
  // injection).
  return clientIp({
    headers: (socket.handshake.headers || {}) as IncomingMessage['headers'],
    socket: { remoteAddress: socket.handshake.address },
  } as IncomingMessage).replace(/[\r\n\x00-\x1f]/g, '');
}

io.on('connection', (socket: Socket) => {
 // Re-check the token on EVERY connection so a tokenless client can't receive
 // `system:status` / `events:replay` and read every cockpit event.
  const hs = socket.handshake;
  const connToken = extractHandshakeToken(hs);
  if (!tokenMatches(connToken, SOCKET_SECRET)) {
 // Log the failed handshake auth with source IP — NEVER the token — then drop.
    console.warn(`[cowork-events] socket handshake auth FAILED from ${socketClientIp(socket)} — dropping connection`);
    socket.disconnect(true);
    return;
  }

 // Capture a scoped sessionId if the handshake auth payload carried one (the
 // cockpit sends only `{ token }` today → undefined → legacy/permissive path).
 // When set, `chat:join` enforces strict ownership.
  const authSessionId = (hs.auth as { sessionId?: unknown } | undefined)?.sessionId;
  socket.data.authorizedSessionId =
    typeof authSessionId === 'string' && authSessionId ? authSessionId : undefined;

 // Hydrate the dashboard with the last 50 events, redacting secret shapes
 // (mirrors the GET /events path).
  const recent = eventBuffer.slice(-50).map((e) => {
    try {
      return JSON.parse(redactSecrets(JSON.stringify(e)));
    } catch {
      return e;
    }
  });
  socket.emit('system:status', {
    hello: true,
    clients: io.engine.clientsCount,
    eventsBuffered: eventBuffer.length,
    serverStartedAt: serverStartedAt ?? 0,
    ts: Date.now(),
  });
  if (recent.length) {
    socket.emit('events:replay', recent);
  }

 // Join a room named after sessionId to receive that session's streamed chat
 // tokens. Ownership is delegated to `evaluateChatJoin`:
 // • `sessionId` must match `/^[A-Za-z0-9_-]{1,128}$/`.
 // • A connection with a scoped `authorizedSessionId` may join only that room.
 // • Legacy clients (no scoped sessionId, e.g. the cockpit) may join any room,
 //   logged `permissive-legacy`.
 // Per-session-HMAC ownership is future work — the deployment assumes a single
 // trusted user on loopback.
  socket.on('chat:join', (sessionId: unknown) => {
    // Rate-limit chat:join (before the join, even if the sessionId is rejected)
    // so a client can't flood the room map. Keyed SEPARATELY from the proxy /
    // socket-emit bucket: on loopback all buckets collapse to 127.0.0.1, so a
    // shared key would let a join burst starve the operator's own /chat calls.
    const rl = rateLimitCheck('chat-join:' + socketClientIp(socket));
    if (!rl.allowed) {
      console.warn(
        `[cowork-events] chat:join RATE-LIMITED from ${socketClientIp(socket)} ` +
          `(retry after ${rl.resetAt})`,
      );
      return;
    }
    // Per-socket room cap. `socket.rooms` includes the socket's own id room, so
    // subtract 1 before comparing.
    const joinedRooms = socket.rooms.size - 1;
    if (joinedRooms >= MAX_SOCKET_ROOMS) {
      console.warn(
        `[cowork-events] chat:join REJECTED (room cap ${MAX_SOCKET_ROOMS} exceeded) ` +
          `from ${socketClientIp(socket)}`,
      );
      return;
    }
    const decision = evaluateChatJoin(socket.data.authorizedSessionId, sessionId);
    if (!decision.allowed) {
      if (decision.reason === 'not-authorized-for-session') {
        console.warn(
          `[cowork-events] chat:join REJECTED (cross-session) requested=${String(sessionId)} ` +
            `owned=${socket.data.authorizedSessionId} from ${socketClientIp(socket)}`,
        );
      }
 // 'invalid-session-id' → silently ignore (no join, no error).
      return;
    }
    if (decision.reason === 'permissive-legacy') {
      console.warn(
        `[cowork-events] chat:join PERMISSIVE (no scoped sessionId at handshake) room=${sessionId} from ${socketClientIp(socket)}`,
      );
    }
    socket.join(sessionId as string);
  });

  socket.on('chat:leave', (sessionId: unknown) => {
    if (typeof sessionId === 'string' && sessionId) {
      socket.leave(sessionId);
    }
  });

 // Allow a connected client to broadcast an event (UI → server → others).
 // Re-check the token (defense-in-depth), accepting EITHER SOCKET_SECRET or
 // SHARED_SECRET — both legitimately open a connection, and a browser bundle
 // only ever holds the UI token, so requiring the S2S secret here would break
 // browser `emit` when the two tokens differ.
  socket.on('emit', (msg: { channel?: string; payload?: unknown }, ack?: (r: unknown) => void) => {
    const hs2 = socket.handshake;
    const emitToken = extractHandshakeToken(hs2);
    if (!tokenMatches(emitToken, SOCKET_SECRET) && !tokenMatches(emitToken, SHARED_SECRET)) {
      if (ack) ack({ ok: false, error: 'Invalid X-Cowork-Token' });
      return;
    }
    if (!msg || typeof msg.channel !== 'string' || !msg.channel) {
      if (ack) ack({ ok: false, error: 'channel required' });
      return;
    }
 // Never let a client impersonate a server-owned channel.
    if (SERVER_OWNED_CHANNELS.has(msg.channel)) {
      if (ack) ack({ ok: false, error: 'channel not allowed on client emit' });
      return;
    }
 // Channel-length + payload caps, mirrored from the HTTP `/emit` route.
    if (msg.channel.length > MAX_CHANNEL_LENGTH) {
      if (ack) ack({ ok: false, error: 'channel too long (max 128 chars)' });
      return;
    }
 // Restrict the channel charset (log-injection defense).
    if (!CHANNEL_PATTERN.test(msg.channel)) {
      if (ack) ack({ ok: false, error: 'invalid channel (allowed A-Za-z0-9:_- 1-128 chars)' });
      return;
    }
    const payload = msg.payload ?? null;
    if (JSON.stringify(payload).length > MAX_EMIT_PAYLOAD_BYTES) {
      if (ack) ack({ ok: false, error: 'payload too large (max 64 KB)' });
      return;
    }
 // Per-IP rate limit on the client emit path too, so an authenticated client
 // can't flood the replay buffer.
    const rl = rateLimitCheck(socketClientIp(socket));
    if (!rl.allowed) {
      if (ack) ack({ ok: false, error: 'Rate limit exceeded. Try again later.', resetAt: rl.resetAt });
      return;
    }
    const evt = recordEvent(msg.channel, payload);
    io.emit(msg.channel, evt.payload, { id: evt.id, ts: evt.ts });
    console.info(`[emit] ok channel=${msg.channel} from=${socketClientIp(socket)} id=${evt.id}`);
    if (ack) ack({ ok: true, id: evt.id });
  });
});

// ---------------------------------------------------------------------------
// Boot (only runs when this file is executed directly, not when imported)
// ---------------------------------------------------------------------------
//
// The status broadcaster, port bind, and signal handlers all live inside
// `main()` so importing this module (e.g. for tests) starts none of them.

/**
 * Bind to port 3003 on 127.0.0.1, start the periodic status broadcaster, and
 * register SIGTERM/SIGINT handlers. Guarded by the `import.meta.url` check at
 * the bottom so it does not run when imported by the test suite.
 */
function main(): void {
 // Refuse to start on the default `dev-token` in EVERY environment unless
 // `COWORK_ALLOW_DEV_TOKEN=1` is set — otherwise anyone who can reach the
 // service could use the publicly documented default.
  if (shouldRefuseStart(process.env.NODE_ENV, SHARED_SECRET)) {
    console.error(
      '[cowork-events] FATAL: COWORK_EVENT_TOKEN is unset or set to the default "dev-token". ' +
        'Set a real secret (e.g. `openssl rand -hex 32`) before running in production.',
    );
    process.exit(1);
  }

 // Record the boot time so reconnecting clients can detect a restart.
  serverStartedAt = Date.now();

 // Bind explicitly to 127.0.0.1 — `listen(port)` with no host binds to 0.0.0.0
 // (all interfaces), exposing the service to the LAN. The cockpit reaches it via
 // the same-origin Caddy gateway.
  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log(`[cowork-events] listening on http://127.0.0.1:${PORT} (loopback only)`);
    console.log(`[cowork-events] socket.io path=/  cors=${CORS_ORIGIN}  buffer=${EVENT_BUFFER_MAX}`);
    console.log(
      `[cowork-events] shared-secret=${
        SHARED_SECRET === DEV_TOKEN ? 'dev-token (default — dev mode only)' : 'custom'
      }`,
    );
  });

 // Startup advisory: chat:join runs in permissive-legacy mode (the cockpit
 // presents no scoped sessionId), so any authenticated client can join any
 // session room. Safe only for the single-trusted-user-on-loopback model.
  console.warn(
    '[cowork-events] WARNING: chat:join is in permissive-legacy mode (no ' +
      'per-session HMAC). Cross-session chat leakage is possible if exposed ' +
      'beyond loopback — single-user-loopback deployment only.',
  );

 // Buffer-reset marker so reconnecting clients can tell "no events yet" apart
 // from "history lost on restart".
  io.emit('system:status', { bufferReset: true, serverStartedAt, ts: Date.now() });

 // Periodic system:status broadcaster (every 15s).
  statusTimer = setInterval(() => {
    const status = {
      clients: io.engine.clientsCount,
      eventsBuffered: eventBuffer.length,
      uptimeSec: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      ts: Date.now(),
    };
    io.emit('system:status', status);
  }, STATUS_INTERVAL_MS);

 // Signal handlers can't await, so kick off the async `shutdown` and log any
 // rejection (instead of it becoming an unhandledRejection), force-exiting since
 // the process is then in an unknown state.
  const shutdownFromSignal = (signal: string) => {
    shutdown(signal).catch((e: unknown) => {
      console.error(`[cowork-events] shutdown rejected:`, e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => shutdownFromSignal('SIGTERM'));
  process.on('SIGINT', () => shutdownFromSignal('SIGINT'));

 // Crash handlers: log an otherwise-fatal rejection/exception and attempt a
 // graceful shutdown. Run under a supervisor so transient crashes self-heal.
  const onCrash = (where: string, e: unknown) => {
    const msg = e instanceof Error ? (e.stack || e.message) : String(e);
    console.error(`[cowork-events] ${where}:`, msg);
    shutdown(where, true).catch(() => process.exit(1));
  };
  process.on('uncaughtException', (e) => onCrash('uncaughtException', e));
  process.on('unhandledRejection', (e) => onCrash('unhandledRejection', e));
}

// Graceful shutdown. Await socket.io's async teardown FIRST — it releases the
// engine.io listeners holding the httpServer, otherwise pending long-polls keep
// the connection count above zero and `httpServer.close()` hangs until the 3s
// force-exit fires.
async function shutdown(signal: string, crash = false): Promise<void> {
  console.log(`[cowork-events] ${signal} received, shutting down...`);
  if (statusTimer !== undefined) {
    clearInterval(statusTimer);
    statusTimer = undefined;
  }
  await io.close();
  httpServer.close(() => {
    console.log('[cowork-events] closed');
 // Non-zero on the crash path so a supervisor's restart detection fires.
    process.exit(crash ? 1 : 0);
  });
 // Force-exit if httpServer.close stalls (e.g. keep-alives that never drain).
  setTimeout(() => process.exit(1), 3000).unref();
}

// ESM equivalent of `if (require.main === module)`: boot only when executed
// directly (not when the test suite imports the module).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

// ---------------------------------------------------------------------------
// Test exports — pure utilities + handler reference
// ---------------------------------------------------------------------------

export {
  httpRequestHandler,
  recordEvent,
  getRecentEvents,
  sendJson,
  readJson,
  parseQuery,
  rateLimitCheck,
  RATE_LIMIT_MAX,
  SHARED_SECRET,
  CORS_ORIGIN,
};
