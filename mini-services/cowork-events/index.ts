// Cowork Web Cockpit WebSocket mini-service — replaces Electron IPC with socket.io.
//
// This service replaces Electron's `ipcMain`/`ipcRenderer` with socket.io. It:
//   • Broadcasts real-time browser/agent events to all connected web clients
//   • Buffers the last 1000 events for replay on reconnect
//   • Exposes POST /emit so Next.js API routes can fan out events
//   • Exposes POST /chat (z-ai-web-dev-sdk streaming chat) and POST /image (image gen)
//
// PORT IS HARDCODED to 3003 per project rules. Do NOT read from env.
//
// NOTE: This service emits ONLY real events (received via POST /emit or the
// socket.io `emit` event). There is no synthetic event simulator — the
// dashboard must show whatever the real browser/agent produces, or empty
// states.

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import ZAI from 'z-ai-web-dev-sdk';

// Re-exported so consumers + tests can import the security primitives from a
// single entry point. The implementations live in `./security.ts` (no
// socket.io / z-ai-web-dev-sdk dependencies) so they can be unit-tested by
// the root vitest config without dragging in the mini-service runtime.
export { tokenMatches, applyCorsHeaders, shouldRefuseStart, evaluateChatJoin, DEV_TOKEN } from './security';
import { tokenMatches, applyCorsHeaders, shouldRefuseStart, evaluateChatJoin, DEV_TOKEN } from './security';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = 3003; // Hardcoded per project rules — do NOT use env.PORT
const EVENT_BUFFER_MAX = 1000;
const SHARED_SECRET = process.env.COWORK_EVENT_TOKEN || DEV_TOKEN;
const STATUS_INTERVAL_MS = 15_000;
// Maximum request body size — 1 MiB. Applies to all POST routes
// (/emit, /chat, /image). Enforced both via `content-length` header (cheap,
// pre-read) and inside `readJson` (defensive — in case the header is missing
// or spoofed by a client that streams more bytes than declared).
const MAX_BODY_BYTES = 1_048_576; // 1 MB
// Per-IP rate limit on the z-ai-web-dev-sdk proxy routes. Each IP gets
// RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS. Exceeding the limit
// returns 429. Tracked in-process (no Redis) — resets on service restart.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
// CORS allowlist. Default to the cockpit dashboard's origin so a
// browser tab on a hostile site can't `fetch('http://localhost:3003/...')` and
// read the response. The operator can override via `COWORK_CORS_ORIGIN`.
const CORS_ORIGIN = process.env.COWORK_CORS_ORIGIN || 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Per-IP in-memory rate limiter
// ---------------------------------------------------------------------------
//
// Simple sliding-window counter keyed by remote IP. Cleans up expired entries
// opportunistically on each check (cheap O(n) scan, n is bounded by the number
// of distinct IPs seen in the last minute). Returns true if the request is
// allowed, false if the limit has been exceeded.

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms when the window resets
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function clientIp(req: IncomingMessage): string {
  // Behind the Caddy gateway (and the Next.js server-to-server fetch), every
  // TCP peer appears as 127.0.0.1 because the mini-service binds to loopback.
  // Reading only `req.socket.remoteAddress` would make all clients share a
  // single rate-limit bucket — turning the "per-IP" limit into a global
  // 10 req/min throttle.
  //
  // Prefer the leftmost IP in `x-forwarded-for` (set by Caddy / Next.js when
  // proxying). Fall back to the socket address when the header is absent
  // (direct localhost dev / curl). The leftmost entry is the original client —
  // subsequent entries are intermediate proxies.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  // `x-forwarded-for` may also arrive as an array (Node lowercases + splits
  // duplicate headers). Handle that case too.
  if (Array.isArray(xff) && xff.length > 0) {
    const first = xff[0].split(',')[0].trim();
    if (first) return first;
  }
  const sock = req.socket as { remoteAddress?: string };
  return sock.remoteAddress || 'unknown';
}

function rateLimitCheck(ip: string): { allowed: boolean; resetAt: number; remaining: number } {
  const now = Date.now();
  // Opportunistic GC: drop expired entries so the Map can't grow unbounded.
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
// In-memory event store
// ---------------------------------------------------------------------------

const eventBuffer: BufferedEvent[] = [];
let eventCounter = 0;

function recordEvent(channel: string, payload: unknown): BufferedEvent {
  // Do NOT record `system:status` events into the replay buffer. The
  // 15-second status broadcaster (in `main()`) calls
  // `recordEvent('system:status', ...)` which would otherwise push a tick
  // into the 1000-entry buffer every 15s. After ~4.2 hours (1000 × 15s), the
  // buffer would be entirely status ticks — real events (tab:updated,
  // agent:task-updated, network:request, etc.) would be spliced out and
  // reconnecting clients would receive only noise in `events:replay`.
  //
  // Skip the buffer for `system:status`. The broadcaster still calls
  // `io.emit('system:status', ...)` for live consumers; we just don't pollute
  // the replay history. If status history is needed, use a separate small
  // ring buffer (not the shared event buffer).
  if (channel === 'system:status') {
    // Return a synthetic event with the next id (so the caller's `io.emit`
    // still receives a consistent `{ id, ts }` envelope) without pushing
    // into `eventBuffer`.
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
    zaiPromise = ZAI.create().catch((err) => {
      // Reset so the next attempt can try again — auth issues may be transient.
      zaiPromise = null;
      throw err;
    });
  }
  return zaiPromise;
}

// ---------------------------------------------------------------------------
// HTTP server (low-level so we can attach socket.io + REST on the same port)
// ---------------------------------------------------------------------------

async function httpRequestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS preflight — only allow the configured origin. `applyCorsHeaders`
  // is a pure function (sets headers iff the origin matches `CORS_ORIGIN`).
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
  applyCorsHeaders(res, origin, CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cowork-Token');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = (req.url || '/').split('?')[0];

  try {
    // `/health` is the only unauthenticated route — and it returns
    // ONLY `{ ok: true }` so a liveness probe can't leak client count, event
    // buffer size, uptime, or port. Every other route requires the
    // `X-Cowork-Token` header.
    if (url === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // All other routes require the shared-secret token.
    if (!tokenMatches(req.headers['x-cowork-token'] as string | undefined, SHARED_SECRET)) {
      // Log failed auth with source IP for security observability.
      // NEVER log the token itself.
      console.warn(`[cowork-events] 401 Unauthorized (invalid X-Cowork-Token) from ${clientIp(req)}`);
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
      // Pre-read body size check via `content-length` (same as /chat and
      // /image). The in-stream check inside `readJson` still catches chunked
      // bodies without `content-length`, but the cheap pre-read check rejects
      // oversized declared bodies before we consume the stream — saving
      // bandwidth + CPU on the stream/destroy cycle.
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
      const payload = body.payload ?? null;
      const evt = recordEvent(channel, payload);
      io.emit(channel, evt.payload, { id: evt.id, ts: evt.ts });
      sendJson(res, 200, { ok: true, id: evt.id, channel });
      return;
    }

    if (url === '/chat' && req.method === 'POST') {
      // Pre-read body size check via `content-length` (cheap — no body
      // parsing). If the client declares a body larger than MAX_BODY_BYTES,
      // reject before consuming the stream.
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'Request body too large (max 1 MB)' });
        return;
      }
      // Per-IP rate limit — 10 chat requests / minute.
      const rl = rateLimitCheck(clientIp(req));
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((rl.resetAt - Date.now()) / 1000)));
        sendJson(res, 429, { error: 'Rate limit exceeded. Try again later.', resetAt: rl.resetAt });
        return;
      }
      // Auth: already enforced above (the global token check).
      const body = await readJson<ChatRequest>(req);
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

      try {
        const zai = await getZai();
        let finalText = '';

        if (wantStream) {
          // The z-ai-web-dev-sdk returns a raw `ReadableStream<Uint8Array>`
          // (the fetch response.body) when `stream: true` is set. We need to
          // parse the SSE event stream manually: each event is a line
          // beginning with `data: ` and ending with a blank line.
          // The final event is `data: [DONE]`.
          const stream = (await zai.chat.completions.create({
            messages,
            stream: true,
            thinking: { type: body.thinking === 'enabled' ? 'enabled' : 'disabled' },
          })) as ReadableStream<Uint8Array> | null;

          if (stream && typeof stream.getReader === 'function') {
            const reader = stream.getReader();
            const decoder = new TextDecoder('utf-8');
            let sseBuffer = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              sseBuffer += decoder.decode(value, { stream: true });
              // SSE events are separated by `\n\n`.
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
                      io.to(sessionId).emit('chat:message', { sessionId, token, ts: Date.now() });
                    }
                  } catch {
                    // Skip malformed event lines.
                  }
                }
              }
            }
          } else {
            // Fallback: some SDK versions might return an async iterable.
            // Treat any non-ReadableStream as such — but guard against a null
            // stream first: `for await of null` throws TypeError at runtime.
            if (!stream) {
              // SDK returned null (auth failure / upstream error). Emit done
              // to the room ONLY (sessionId must not leak to other clients)
              // and return the partial (empty) result so the client doesn't hang.
              io.to(sessionId).emit('chat:done', { sessionId, ts: Date.now() });
              sendJson(res, 200, { ok: true, sessionId, content: finalText, streamed: wantStream });
              return;
            }
            for await (const chunk of (stream as unknown as AsyncIterable<{
              choices?: Array<{ delta?: { content?: string } }>;
            }>)) {
              const token = chunk?.choices?.[0]?.delta?.content || '';
              if (token) {
                finalText += token;
                io.to(sessionId).emit('chat:message', { sessionId, token, ts: Date.now() });
              }
            }
          }
          io.to(sessionId).emit('chat:done', { sessionId, ts: Date.now() });
          // NOTE: Do NOT `io.emit('chat:done', ...)` globally — that leaks
          // `sessionId` to every connected client (including ones in other
          // sessions). Room-scoped broadcast above is sufficient; clients that
          // want chat updates must `chat:join` the session room first.
        } else {
          const completion = await zai.chat.completions.create({
            messages,
            thinking: { type: body.thinking === 'enabled' ? 'enabled' : 'disabled' },
          });
          finalText = completion?.choices?.[0]?.message?.content || '';
        }

        sendJson(res, 200, { ok: true, sessionId, content: finalText, streamed: wantStream });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[/chat] error:', msg);
        io.to(sessionId).emit('chat:error', { sessionId, error: msg, ts: Date.now() });
        // Return HTTP 500 (not 200 with `{ok:false}`) when the
        // z-ai SDK throws. The previous `{ok:false}` shape was indistinguishable
        // from a successful empty-content response at the HTTP layer — fetch
        // callers that only checked `res.ok` (the React Query mutation in
        // `useSendChat` does exactly that: `if (!r.ok) throw`) treated the
        // SDK failure as a success, then surfaced the empty content as
        // "Empty response" instead of "Chat backend offline". 500 lets the
        // client distinguish "the server-side SDK blew up" from "the LLM
        // returned no content".
        sendJson(res, 500, { ok: false, sessionId, content: '', error: msg });
      }
      return;
    }

    if (url === '/image' && req.method === 'POST') {
      // Pre-read body size check (same as /chat).
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'Request body too large (max 1 MB)' });
        return;
      }
      // Per-IP rate limit — 10 image requests / minute.
      const rl = rateLimitCheck(clientIp(req));
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((rl.resetAt - Date.now()) / 1000)));
        sendJson(res, 429, { error: 'Rate limit exceeded. Try again later.', resetAt: rl.resetAt });
        return;
      }
      // Auth: already enforced above (the global token check).
      const body = await readJson<ImageRequest>(req);
      if (!body.prompt || typeof body.prompt !== 'string') {
        sendJson(res, 400, { error: 'prompt required' });
        return;
      }
      const size = body.size || '1024x1024';
      try {
        const zai = await getZai();
        const response = await zai.images.generations.create({ prompt: body.prompt, size });
        const base64 = response?.data?.[0]?.base64 || '';
        // Broadcasting `io.emit('snapshot:captured', ...)` would push the
        // prompt (which may contain sensitive user input) to EVERY connected
        // socket.io client — including clients in other browser tabs or other
        // users sharing the same `SHARED_SECRET`. The HTTP response already
        // returns the result to the requesting client (the cockpit server-side
        // fetch), so the live broadcast is unnecessary AND a privacy leak.
        //
        // Only `recordEvent` (so reconnecting clients see the event in
        // `events:replay` — the documented event-sourcing behavior), and skip
        // the live `io.emit`. The requester already has the response
        // via the HTTP round-trip; other live clients don't need to see the
        // prompt in real time. The recorded event still contains the prompt
        // (any client that can authenticate + connect can read the replay),
        // but that's the same trust boundary as every other recorded event.
        recordEvent('snapshot:captured', { kind: 'ai-image', prompt: body.prompt, size, bytes: base64.length });
        sendJson(res, 200, { ok: true, base64, prompt: body.prompt, size, bytes: base64.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[/image] error:', msg);
        // Return HTTP 500 (not 200 with `{ok:false}`) when the
        // z-ai SDK throws — same rationale as the /chat catch block above.
        sendJson(res, 500, { ok: false, error: msg });
      }
      return;
    }

    if (url === '/events' && req.method === 'GET') {
      // SSE-style replay: returns the buffered events as JSON.
      const sinceId = parseInt(parseQuery(req.url || '').since_id || '0', 10) || 0;
      sendJson(res, 200, { events: getRecentEvents(sinceId) });
      return;
    }

    sendJson(res, 404, { error: 'Not found', url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[http] error:', msg);
    // If the body exceeded the size limit during streaming, `readJson`
    // rejects with our size-limit error message — surface that as a 413 rather
    // than a generic 500.
    if (/too large/i.test(msg)) {
      sendJson(res, 413, { error: msg });
      return;
    }
    sendJson(res, 500, { error: msg });
  }
}

const httpServer = createServer(httpRequestHandler);
// Exported so the test suite can drive a real HTTP server bound to a
// random port without invoking `main()` (which would bind to port 3003 +
// register signal handlers + start the 15-second status interval).
export { httpServer };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // `Access-Control-Allow-Origin` is set per-request by
  // `applyCorsHeaders` in `httpRequestHandler`. We do NOT set a wildcard
  // here — same-origin callers (the cockpit dashboard) don't need CORS at
  // all, and cross-origin callers must match the allowlist.
  res.writeHead(status, {
    'Content-Type': 'application/json',
  });
  res.end(payload);
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      // Defensive size limit — even if `content-length` is missing or
      // spoofed, abort reading once we've buffered more than MAX_BODY_BYTES.
      // This stops a client from streaming an unbounded payload and exhausting
      // memory. We destroy the socket so the client gets an RST/ECONNRESET.
      totalBytes += c.length;
      if (totalBytes > MAX_BODY_BYTES) {
        if (!aborted) {
          aborted = true;
          req.destroy();
          reject(new Error('Request body too large (max 1 MB)'));
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return; // already rejected in 'data'
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({} as T);
      try {
        resolve(JSON.parse(text) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err instanceof Error ? err : new Error(String(err)));
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
      // `decodeURIComponent` throws `URIError` on malformed
      // percent-escapes like `%ZZ` or `%E0%A4%A` (truncated multibyte). A
      // hostile or buggy client could otherwise crash the whole request
      // with a malformed query string. Fall back to the raw value — the
      // caller (currently `/events?since_id=N`) only reads `since_id`,
      // which a sane client always sends as a plain integer; the fallback
      // only kicks in for keys/values the caller didn't intend to read.
      try {
        out[decodeURIComponent(k)] = decodeURIComponent(v || '');
      } catch {
        out[k] = v || '';
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Socket.IO server
// ---------------------------------------------------------------------------
//
// IMPORTANT: socket.io's `path: '/'` is required by project rules so the
// frontend can connect via `io('/?XTransformPort=3003', ...)`. But engine.io's
// `attach()` (called by the `SocketIOServer` constructor below) registers a
// `request` listener that matches every URL when `path === '/'` — that would
// intercept our HTTP routes (/health, /chat, /image, /emit, /events) and
// return `{"code":0,"message":"Transport unknown"}`.
//
// To work around this, after SocketIOServer attaches we replace the request
// listener with a dispatcher: HTTP routes go to `httpRequestHandler` directly,
// while engine.io handshake/polling URLs (containing `EIO=` or `transport=`)
// fall through to socket.io's wrapper. See the re-wrap block below.

// Exported so the test suite can call `io.close()` to release socket.io's
// hold on the underlying httpServer before tearing the test process down.
const io = new SocketIOServer(httpServer, {
  path: '/', // MUST be '/' — Caddy uses this to route via XTransformPort
  // Restrict CORS to the configured cockpit origin (default
  // `http://localhost:3000`). A wildcard would let any hostile site connect
  // and read every broadcast event.
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60_000,
  pingInterval: 25_000,
});
export { io };

// Re-wrap request listeners: HTTP routes first, socket.io for the rest.
{
  // Capture socket.io's wrapper (the only listener currently registered).
  const wrappedListeners = httpServer.listeners('request').slice(0);
  httpServer.removeAllListeners('request');
  httpServer.on('request', (req, res) => {
    const url = req.url || '/';
    // Engine.io handshake/polling URLs always contain `EIO=` (protocol version)
    // and/or `transport=` (transport name). Anything else is an HTTP route.
    const isEngineIo = url.includes('EIO=') || url.includes('transport=');
    if (!isEngineIo) {
      // A floating `void httpRequestHandler(req, res)` promise
      // silently swallowed any rejection that escaped the handler — most
      // likely a sync throw before the first `await` (e.g. inside
      // `applyCorsHeaders` or `res.setHeader` on a closed socket). The
      // client would see a hung connection and the operator would see no
      // log. Catch + log + send a structured 500 so the failure is at
      // least observable. `res.headersSent` guards against double-writing
      // when the handler had already started a response.
      httpRequestHandler(req, res).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[http] uncaught handler error:', msg);
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

// Derive the client IP for a socket.io connection, reusing the HTTP-side
// `clientIp` helper so IP resolution is consistent across both layers.
// socket.io exposes the forwarded + direct addresses on `socket.handshake`.
function socketClientIp(socket: Socket): string {
  return clientIp({
    headers: (socket.handshake.headers || {}) as IncomingMessage['headers'],
    socket: { remoteAddress: socket.handshake.address },
  } as IncomingMessage);
}

io.on('connection', (socket: Socket) => {
  // Require the shared-secret token on EVERY connection. A malicious
  // website that just opens `io('/?XTransformPort=3003')` with no token must
  // NOT receive `system:status` or `events:replay` — otherwise it would
  // silently read every cockpit event in real time.
  const hs = socket.handshake;
  const authTok = (hs.auth as { token?: unknown } | undefined)?.token;
  const queryTok = (hs.query as Record<string, unknown> | undefined)?.token;
  const connToken =
    (typeof authTok === 'string' ? authTok : '') ||
    (typeof queryTok === 'string' ? queryTok : '') ||
    (Array.isArray(queryTok) && typeof queryTok[0] === 'string' ? queryTok[0] : '') ||
    '';
  if (!tokenMatches(connToken, SHARED_SECRET)) {
    // Log the failed handshake auth with source IP for observability.
    // NEVER log the token. Then drop the connection without emitting anything.
    console.warn(`[cowork-events] socket handshake auth FAILED from ${socketClientIp(socket)} — dropping connection`);
    socket.disconnect(true);
    return;
  }

  // Capture a per-connection scoped sessionId if the client presented one in
  // the handshake auth payload. The cockpit currently only sends
  // `{ token }`, so this is `undefined` for today's clients (legacy /
  // permissive path). When set, `chat:join` enforces strict ownership.
  const authSessionId = (hs.auth as { sessionId?: unknown } | undefined)?.sessionId;
  socket.data.authorizedSessionId =
    typeof authSessionId === 'string' && authSessionId ? authSessionId : undefined;

  // Send last 50 events on connect so the dashboard can hydrate immediately.
  const recent = eventBuffer.slice(-50);
  socket.emit('system:status', {
    hello: true,
    clients: io.engine.clientsCount,
    eventsBuffered: eventBuffer.length,
    ts: Date.now(),
  });
  if (recent.length) {
    socket.emit('events:replay', recent);
  }

  // Clients can join a "room" named after their sessionId to receive
  // streamed chat tokens targeted at them only.
  //
  // ROOM SCOPING: chat:join enforces strict ownership so a connected client
  // cannot read another session's streamed `chat:message` tokens.
  //
  // The ownership decision is delegated to the pure `evaluateChatJoin`
  // helper (in `./security.ts`):
  //   • `sessionId` must match `/^[A-Za-z0-9_-]{1,128}$/` (defeats arbitrary
  //     room-name abuse).
  //   • If this connection authenticated with a scoped `authorizedSessionId`
  //     (captured above), it may ONLY join that exact session's room.
  //   • Legacy clients (no scoped sessionId — e.g. the current cockpit) are
  //     still allowed to join any room, but the join is logged as
  //     `permissive-legacy` so operators can spot the unconstrained path.
  //
  // TODO (unchanged intent): bind room membership to a per-client identifier
  // that the client cannot spoof — e.g. the cockpit mints sessionIds and the
  // client proves ownership with a per-session HMAC. The current
  // `authorizedSessionId`-from-handshake model only restricts clients that
  // voluntarily present a scoped sessionId; a client that omits it stays on
  // the permissive path. Out of scope here — the current deployment assumes a
  // single trusted user (the operator) on loopback.
  socket.on('chat:join', (sessionId: unknown) => {
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

  // Allow a connected client to broadcast an event too (e.g. UI → server → others).
  //
  // Auth: the client must present the shared secret (`COWORK_EVENT_TOKEN`, same
  // value as the HTTP `X-Cowork-Token` header) in either `socket.handshake.auth.token`
  // or `socket.handshake.query.token`. The connection-level auth check above
  // already enforces this, but we re-check here in case socket.io's handshake
  // auth state is tampered with after connection (defense-in-depth).
  socket.on('emit', (msg: { channel?: string; payload?: unknown }, ack?: (r: unknown) => void) => {
    const hs2 = socket.handshake;
    const authTok2 = (hs2.auth as { token?: unknown } | undefined)?.token;
    const queryTok2 = (hs2.query as Record<string, unknown> | undefined)?.token;
    const emitToken =
      (typeof authTok2 === 'string' ? authTok2 : '') ||
      (typeof queryTok2 === 'string' ? queryTok2 : '') ||
      (Array.isArray(queryTok2) && typeof queryTok2[0] === 'string' ? queryTok2[0] : '') ||
      '';
    if (!tokenMatches(emitToken, SHARED_SECRET)) {
      if (ack) ack({ ok: false, error: 'Invalid X-Cowork-Token' });
      return;
    }
    if (!msg || typeof msg.channel !== 'string' || !msg.channel) {
      if (ack) ack({ ok: false, error: 'channel required' });
      return;
    }
    const evt = recordEvent(msg.channel, msg.payload);
    io.emit(msg.channel, evt.payload, { id: evt.id, ts: evt.ts });
    if (ack) ack({ ok: true, id: evt.id });
  });

  socket.on('disconnect', () => {
    // No-op; we just rely on socket.io's internal bookkeeping.
  });
});

// ---------------------------------------------------------------------------
// Periodic system:status broadcaster
// ---------------------------------------------------------------------------
//
// (Moved inside `main()` below so that simply importing this module — e.g. for
// unit tests — does NOT start the 15-second interval + bind to port 3003 +
// register signal handlers. Tests that need a live HTTP server call
// `httpServer.listen(0, '127.0.0.1')` themselves.)

// ---------------------------------------------------------------------------
// Boot (only runs when this file is executed directly, not when imported)
// ---------------------------------------------------------------------------

/**
 * Bind to port 3003 on 127.0.0.1, start the periodic status broadcaster, and
 * register SIGTERM/SIGINT handlers. Pure side-effect — returns void.
 *
 * Guarded by the ESM `import.meta.url` check at the bottom of the file so it
 * does NOT run when the module is imported by the test suite.
 */
function main(): void {
  // Refuse to start in production if the shared secret is the
  // well-known `dev-token`. An operator who deploys this service without
  // setting `COWORK_EVENT_TOKEN` would otherwise be running with a publicly
  // documented default that anyone on the LAN could use.
  if (shouldRefuseStart(process.env.NODE_ENV, SHARED_SECRET)) {
    console.error(
      '[cowork-events] FATAL: COWORK_EVENT_TOKEN is unset or set to the default "dev-token". ' +
        'Set a real secret (e.g. `openssl rand -hex 32`) before running in production.',
    );
    process.exit(1);
  }

  // Bind explicitly to 127.0.0.1 — Node's `listen(port)` with no host
  // argument binds to 0.0.0.0 (all interfaces), which would expose the
  // mini-service to every host on the LAN. The cockpit dashboard reaches the
  // mini-service via the same-origin Caddy gateway (`XTransformPort=3003`),
  // not via direct LAN access.
  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log(`[cowork-events] listening on http://127.0.0.1:${PORT} (loopback only)`);
    console.log(`[cowork-events] socket.io path=/  cors=${CORS_ORIGIN}  buffer=${EVENT_BUFFER_MAX}`);
    console.log(
      `[cowork-events] shared-secret=${
        SHARED_SECRET === DEV_TOKEN ? 'dev-token (default — dev mode only)' : 'custom'
      }`,
    );
  });

  // Periodic system:status broadcaster — fires every 15 seconds. Inside
  // `main()` so tests don't inherit the interval.
  setInterval(() => {
    const status = {
      clients: io.engine.clientsCount,
      eventsBuffered: eventBuffer.length,
      uptimeSec: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      ts: Date.now(),
    };
    io.emit('system:status', status);
  }, STATUS_INTERVAL_MS);

  // `shutdown` is async (it awaits `io.close()`). Signal
  // handlers can't await, so we kick off the promise and attach a `.catch`
  // handler so a rejection (e.g. `io.close()` throwing on a half-closed
  // socket) is observable in the logs instead of becoming an
  // unhandledRejection. The previous `void shutdown(...)` form marked the
  // floating promise as intentional but still swallowed rejections silently.
  const shutdownFromSignal = (signal: string) => {
    shutdown(signal).catch((e: unknown) => {
      console.error(`[cowork-events] shutdown rejected:`, e instanceof Error ? e.message : String(e));
      // Force-exit if graceful shutdown failed — the process is in an
      // unknown state and shouldn't keep running.
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => shutdownFromSignal('SIGTERM'));
  process.on('SIGINT', () => shutdownFromSignal('SIGINT'));
}

// Graceful shutdown
//
// `shutdown` is async so we can `await io.close()` before
// `httpServer.close()`. `io.close()` is the socket.io Server's async teardown
// — it sends disconnect packets to all connected clients, waits for
// acknowledgements, and releases the engine.io listeners that hold references
// to the underlying httpServer. Without awaiting it, `httpServer.close()`
// races with socket.io's teardown: pending socket.io HTTP long-poll requests
// can keep the httpServer's connection count above zero, causing
// `httpServer.close()` to hang until the 3s force-exit fallback fires.
async function shutdown(signal: string): Promise<void> {
  console.log(`[cowork-events] ${signal} received, shutting down...`);
  // Await socket.io's graceful teardown FIRST so it can send disconnect
  // packets + release its hold on the httpServer. `io.close` returns a
  // Promise (socket.io v4+) that resolves when all connections are closed.
  await io.close();
  httpServer.close(() => {
    console.log('[cowork-events] closed');
    process.exit(0);
  });
  // Force-exit after 3s if httpServer.close stalls (e.g., keep-alive
  // connections that never drain).
  setTimeout(() => process.exit(1), 3000).unref();
}

// ESM equivalent of CommonJS `if (require.main === module)`. When this file
// is executed directly via `npx tsx index.ts` / `npm run dev`, `process.argv[1]`
// is the absolute path to this file — so we boot. When the test suite imports
// the module, `process.argv[1]` is the vitest binary — so we skip `main()`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

// ---------------------------------------------------------------------------
// Test exports — pure utilities + handler reference
// ---------------------------------------------------------------------------
//
// Exported so `tests/cowork-events.test.ts` can drive the HTTP routes directly
// against a real `httpServer` bound to port 0 (OS-assigned), without invoking
// `main()` (which would bind to port 3003 + register signal handlers).

export {
  httpRequestHandler,
  recordEvent,
  getRecentEvents,
  sendJson,
  readJson,
  parseQuery,
  SHARED_SECRET,
  CORS_ORIGIN,
};
