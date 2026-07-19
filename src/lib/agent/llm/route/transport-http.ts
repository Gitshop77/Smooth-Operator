/**
 * HTTP transport — sends requests via fetch, streams responses.
 * Sends a prepared request via `fetch` and streams the response.
 */

import type { Auth } from "./auth";
import type { Endpoint } from "./endpoint";
import type { Framing, Frame } from "./framing";
import { buildURL } from "./endpoint";
import { withLLMRetry } from "../retry";
import {
  type SsrfProvenance,
  isAllowedLlmBaseUrl,
  isCuratedLocalOrigin,
  resolveAndValidateLlmBaseUrl,
} from "./ssrf";

/** Strip userinfo (`user:pass@`) and query/fragment (possible secret-bearing tokens) from a URL for logs/errors. */
function redactUrlForLog(u: string): string {
  return u.replace(/\/\/[^@/]*@/, "//").replace(/[?#].*$/, "[redacted-query]");
}

/**
 * Parse an HTTP `Retry-After` header value into a delay in milliseconds.
 *
 * Accepts both the integer-seconds form (`"5"`) and the HTTP-date form
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns `undefined` when the value is
 * unparseable (e.g. garbage) so callers fall back to a default delay rather
 * than using `NaN`. A delay in the past (already-expired HTTP-date) clamps to
 * `0` so it's still honored as "retry immediately".
 */
export function parseRetryAfterHeader(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
 // Integer-seconds form (most common). Also tolerate "5.5"-style decimals.
 // Restrict to a plain decimal shape so JS numeric quirks (hex `0x10`,
 // scientific `1e3`, `Infinity`) are NOT silently accepted as delays —
 // RFC 7231 `delay-seconds` is `1*DIGIT`.
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
 // HTTP-date form (RFC 7231).
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/** Per-request timeout (ms). A stalled provider connection
 * hangs the agent indefinitely without this — a user-abort is the only
 * other way to interrupt it. 60s matches the SSE route's documented maxDuration. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Per-chunk timeout for SSE stream reading (ms). `fetchWithTimeout`
 * below only guards the INITIAL fetch (connection + response headers) — its
 * timer is cleared in `.finally()` as soon as headers arrive, BEFORE the
 * stream body is consumed. Without a per-chunk timeout, a stalled provider
 * (server-side hang, network hiccup mid-stream) blocks `reader.read()`
 * indefinitely; `withLLMRetry` never fires because the fetch "succeeded"
 * (200 OK + headers).
 *
 * 30s is generous enough to accommodate slow providers (Claude queue depth,
 * Gemini cold start) but bounded enough that a true stall is retried quickly.
 * On timeout we cancel the reader and throw a retryable error so `withLLMRetry`
 * re-attempts the whole request.
 */
const CHUNK_TIMEOUT_MS = 30_000;

/**
 * Upper bound on the total decoded bytes read from a single upstream response
 * (availability/DoS). The per-chunk stall timer only fires when NO data arrives
 * for `CHUNK_TIMEOUT_MS`; a runaway body that keeps trickling chunks inside that
 * window would otherwise grow unbounded and exhaust service-worker memory. On
 * exceed we cancel the reader and throw so the stream is treated as a failure
 * (mirrors the stall-error path). 100 MB is far above any legitimate LLM
 * completion stream while still bounding worst-case memory.
 */
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Upper bound on a `Retry-After` delay (1 hour) so a malicious or exhausted
 * provider can't stall the agent for an unbounded duration (availability/DoS). */
const MAX_RETRY_AFTER_MS = 3_600_000;

export interface TransportPrepareInput<Body> {
  readonly body: Body;
  readonly endpoint: Endpoint<Body>;
  readonly auth: Auth;
  readonly encodeBody: (body: Body) => string;
  readonly headers?: Record<string, string>;
}

// `FrameType` is a phantom type parameter: it tags `HttpPrepared` so the
// `Transport`/`Route` generic chains (`HttpPrepared<FrameType>`) can thread
// the frame type through `frames()`'s `AsyncIterable<FrameType>` without the
// field set itself holding a frame. The @typescript-eslint/no-unused-vars
// rule flags it because no field references it; the tag is intentional.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface HttpPrepared<FrameType = Frame> {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface Transport<Body = unknown, Prepared = unknown, FrameType = Frame> {
  readonly prepare: (input: TransportPrepareInput<Body>) => Prepared;
  readonly frames: (
    prepared: Prepared,
    signal?: AbortSignal
  ) => AsyncIterable<FrameType>;
}

/**
 * Fetch with a per-request timeout. Combines the caller's
 * AbortSignal (user-initiated Stop) with a 60s timeout signal. If the timeout
 * fires, the error is re-thrown as "Request timeout" (not "abort") so
 * `withLLMRetry` treats it as a retryable network error rather than a
 * non-retryable user cancel.
 *
 * Security: `redirect: "manual"` returns an opaque-redirect response WITHOUT
 * following the redirect — the request BODY (conversation + extracted page
 * content) is NEVER forwarded to the redirect target. This is strictly safer
 * than `redirect: "follow"` + a same-origin check, which would follow 307/308
 * redirects (body-preserving per RFC 7231/7538) BEFORE the check could
 * intervene, re-introducing an exfiltration risk. `redirect: "error"` blocks
 * all redirects but throws `TypeError("Failed to fetch")` which matches
 * retry.ts's network-error regex → 10.5s retry storm. `redirect: "manual"` +
 * an explicit non-retryable error gives the best of both: no body forwarding
 * (security) AND no retry storm (the "redirect" keyword doesn't match the
 * network regex). LLM provider endpoints never redirect in normal operation;
 * a redirect is misconfiguration or a body-exfil attempt. Legitimate custom
 * proxies that rely on same-origin redirects should configure their endpoint
 * URL to the final destination instead.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  userSignal: AbortSignal | undefined,
  provenance: SsrfProvenance
): Promise<Response> {
 // (SSRF guard) — defense-in-depth: refuse to fetch an LLM endpoint that
 // resolves to a loopback / private / link-local / cloud-metadata address.
 // `redirect: "manual"` already prevents body-forwarding via 3xx, but this
 // stops the request from ever leaving the service worker in the first place.
 //
 // Provenance: a curated local-provider origin (Ollama / LiteLLM loopback) is
 // the user's OWN self-hosted model server, so we treat it as
 // `user-configured` and keep it reachable. EVERY other URL — a public
 // hostname OR an injected / non-user URL — is treated per the supplied
 // `provenance` (default `untrusted`), so the SSRF guards FAIL CLOSED on it and
 // an injected `baseUrl` can never reach a local model server or an internal
 // host. `isAllowedLlmBaseUrl` applies the same range checks as
 // `validateLlmBaseUrl` while exempting the curated Ollama/LiteLLM local
 // endpoints. We throw (rather than silently contacting the host) so a bad URL
 // fails closed.
  const effectiveProvenance: SsrfProvenance = isCuratedLocalOrigin(url)
    ? "user-configured"
    : provenance;
  const exempt = effectiveProvenance === "user-configured";
  if (!isAllowedLlmBaseUrl(url, exempt, effectiveProvenance)) {
    throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${redactUrlForLog(url)}`);
  }
  // (SSRF guard, DNS-rebinding) — re-validate the real target at fetch time.
  // `isAllowedLlmBaseUrl` above only inspects the parsed HOST, so a public
  // hostname that DNS-rebinds to a cloud-metadata / link-local / unspecified /
  // CGNAT address at fetch time would otherwise reach the internal address.
  // `resolveAndValidateLlmBaseUrl` resolves the hostname and rejects any
  // resolution into a genuine SSRF sink. The curated Ollama/LiteLLM local
  // endpoints are exempted (so they stay reachable) while the DNS step still
  // blocks the sinks for every other host. This is re-checked on every fetch
  // (no cached IP) as defense-in-depth. NOTE: it does NOT fully close the
  // DNS-rebinding hole — `fetch` performs its own independent DNS lookup that
  // this validation cannot pin in a service worker, so a fast-flux attacker
  // could still flip the address between validate and connect. It narrows the
  // window; it is not a guarantee. Failures are thrown so a bad URL fails
  // closed. An unverifiable DNS result (unavailable / error) FAILS CLOSED
  // regardless of `exempt`.
  const dnsCheck = await resolveAndValidateLlmBaseUrl(url, exempt, effectiveProvenance);
  if (!dnsCheck.ok) {
    throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${redactUrlForLog(url)} (${dnsCheck.reason})`);
  }
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

 // Single source of truth for the terminal `.catch` on both fetch branches
 // (with / without a user signal). A timeout abort is surfaced as a retryable
 // "Request timeout" error; every other rejection (SSRF guard, opaque-redirect
 // refusal, real network error, user abort) passes through unchanged. Keeping
 // this in one place stops the two branches from silently diverging.
  const wrapTimeoutError = (e: unknown): never => {
    if (timedOut) {
      throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw e;
  };

  const verifyNoRedirect = (res: Response): Response => {
 // `redirect: "manual"` returns an opaque-redirect response (type
 // "opaqueredirect", status 0, no body/headers) when the server sends a
 // 3xx. The body was NOT forwarded (the redirect was not followed). Throw
 // a NON-retryable error so withLLMRetry doesn't waste 10.5s re-attempting.
 // The "redirect" keyword deliberately doesn't match retry.ts's
 // /fetch|network|econn|timeout/i regex.
    if (res.type === "opaqueredirect") {
      throw new Error(`LLM endpoint returned a redirect — refused to follow (potential request-body exfiltration). URL: ${redactUrlForLog(url)}`);
    }
    return res;
  };

  if (userSignal) {
    if (userSignal.aborted) {
 // Already aborted before we even issue the fetch — reject immediately and
 // skip constructing/invoking `fetch` against an already-aborted controller.
      clearTimeout(timer);
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    const onAbort = () => {
      clearTimeout(timer);
      controller.abort();
    };
    userSignal.addEventListener("abort", onAbort, { once: true });
 // Clean up the listener on completion so it doesn't accumulate
 // on the long-lived run-level abort signal.
    return fetch(url, { ...init, redirect: "manual", signal: controller.signal })
      .then(verifyNoRedirect)
      .then((res) => {
        // Stash a detach fn on the response so the stream consumer can remove
        // the abort listener exactly when the body is done (not before).
        (res as Response & { __detachAbortListener?: () => void }).__detachAbortListener = () =>
          userSignal.removeEventListener("abort", onAbort);
        return res;
      })
      .finally(() => {
        clearTimeout(timer);
      })
      .catch(wrapTimeoutError);
  }

  return fetch(url, { ...init, redirect: "manual", signal: controller.signal })
    .then(verifyNoRedirect)
    .finally(() => clearTimeout(timer))
    .catch(wrapTimeoutError);
}

/** Create an HTTP transport that sends JSON + reads SSE/JSON-line streams. */
export const httpJson = <Body = unknown, FrameType = Frame>(opts: {
  framing: Framing<FrameType>;
  /**
   * Provenance of the `baseUrl` this transport will fetch. Threaded into the
   * SSRF guards so an injected / non-user URL FAILS CLOSED. Defaults to
   * `"untrusted"`; pass `"user-configured"` only for a URL the user explicitly
   * configured (the curated Ollama / LiteLLM loopback origins are always
   * treated as `user-configured` regardless).
   */
  provenance?: SsrfProvenance;
}): Transport<Body, HttpPrepared<FrameType>, FrameType> => ({
  prepare: (input: TransportPrepareInput<Body>): HttpPrepared<FrameType> => {
    const bodyStr = input.encodeBody(input.body);
    const url = buildURL(input.endpoint, input.body);
    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...input.headers,
    };
    const headers = input.auth.apply({
      method: "POST",
      url,
      body: bodyStr,
      headers: baseHeaders,
    });
    return { url, headers, body: bodyStr };
  },
  frames: async function* (prepared: HttpPrepared<FrameType>, signal?: AbortSignal): AsyncIterable<FrameType> {
    const res = await withLLMRetry(async () => {
      const r = await fetchWithTimeout(prepared.url, {
        method: "POST",
        headers: prepared.headers,
        body: prepared.body,
      }, signal, opts.provenance ?? "untrusted");
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        const err = new Error(`LLM API ${r.status}: ${txt.slice(0, 300)}`);
 // Carry the numeric HTTP status so withLLMRetry can classify retryable
 // errors from the status code (429 / 5xx) instead of string-matching
 // the response body — which is fragile and language-dependent.
        (err as Error & { status?: number }).status = r.status;
 // Capture a `Retry-After` header (integer-seconds OR HTTP-date) so
 // withLLMRetry can honor it instead of exponential backoff. Invalid
 // values yield `undefined` so withLLMRetry falls back to its default
 // delay (never `NaN`).
        const retryAfter = r.headers.get("retry-after");
        if (retryAfter) {
          const ms = parseRetryAfterHeader(retryAfter);
 // Honour a zero delay (`Retry-After: 0`) as "retry immediately"
 // — the doc promises a processed-0 value is honoured, so use
 // `>= 0` rather than `> 0` (which would silently drop it and
 // fall back to the default backoff).
          if (typeof ms === "number" && ms >= 0 && ms <= MAX_RETRY_AFTER_MS) {
            (err as Error & { retryAfter?: number }).retryAfter = ms;
          }
        }
        throw err;
      }
      return r;
    }, signal);
 // `withLLMRetry` only returns when the fetch succeeded (non-ok responses
 // throw inside the retry callback above), so `res.ok` is guaranteed true
 // here — no guard needed.
    // Detach the user-abort listener (attached in fetchWithTimeout) once the
    // stream is fully consumed — keeping it alive for the whole SSE body so a
    // mid-stream Stop actually cancels the fetch (HIGH finding: user-Stop not
    // honored mid-stream).
    const detachAbortListener = (res as Response & { __detachAbortListener?: () => void }).__detachAbortListener;
    try {
    if (!res.body) {
 // Non-streaming response — parse the full body through the framing so it
 // yields proper `FrameType` objects (consistent with the streaming path).
 // Apply the same availability ceiling the streaming path enforces
 // (MAX_RESPONSE_BYTES). This branch reads via `res.text()`, which buffers the
 // whole body uncapped, so a non-chunked response from a custom baseURL could
 // exhaust service-worker memory. Reject upfront on a declared `content-length`
 // that exceeds the cap before buffering; fall back to a byte-length check on
 // the decoded text to catch a spoofed/absent header.
      const declaredLen = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
        throw new Error(`response too large: exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      const text = await res.text();
      if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
        throw new Error(`response too large: exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      const frames = opts.framing.parse(text);
      for (const frame of frames) yield frame;
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    const flushRemaining = function* (): Generator<FrameType> {
      if (buffer.trim()) {
        for (const frame of opts.framing.parse(buffer)) yield frame;
      }
    };
    try {
      while (true) {
        // Honor a user Stop mid-stream: cancel the reader and abort the
        // generator instead of letting the (now-orphaned) body keep draining
        // in the background (HIGH finding: user-Stop not honored mid-stream).
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          throw new DOMException("Aborted", "AbortError");
        }
 // race the read against a 30s timeout. If the provider
 // stalls mid-stream, cancel the reader and throw a retryable error
 // so `withLLMRetry` re-attempts the whole request. The timeout timer
 // is cleared as soon as the chunk arrives (or as soon as we throw).
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`stream stall: no data for ${CHUNK_TIMEOUT_MS}ms`)),
                CHUNK_TIMEOUT_MS,
              );
            }),
          ]);
          if (done) break;
 // Enforce a cumulative response-size cap. A runaway body that keeps
 // delivering chunks inside the per-chunk stall window would otherwise grow
 // unbounded; cancel the reader and throw a failure (handled below like a
 // stall) rather than exhaust memory.
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            throw new Error(`response too large: exceeded ${MAX_RESPONSE_BYTES} bytes`);
          }
          buffer += decoder.decode(value, { stream: true });
 // SSE events are terminated by a blank line (`\n\n`). The framing's
 // SSE parser builds a FRESH accumulator on every `parse` call (it is
 // stateless across calls), so we must feed it COMPLETE events — not
 // individual lines — otherwise a `data:` line and its terminating
 // blank line land in two separate stateless parses, the accumulator
 // is reset before the event flushes, and we yield 0 frames (the
 // regression this block restores). Split on the event boundary and
 // keep the trailing partial event (everything after the last `\n\n`)
 // buffered for the next chunk. Real streaming is preserved: a partial
 // event that has not yet received its terminating blank line stays
 // buffered until more bytes arrive or the stream ends.
          const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          const events = normalized.split("\n\n");
 // The segment after the final `\n\n` is an incomplete event; keep it.
 // It stays LF-normalized, so a split event completes correctly on the next
 // chunk.
          buffer = events.pop() ?? "";
          for (const event of events) {
            if (event === "") continue;
            const frames = opts.framing.parse(event + "\n\n");
            for (const frame of frames) yield frame;
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
 // Flush remaining buffer
      yield* flushRemaining();
    } catch (e) {
 // On per-chunk timeout (stream stall) cancel the reader to release the
 // underlying network resources. A stalled mid-stream response is NOT a
 // successful completion: we flush any buffered partial frames (so the
 // consumer still sees them) and then RE-THROW below so the consumer (and
 // the orchestrator's retry loop) treats the truncated stream as a failure
 // rather than silently executing truncated content and under-reporting
 // usage/cost. `withLLMRetry` only wraps the INITIAL fetch, so a
 // mid-stream stall cannot be transparently retried here.
      try {
        await reader.cancel();
      } catch {
 // `cancel` can throw if the reader is already closed — ignore.
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("stream stall:")) {
 // Flush any buffered partial frames first so the consumer sees them.
        yield* flushRemaining();
 // A stalled mid-stream response is NOT a successful completion: re-throw
 // so the consumer (and the orchestrator's retry loop) treats the truncated
 // stream as a failure rather than silently executing truncated content and
 // under-reporting usage/cost.
        throw e;
      }
 // Non-stall errors (real network failures, aborts, etc.) propagate.
      throw e;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    } finally {
      detachAbortListener?.();
    }
  },
});

export * as HttpTransport from "./transport-http";
