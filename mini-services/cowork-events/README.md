# cowork-events

WebSocket + REST mini-service (port **3003**, bound to `127.0.0.1`) that
powers real-time event broadcasting and AI integration for the Cowork Web
Cockpit.

This service is the **security boundary** between the cockpit dashboard (which
runs in the browser) and the outside world. It:

- Broadcasts real-time browser/agent events to all connected web clients
  (socket.io)
- Buffers the last 1000 events for replay on reconnect
- Exposes `POST /emit` so Next.js API routes can fan out events
- Proxies `POST /chat` and `POST /image` to the
  [`z-ai-web-dev-sdk`](https://www.npmjs.com/package/z-ai-web-dev-sdk) so the
  browser never sees the upstream API token
- Enforces a shared-secret token on **every** route except `/health`
- Disconnects unauthenticated socket.io connections immediately (no event
  leakage)

The service lives inside the Open Cowork Chrome Extension repo at
`mini-services/cowork-events/`.

---

## Install + run

The mini-service has its own `package.json` (so its dependencies — `socket.io`,
`z-ai-web-dev-sdk`, `tsx` — don't pollute the root). Its dependencies are
installed by the root `bootstrap` script (`npm run bootstrap`, which runs
`npm ci --prefix mini-services/cowork-events` alongside the cockpit install).

### From the repo root (recommended for development)

```bash
npm install               # root deps
npm run bootstrap         # installs mini-services/cowork-events (+ cockpit) deps
npm run dev:events        # → cd mini-services/cowork-events && npx tsx watch index.ts
```

`npm run dev` (concurrent) also starts the cockpit + extension watchers
alongside `dev:events`.

### Standalone (inside `mini-services/cowork-events/`)

```bash
cd mini-services/cowork-events
npm install
npx tsx watch index.ts    # hot reload
# or
npx tsx index.ts          # one-shot
```

> **Note:** the package scripts in `mini-services/cowork-events/package.json`
> (`npm run dev` / `npm run start`) are thin wrappers around
> `npx tsx watch index.ts` / `npx tsx index.ts` respectively. Both work; the
> `npx tsx …` form is what the root `dev:events` script invokes.

### Logs

The service logs to **stdout** — it performs no file logging of its own. Redirect
stdout if you want a persistent log file:

```bash
npx tsx index.ts >> mini-services/cowork-events/service.log 2>&1
```

---

## Network binding

The service binds to **`127.0.0.1:3003`** — loopback only. It does NOT listen
on `0.0.0.0`. The cockpit dashboard reaches the service via the same-origin
Caddy gateway (`?XTransformPort=3003`), never via direct LAN access.

```text
[cowork-events] listening on http://127.0.0.1:3003 (loopback only)
```

---

## Environment variables

| Variable                | Required?         | Default                  | Notes                                                                                                                                                                       |
|-------------------------|-------------------|--------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `COWORK_EVENT_TOKEN`    | **yes in prod**   | `dev-token`              | Shared secret used for `X-Cowork-Token` HTTP header + socket.io `auth.token`. **The service refuses to start if this is unset or set to the well-known `dev-token` — unless `COWORK_ALLOW_DEV_TOKEN=1` is explicitly set (dev-loopback only). `NODE_ENV` is NOT a safety net.** |
| `COWORK_ALLOW_DEV_TOKEN`| no (dev only)     | unset (off)              | Explicit opt-in to run with the `dev-token` default. Set to `1` ONLY for a trusted local loopback dev session. Must NEVER be set in production.                              |
| `COWORK_CORS_ORIGIN`    | no                | `http://localhost:3000`  | Allowlisted origin for CORS (`Access-Control-Allow-Origin` is mirrored only when the request's `Origin` header matches this value).                                        |
| `NODE_ENV`              | **yes for any non-localhost deploy** | —            | **MANDATORY = `production` for any deployment reachable from another host** (i.e. anything that is not bound to `127.0.0.1`/localhost). The dev-token refusal does NOT depend on `NODE_ENV` — a real `COWORK_EVENT_TOKEN` is required regardless — but `NODE_ENV=production` is the production signal other operators rely on and must be set outside loopback. |

> **Note on `ZAI_API_TOKEN`:** an earlier version of this README listed a
> `ZAI_API_TOKEN` environment variable here. That was incorrect — the
> installed `z-ai-web-dev-sdk@0.0.18` does NOT read any env var. It reads
> its API key from a `.z-ai-config` JSON file (see "Z-AI SDK configuration"
> below). Setting `ZAI_API_TOKEN` has no effect.

Generate a real secret with:

```bash
openssl rand -hex 32
```

### ⚠️ Production hardening — READ BEFORE DEPLOYING

These rules are enforced by `security.ts → shouldRefuseStart` and the
socket.io connection handler. They are easy to get wrong, so they are called out
explicitly:

- **Set a REAL `COWORK_EVENT_TOKEN`** for every deployment that is not a
  trusted local loopback dev session. **Never use `dev-token` in production** —
  it is a publicly documented default that anyone on the LAN could use.
- **`NODE_ENV=production` is MANDATORY** for any deployment that is NOT bound to
  `127.0.0.1` / localhost (anything reachable from another host). Without it the
  process still refuses the `dev-token`, but you lose the production signal that
  other operators and tooling rely on.
- **The `dev-token` is REFUSED by default.** The service refuses to start when
  `COWORK_EVENT_TOKEN` is unset **or** equals the well-known `dev-token`,
  **UNLESS** `COWORK_ALLOW_DEV_TOKEN=1` is explicitly set. This is a hard
  default that does **NOT** depend on `NODE_ENV`. A misconfigured deploy that
  runs `npx tsx index.ts` with no `NODE_ENV` (or any non-production value) will
  **NOT** silently accept the public default — it must be explicitly opted in.
- **Never set `COWORK_ALLOW_DEV_TOKEN=1` in production.** It exists only for a
  trusted local loopback dev session where you have consciously chosen to run
  unauthenticated. See `.env.example` for the full template.

### Z-AI SDK configuration (`.z-ai-config`)

The `/chat` and `/image` routes proxy to `z-ai-web-dev-sdk@0.0.18`. The SDK
loads its credentials from a `.z-ai-config` JSON file — **not** from an
environment variable. The SDK searches the following paths in order and uses
the first one that parses successfully:

1. `mini-services/cowork-events/.z-ai-config` (current project directory — recommended)
2. `~/.z-ai-config` (user home directory)
3. `/etc/.z-ai-config` (system directory)

The file must be valid JSON with **both** `baseUrl` and `apiKey` fields
(the SDK rejects configs missing either). `chatId` and `userId` are
optional.

```json
{
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "your-api-key-here",
  "chatId": "optional-chat-id",
  "userId": "optional-user-id"
}
```

> **`baseUrl` must include the `/v1` prefix** (e.g.
> `https://api.example.com/v1`) — the SDK appends path segments like
> `/chat/completions` directly to `baseUrl`.

If the SDK can't find a valid config in any of the three locations, the
first call to `/chat` or `/image` will throw
`Configuration file not found or invalid. Please create .z-ai-config …`
and the proxy route returns a 500 to the caller. `/health`, `/events`,
`/emit`, and `/` are NOT affected (they don't touch the SDK).

Example — create the config inside the mini-service directory:

```bash
cat > mini-services/cowork-events/.z-ai-config <<'EOF'
{
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "your-api-key-here"
}
EOF
chmod 600 mini-services/cowork-events/.z-ai-config   # restrict read access
```

The `.gitignore` at the repo root excludes `.env*` AND `.z-ai-config`
specifically — operators can safely paste a real API key into either of
those paths without risking an accidental commit.

---

## Authentication model

Every REST route except `/health` requires the `X-Cowork-Token` HTTP header to
match `COWORK_EVENT_TOKEN`. Missing or wrong token → `401` (not `403`):

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{ "error": "Invalid X-Cowork-Token" }
```

The comparison is constant-time (`crypto.timingSafeEqual`) and length-safe
(returns `false` instead of throwing `RangeError` on length mismatch — so the
expected token's length is not leaked via the error path).

Socket.io connections require the same secret in the handshake:

```typescript
io('/?XTransformPort=3003', {
  auth: { token: process.env.COWORK_UI_TOKEN ?? process.env.COWORK_EVENT_TOKEN },
});
```

The socket handshake authenticates against `SOCKET_SECRET` (= `COWORK_UI_TOKEN`,
falling back to `COWORK_EVENT_TOKEN`), while the HTTP `/emit/` routes
authenticate against `SHARED_SECRET` (= `COWORK_EVENT_TOKEN`). Use
`COWORK_UI_TOKEN` here so the browser-facing secret stays distinct from the
service-to-service secret.

The token can be supplied in either `socket.handshake.auth.token` **or**
`socket.handshake.query.token`. **Unauthenticated connections are
disconnected immediately** — they do NOT receive `system:status`,
`events:replay`, or any broadcast event. (This is the post-hardening
behavior: an earlier version of this service kept the listening socket open
even when auth failed — that has been fixed.)

---

## REST endpoints

| Method | Path       | Auth required? | Description                                                                                                    |
|--------|------------|----------------|----------------------------------------------------------------------------------------------------------------|
| `GET`  | `/health`  | **no**         | Liveness probe. Returns ONLY `{ ok: true }` — does not leak client count, buffer size, uptime, or port.       |
| `GET`  | `/`        | yes            | Service info + supported channels (used by the cockpit to discover the channel list at boot).                  |
| `GET`  | `/events`  | yes            | Buffered event replay as JSON. Pass `?since_id=N` to get only events with `id > N`.                            |
| `POST` | `/emit`    | yes            | Broadcast an event to all connected socket.io clients. Body: `{ channel, payload }`. Records into the buffer.  |
| `POST` | `/chat`    | yes            | Proxy to `z-ai-web-dev-sdk` chat completions. Streams tokens to socket.io room `sessionId` (default: stream).   |
| `POST` | `/image`   | yes            | Proxy to `z-ai-web-dev-sdk` image generations. Returns `{ ok, base64, prompt, size, bytes }`.                  |

### Additional safety nets

- **Request body size limit:** 1 MiB. Enforced both via the
  `content-length` header (cheap, pre-read) and inside the body reader
  (defensive — for clients that stream more bytes than declared). Oversized
  bodies return `413`.
- **Per-IP rate limit** on `/emit`, `/chat` and `/image` (and the socket.io
  emit message): 10 requests / minute / IP. Exceeding returns `429` with a
  `Retry-After` header. Tracked in-process (no Redis) — resets on service
  restart.

---

## Socket.io

### Path

`/` — required by project rules so the frontend can connect via
`io('/?XTransformPort=3003', ...)`. The Caddy gateway uses the
`XTransformPort` query param to route the request to port 3003.

### Channels

The server broadcasts on these channels:

| Channel             | Origin               | Audience              | Description                                                              |
|---------------------|----------------------|-----------------------|--------------------------------------------------------------------------|
| `tab:updated`       | extension            | all clients           | A browser tab's state changed.                                           |
| `tab:opened`        | extension            | all clients           | A new tab was opened.                                                    |
| `tab:closed`        | extension            | all clients           | A tab was closed.                                                        |
| `workspace:updated` | extension            | all clients           | The workspace metadata changed.                                          |
| `agent:task-updated`| extension            | all clients           | An agent's task state changed.                                           |
| `agent:handoff`     | extension            | all clients           | Control transferred between planner/navigator agents.                    |
| `network:request`   | extension            | all clients           | A network request was observed.                                          |
| `devtools:log`      | extension            | all clients           | A devtools console log was captured.                                     |
| `security:event`    | extension / cockpit  | all clients           | A security-relevant event (prompt-injection detection, domain block, …). |
| `snapshot:captured` | extension / `/image` | all clients           | A page snapshot or AI-generated image was captured.                       |
| `chat:message`      | `/chat`              | room `sessionId` only | A streamed chat token (server-side, never broadcast globally).           |
| `chat:done`         | `/chat`              | room `sessionId` only | Chat stream completed (server-side, never broadcast globally).           |
| `chat:error`        | `/chat`              | room `sessionId` only | Chat error (server-side, never broadcast globally).                      |
| `system:status`     | server (15s interval)| all clients           | Periodic status broadcast (`clients`, `eventsBuffered`, `uptimeSec`, …). |
| `events:replay`     | server (on connect)  | the new client only   | Last 50 buffered events, sent immediately after a successful handshake.  |

### Client→server events

| Event         | Payload                              | Description                                                                              |
|---------------|--------------------------------------|------------------------------------------------------------------------------------------|
| `chat:join`   | `sessionId: string`                  | Join the room for `sessionId` to receive `chat:message` / `chat:done` / `chat:error`.    |
| `chat:leave`  | `sessionId: string`                  | Leave the room.                                                                          |
| `emit`        | `{ channel: string, payload: any }`  | Broadcast an event to all clients (re-checked against the shared secret — defense-in-depth). Acknowledged with `{ ok, id }` or `{ ok: false, error }`. |

---

## Example: curl

```bash
# Health check (no auth)
curl http://127.0.0.1:3003/health
# → { "ok": true }

# Emit an event (auth required)
curl -X POST http://127.0.0.1:3003/emit \
  -H "Content-Type: application/json" \
  -H "X-Cowork-Token: $COWORK_EVENT_TOKEN" \
  -d '{"channel":"tab:updated","payload":{"tabId":1,"url":"https://example.com"}}'
# → { "ok": true, "id": 42, "channel": "tab:updated" }

# Replay buffered events
curl -H "X-Cowork-Token: $COWORK_EVENT_TOKEN" \
  "http://127.0.0.1:3003/events?since_id=40"
# → { "events": [ { "id": 41, "channel": "tab:updated", "payload": {...}, "ts": 1700000000000 }, ... ] }

# Image generation (proxied to z-ai-web-dev-sdk)
curl -X POST http://127.0.0.1:3003/image \
  -H "Content-Type: application/json" \
  -H "X-Cowork-Token: $COWORK_EVENT_TOKEN" \
  -d '{"prompt":"a phosphor-amber terminal glow","size":"1024x1024"}'
# → { "ok": true, "base64": "...", "prompt": "...", "size": "1024x1024", "bytes": 1234567 }
```

Missing token:

```bash
curl -i http://127.0.0.1:3003/events
# HTTP/1.1 401 Unauthorized
# { "error": "Invalid X-Cowork-Token" }
```

---

## Example: socket.io client (browser)

Per project rules, the React client must connect using the relative path with
the `XTransformPort` query param — **never** a port in the URL. Caddy uses
that query param to route the request to port 3003.

```typescript
import { io } from 'socket.io-client';

const socket = io('/?XTransformPort=3003', {
  transports: ['websocket', 'polling'],
  auth: {
    token: process.env.NEXT_PUBLIC_COWORK_UI_TOKEN!, // SOCKET_SECRET (see handshake)
  },
});

socket.on('connect', () => console.log('connected', socket.id));
socket.on('events:replay', (events) => console.log('replay', events.length));
socket.on('tab:updated', (tab) => console.log('tab updated', tab));
socket.on('system:status', (status) => console.log('status', status));

// For streaming chat, join the session room before POSTing to /chat. The
// /chat HTTP route validates `X-Cowork-Token` against the SHARED_SECRET
// (= COWORK_EVENT_TOKEN). That is a service-to-service secret — it must
// only be used in SERVER-side code (e.g. a Next.js API route in the cockpit)
// and must NEVER be embedded in the browser bundle. Browsers reach /chat
// through the cockpit proxy, which injects the secret server-side.

socket.on('chat:message', ({ sessionId, token }) => console.log(sessionId, token));
socket.on('chat:done', ({ sessionId }) => console.log('chat done', sessionId));
```

> **Without** the `auth.token` field, the server disconnects the socket
> immediately — no events are received.

---

## Server-to-server calls

Next.js API routes (which run server-side) can call this service directly at
`http://127.0.0.1:3003` — no `XTransformPort` needed for internal traffic.
Use the `broadcastEvent` helper in the cockpit's events client
(`cockpit/src/lib/cowork/events/client.ts`) which sends the `X-Cowork-Token`
header and reads the secret from `COWORK_EVENT_TOKEN`.

---

## Event sourcing

This service emits ONLY real events received via `POST /emit` or the
socket.io `emit` message. There is no synthetic event simulator — the
dashboard shows whatever the real browser/agent produces, or renders empty
states. Real events are kept in a 1000-entry ring buffer for reconnect replay.

---

## Graceful shutdown

`SIGTERM` and `SIGINT` trigger a graceful shutdown: socket.io server closes
first (disconnects all clients), then the HTTP server closes (waits for
in-flight requests). A 3-second force-exit fallback ensures the process
doesn't hang if `httpServer.close()` stalls.

---

## Test coverage

The pure security primitives (`tokenMatches`, `applyCorsHeaders`,
`shouldRefuseStart`, `evaluateChatJoin`) live in
[`./security.ts`](./security.ts) and are unit-tested by
`tests/cowork-events.test.ts` at the repo root. The same test file also spins up
the full HTTP server + socket.io on a random port and exercises the REST routes
(`/health`, `/events`, `/`, `/emit`, `/chat`, `/image`) end-to-end with real
`fetch()` calls, plus the socket.io surface with `socket.io-client`:

- **REST:** 401-vs-200 auth gating, CORS allowlist, body-size (413) and
  per-IP rate-limit (429) rails, `system:status` exclusion from the replay
  buffer.
- **socket.io:** `system:status` + `events:replay` on a successful handshake;
  `/chat` streaming tokens delivered to the `sessionId` room (via `chat:message`
  / `chat:done`); `/image` success (z-ai SDK stubbed, no real network call);
  and two **negative** tests — an unauthenticated (wrong-token) socket is
  disconnected and receives nothing, and a hostile socket that authenticated
  with a *scoped* `sessionId` **cannot** join another session's room and so
  **cannot** read that session's streamed `chat:message`.

The z-ai SDK (`z-ai-web-dev-sdk`) is mocked in the test file so `/chat` and
`/image` run with no real upstream call.

Run them with:

```bash
npm run test -- cowork-events
# or, directly:
npx vitest run tests/cowork-events.test.ts
```
