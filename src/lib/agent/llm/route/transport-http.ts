/**
 * HTTP transport — sends requests via fetch, streams responses.
 * Sends a prepared request via `fetch` and streams the response.
 */

import type { AuthStrategy } from "./auth";
import type { Endpoint } from "./endpoint";
import type { Framing, Frame } from "./framing";
import { buildURL } from "./endpoint";
import { withLLMRetry } from "../retry";
import { redactKeyShapes } from "../../key-shape-redact";
import { redactProviderErrorPreview } from "../../secrets";
import { MAX_RETRY_AFTER_MS } from "../constants";
import type { SsrfProvenance } from "./ssrf";
import {
  parseRetryAfterHeader,
  TEXT_ENCODER,
  CHUNK_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  fetchWithTimeout,
  readErrorBodyPreview,
} from "./transport-http-utils";

export { parseRetryAfterHeader } from "./transport-http-utils";

/** Upper bound on a `Retry-After` delay — shared with retry.ts via constants.ts
 * so the transport and retry layers agree on the same ceiling. */

interface TransportPrepareInput<Body> {
  readonly body: Body;
  readonly endpoint: Endpoint<Body>;
  readonly auth: AuthStrategy;
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

/** Create an HTTP transport that sends JSON + reads SSE/JSON-line streams. */
export const httpJson = <Body = unknown, FrameType = Frame>(opts: {
  framing: Framing<FrameType>;
  /**
   * Provenance of the `baseUrl` this transport will fetch. Threaded into the
   * SSRF guards so an injected / non-user URL FAILS CLOSED. Defaults to
   * `"untrusted"`; pass `"user-configured"` only for a URL the user explicitly
   * configured. The curated Ollama / LiteLLM loopback origins are only treated
   * as `user-configured` when the caller explicitly passes that flag — they are
   * never upgraded automatically.
   */
  provenance?: SsrfProvenance;
  /**
   * Provider id for retry classification. Threaded into
   * {@link withLLMRetry} so the OpenAI-404 quirk
   * ({@link isRetryableOpenAI404}) can distinguish transient 404s from
   * OpenAI/Azure/OpenRouter from permanent "model not found" 404s on other
   * providers. Optional — omit to keep 404 non-retryable.
   */
  providerId?: string;
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
        // Detach the user-abort listener BEFORE throwing: a non-ok response
        // resolves normally from fetchWithTimeout (its .catch detach only
        // fires on fetch-layer errors), so without this every retryable
        // 429/5xx attempt leaks an abort listener on the long-lived run
        // signal — an erroring endpoint would accumulate one per attempt for
        // the whole run. The success path keeps its detach until the stream
        // ends (mid-stream Stop must stay honored).
        let txt = "";
        try {
          // Keep the fetch listener attached while the preview is consumed: a
          // Stop must cancel a stalled non-2xx body just as it cancels SSE.
          txt = await readErrorBodyPreview(r, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
        } finally {
          (r as Response & { __detachAbortListener?: () => void }).__detachAbortListener?.();
        }
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError");
        }
        const err = new Error(`LLM API ${r.status}: ${redactProviderErrorPreview(redactKeyShapes(txt.slice(0, 100)))}`);
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
    }, signal, undefined, opts.providerId);
 // `withLLMRetry` only returns when the fetch succeeded (non-ok responses
 // throw inside the retry callback above), so `res.ok` is guaranteed true
 // here — no guard needed.
    // Detach the user-abort listener (attached in fetchWithTimeout) once the
    // stream is fully consumed — keeping it alive for the whole SSE body so a
    // mid-stream Stop actually cancels the fetch (user-Stop must be honored
    // mid-stream).
    const detachAbortListener = (res as Response & { __detachAbortListener?: () => void }).__detachAbortListener;
    try {
    if (!res.body) {
      // No ReadableStream exposed (body-less response). Reject on a declared
      // content-length over the cap; the byte-length check below still bounds
      // the buffered text if the header is absent/forged.
      const declaredLen = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
        throw new Error(`response too large: exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      const text = await res.text();
      if (TEXT_ENCODER.encode(text).length > MAX_RESPONSE_BYTES) {
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
    let currentRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    const flushRemaining = function* (): Generator<FrameType> {
      if (buffer.trim()) {
        for (const frame of opts.framing.parse(buffer)) yield frame;
      }
    };
    // SSE streams are delimited by a blank line; non-SSE (JSON) bodies must be
    // parsed as a whole, not split on "\n\n". Choose the parse strategy by
    // content type. BOTH paths read in bounded chunks and enforce
    // MAX_RESPONSE_BYTES as bytes arrive, instead of buffering the entire body
    // up front (memory-exhaustion DoS for the non-streaming path).
    const isSse = (res.headers.get("content-type") || "").includes("text/event-stream");
    try {
      while (true) {
        // Honor a user Stop mid-stream: cancel the reader and abort the
        // generator instead of letting the (now-orphaned) body keep draining
        // in the background (user-Stop must be honored mid-stream).
        if (signal?.aborted) {
          currentRead?.catch(() => {});
          await reader.cancel().catch(() => {});
          throw new DOMException("Aborted", "AbortError");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          currentRead = reader.read();
          const { done, value } = await Promise.race([
            currentRead,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`stream stall: no data for ${CHUNK_TIMEOUT_MS}ms`)),
                CHUNK_TIMEOUT_MS,
              );
            }),
          ]);
          if (done) break;
          // Enforce a cumulative response-size cap. A runaway body that keeps
          // delivering chunks inside the per-chunk stall window would otherwise
          // grow unbounded; cancel the reader and throw a failure rather than
          // exhaust memory.
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            throw new Error(`response too large: exceeded ${MAX_RESPONSE_BYTES} bytes`);
          }
          buffer += decoder.decode(value, { stream: true });
          if (isSse) {
            // Split on the SSE event boundary and keep the trailing partial
            // event buffered for the next chunk.
            const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const events = normalized.split("\n\n");
            buffer = events.pop() ?? "";
            for (const event of events) {
              if (event === "") continue;
              const frames = opts.framing.parse(event + "\n\n");
              for (const frame of frames) yield frame;
            }
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      if (isSse) {
        yield* flushRemaining();
      } else {
        // Non-streaming body fully buffered in bounded chunks — parse the whole
        // thing once (no res.text() up-front buffer, so no uncapped memory).
        buffer += decoder.decode();
        const frames = opts.framing.parse(buffer);
        for (const frame of frames) yield frame;
      }
    } catch (e) {
      // `reader.cancel()` rejects the pending `reader.read()` promise; attach a
      // no-op catch so it does not surface as an unhandled rejection.
      currentRead?.catch(() => {});
      try {
        await reader.cancel().catch(() => {});
      } catch {
        /* already closed */
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("stream stall:")) {
        if (isSse) yield* flushRemaining();
        throw e;
      }
      // Non-stall errors (real network failures, aborts, etc.) propagate.
      throw e;
    } finally {
      try {
        await reader.cancel().catch(() => {});
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
