/**
 * Mini-service (cowork-events) test suite.
 *
 * Tests the security boundary between the cockpit dashboard and the outside
 * world. Before this file existed, `mini-services/cowork-events/index.ts` had
 * ZERO test coverage — which was critical to fix before public launch.
 *
 * Two layers of tests:
 *
 *   1. Pure-function unit tests against `mini-services/cowork-events/security.ts`
 *      (no socket.io / z-ai-web-dev-sdk runtime needed — `security.ts` is
 *      intentionally dependency-light so the root vitest config can load it
 *      without installing the mini-service's npm deps at the repo root).
 *        - `tokenMatches` — constant-time + length-safe token comparison.
 *        - `applyCorsHeaders` — allowlist-driven CORS header setter.
 *        - `shouldRefuseStart` — production dev-token refusal policy.
 *        - `evaluateChatJoin` — chat:join room-scoping decision (F-04).
 *
 *   2. HTTP integration tests that spin up the REAL `httpServer` exported by
 *      `index.ts` on an OS-assigned port (port 0) and make real `fetch()`
 *      requests against `/health`, `/events`, `/`, and `/emit`. Verifies the
 *      401-vs-200 auth gating and the CORS allowlist behavior end-to-end.
 *
 * The mini-service's `main()` (which binds to port 3003, registers signal
 * handlers, and starts the 15-second status interval) is guarded by an ESM
 * `import.meta.url === process.argv[1]` check, so simply importing the module
 * does NOT start the production server.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { AddressInfo } from "net";
import {
  tokenMatches,
  applyCorsHeaders,
  shouldRefuseStart,
  evaluateChatJoin,
  DEV_TOKEN,
} from "../mini-services/cowork-events/security";

// ─── Pure function tests: tokenMatches ─────────────────────────────────────

describe("tokenMatches", () => {
  const expected = "a-very-secure-secret-123";

  test("returns true for the correct token", () => {
    expect(tokenMatches("a-very-secure-secret-123", expected)).toBe(true);
  });

  test("returns false for a wrong token of the same length", () => {
    expect(tokenMatches("a-very-secure-secret-456", expected)).toBe(false);
  });

  test("returns false for a wrong token of a different length", () => {
    expect(tokenMatches("wrong", expected)).toBe(false);
    expect(tokenMatches("a-very-secure-secret-123-with-extra", expected)).toBe(false);
  });

  test("returns false for undefined (missing header)", () => {
    expect(tokenMatches(undefined, expected)).toBe(false);
  });

  test("returns false for the empty string", () => {
    expect(tokenMatches("", expected)).toBe(false);
  });

  test("does NOT throw on different-length tokens (length-safe)", () => {
    // crypto.timingSafeEqual throws RangeError on length mismatch — the
    // wrapper must swallow that, otherwise the expected token's length would
    // be leaked via the error path.
    expect(() => tokenMatches("short", expected)).not.toThrow();
    expect(() => tokenMatches("x".repeat(1000), expected)).not.toThrow();
  });

  test("returns false when expected is the empty string", () => {
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("nonempty", "")).toBe(false);
  });
});

// ─── Pure function tests: applyCorsHeaders ─────────────────────────────────

describe("applyCorsHeaders", () => {
  // Minimal mock that satisfies `Pick<ServerResponse, 'setHeader'>`.
  function mockRes() {
    const headers: Record<string, unknown> = {};
    return {
      headers,
      setHeader(name: string, value: unknown) {
        headers[name] = value;
      },
    };
  }

  const allowed = "http://localhost:3000";

  test("sets Access-Control-Allow-Origin + Vary when origin matches the allowlist", () => {
    const res = mockRes();
    const result = applyCorsHeaders(res, "http://localhost:3000", allowed);
    expect(result).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
    expect(res.headers["Vary"]).toBe("Origin");
  });

  test("does NOT set headers when origin is on a different host", () => {
    const res = mockRes();
    const result = applyCorsHeaders(res, "http://evil.com", allowed);
    expect(result).toBe(false);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(res.headers["Vary"]).toBeUndefined();
  });

  test("does NOT set headers when origin is on a different port (same host)", () => {
    // Same host, different port — must NOT match. This catches a regression
    // where a naive `startsWith` check would let `http://localhost:3000.evil`
    // through.
    const res = mockRes();
    const result = applyCorsHeaders(res, "http://localhost:3001", allowed);
    expect(result).toBe(false);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("does NOT set headers when origin is null (same-origin request)", () => {
    const res = mockRes();
    expect(applyCorsHeaders(res, null, allowed)).toBe(false);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("does NOT set headers when origin is undefined", () => {
    const res = mockRes();
    expect(applyCorsHeaders(res, undefined, allowed)).toBe(false);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("returns true + sets headers for an arbitrary custom allowlisted origin", () => {
    // Verify the function is parameterised — it doesn't hardcode any origin.
    const res = mockRes();
    const custom = "https://cockpit.example.internal:8443";
    expect(applyCorsHeaders(res, custom, custom)).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(custom);
    expect(res.headers["Vary"]).toBe("Origin");
  });
});

// ─── Pure function tests: shouldRefuseStart ────────────────────────────────

describe("shouldRefuseStart", () => {
  // F-05: the dev-token is only accepted with an EXPLICIT opt-in
  // (COWORK_ALLOW_DEV_TOKEN=1). NODE_ENV is no longer a safety net, so a
  // misconfigured deploy (e.g. `npx tsx index.ts` with no NODE_ENV) must NOT
  // silently accept the public default.
  const orig = process.env.COWORK_ALLOW_DEV_TOKEN;
  afterEach(() => {
    if (orig === undefined) delete process.env.COWORK_ALLOW_DEV_TOKEN;
    else process.env.COWORK_ALLOW_DEV_TOKEN = orig;
  });

  test("refuses the dev-token regardless of NODE_ENV when opt-in is absent", () => {
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    // The old behavior allowed dev-token in development / unset NODE_ENV.
    // Now it refuses in ALL of those cases unless explicitly opted in.
    expect(shouldRefuseStart("production", DEV_TOKEN)).toBe(true);
    expect(shouldRefuseStart("development", DEV_TOKEN)).toBe(true);
    expect(shouldRefuseStart(undefined, DEV_TOKEN)).toBe(true);
    expect(shouldRefuseStart("test", DEV_TOKEN)).toBe(true);
  });

  test("allows the dev-token ONLY when COWORK_ALLOW_DEV_TOKEN=1 is explicitly set", () => {
    process.env.COWORK_ALLOW_DEV_TOKEN = "1";
    expect(shouldRefuseStart("production", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("development", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart(undefined, DEV_TOKEN)).toBe(false);
  });

  test("allows a real secret in any NODE_ENV without an opt-in", () => {
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    expect(shouldRefuseStart("production", "a-real-secret-abc123-xyz")).toBe(false);
    expect(shouldRefuseStart("development", "a-real-secret-abc123-xyz")).toBe(false);
    expect(shouldRefuseStart(undefined, "a-real-secret-abc123-xyz")).toBe(false);
  });

  test("refuses ONLY for the exact dev-token string, not a longer prefix", () => {
    // A secret like "dev-token-extra" must NOT trip the refusal — only the
    // exact well-known default does.
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    expect(shouldRefuseStart("production", "dev-token-extra")).toBe(false);
    expect(shouldRefuseStart("production", "DEV-TOKEN")).toBe(false); // case-sensitive
  });
});

// ─── Pure function tests: evaluateChatJoin (chat:join room-scoping, F-04) ──
//
// NOTE: the integration suite below cannot exercise `chat:join` over a real
// socket because `socket.io-client` is NOT installed at the repo root (the
// existing suite documents this). The room-scoping *decision* has therefore
// been extracted into the pure `evaluateChatJoin` helper in `security.ts` and
// is unit-tested here. This is the precise invariant the finding asks for: a
// hostile/authenticated socket MUST NOT be able to read another session's
// `chat:message` (it cannot join that session's room), and an authorized
// socket CAN join its own session room.

describe("evaluateChatJoin", () => {
  test("rejects a non-string sessionId (invalid-session-id)", () => {
    expect(evaluateChatJoin(undefined, 123)).toEqual({ allowed: false, reason: "invalid-session-id" });
    expect(evaluateChatJoin(undefined, null)).toEqual({ allowed: false, reason: "invalid-session-id" });
    expect(evaluateChatJoin(undefined, {})).toEqual({ allowed: false, reason: "invalid-session-id" });
    expect(evaluateChatJoin(undefined, "")).toEqual({ allowed: false, reason: "invalid-session-id" });
  });

  test("rejects a sessionId with illegal characters or over-length (invalid-session-id)", () => {
    expect(evaluateChatJoin(undefined, "bad id!")).toEqual({ allowed: false, reason: "invalid-session-id" });
    expect(evaluateChatJoin(undefined, "../evil")).toEqual({ allowed: false, reason: "invalid-session-id" });
    expect(evaluateChatJoin(undefined, "a".repeat(129))).toEqual({ allowed: false, reason: "invalid-session-id" });
  });

  test("legacy client (no scoped sessionId) may join any valid room — flagged permissive-legacy", () => {
    expect(evaluateChatJoin(undefined, "my-chat-1")).toEqual({ allowed: true, reason: "permissive-legacy" });
    expect(evaluateChatJoin(undefined, "sess-9")).toEqual({ allowed: true, reason: "permissive-legacy" });
  });

  test("authorized socket CAN join its OWN session room", () => {
    expect(evaluateChatJoin("sess-A", "sess-A")).toEqual({ allowed: true, reason: "ok" });
  });

  test("hostile socket CANNOT read another session's room (cross-session rejected)", () => {
    // A socket that authenticated as "sess-A" tries to join "sess-B" → must be
    // rejected, so it can never receive "sess-B"'s streamed chat:message.
    expect(evaluateChatJoin("sess-A", "sess-B")).toEqual({
      allowed: false,
      reason: "not-authorized-for-session",
    });
    // Path/character tricks that would defeat a naive check are still rejected
    // by the strict charset before ownership is even considered.
    expect(evaluateChatJoin("sess-A", "sess-A/../sess-B")).toEqual({
      allowed: false,
      reason: "invalid-session-id",
    });
  });
});

// ─── HTTP integration tests ────────────────────────────────────────────────
//
// Spin up the REAL httpServer + socket.io server exported by `index.ts` on an
// OS-assigned port (port 0). Make real `fetch()` requests. The mini-service's
// `main()` is guarded by an ESM `import.meta.url === process.argv[1]` check,
// so importing the module does NOT bind to port 3003 / register signal
// handlers / start the 15-second status interval.
//
// Env vars MUST be set BEFORE the dynamic `import()` — `SHARED_SECRET` and
// `CORS_ORIGIN` are computed at module load time and never re-read.

describe("cowork-events HTTP server (integration)", () => {
  let server: import("http").Server;
  let io: { close: (cb?: () => void) => void };
  let port: number;
  let token: string;
  let corsOrigin: string;
  // expose the module so the system:status test can call
  // `recordEvent` directly (the periodic broadcaster in `main()` never runs
  // during tests, so the only way to push a `system:status` event into the
  // module is via the exported `recordEvent` function).
  let mod: typeof import("../mini-services/cowork-events/index");

  beforeAll(async () => {
    token = "integration-test-secret-xyz-abc-123";
    corsOrigin = "http://test-origin.local";
    process.env.COWORK_EVENT_TOKEN = token;
    process.env.COWORK_CORS_ORIGIN = corsOrigin;
    // Make sure NODE_ENV is NOT "production" — otherwise shouldRefuseStart
    // would block startup (and we're using a non-dev-token anyway, but be
    // defensive: the integration test runs against a real server).
    process.env.NODE_ENV = "test";

    mod = await import("../mini-services/cowork-events/index");
    server = mod.httpServer;
    io = mod.io;

    // Confirm the env vars were picked up at module load time.
    expect(mod.SHARED_SECRET).toBe(token);
    expect(mod.CORS_ORIGIN).toBe(corsOrigin);

    // Bind to a random port (port 0 = OS-assigned) so we don't conflict
    // with a real dev server that might be listening on 3003.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error(`Expected AddressInfo, got: ${JSON.stringify(addr)}`);
    }
    port = (addr as AddressInfo).port;
  });

  afterAll(async () => {
    // io.close() also closes the underlying httpServer.
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
      // Fallback in case io.close never invokes its callback.
      setTimeout(resolve, 2000).unref();
    });
    // belt-and-suspenders: if httpServer is still listening, force it closed.
    if (server.listening) {
      // Node 18.2+ — destroy keep-alive connections so close() resolves.
      const anyServer = server as unknown as {
        closeAllConnections?: () => void;
      };
      if (typeof anyServer.closeAllConnections === "function") {
        anyServer.closeAllConnections();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 2000).unref();
      });
    }
  });

  // ── /health ────────────────────────────────────────────────────────────

  test("GET /health returns 200 { ok: true } WITHOUT auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("GET /health does NOT leak client count, buffer size, uptime, or port", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(body).not.toHaveProperty("clients");
    expect(body).not.toHaveProperty("eventsBuffered");
    expect(body).not.toHaveProperty("uptimeSec");
    expect(body).not.toHaveProperty("port");
  });

  // ── /events auth gating ────────────────────────────────────────────────

  test("GET /events WITHOUT token returns 401 (not 403)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid X-Cowork-Token/);
  });

  test("GET /events WITH correct token returns 200 + events array", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { "X-Cowork-Token": token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  test("GET /events WITH wrong token returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { "X-Cowork-Token": "totally-wrong-token-aaa-bbb" },
    });
    expect(res.status).toBe(401);
  });

  test("GET /events WITH empty token returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { "X-Cowork-Token": "" },
    });
    expect(res.status).toBe(401);
  });

  // ── / (service info) ───────────────────────────────────────────────────

  test("GET / WITH correct token returns 200 + service info + channel list", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "X-Cowork-Token": token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe("cowork-events");
    expect(body.port).toBe(3003); // hardcoded
    expect(Array.isArray(body.channels)).toBe(true);
    expect(body.channels).toContain("tab:updated");
    expect(body.channels).toContain("security:event");
    expect(body.channels).toContain("chat:message");
    expect(body.endpoints).toEqual(
      expect.arrayContaining(["/health", "/emit", "/chat", "/image", "/events"]),
    );
  });

  test("GET / WITHOUT token returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(401);
  });

  // ── 404 handling ───────────────────────────────────────────────────────

  test("GET /nonexistent WITH correct token returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`, {
      headers: { "X-Cowork-Token": token },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Not found/);
    expect(body.url).toBe("/nonexistent");
  });

  // ── CORS allowlist ─────────────────────────────────────────────────────

  test("CORS Access-Control-Allow-Origin header is present on allowed origin", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: corsOrigin },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(corsOrigin);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("CORS Access-Control-Allow-Origin header is ABSENT on disallowed origin", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "http://evil.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("CORS header is ABSENT when no Origin header is sent (same-origin request)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("OPTIONS preflight returns 204 (CORS preflight)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      method: "OPTIONS",
      headers: { Origin: corsOrigin },
    });
    expect(res.status).toBe(204);
    // Allow-Methods + Allow-Headers are set unconditionally on every response
    // (preflight or not) so the browser can complete the preflight handshake.
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, X-Cowork-Token");
  });

  // ── /emit (broadcast) ──────────────────────────────────────────────────

  test("POST /emit with correct token broadcasts + records the event", async () => {
    // This test previously only verified the HTTP response shape
    // — it would have passed even if `io.emit` and `recordEvent` were both
    // removed. We now also GET /events to verify the event was actually
    // appended to the in-memory buffer (which is what reconnecting clients
    // receive on `/events?since_id=0`). The socket.io broadcast itself is
    // not tested here — there is no socket.io-client installed at the root
    // of the repo, and stubbing one would not exercise the real io.emit
    // path. The GET /events check below DOES verify the recording half of
    // the contract (the buffer is the source of truth for late/replaying
    // clients); the broadcast half is exercised indirectly by the /events
    // replay path which uses the same buffer.
    const channel = "tab:updated";
    const payload = { id: 1, url: "https://example.com" };
    const res = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cowork-Token": token,
      },
      body: JSON.stringify({ channel, payload }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.channel).toBe(channel);
    expect(typeof body.id).toBe("number");
    const emittedId = body.id as number;

    // Verify the event was actually recorded in the buffer by fetching
    // /events and asserting the emitted event appears with the same id,
    // channel, and payload. This catches a regression where the response
    // shape is correct but `recordEvent` was never called (or was called
    // with the wrong channel) — which would silently break reconnecting
    // clients.
    const evRes = await fetch(`http://127.0.0.1:${port}/events?since_id=${emittedId - 1}`, {
      headers: { "X-Cowork-Token": token },
    });
    expect(evRes.status).toBe(200);
    const evBody = await evRes.json();
    expect(Array.isArray(evBody.events)).toBe(true);
    const found = (evBody.events as Array<{ id: number; channel: string; payload: unknown }>).find(
      (e) => e.id === emittedId,
    );
    expect(found).toBeDefined();
    expect(found?.channel).toBe(channel);
    expect(found?.payload).toEqual(payload);
  });

  test("POST /emit WITHOUT token returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "tab:updated", payload: {} }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /emit WITHOUT channel returns 400 (auth still required first)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cowork-Token": token,
      },
      body: JSON.stringify({ payload: { id: 1 } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/channel required/);
  });

  // ── /events?since_id=N ─────────────────────────────────────────────────

  test("GET /events?since_id=N returns only events with id > N", async () => {
    // Emit two events so the buffer has something to replay.
    const emit1 = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({ channel: "test:event-a", payload: { n: 1 } }),
    });
    const body1 = await emit1.json();
    const firstId = body1.id as number;

    const emit2 = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({ channel: "test:event-b", payload: { n: 2 } }),
    });
    const body2 = await emit2.json();
    const secondId = body2.id as number;

    expect(secondId).toBeGreaterThan(firstId);

    // since_id=firstId should return at least the second event.
    const res = await fetch(
      `http://127.0.0.1:${port}/events?since_id=${firstId}`,
      { headers: { "X-Cowork-Token": token } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    for (const evt of body.events) {
      expect(evt.id).toBeGreaterThan(firstId);
    }
  });

  test("GET /events?since_id=0 returns the full buffer", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events?since_id=0`, {
      headers: { "X-Cowork-Token": token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0); // we've emitted several by now
  });

  // Body limit, rate limit, system:status exclusion
  //
  // Three regression tests for the safety rails: the 1 MB body limit, the
  // per-IP rate limit, and system:status exclusion from the replay buffer.
  // These are untested by the existing suite — it covers the happy paths
  // and auth/CORS but never exercises the safety rails.

  test("/chat with body > 1 MB returns 413 (pre-read content-length check)", async () => {
    // The pre-read content-length check rejects a declared-oversized
    // body BEFORE consuming the stream. Build a JSON body just over 1 MiB
    // (MAX_BODY_BYTES = 1_048_576). fetch() sets content-length from the
    // body, so the server sees content-length > MAX_BODY_BYTES and returns
    // 413 without reading the body.
    const largeContent = "x".repeat(1_100_000);
    const body = JSON.stringify({
      messages: [{ role: "user", content: largeContent }],
    });
    expect(body.length).toBeGreaterThan(1_048_576);
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cowork-Token": token,
      },
      body,
    });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toMatch(/too large/i);
  });

  test("/chat 11 times in the same minute returns 429 on the 11th (rate limit)", async () => {
    // Per-IP rate limit — 10 /chat requests per minute. The 11th must
    // be rejected with 429 + a Retry-After header. We send empty-message
    // bodies so each of the first 10 requests returns 400 (messages
    // required) — the rate-limit counter is incremented BEFORE the body
    // validation, so 10 × 400 consumes the budget and the 11th gets 429.
    //
    // This test MUST be the only test that makes /chat or /image requests
    // (other than the 413 test above, which returns before the rate-limit
    // check). The rate-limit counter is in-process and shared across the
    // whole test suite — if a prior test had already consumed the budget
    // for 127.0.0.1, the 11th request here would still be 429 but the
    // first 10 would NOT be 400 (they'd be 429 too). The assertion below
    // checks BOTH the first 10 (400) AND the 11th (429) so the test fails
    // loudly if the counter was non-zero at start.
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      "X-Cowork-Token": token,
    };
    const emptyBody = JSON.stringify({ messages: [] });
    // First 10: should pass rate limit + fail body validation → 400.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers,
        body: emptyBody,
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/messages required/);
    }
    // 11th: rate limit exceeded → 429 + Retry-After header.
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers,
      body: emptyBody,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    const json = await res.json();
    expect(json.error).toMatch(/rate limit/i);
  });

  test("system:status events are NOT recorded in the replay buffer", async () => {
    // `recordEvent('system:status', ...)` must NOT push into the
    // event buffer — otherwise the 15-second status broadcaster would, after
    // ~4.2 hours (1000 × 15s), splice all real events out of the 1000-entry
    // buffer and reconnecting clients would receive only noise in
    // `events:replay`. The periodic broadcaster in `main()` never runs
    // during tests, so we call `recordEvent` directly to simulate one tick.
    //
    // We push BOTH a system:status event AND a real event, then GET /events
    // and assert the real event IS present while the system:status event
    // is NOT. This catches a regression where the `channel === 'system:status'`
    // guard inside `recordEvent` is removed.
    const statusPayload = { clients: 1, eventsBuffered: 0, ts: Date.now() };
    const statusEvt = mod.recordEvent("system:status", statusPayload);
    const realEvt = mod.recordEvent("test:r5-p4-m1-real", { marker: "should-be-in-buffer" });
    // `recordEvent` returns an event with an id for both channels (so the
    // caller's `io.emit` still receives a consistent envelope), but only
    // the real event should appear in the buffer.
    expect(typeof statusEvt.id).toBe("number");
    expect(typeof realEvt.id).toBe("number");
    // Fetch events since the status event's id - 1 (i.e. include both).
    const sinceId = Math.min(statusEvt.id, realEvt.id) - 1;
    const res = await fetch(
      `http://127.0.0.1:${port}/events?since_id=${sinceId}`,
      { headers: { "X-Cowork-Token": token } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    const events = body.events as Array<{ id: number; channel: string; payload: unknown }>;
    // The real event MUST be in the buffer.
    const foundReal = events.find((e) => e.id === realEvt.id);
    expect(foundReal).toBeDefined();
    expect(foundReal?.channel).toBe("test:r5-p4-m1-real");
    // The system:status event MUST NOT be in the buffer.
    const foundStatus = events.find((e) => e.id === statusEvt.id);
    expect(foundStatus).toBeUndefined();
    // Defense-in-depth: assert NO event in the entire buffer has channel
    // `system:status` — catches a regression where the guard is removed
    // for ALL status events, not just the one we just pushed.
    const allRes = await fetch(`http://127.0.0.1:${port}/events?since_id=0`, {
      headers: { "X-Cowork-Token": token },
    });
    const allBody = await allRes.json();
    const allEvents = allBody.events as Array<{ channel: string }>;
    expect(allEvents.every((e) => e.channel !== "system:status")).toBe(true);
  });
});
