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

/** Build a `FakeResponse` with safe defaults; override only what a test needs. */
function makeFakeResponse(o: Partial<FakeResponse> = {}): FakeResponse {
  return {
    type: "basic",
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: null,
    text: () => Promise.resolve(""),
    ...o,
  };
}

// ─── opaqueredirect security ───────────────────────────────────────────────

// Save/restore globalThis.fetch around every test that mocks it, so a mock
// never leaks into a later test (a single shared helper instead of three
// copy-pasted save/restore blocks).
let savedFetch: typeof globalThis.fetch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
});

// ─── SSRF-guard DNS shim ────────────────────────────────────────────────────
//
// In the Node/vitest runtime there is no `chrome.dns` and no `require("dns")`,
// so the async SSRF guard (`resolveAndValidateLlmBaseUrl`, invoked by
// `fetchWithTimeout`) FAILS CLOSED for every hostname URL (e.g.
// `https://api.example.com`). Mock a resolver that returns a public IP for ANY
// host so legitimate public-hostname transports pass the guard. The dedicated
// SSRF-blocking tests in this file still assert rejection: IP-literal /
// link-local URLs are rejected at the synchronous IP-classification layer, and
// the DNS-rebinding test installs its OWN `chrome.dns` stub that returns a
// metadata address (then restores to `undefined`). We restore the prior
// `chrome` global after each test so the DNS-rebinding test's local override
// never leaks.

const dnsShimChrome: { v: unknown } = { v: undefined };
beforeEach(() => {
  dnsShimChrome.v = (globalThis as unknown as { chrome?: unknown }).chrome;
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: { lastError: undefined },
    dns: {
      resolve: (_h: string, cb: (r: { addresses?: string[] }) => void) =>
        cb({ addresses: ["93.184.216.34"] }),
    },
  };
});
afterEach(() => {
  (globalThis as unknown as { chrome?: unknown }).chrome = dnsShimChrome.v;
});

describe("httpJson.frames — opaqueredirect security", () => {
  test("THROWS when fetch resolves with type:'opaqueredirect' (refuses to follow redirect)", async () => {
 // `redirect: "manual"` makes fetch resolve with an opaque-redirect response
 // (type "opaqueredirect", status 0, no body) instead of following the 3xx.
 // The transport's `verifyNoRedirect` must throw so the request BODY
 // (conversation + extracted page content) is NEVER forwarded to the
 // redirect target — blocks body-exfiltration via 3xx redirects.
    const fakeResponse = makeFakeResponse({ type: "opaqueredirect", status: 0, ok: false });
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
    const fakeResponse = makeFakeResponse({ type: "opaqueredirect", status: 0, ok: false });
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
    const fakeResponse = makeFakeResponse({ body: stringToStream(sseBody) });
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
    const fakeResponse = makeFakeResponse({ body: stringToStream("data: [DONE]\n\n") });
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
  test("Retry-After: 0 is honored as an immediate retry (no exponential backoff)", async () => {
 // Regression guard for the contract that `Retry-After: 0` means "retry
 // immediately". `retry.ts` honors `>= 0`, so the second attempt must fire
 // with a delay of exactly 0ms rather than the ~1.5s base exponential backoff.
 // Driven with fake timers so the contract is pinned deterministically — the
 // old `gap < 600` wall-clock check was flaky on slow CI runners.
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const fetchMock = vi.fn(async () => {
        if (attempt === 0) {
          attempt++;
          return makeFakeResponse({
            status: 429,
            ok: false,
            headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? "0" : null) },
            text: () => Promise.resolve("rate limited"),
          }) as unknown as Response;
        }
        return makeFakeResponse({ body: stringToStream("data: [DONE]\n\n") }) as unknown as Response;
      });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const transport = httpJson({ framing: sse });
      const iter = transport.frames(makePrepared());
      const drained = (async () => {
        for await (const _ of iter) { void _; }
      })();

 // Retry-After: 0 → delay is exactly 0ms, so advancing past 0 fires the
 // second attempt. The exponential backoff (~1500ms) would NOT fire within
 // 1ms — this pins the "retry immediately" contract (no wall-clock dependence).
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
 // Drain the rest of the stream deterministically.
      await vi.advanceTimersByTimeAsync(1);
      await drained;
    } finally {
      vi.useRealTimers();
    }
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

  test("frames() THROWS before calling fetch for IPv6-mapped metadata sinks", async () => {
    // The transport guard's IPv6 classification must reject link-local /
    // IPv4-mapped metadata forms before any network call leaves the service
    // worker. A regression that dropped IPv6 handling at the transport guard
    // would not be caught by the IPv4-metadata / DNS-rebind cases above.
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should never run for a blocked baseUrl");
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
    for (const url of [
      "http://[::ffff:169.254.169.254]/",
      "http://[fe80::1]/",
      "http://[::ffff:0.0.0.0]/",
      "http://[2001::5601:5601]/",
    ]) {
      const iter = transport
        .frames(makePrepared(url))[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow(/SSRF guard/i);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  test("frames() THROWS before calling fetch when baseUrl is a hostname that DNS-rebinds to a metadata address", async () => {
    // The transport guard now re-validates the REAL target at fetch time. A
    // public hostname that DNS-resolves to the cloud-metadata address (a
    // DNS-rebinding SSRF) must be rejected BEFORE any network call leaves the
    // service worker — the synchronous isAllowedLlmBaseUrl host check alone
    // would let it through. `fetch` must therefore never be invoked.
    const chromeRef = globalThis as unknown as { chrome?: unknown };
    chromeRef.chrome = {
      runtime: {},
      dns: { resolve: (_h: string, cb: (r: { addresses?: string[] }) => void) => cb({ addresses: ["169.254.169.254"] }) },
    };
    try {
      const fetchMock = vi.fn(async () => {
        throw new Error("fetch should never run for a DNS-rebound baseUrl");
      });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const transport = httpJson({ framing: sse });
      const iter = transport
        .frames(makePrepared("http://metadata.example.attacker/v1"))[Symbol.asyncIterator]();

      await expect(iter.next()).rejects.toThrow(/SSRF guard/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      chromeRef.chrome = undefined;
    }
  });
});

// ─── Bounded error-body reads ────────────────────────────────────────────────

describe("httpJson.frames — bounded error-body reads", () => {
  test("a huge 4xx error body is consumed with a byte cap, not buffered whole via text()", async () => {
    // The old `r.text()` on 4xx/5xx buffered the ENTIRE (potentially
    // multi-GB) error body before slicing the first 100 chars. The fixed path
    // must read from the body STREAM with a byte cap. Instrument the stream to
    // count consumed bytes: the fixed path reads at most the cap; the old
    // text()-based path never touches the stream at all.
    const encoder = new TextEncoder();
    const CHUNK = 8 * 1024; // realistic network-chunk size
    const chunkCount = 512; // 512 × 8 KB = 4 MB of error text
    const hugeBody = "e".repeat(CHUNK * chunkCount);
    let bytesConsumed = 0;
    const makeCountingStream = () => {
      const counting = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesConsumed += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < chunkCount; i++) {
            controller.enqueue(encoder.encode("e".repeat(CHUNK)));
          }
          controller.close();
        },
      }).pipeThrough(counting);
    };
    // withLLMRetry re-issues the fetch for a 500 — each attempt must get a
    // FRESH response (a real network would too); reusing one Response object
    // would hand later attempts an already-cancelled body.
    const fetchMock = vi.fn(async () =>
      makeFakeResponse({
        status: 500,
        ok: false,
        body: makeCountingStream(),
        // Mirror a real Response: text() would produce the whole (huge) body.
        text: () => Promise.resolve(hugeBody),
      }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const transport = httpJson({ framing: sse });
    const iter = transport.frames(makePrepared())[Symbol.asyncIterator]();

    // A 500 is retryable, so withLLMRetry re-issues the fetch with backoff
    // delays; drive them with fake timers for deterministic, fast completion.
    vi.useFakeTimers();
    try {
      const settled = iter.next().then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, error: e as Error }),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await settled;
      expect(result.ok).toBe(false);
      const msg = (result as { error: Error }).error.message;
      // The message must still carry the first 100 chars of the error body.
      expect(msg).toBe(`LLM API 500: ${"e".repeat(100)}`);
    } finally {
      vi.useRealTimers();
    }
    // The body was read from the STREAM (bounded), not via text() (unbounded):
    // some bytes flowed, but far fewer than the 4 MB body (even across the
    // retry loop's re-reads of the 500 response).
    expect(bytesConsumed).toBeGreaterThan(0);
    expect(bytesConsumed).toBeLessThan(64 * 1024);
  });
});

// ─── Per-chunk stream-stall timeout ──────────────────────────────────────────

describe("httpJson.frames — per-chunk stream-stall timeout", () => {
 // Keep this in sync with `CHUNK_TIMEOUT_MS` in transport-http.ts (30s). It is
 // not exported, so we mirror the value here to drive fake timers past it.
  const CHUNK_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const fakeResponse = makeFakeResponse({ body: stallStream });
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
