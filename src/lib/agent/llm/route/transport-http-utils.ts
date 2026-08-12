import { redactUrl } from "./url-redact";
import {
  type SsrfProvenance,
  isAllowedLlmBaseUrl,
  resolveAndValidateLlmBaseUrl,
} from "./ssrf";

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

export const TEXT_ENCODER = new TextEncoder();

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
 * Gemini cold start) but bounded enough that a true stall is not masked.
 * This fires AFTER `withLLMRetry` has returned (the fetch "succeeded"), so the
 * timeout cannot be retried there. On timeout we cancel the reader and re-throw
 * as a failure so the orchestrator treats the truncated stream as a failed step
 * (never as a silent success that under-reports usage/cost). The error message
 * deliberately stays outside `withLLMRetry`'s retryable regex so it cannot
 * masquerade as a retryable network error.
 */
export const CHUNK_TIMEOUT_MS = 30_000;

/**
 * Upper bound on the total decoded bytes read from a single upstream response
 * (availability/DoS). The per-chunk stall timer only fires when NO data arrives
 * for `CHUNK_TIMEOUT_MS`; a runaway body that keeps trickling chunks inside that
 * window would otherwise grow unbounded and exhaust service-worker memory. On
 * exceed we cancel the reader and throw so the stream is treated as a failure
 * (mirrors the stall-error path). 100 MB is far above any legitimate LLM
 * completion stream while still bounding worst-case memory.
 */
export const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Byte cap for the error-message body preview read. 4xx/5xx error
 * bodies only need the first few chars for diagnostics; a malicious or
 * accidental multi-GB error body must not be buffered whole via `text()`
 * before slicing.
 */
const ERROR_BODY_PREVIEW_BYTES = 1024;

/**
 * Read up to {@link ERROR_BODY_PREVIEW_BYTES} of a response body for an error
 * message, streaming from the body when available. The old `r.text()` path
 * buffered the ENTIRE (potentially multi-GB) error payload before
 * `slice(0, 100)`; this reads bounded chunks and cancels the reader once the
 * cap is reached. Returns the (UTF-8 decoded) preview text.
 */
function abortError(signal?: AbortSignal): DOMException {
  return signal?.reason instanceof DOMException
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

/** Race an uninterruptible platform promise with the root cancellation signal. */
function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function readErrorBodyPreview(res: Response, signal?: AbortSignal): Promise<string> {
  const cap = ERROR_BODY_PREVIEW_BYTES;
  if (signal?.aborted) throw abortError(signal);
  if (!res.body) {
    return (await awaitAbortable(res.text(), signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return "";
    })).slice(0, cap);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    while (total < cap) {
      // Stall guard: an upstream that accepts the request and then goes silent
      // on the error body would otherwise hang the retry callback past the
      // whole retry budget. Race every chunk against the same per-chunk
      // timeout the stream path uses and bail out with an empty preview — the
      // error message then carries just the status, and the empty string can
      // never match retry.ts's retryable network regex.
      const readPromise = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<"__stalled__">((resolve) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          resolve("__stalled__");
        }, CHUNK_TIMEOUT_MS);
      });
      const chunk = await awaitAbortable(Promise.race([readPromise, stall]), signal).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (chunk === "__stalled__") return "";
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try {
      await reader.cancel().catch(() => {});
    } catch {
      /* already closed */
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return out.slice(0, cap);
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
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  userSignal: AbortSignal | undefined,
  provenance: SsrfProvenance
): Promise<Response> {
  if (userSignal?.aborted) throw abortError(userSignal);
 // (SSRF guard) — defense-in-depth: refuse to fetch an LLM endpoint that
 // resolves to a loopback / private / link-local / cloud-metadata address.
 // `redirect: "manual"` already prevents body-forwarding via 3xx, but this
 // stops the request from ever leaving the service worker in the first place.
 //
 // Provenance: a curated local-provider origin (Ollama / LiteLLM loopback) is
 // the user's OWN self-hosted model server and may be exempted from the SSRF
 // range check — BUT ONLY when the caller already established that the baseUrl
 // was explicitly user-configured. We must NOT upgrade an `untrusted` provenance
 // (e.g. a page-injected `baseUrl`) to `user-configured` merely because it
 // points at a curated local origin, or an injected URL could reach the user's
 // local model server / loopback while bypassing the SSRF fail-closed. So the
 // curated-local exemption is gated on the supplied `provenance` staying
 // `user-configured`; for every other URL the SSRF guards FAIL CLOSED.
  const effectiveProvenance: SsrfProvenance = provenance;
  const exempt = effectiveProvenance === "user-configured";
  if (!isAllowedLlmBaseUrl(url, exempt, effectiveProvenance)) {
    throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${redactUrl(url, false)}`);
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
  const dnsCheck = await resolveAndValidateLlmBaseUrl(url, exempt, effectiveProvenance, {
    signal: userSignal,
  });
  if (!dnsCheck.ok) {
    throw new Error(`Unsafe LLM baseUrl rejected (SSRF guard): ${redactUrl(url, false)} (${dnsCheck.reason})`);
  }
  if (userSignal?.aborted) throw abortError(userSignal);
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
      throw new Error(`LLM endpoint returned a redirect — refused to follow (potential request-body exfiltration). URL: ${redactUrl(url, false)}`);
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
 // on the long-lived run-level abort signal. A local detach fn ensures
 // cleanup on BOTH the success path (stashed on the response for the
 // stream consumer) AND the error path (called in .catch before
 // re-throwing). Previously, if verifyNoRedirect threw (redirect
 // detected), the .then() that stashed __detachAbortListener was
 // skipped, leaking the listener on the long-lived run signal.
    const detachAbortListener = () =>
      userSignal.removeEventListener("abort", onAbort);
    return fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
      // Credential/cache-leak hardening: never send ambient cookies/HTTP-auth
      // to a configured/redirected endpoint, never reuse a prior conversation's
      // cached body, and never attach a Referer. (Redirects are already refused
      // via `manual`; this closes the same leak class for cache/credentials.)
      credentials: "omit",
      cache: "no-store",
      referrer: "",
    })
      .then((r) => verifyNoRedirect(r))
      .then((res) => {
        (res as Response & { __detachAbortListener?: () => void }).__detachAbortListener = detachAbortListener;
        return res;
      })
      .finally(() => {
        clearTimeout(timer);
      })
      .catch((e) => {
        detachAbortListener();
        return wrapTimeoutError(e);
      });
  }

  return fetch(url, {
    ...init,
    redirect: "manual",
    signal: controller.signal,
    credentials: "omit",
    cache: "no-store",
    referrer: "",
  })
    .then((r) => verifyNoRedirect(r))
    .finally(() => clearTimeout(timer))
    .catch(wrapTimeoutError);
}
