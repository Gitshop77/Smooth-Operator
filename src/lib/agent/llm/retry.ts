/**
 * Shared LLM retry helper — exponential backoff + jitter for transient errors
 * (429 / 5xx / network). Used by the HTTP transport
 * ({@link ./route/transport-http.ts}) so every provider has consistent
 * transient-error resilience.
 *
 * Non-retryable errors (4xx except 429) propagate immediately.
 *
 * Abort-handling: this helper accepts an optional `AbortSignal` and chunks its
 * backoff sleep (100ms slices) so a user-initiated abort mid-retry is observed
 * promptly. The chunked-sleep pattern lets a user cancel mid-backoff without
 * waiting for the full delay to elapse.
 *
 * Retry policy: retries ONLY on 429/5xx/network patterns and propagates all
 * other errors immediately (including 4xx except 429). Cancelled/aborted
 * errors propagate without retry. When a 429 response carries a `Retry-After`
 * header, the header's value (in ms) replaces the exponential backoff delay.
 */

/** Max retry attempts for transient errors (429/5xx/network). */
const MAX_RETRIES = 3;
/** Base delay for exponential backoff (doubles each attempt, in ms). */
const BASE_DELAY_MS = 1_500;
/** Max jitter added to each backoff delay (ms). */
const BACKOFF_JITTER_MS = 500;
/** Chunk size (ms) for the abort-aware sleep loop. */
const SLEEP_CHUNK_MS = 100;

/** Sleep helper. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Abort-aware sleep — sleeps in {@link SLEEP_CHUNK_MS} chunks so the signal is
 * checked at most every 100ms. Throws `Error("The operation was aborted")` if
 * the signal fires mid-sleep.
 */
async function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  const chunks = Math.ceil(ms / SLEEP_CHUNK_MS);
  for (let c = 0; c < chunks; c++) {
    if (signal.aborted) throw new Error("The operation was aborted");
    await sleep(Math.min(SLEEP_CHUNK_MS, ms - c * SLEEP_CHUNK_MS));
  }
}

/**
 * Retry a function with exponential backoff + jitter on 429/5xx/network errors.
 * Non-retryable errors (4xx except 429) propagate immediately.
 *
 * The error message is inspected (case-insensitive) for retry signals — this
 * works across providers because HTTP error messages consistently include the
 * status code or canonical text ("429", "Too many requests", "500", "fetch",
 * "network", "ECONN", "timeout").
 *
 * @param fn     The async function to retry.
 * @param signal Optional abort signal — checked before every retry attempt
 *               AND between chunks of the backoff sleep so a user-cancelled
 *               run interrupts the retry promptly. When the signal is already
 *               aborted at entry, the function throws immediately without
 *               attempting `fn`. A deliberate abort (signal aborted, or an
 *               `AbortError`/`TimeoutError`/`*abort*`-named error) is NEVER
 *               retried — it propagates immediately so a user cancel is not
 *               masked by an extra backoff.
 * @param runId  Optional correlation/run id, included in retry log lines for
 *               traceability. Defaults to undefined. Backward compatible — the
 *               caller may omit it.
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  runId?: string
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Honor abort before every attempt (including the first).
    if (signal?.aborted) throw new Error("The operation was aborted");
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const err = e instanceof Error ? e : new Error(String(e));
      const msg = err.message;
      const status = (e as Error & { status?: number }).status;
      // Cancelled/aborted — propagate immediately, no retry. Check BOTH the
      // signal (a user cancel that fired mid-flight) and the error's name
      // (AbortError / TimeoutError thrown by fetch / fetch-with-timeout), plus
      // the legacy message-substring match. A deliberate abort must never be
      // treated as a retryable network glitch.
      if (signal?.aborted) throw e;
      if (
        err.name === "AbortError" ||
        err.name === "TimeoutError" ||
        /\b(abort|cancelled|canceled)/i.test(err.name)
      ) throw e;
      if (/\b(abort|cancelled|canceled)/i.test(msg)) throw e;
      // Prefer the numeric HTTP status carried on the error (set by the HTTP
      // transport) for classifying retryable transients. Fall back to scanning
      // the message body if the status isn't available (e.g. non-transport errors).
      // Classify retryable transients from the numeric HTTP status when it is
      // present (set by the HTTP transport). This is authoritative: a 4xx whose
      // body text happens to mention "500"/"429" must NOT be retried just
      // because the substring appears in the (up to 300-char) provider body.
      // Only when the status is absent (non-transport errors) do we fall back to
      // scanning the message for 429/5xx signals.
      const hasStatus = typeof status === "number";
      const is429 = hasStatus
        ? status === 429
        : msg.includes("429") || /too many requests/i.test(msg);
      const is5xx = hasStatus
        ? status >= 500 && status < 600
        : /\b5\d\d\b/.test(msg);
      // Exclude a deliberate abort from the network/timeout retryable class so a
      // user cancel (which can surface as a "timeout"/"fetch" error) propagates
      // immediately rather than burning an extra backoff.
      const isNetwork = !signal?.aborted && /fetch|network|econn|timeout/i.test(msg);
      const retryable = is429 || is5xx || isNetwork;
      if (!retryable || attempt === MAX_RETRIES) throw e;
      // if the error carries a Retry-After value (from a 429 response
      // header), use that instead of exponential backoff.
      const retryAfterMs = (e as Error & { retryAfter?: number }).retryAfter;
      const delay = typeof retryAfterMs === "number" && retryAfterMs > 0
        ? retryAfterMs + Math.random() * BACKOFF_JITTER_MS
        : BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BACKOFF_JITTER_MS;
      // F7: surface retries (debug level — quiet unless explicitly enabled).
      // Includes the optional correlation runId, attempt number, status when
      // available, the computed delay, and any Retry-After value.
      const statusStr = typeof status === "number" ? `status=${status}` : "no-status";
      const retryAfterStr = typeof retryAfterMs === "number" && retryAfterMs > 0
        ? `; retryAfter=${retryAfterMs}ms`
        : "";
      console.debug(
        `[withLLMRetry${runId ? ` run=${runId}` : ""}] attempt ` +
        `${attempt + 1}/${MAX_RETRIES + 1} failed (${statusStr}); ` +
        `retryable=${retryable}; delay=${Math.round(delay)}ms${retryAfterStr}`
      );
      await abortAwareSleep(delay, signal);
    }
  }
  // Unreachable — the loop always throws on the final iteration.
  // This satisfies TypeScript's "not all code paths return" check.
  throw lastErr;
}
