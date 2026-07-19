/**
 * Mini-service (cowork-events) test suite.
 *
 * Tests the security boundary between the cockpit dashboard and the outside
 * world. Before this file existed, `mini-services/cowork-events/index.ts` had
 * ZERO test coverage — which was critical to fix before public launch.
 *
 * Two layers of tests:
 *
 * 1. Pure-function unit tests against `mini-services/cowork-events/security.ts`
 * (no socket.io / z-ai-web-dev-sdk runtime needed — `security.ts` is
 * intentionally dependency-light so the root vitest config can load it
 * without installing the mini-service's npm deps at the repo root).
 * - `tokenMatches` — constant-time + length-safe token comparison.
 * - `applyCorsHeaders` — allowlist-driven CORS header setter.
 * - `shouldRefuseStart` — production dev-token refusal policy.
 * - `evaluateChatJoin` — chat:join room-scoping decision.
 *
 * 2. HTTP integration tests that spin up the REAL `httpServer` exported by
 * `index.ts` on an OS-assigned port (port 0) and make real `fetch()`
 * requests against `/health`, `/events`, `/`, and `/emit`. Verifies the
 * 401-vs-200 auth gating and the CORS allowlist behavior end-to-end.
 *
 * The mini-service's `main()` (which binds to port 3003, registers signal
 * handlers, and starts the 15-second status interval) is guarded by an ESM
 * `import.meta.url === process.argv[1]` check, so simply importing the module
 * does NOT start the production server.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { AddressInfo } from "net";
import { io as ioClient, type Socket } from "socket.io-client";
import {
  tokenMatches,
  applyCorsHeaders,
  shouldRefuseStart,
  evaluateChatJoin,
  DEV_TOKEN,
} from "../mini-services/cowork-events/security";

// ─── Robust server/io teardown helper ─────────────────────────────────
//
// socket.io v4's `Server.close()` (called with no callback) returns a Promise
// AND ALSO closes the underlying http.Server. So after awaiting
// `io.close()`, calling `httpServer.close()` again throws
// ERR_SERVER_NOT_RUNNING ("Server is not running"). We therefore:
//   1. close socket.io FIRST (releasing its engine.io listeners/connections),
//   2. destroy any lingering keep-alive connections, then
//   3. close the http.Server ONLY IF it is still listening, swallowing the
//      ERR_SERVER_NOT_RUNNING case (socket.io already closed it).
// Both the callback and Promise return shapes are supported so the helper is
// version-robust. This guarantees no open handle and no teardown error, and
// does NOT rely on a setTimeout fallback.

type CloseableIo = { close: (cb?: (err?: Error) => void) => void | Promise<void> };

async function closeServerAndIo(
  server: import("http").Server,
  io: CloseableIo,
): Promise<void> {
  // 1. Close socket.io first. Support both the callback form (older socket.io)
  //    and the Promise form (no-callback). The `settled` guard avoids double
  //    resolve/reject if both fire.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    const ret = io.close(done);
    if (ret && typeof (ret as Promise<void>).then === "function") {
      (ret as Promise<void>).then(resolve, reject);
    }
  }).catch(() => {
    // A socket.io close error must not fail teardown; we still close the server.
  });

  // 2. Destroy lingering keep-alive connections so the http.Server can close.
  const anyServer = server as unknown as { closeAllConnections?: () => void };
  if (typeof anyServer.closeAllConnections === "function") {
    try {
      anyServer.closeAllConnections();
    } catch {
      /* ignore — already closed or unsupported */
    }
  }

  // 3. Close the http.Server, but only if it is still listening (socket.io may
  //    have already closed it). Swallow ERR_SERVER_NOT_RUNNING explicitly.
  if ((server as unknown as { listening?: boolean }).listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => {
        if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(err);
        } else {
          resolve();
        }
      });
    }).catch(() => {
      /* swallow non-fatal close errors */
    });
  }
}

// ─── z-ai SDK mock ───────────────────────────────────────────────────
//
// The real mini-service calls `ZAI.create()` then
// `zai.chat.completions.create(...)` / `zai.images.generations.create(...)`.
// Those reach the real upstream API (and read a `.z-ai-config` file). To test
// the `/chat` streaming success path and the `/image` success path without any
// network call, we stub the entire `z-ai-web-dev-sdk` module. The stub reads
// its canned output from a `vi.hoisted` store so each test can configure the
// streamed chat tokens / returned image base64 independently.

const zaiStore = vi.hoisted(() => ({
 // Tokens the fake `/chat` SSE stream will emit (concatenated into the
 // final `content`). When empty, the stream yields only `[DONE]`.
  chatChunks: [] as string[],
 // Non-stream `/chat` (body.stream === false) returns this as the message.
  chatText: "non-streamed reply",
 // Fake generated image (base64) for `/image`.
  imageBase64: "BASE64FAKEIMAGE==",
 // Force the SDK to throw (exercises the route's 500 path if needed).
  failChat: false,
  failImage: false,
}));

// NOTE: the specifier must point at the copy `index.ts` actually imports — the
// SDK lives in the mini-service's NESTED node_modules, not the repo root, so a
// bare `vi.mock("z-ai-web-dev-sdk")` (resolved from this test file's location)
// would never match and the real SDK (which reads a `.z-ai-config` file) would
// run instead. Mocking the resolved nested path guarantees interception.
vi.mock("../mini-services/cowork-events/node_modules/z-ai-web-dev-sdk", () => {
  const encoder = new TextEncoder();

 // Build an SSE ReadableStream from a list of content chunks, terminated by
 // `data: [DONE]`. Each chunk is one `choices[0].delta.content` token — the
 // exact shape the server's SSE parser expects.
  function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
    let sse = "";
    for (const c of chunks) {
      sse += `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
    }
    sse += "data: [DONE]\n\n";
    const bytes = encoder.encode(sse);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  const instance = {
    chat: {
      completions: {
        create: vi.fn(async (opts: { stream?: boolean } | undefined) => {
          if (zaiStore.failChat) throw new Error("mock z-ai chat failure");
          if (opts && opts.stream) return streamFrom(zaiStore.chatChunks);
          return { choices: [{ message: { content: zaiStore.chatText } }] };
        }),
      },
    },
    images: {
      generations: {
        create: vi.fn(async () => {
          if (zaiStore.failImage) throw new Error("mock z-ai image failure");
          return { data: [{ base64: zaiStore.imageBase64 }] };
        }),
      },
    },
  };

  return { default: { create: vi.fn().mockResolvedValue(instance) } };
});

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
 // ZERO-CONFIG policy: the dev-token is accepted in ANY non-production
 // environment (development / dev / local / test / staging / unset NODE_ENV)
 // WITHOUT requiring COWORK_ALLOW_DEV_TOKEN, so the cockpit (which also
 // defaults to dev-token) can connect with no env setup. PRODUCTION stays
 // strict: the well-known dev-token always fails closed there.
  const orig = process.env.COWORK_ALLOW_DEV_TOKEN;
  afterEach(() => {
    if (orig === undefined) delete process.env.COWORK_ALLOW_DEV_TOKEN;
    else process.env.COWORK_ALLOW_DEV_TOKEN = orig;
  });

  test("refuses the dev-token ONLY in production; boots zero-config in every non-prod env when opt-in is absent", () => {
    delete process.env.COWORK_ALLOW_DEV_TOKEN;
    // Production always fails closed.
    expect(shouldRefuseStart("production", DEV_TOKEN)).toBe(true);
    // Zero-config: no opt-in, no env — the default dev-token is accepted in
    // dev/local/test and even in an unset/ambiguous NODE_ENV so the cockpit
    // connects with no setup whatsoever.
    expect(shouldRefuseStart(undefined, DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("development", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("dev", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("local", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("test", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("staging", DEV_TOKEN)).toBe(false);
  });

  test("COWORK_ALLOW_DEV_TOKEN opt-in is still honored but no longer required in non-prod", () => {
    process.env.COWORK_ALLOW_DEV_TOKEN = "1";
    // Production stays strict even with the opt-in (a real auth hole otherwise).
    expect(shouldRefuseStart("production", DEV_TOKEN)).toBe(true);
    // Non-prod with the opt-in still boots (and would have booted without it).
    expect(shouldRefuseStart("development", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("dev", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("local", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("test", DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart(undefined, DEV_TOKEN)).toBe(false);
    expect(shouldRefuseStart("staging", DEV_TOKEN)).toBe(false);
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
    expect(shouldRefuseStart("development", "dev-token-extra")).toBe(false);
    expect(shouldRefuseStart("production", "DEV-TOKEN")).toBe(false); // case-sensitive
    expect(shouldRefuseStart("development", "DEV-TOKEN")).toBe(false);
  });
});

// ─── Pure function tests: evaluateChatJoin (chat:join room-scoping) ──
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

  test("connection without a scoped sessionId is rejected (fail-closed, no-scoped-session-id)", () => {
    expect(evaluateChatJoin(undefined, "my-chat-1")).toEqual({ allowed: false, reason: "no-scoped-session-id" });
    expect(evaluateChatJoin(undefined, "sess-9")).toEqual({ allowed: false, reason: "no-scoped-session-id" });
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

// ─── Pure function tests: redactSecrets ─────────────────────────────────────
//
// redactSecrets is the primitive applied to every error / SDK message before it
// reaches logs or client sinks. It must mask the common credential shapes plus
// any of the service's own configured secrets. These cases lock in that
// coverage so a future edit cannot silently drop a regex or the SHARED_SECRET
// masking branch.

describe("redactSecrets", () => {
  let mod: typeof import("../mini-services/cowork-events/index");

  beforeAll(async () => {
    process.env.COWORK_EVENT_TOKEN = "redact-test-secret-abc-123";
    process.env.NODE_ENV = "test";
 // Fresh module instance so this suite observes a deterministic SHARED_SECRET
 // (the repo-root vitest cache would otherwise reuse another describe's load).
    vi.resetModules();
    mod = await import("../mini-services/cowork-events/index");
  });

  test("masks Anthropic / OpenAI / Google / Grok / Slack / AWS token prefixes", () => {
    // Samples use realistic key lengths (>= 20 chars after the `sk-ant-` /
    // `sk-` prefix, >= 35 after `AIza`) to mirror the canonical cockpit
    // redactor's min-lengths — short decoys are intentionally NOT masked.
    expect(mod.redactSecrets("leak sk-ant-1234567890abcdefghij here")).toContain("sk-ant-***");
    expect(mod.redactSecrets("leak sk-1234567890abcdefghij here")).toContain("sk-***");
    expect(mod.redactSecrets("leak AIza" + "a".repeat(35) + " here")).toContain("AIza***");
    expect(mod.redactSecrets("leak gsk_1234567890abcdef here")).toContain("gsk_***");
    expect(mod.redactSecrets("leak xoxb-1234567890abcdef here")).toContain("xoxb-***");
    expect(mod.redactSecrets("leak AKIA1234567890ABCDEF here")).toContain("AKIA***");
  });

  test("masks GitHub / GitLab / AWS-session / Google-OAuth token prefixes", () => {
    expect(mod.redactSecrets("leak ghp_1234567890abcdef here")).toContain("ghp_***");
    expect(mod.redactSecrets("leak glpat-1234567890abcdef here")).toContain("glpat-***");
    expect(mod.redactSecrets("leak ASIA1234567890ABCDEF here")).toContain("ASIA***");
    expect(mod.redactSecrets("leak ya291234567890abcdef here")).toContain("ya29***");
  });

  test("masks credentials embedded in connection URLs", () => {
    const out = mod.redactSecrets("mongodb://user:pass@db.example.com:27017/app");
    expect(out).toContain("mongodb://***:***@db.example.com:27017/app");
    expect(out).not.toContain("pass");
    const https = mod.redactSecrets("https://admin:secret@api.example.com/v1");
    expect(https).toContain("https://***:***@api.example.com/v1");
    expect(https).not.toContain("secret");
  });

  test("masks the service's own configured secret", () => {
    const secret = mod.SHARED_SECRET;
    expect(secret).toBeTruthy();
    const out = mod.redactSecrets(`token=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain("***");
  });

  test("masks Authorization: Bearer tokens in SDK / error messages", () => {
    const out = mod.redactSecrets("Authorization: Bearer abc.def.ghi");
    expect(out).toContain("Authorization: Bearer ***");
    expect(out).not.toContain("abc.def.ghi");
  });

  test("masks JSON-shaped credential field values", () => {
    expect(mod.redactSecrets('{"password":"hunter2"}')).not.toContain("hunter2");
    expect(mod.redactSecrets('{"password":"hunter2"}')).toContain('"password":"***"');
    expect(mod.redactSecrets('{"apiKey":"xyz-123"}')).not.toContain("xyz-123");
    expect(mod.redactSecrets('{"token":"tok-9"}')).toContain('"token":"***"');
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
  let io: { close: (cb?: (err?: Error) => void) => void | Promise<void> };
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

 // Fresh module instance so this suite observes a deterministic SHARED_SECRET
 // / CORS_ORIGIN. The `redactSecrets` describe above also imports this module
 // (with a different COWORK_EVENT_TOKEN) and its cached instance would
 // otherwise leak in here — SHARED_SECRET/CORS_ORIGIN are computed at module
 // load time and never re-read, so we must reset before re-importing.
    vi.resetModules();
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
 // Mirror the production graceful-shutdown order
 // (`mini-services/cowork-events/index.ts` `shutdown()`): close socket.io FIRST
 // (it releases engine.io's listeners on the httpServer), then close the
 // httpServer. Both are awaited — no setTimeout fallback — so the test cannot
 // hang on an un-fired callback and cannot leak an open handle.
    await closeServerAndIo(server, io);
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

  // ── trust-boundary security rails ─────────────────────────────────────
  //
  // Regression tests for the controls that stop a caller from corrupting
  // shared state or impersonating server-owned channels. These guard
  // exactly the paths a hostile-but-authenticated caller would probe.

  test("parseQuery blocks __proto__/constructor/prototype keys (prototype pollution guard)", () => {
    const out = mod.parseQuery("?__proto__=polluted&normal=1");
    expect(out.normal).toBe("1");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const c = mod.parseQuery("?constructor=evil&normal=2");
    expect(c.normal).toBe("2");
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    const p = mod.parseQuery("?prototype=leak&normal=3");
    expect(p.normal).toBe("3");
    expect(({} as Record<string, unknown>).leak).toBeUndefined();
  });

  describe("rateLimitCheck + parseQuery unit", () => {
    test("parseQuery tolerates malformed %ZZ URIs without crashing", () => {
      const out = mod.parseQuery("?ok=good&bad=%ZZ&__proto__=x");
      expect(out.ok).toBe("good");
      expect(out.bad).toBe("%ZZ");
      expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
    });

    test("rateLimitCheck allows up to RATE_LIMIT_MAX then blocks", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(0));
        const ip = `unit-${Math.random()}`;
        let allowed = 0;
        for (let i = 0; i < mod.RATE_LIMIT_MAX; i++) {
          if (mod.rateLimitCheck(ip).allowed) allowed++;
        }
        expect(allowed).toBe(mod.RATE_LIMIT_MAX);
        const blocked = mod.rateLimitCheck(ip);
        expect(blocked.allowed).toBe(false);
        expect(blocked.remaining).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("rateLimitCheck resets exactly at the window boundary", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date(1000));
        const ip = `unit-${Math.random()}`;
        const resetAt = mod.rateLimitCheck(ip).resetAt;
        for (let i = 1; i < mod.RATE_LIMIT_MAX; i++) mod.rateLimitCheck(ip);
        expect(mod.rateLimitCheck(ip).allowed).toBe(false);
        vi.setSystemTime(new Date(resetAt - 1));
        expect(mod.rateLimitCheck(ip).allowed).toBe(false);
        vi.setSystemTime(new Date(resetAt + 1));
        expect(mod.rateLimitCheck(ip).allowed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test("POST /emit on a server-owned channel returns 400 (channel not allowed)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({ channel: "system:status", payload: {} }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/channel not allowed/i);
  });

  test("POST /emit with an over-length channel returns 400 (channel too long)", async () => {
    const channel = "x".repeat(129);
    const res = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({ channel, payload: {} }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/channel too long/i);
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

  // REGRESSION (O1): a previous build serialized the replay buffer with NO
  // redaction, so a secret captured into an event payload (e.g. a token
  // scraped from a tab) was returned to any authenticated client in
  // cleartext. This test emits a secret-bearing payload, then asserts the
  // GET /events replay has it masked — proving the endpoint path actually
  // redacts, not just the `redactSecrets` unit primitive.
  test("GET /events redacts secrets embedded in event payloads", async () => {
    const secret = "sk-ant-SECRET12345678";
    const channel = "tab:updated";
    const payload = { token: secret, note: "benign" };
    const emitRes = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({ channel, payload }),
    });
    expect(emitRes.status).toBe(200);
    const emittedId = (await emitRes.json()).id as number;

    const evRes = await fetch(`http://127.0.0.1:${port}/events?since_id=${emittedId - 1}`, {
      headers: { "X-Cowork-Token": token },
    });
    expect(evRes.status).toBe(200);
    const raw = await evRes.text();
    // The raw secret must never appear in the response body.
    expect(raw).not.toContain(secret);
    // The masked shape must be present.
    expect(raw).toContain("***");
    // And the structured payload must carry the masked token (not the secret).
    const body = JSON.parse(raw) as { events: Array<{ id: number; payload: { token: string } }> };
    const found = body.events.find((e) => e.id === emittedId);
    expect(found).toBeDefined();
    expect(found?.payload.token).toBe("***");
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

 // Per-IP rate limit, exercised in isolation. The limit is keyed on the
 // real TCP peer (127.0.0.1 for every test client), so the bucket is SHARED
 // across the whole suite. To test the 10-per-minute cap without contending
 // with other tests' requests, spin up a FRESH module instance (clean
 // rate-limit map + its own server port) — the same pattern the socket.io
 // block uses for the same reason.
  describe("per-IP /chat rate limit (isolated module)", () => {
    let server: import("http").Server;
    let io2: { close: (cb?: () => void) => void };
    let port2: number;
    let token2: string;
    let mod2: typeof import("../mini-services/cowork-events/index");

    beforeAll(async () => {
      token2 = "rate-limit-isolated-secret-abc-123";
      process.env.COWORK_EVENT_TOKEN = token2;
      process.env.COWORK_CORS_ORIGIN = "http://test-origin.local";
      process.env.NODE_ENV = "test";
      vi.resetModules();
      mod2 = await import("../mini-services/cowork-events/index");
      server = mod2.httpServer;
      io2 = mod2.io;
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
      port2 = (addr as AddressInfo).port;
    });

    afterAll(async () => {
      // Close socket.io + http server explicitly (guarded against
      // ERR_SERVER_NOT_RUNNING and with no setTimeout-only fallback).
      await closeServerAndIo(server, io2);
    });

    test("/chat 11 times in the same minute returns 429 on the 11th (rate limit)", async () => {
   // Per-IP rate limit — 10 /chat requests per minute. The 11th must
   // be rejected with 429 + a Retry-After header. We send empty-message
   // bodies so each of the first 10 requests returns 400 (messages
   // required) — the rate-limit counter is incremented BEFORE the body
   // validation, so 10 × 400 consumes the budget and the 11th gets 429.
      const headers: HeadersInit = {
        "Content-Type": "application/json",
        "X-Cowork-Token": token2,
      };
      const emptyBody = JSON.stringify({ messages: [] });
   // First 10: should pass rate limit + fail body validation (400).
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`http://127.0.0.1:${port2}/chat`, {
          method: "POST",
          headers,
          body: emptyBody,
        });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/messages required/);
      }
   // 11th: rate limit exceeded (429) + Retry-After header.
      const res = await fetch(`http://127.0.0.1:${port2}/chat`, {
        method: "POST",
        headers,
        body: emptyBody,
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).not.toBeNull();
      const json = await res.json();
      expect(json.error).toMatch(/rate limit/i);
    });
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

// ─── Socket.io integration tests ─────────────────────────────────────
//
// Spins up a SECOND, independent httpServer + socket.io server from a FRESH
// module instance (via `vi.resetModules()` + a dynamic re-import). This gives us
// a clean per-IP rate-limit map (the first integration describe above exhausts
// the 10/min budget with its 429 test) and a clean event buffer, so the
// streaming / image / replay tests below don't trip the safety rails.
//
// The z-ai SDK is fully mocked (see the `vi.mock("z-ai-web-dev-sdk")` block
// above), so `/chat` and `/image` run with no real upstream call. The
// `socket.io-client` package is a devDependency of the repo root, so it resolves
// from the test file.
//
// These tests exercise exactly the gaps called out in `/chat` success
// streaming, `/image` success, `events:replay` on connect, and the negative
// case where a hostile (but authenticated-with-a-scoped-sessionId) socket CANNOT
// read another session's `chat:message` (the room-scoping that the
// orchestrator wired into `chat:join` + `evaluateChatJoin`).

describe("cowork-events socket.io (integration)", () => {
  let server: import("http").Server;
  let io: { close: (cb?: () => void) => void };
  let port: number;
  let token: string;
  let mod: typeof import("../mini-services/cowork-events/index");
  let savedWebSocket: unknown;

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

 // Connect a socket.io-client to the test server. `auth` is forwarded to the
 // handshake so we can present either just the shared token, or a token plus a
 // scoped `sessionId` (to exercise the room-scoping path).
  function connect(auth: Record<string, unknown>): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const c = ioClient(`http://127.0.0.1:${port}`, {
        path: "/",
        auth,
        transports: ["websocket"],
        reconnection: false,
        timeout: 5000,
      });
      c.on("connect", () => resolve(c));
      c.on("connect_error", (err) => reject(err));
    });
  }

  beforeAll(async () => {
    token = "socket-integration-secret-xyz-789";
    process.env.COWORK_EVENT_TOKEN = token;
 // Allow any origin for socket.io handshakes in tests. The node
 // socket.io-client may or may not send an `Origin` header; `*` guarantees
 // the CORS layer doesn't reject the test connection regardless. This only
 // affects THIS test server instance (imported fresh below).
    process.env.COWORK_CORS_ORIGIN = "*";
 // Ensure the service would start even if NODE_ENV were production — our
 // token is a real secret, not the dev-token, so refusal is off regardless.
    process.env.NODE_ENV = "test";

 // Get a FRESH module instance with reset rate-limit + event buffers.
    vi.resetModules();
    mod = await import("../mini-services/cowork-events/index");
    server = mod.httpServer;
    io = mod.io;

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

 // jsdom provides a (non-functional) global `WebSocket`. engine.io-client in
 // Node normally uses the `ws` package; guard against it picking up jsdom's
 // stub by hiding the global for the duration of these tests, then restore.
    savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
  });

  afterAll(async () => {
 // Restore the global WebSocket we hid in beforeAll.
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
    // Close socket.io + http server explicitly (guarded against
    // ERR_SERVER_NOT_RUNNING and with no setTimeout-only fallback).
    await closeServerAndIo(server, io);
  });

 // ── events:replay + system:status on a successful handshake ───────────────

  test("socket.io handshake receives system:status and events:replay", async () => {
 // Seed a marker event so the replay buffer is non-empty and identifiable.
    const markerPayload = { probe: "replay-marker", ts: Date.now() };
    const emitRes = await fetch(`http://127.0.0.1:${port}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({ channel: "replay:probe", payload: markerPayload }),
    });
    expect(emitRes.status).toBe(200);

    const c = ioClient(`http://127.0.0.1:${port}`, {
      path: "/",
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      timeout: 5000,
    });

    const result = await new Promise<{ status: unknown; replay: unknown[] }>(
      (resolve, reject) => {
        const data: { status: unknown; replay: unknown[] } = { status: null, replay: [] };
 // Fail fast (rather than silently resolving with an empty replay buffer)
 // if the server never sends `events:replay` after a successful handshake.
        const failTimer = setTimeout(() => {
          c.close();
          reject(new Error("timed out waiting for events:replay after handshake"));
        }, 3000);
        c.on("system:status", (s) => {
          data.status = s;
        });
        c.on("events:replay", (e) => {
          clearTimeout(failTimer);
          data.replay = e as unknown[];
          resolve(data);
        });
      },
    );
    c.close();

 // The server emits a `system:status` hello packet on every successful
 // handshake.
    expect(result.status).not.toBeNull();
    expect((result.status as { hello?: boolean }).hello).toBe(true);
 // And replays the buffered events (including our marker) to the new client.
    expect(Array.isArray(result.replay)).toBe(true);
    const found = (result.replay as Array<{ channel: string; payload: unknown }>).find(
      (e) => e.channel === "replay:probe",
    );
    expect(found).toBeDefined();
    expect(found?.payload).toEqual(markerPayload);
  });

 // ── /chat success: streaming tokens delivered to the sessionId room ────────

  test("POST /chat streams tokens to the sessionId room over socket.io", async () => {
    zaiStore.chatChunks = ["Hello", " ", "world"];

    const sessionId = "test-sess-stream";
    const c = await connect({ token, sessionId });
    c.emit("chat:join", sessionId);

 // Collect streamed tokens via socket.io BEFORE issuing the HTTP request,
 // because the server emits chat:done (and thus finishes the HTTP response)
 // before the fetch promise resolves.
    const tokens: string[] = [];
    let done = false;
    const donePromise = new Promise<string[]>((resolve) => {
      c.on("chat:message", (m: { token?: string }) => {
        if (m?.token) tokens.push(m.token);
      });
      c.on("chat:done", () => {
        done = true;
        resolve(tokens);
      });
      c.on("chat:error", () => resolve(tokens));
    });

    await delay(150); // let the server process the chat:join
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        sessionId,
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const httpBody = await res.json();
    expect(httpBody.ok).toBe(true);
    expect(httpBody.content).toBe("Hello world");

    const got = await donePromise;
    expect(done).toBe(true);
    expect(got.join("")).toBe("Hello world");
    c.close();
  });

 // REGRESSION: a mid-stream upstream failure must STILL terminate the
 // session room with chat:done. The cockpit client keys its stream-finalize /
 // spinner-clear signal on chat:done; if the error path emits only chat:error
 // the room is left without a terminator and the client can hang. chat:error
 // already carries the failure state, so chat:done serves purely as a
 // terminator and never masks the error.
  test("POST /chat stream error still emits chat:done to the session room", async () => {
    zaiStore.failChat = true;
    try {
      const sessionId = "test-sess-err";
      const c = await connect({ token, sessionId });
      c.emit("chat:join", sessionId);

      let sawError = false;
      let sawDone = false;
      const finishPromise = new Promise<void>((resolve, reject) => {
        const failTimer = setTimeout(() => {
          c.close();
          reject(new Error("timed out waiting for chat:error + chat:done on upstream failure"));
        }, 3000);
        c.on("chat:error", () => {
          sawError = true;
          if (sawDone) {
            clearTimeout(failTimer);
            resolve();
          }
        });
        c.on("chat:done", () => {
          sawDone = true;
          if (sawError) {
            clearTimeout(failTimer);
            resolve();
          }
        });
      });

      await delay(150); // let the server process the chat:join
      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          sessionId,
          stream: true,
        }),
      });
      expect(res.status).toBe(500);

      await finishPromise;
      expect(sawError).toBe(true);
      expect(sawDone).toBe(true);
      c.close();
    } finally {
      zaiStore.failChat = false;
    }
  });

 // NEGATIVE: /chat must reject a missing token with 401 (same auth gate as
 // /emit and /events) — a regression that drops the middleware on /chat would
 // otherwise silently expose the LLM proxy.
  test("POST /chat WITHOUT token returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], sessionId: "x", stream: true }),
    });
    expect(res.status).toBe(401);
  });

 // ── /image success: returns base64 and records snapshot:captured ───────────

  test("POST /image returns the generated image and records snapshot:captured", async () => {
    zaiStore.imageBase64 = "BASE64FAKEIMAGE==";
    const prompt = "a tiny cat glowing on a phosphor terminal";

    const res = await fetch(`http://127.0.0.1:${port}/image`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({ prompt, size: "1024x1024" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.base64).toBe("BASE64FAKEIMAGE==");
    expect(body.prompt).toBe(prompt);
    expect(body.size).toBe("1024x1024");

 // The generated image is recorded so reconnecting clients see it in
 // `events:replay`. Verify it landed in the buffer (no live broadcast).
 //
 // SECURITY CONTRACT: the recorded `snapshot:captured` event DELIBERATELY
 // OMITS `prompt`. The prompt may contain sensitive user input / PII, and
 // persisting it into the replay buffer would expose that text to any client
 // that can authenticate (even though the live `io.emit` broadcast is
 // suppressed). The HTTP response still returns the prompt to the requesting
 // client (asserted above via `body.prompt`), but the buffered event only
 // carries non-sensitive metadata. This test therefore matches on
 // channel + size + kind, NOT on the prompt — updating it to require the
 // prompt would revert a privacy hardening fix.
    const evRes = await fetch(`http://127.0.0.1:${port}/events?since_id=0`, {
      headers: { "X-Cowork-Token": token },
    });
    const evBody = await evRes.json();
    const snap = (evBody.events as Array<{ channel: string; payload: { kind?: string; size?: string; bytes?: number } }>).find(
      (e) => e.channel === "snapshot:captured" && e.payload?.kind === "ai-image" && e.payload?.size === "1024x1024",
    );
    expect(snap).toBeDefined();
    expect(snap!.payload.bytes).toBe("BASE64FAKEIMAGE==".length);
 // Explicitly assert the prompt is NOT persisted (PII hardening).
    expect((snap!.payload as { prompt?: string }).prompt).toBeUndefined();
  });

 // NEGATIVE: /image must reject a missing token with 401 (same auth gate as
 // /emit and /events) — a regression that drops the middleware on /image would
 // otherwise silently expose the image-generation proxy.
  test("POST /image WITHOUT token returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a tiny cat", size: "1024x1024" }),
    });
    expect(res.status).toBe(401);
  });

 // ── NEGATIVE: unauthenticated (wrong-token) socket is dropped ─────────────

  test("unauthenticated (wrong-token) socket is dropped and receives nothing", async () => {
    const c = ioClient(`http://127.0.0.1:${port}`, {
      path: "/",
      auth: { token: "completely-wrong-token-aaa" },
      transports: ["websocket"],
      reconnection: false,
      timeout: 5000,
    });

    let gotReplay = false;
    let gotStatus = false;
    let endReason: "disconnect" | "connect_error" | null = null;
    c.on("events:replay", () => {
      gotReplay = true;
    });
    c.on("system:status", () => {
      gotStatus = true;
    });
    c.on("disconnect", () => {
      endReason = "disconnect";
    });
    c.on("connect_error", () => {
      endReason = "connect_error";
    });

    await delay(2500); // long enough for any handshake to be rejected
    c.close();

 // The connection must NOT stay open and must receive NO data — otherwise an
 // unauthenticated site could silently read every cockpit event.
    expect(endReason).not.toBeNull();
    expect(gotReplay).toBe(false);
    expect(gotStatus).toBe(false);
  });

 // ── NEGATIVE: cross-session hostile socket CANNOT read another session ─────
 //
 // The hostile client authenticates with a REAL token but a SCOPED sessionId
 // ("attacker") and then tries to join the victim's room. Because it presented
 // a scoped sessionId, `chat:join` enforces ownership and rejects the
 // cross-session join — so when `/chat` streams into the victim room, the
 // attacker's socket receives nothing.

  test("cross-session: scoped socket CANNOT read another session's chat:message", async () => {
    zaiStore.chatChunks = ["secret", "-token"];

    const victim = "victim-session-x";
    const attacker = "attacker-session-y";

    const victimSocket = await connect({ token, sessionId: victim });
    victimSocket.emit("chat:join", victim); // own room → allowed

    const attackerSocket = await connect({ token, sessionId: attacker });
    attackerSocket.emit("chat:join", victim); // victim's room → REJECTED

 // Attach listeners BEFORE the request so we don't miss the streamed events.
    const victimTokens: string[] = [];
    let victimDone = false;
    const victimDonePromise = new Promise<string[]>((resolve) => {
      victimSocket.on("chat:message", (m: { token?: string }) => {
        if (m?.token) victimTokens.push(m.token);
      });
      victimSocket.on("chat:done", () => {
        victimDone = true;
        resolve(victimTokens);
      });
      victimSocket.on("chat:error", () => resolve(victimTokens));
    });

    const attackerTokens: string[] = [];
    attackerSocket.on("chat:message", (m: { token?: string }) => {
      if (m?.token) attackerTokens.push(m.token);
    });

    await delay(150); // let both joins be processed
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cowork-Token": token },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        sessionId: victim, // stream into the VICTIM's room
        stream: true,
      }),
    });
    expect(res.status).toBe(200);

 // Victim legitimately receives the streamed tokens.
    const got = await victimDonePromise;
    expect(victimDone).toBe(true);
    expect(got.join("")).toBe("secret-token");

 // Attacker (rejected from the victim room) must receive NOTHING.
    await delay(400); // allow any stray message to arrive (it shouldn't)
    expect(attackerTokens.length).toBe(0);

    victimSocket.close();
    attackerSocket.close();
  });
});
