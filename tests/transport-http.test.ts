/**
 * HTTP transport regression tests — covers the `redirect: "manual"` +
 * opaqueredirect security check and the per-chunk stream-stall timeout.
 * These paths had ZERO coverage before — a future refactor could silently
 * revert `redirect: "manual"` to `redirect: "follow"` (or drop the
 * `verifyNoRedirect` check) and the 542-test suite would still pass green.
 *
 * The transport is exercised directly via `httpJson({ framing: sse }).frames(prepared)`
 * with a mocked `globalThis.fetch`. We do NOT go through a real provider route —
 * the goal is to verify the transport's response-handling logic, not provider
 * wire-format parsing.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { httpJson, parseRetryAfterHeader, type HttpPrepared } from "../src/lib/agent/llm/route/transport-http";
import { sse } from "../src/lib/agent/llm/route/framing";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal `HttpPrepared` the transport's `frames()` can consume. */
function makePrepared(url = "https://evil.example.com/v1/chat"): HttpPrepared {
  return {
    url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  };
}

/** Minimal Response-shaped object usable by the transport's response handler. */
interface FakeResponse {
  type?: string;
  status: number;
  ok: boolean;
  headers: { get: (name: string) => string | null };
  body: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
}

/** Encode a string into a UTF-8 ReadableStream. */
function stringToStream(s: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(s));
      controller.close();
    },
  });
}

// ─── opaqueredirect security ───────────────────────────────────────────────

describe("httpJson.frames — opaqueredirect security", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("THROWS when fetch resolves with type:'opaqueredirect' (refuses to follow redirect)", async () => {
 // `redirect: "manual"` makes fetch resolve with an opaque-redirect response
 // (type "opaqueredirect", status 0, no body) instead of following the 3xx.
 // The transport's `verifyNoRedirect` must throw so the request BODY
 // (conversation + extracted page content) is NEVER forwarded to the
 // redirect target — blocks body-exfiltration via 3xx redirects.
    const fakeResponse: FakeResponse = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: { get: () => null },
      body: null,
      text: () => Promise.resolve(""),
    };
    globalThis.fetch = vi.fn(async () => fakeResponse as unknown as Response) as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
    const iter = transport.frames(makePrepared())[Symbol.asyncIterator]();

 // The error must mention "redirect" so a reader can identify the cause.
    await expect(iter.next()).rejects.toThrow(/redirect/i);
  });

  test("opaqueredirect error message is NON-retryable (no fetch/network/econn/timeout keywords)", async () => {
 // withLLMRetry's retryable-regex is /fetch|network|econn|timeout/i. The
 // redirect error message must NOT match any of these — otherwise a
 // misconfigured endpoint (or an attacker-controlled 3xx) would trigger a
 // 10.5s retry storm (3 retries × ~3.5s backoff) on every request. The
 // "redirect" keyword is deliberately chosen to fall outside the regex.
    const fakeResponse: FakeResponse = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: { get: () => null },
      body: null,
      text: () => Promise.resolve(""),
    };
    const fetchMock = vi.fn(async () => fakeResponse as unknown as Response);
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
    const iter = transport.frames(makePrepared())[Symbol.asyncIterator]();

    let caught: Error | undefined;
    try {
      await iter.next();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const msg = caught!.message.toLowerCase();
    expect(msg).not.toMatch(/fetch|network|econn|timeout/);
    expect(msg).toMatch(/redirect/);
 // Non-retryable ⇒ fetch must be called EXACTLY once (no retries).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("normal (non-redirect) streaming response still works — yields parsed SSE frames", async () => {
 // Regression guard: the opaqueredirect check must not break the happy path.
 // A real provider 200-OK response with an SSE body must yield its frames.
    const sseBody =
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
      'data: [DONE]\n\n';
    const fakeResponse: FakeResponse = {
      type: "basic",
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: stringToStream(sseBody),
      text: () => Promise.resolve(""),
    };
    const fetchMock = vi.fn(async () => fakeResponse as unknown as Response);
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
    const iter = transport.frames(makePrepared("https://api.example.com/v1/chat"));

    const frames: string[] = [];
    for await (const f of iter) frames.push(f as string);

 // The first SSE `data:` line carries a JSON payload; the second carries [DONE].
    expect(frames.length).toBe(2);
    expect(frames[0]).toContain('"content":"hi"');
    expect(frames[1]).toBe("[DONE]");
 // fetch must be called with `redirect: "manual"` in the init (the fix).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.redirect).toBe("manual");
  });

  test("fetch is invoked with `redirect: \"manual\"` in the init (regression guard)", async () => {
 // Even on a non-redirect response, the init MUST carry `redirect: "manual"`.
 // A future refactor that drops this back to the default ("follow") would
 // re-open the body-exfiltration vector the opaqueredirect check closes.
    const fakeResponse: FakeResponse = {
      type: "basic",
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: stringToStream("data: [DONE]\n\n"),
      text: () => Promise.resolve(""),
    };
    const fetchMock = vi.fn(async () => fakeResponse as unknown as Response);
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
 // Drain the iterator so the fetch actually fires.
    for await (const _ of transport.frames(makePrepared())) { void _; }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("POST");
  });
});

// ─── Retry-After header parsing ───────────────────────────────────────

describe("parseRetryAfterHeader — seconds + HTTP-date", () => {
  test("parses the integer-seconds form", () => {
    expect(parseRetryAfterHeader("5")).toBe(5000);
    expect(parseRetryAfterHeader("0")).toBe(0);
    expect(parseRetryAfterHeader("2.5")).toBe(2500);
  });

  test("parses the HTTP-date form into a positive delay", () => {
 // A date ~10s in the future should yield a positive (non-NaN) delay.
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterHeader(future);
    expect(typeof ms).toBe("number");
    expect(Number.isNaN(ms as number)).toBe(false);
    expect((ms as number)).toBeGreaterThan(0);
  });

  test("clamps an already-expired HTTP-date to 0 (still honored)", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfterHeader(past)).toBe(0);
  });

  test("garbage yields undefined (so the caller never uses NaN)", () => {
    expect(parseRetryAfterHeader("not-a-date")).toBeUndefined();
    expect(parseRetryAfterHeader("")).toBeUndefined();
  });
});

// ─── Retry-After delay + SSRF guard (end-to-end through frames()) ─────────

describe("httpJson.frames — Retry-After + SSRF guard", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("Retry-After: 0 is honored as an immediate retry (no exponential backoff)", async () => {
 // Regression guard for the contract that `Retry-After: 0` means "retry
 // immediately". `retry.ts` honors `>= 0`, so the second attempt must fire
 // with essentially no delay rather than the ~1.5s base exponential backoff.
    let attempt = 0;
    let firstCall = 0;
    let secondCall = 0;
    const fetchMock = vi.fn(async () => {
      const t = Date.now();
      if (attempt === 0) {
        firstCall = t;
        attempt++;
        return {
          type: "basic",
          status: 429,
          ok: false,
          headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? "0" : null) },
          body: null,
          text: () => Promise.resolve("rate limited"),
        } as unknown as Response;
      }
      secondCall = t;
      return {
        type: "basic",
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: stringToStream("data: [DONE]\n\n"),
        text: () => Promise.resolve(""),
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
 // Drain the iterator so both fetch attempts fire.
    for await (const _ of transport.frames(makePrepared())) { void _; }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const gap = secondCall - firstCall;
 // Far below the 1.5s BASE_DELAY_MS exponential backoff — proves the 0
 // value was honored instead of silently downgraded to the default wait.
    expect(gap).toBeLessThan(600);
  });

  test("frames() THROWS before calling fetch when baseUrl is an SSRF sink", async () => {
 // The transport's `isAllowedLlmBaseUrl` guard (defense-in-depth) must reject
 // cloud-metadata / link-local endpoints BEFORE any network call leaves the
 // service worker. `fetch` must therefore never be invoked for a blocked URL.
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should never run for a blocked baseUrl");
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
    const iter = transport
      .frames(makePrepared("http://169.254.169.254/"))[Symbol.asyncIterator]();

    await expect(iter.next()).rejects.toThrow(/SSRF guard/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Per-chunk stream-stall timeout ──────────────────────────────────────────

describe("httpJson.frames — per-chunk stream-stall timeout", () => {
 // Keep this in sync with `CHUNK_TIMEOUT_MS` in transport-http.ts (30s). It is
 // not exported, so we mirror the value here to drive fake timers past it.
  const CHUNK_TIMEOUT_MS = 30_000;

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  test("THROWS a retryable-safe 'stream stall' error and cancels the reader when a chunk read stalls past CHUNK_TIMEOUT_MS", async () => {
 // `fetchWithTimeout` only guards the INITIAL fetch (connection + headers);
 // its timer is cleared once headers arrive. A provider that returns 200 OK
 // + headers but then hangs mid-stream would block `reader.read()` forever
 // without the per-chunk timeout. This exercises that path: the stream body
 // never enqueues and never closes, so `reader.read()` never resolves and the
 // 30s per-chunk timeout must fire, cancel the reader, and re-throw so the
 // orchestrator treats the truncated stream as a failure (not a silent
 // completion that under-reports usage/cost).
    let cancelled = false;
    const stallStream = new ReadableStream<Uint8Array>({
      start() {
 // Enqueue nothing and never close → `reader.read()` hangs indefinitely.
      },
      cancel() {
        cancelled = true;
      },
    });
    const fakeResponse: FakeResponse = {
      type: "basic",
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: stallStream,
      text: () => Promise.resolve(""),
    };
    globalThis.fetch = vi.fn(async () => fakeResponse as unknown as Response) as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
    const iter = transport
      .frames(makePrepared("https://api.example.com/v1/chat"))[Symbol.asyncIterator]();

    const pending = iter.next();
 // Attach a rejection handler synchronously so an early rejection isn't
 // reported as an unhandled promise rejection while we advance timers.
    const settled = pending.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, error: e as Error }),
    );

 // Let the mocked fetch resolve and the generator reach the read/timeout race,
 // then advance past the 30s per-chunk timeout to fire the stall.
    await vi.advanceTimersByTimeAsync(CHUNK_TIMEOUT_MS + 1);

    const result = await settled;
    expect(result.ok).toBe(false);
    const msg = (result as { error: Error }).error.message;
    expect(msg).toMatch(/stream stall/i);
 // The stall message must NOT match retry.ts's /fetch|network|econn|timeout/i
 // regex — otherwise a mid-stream stall (which withLLMRetry cannot wrap) would
 // masquerade as a retryable network error.
    expect(msg.toLowerCase()).not.toMatch(/fetch|network|econn|timeout/);
 // The reader must be cancelled to release the underlying network resources.
    expect(cancelled).toBe(true);
  });
});
