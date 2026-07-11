/**
 * HTTP transport — sends requests via fetch, streams responses.
 * Sends a prepared request via `fetch` and streams the response.
 */

import type { Auth } from "./auth";
import type { Endpoint } from "./endpoint";
import type { Framing, Frame } from "./framing";
import { buildURL } from "./endpoint";
import { withLLMRetry } from "../retry";
import { isAllowedLlmBaseUrl } from "./ssrf";

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
  // Integer-seconds form (most common). Also handles "5.5"-style decimals.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  // HTTP-date form (RFC 7231).
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/** Per-request timeout (ms). A stalled provider connection
 *  hangs the agent indefinitely without this — a user-abort is the only
 *  other way to interrupt it. 60s matches the SSE route's documented maxDuration. */
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
function fetchWithTimeout(
  url: string,
  init: RequestInit,
  userSignal?: AbortSignal
): Promise<Response> {
  // (SSRF guard) — defense-in-depth: refuse to fetch an LLM endpoint that
  // resolves to a loopback / private / link-local / cloud-metadata address.
  // `redirect: "manual"` already prevents body-forwarding via 3xx, but this
  // stops the request from ever leaving the service worker in the first place.
  // `isAllowedLlmBaseUrl` applies the same range checks as `validateLlmBaseUrl`
  // while exempting the curated Ollama/LiteLLM local endpoints. We throw (rather
  // than silently contacting the host) so a bad URL fails closed.
  if (!isAllowedLlmBaseUrl(url)) {
    throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${url}`);
  }
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const verifyNoRedirect = (res: Response): Response => {
    // `redirect: "manual"` returns an opaque-redirect response (type
    // "opaqueredirect", status 0, no body/headers) when the server sends a
    // 3xx. The body was NOT forwarded (the redirect was not followed). Throw
    // a NON-retryable error so withLLMRetry doesn't waste 10.5s re-attempting.
    // The "redirect" keyword deliberately doesn't match retry.ts's
    // /fetch|network|econn|timeout/i regex.
    if (res.type === "opaqueredirect") {
      throw new Error(`LLM endpoint returned a redirect — refused to follow (potential request-body exfiltration). URL: ${url}`);
    }
    return res;
  };

  if (userSignal) {
    if (userSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      const onAbort = () => {
        clearTimeout(timer);
        controller.abort();
      };
      userSignal.addEventListener("abort", onAbort, { once: true });
      // Clean up the listener on completion so it doesn't accumulate
      // on the long-lived run-level abort signal.
      return fetch(url, { ...init, redirect: "manual", signal: controller.signal })
        .then(verifyNoRedirect)
        .finally(() => {
          clearTimeout(timer);
          userSignal.removeEventListener("abort", onAbort);
        })
        .catch((e) => {
          if (timedOut) {
            throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
          }
          throw e;
        });
    }
  }

  return fetch(url, { ...init, redirect: "manual", signal: controller.signal })
    .then(verifyNoRedirect)
    .finally(() => clearTimeout(timer))
    .catch((e) => {
      if (timedOut) {
        throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw e;
    });
}

/** Create an HTTP transport that sends JSON + reads SSE/JSON-line streams. */
export const httpJson = <FrameType = Frame>(opts: { framing: Framing<FrameType> }): Transport<unknown, HttpPrepared<FrameType>, FrameType> => ({
  prepare: (input: TransportPrepareInput<unknown>): HttpPrepared<FrameType> => {
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
      }, signal);
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
          if (typeof ms === "number" && ms > 0) {
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
    if (!res.body) {
      // Non-streaming response — parse as single JSON
      const text = await res.text();
      yield text as unknown as FrameType;
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
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
          buffer += decoder.decode(value, { stream: true });
          // Split on newlines — each line is a frame (SSE `data:` payload
          // or a JSON line). The framing-type-specific parsing happens in
          // `opts.framing.parse(part + "\n")` below.
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const frames = opts.framing.parse(part + "\n");
            for (const frame of frames) yield frame;
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      // Flush remaining buffer
      if (buffer.trim()) {
        const frames = opts.framing.parse(buffer);
        for (const frame of frames) yield frame;
      }
    } catch (e) {
      // On per-chunk timeout (stream stall), cancel the reader to release the
      // underlying network resources, then emit a synthetic "[DONE]" sentinel
      // frame so the protocol's `step()` reducer emits its normal `finish`
      // event carrying whatever partial content + usage was accumulated before
      // the stall. `withLLMRetry` only wraps the INITIAL fetch, so we cannot
      // retry mid-stream — partial content + partial usage is strictly better
      // than a hard failure for the agent loop.
      try {
        await reader.cancel();
      } catch {
        // `cancel` can throw if the reader is already closed — ignore.
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("stream stall:")) {
        // Flush any buffered partial frames first so the consumer sees them.
        if (buffer.trim()) {
          const frames = opts.framing.parse(buffer);
          for (const frame of frames) yield frame;
        }
        // Synthetic terminal frame.
        yield "[DONE]" as unknown as FrameType;
        return;
      }
      // Non-stall errors (real network failures, aborts, etc.) propagate.
      throw e;
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  },
});

export * as HttpTransport from "./transport-http";
