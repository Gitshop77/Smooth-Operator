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
/**
 * Ceiling (ms) for a `Retry-After` header so a hostile/buggy 429 can't freeze
 * the run. This is intentionally conservative: a legitimate provider returning
 * a large Retry-After (e.g. during maintenance) would be retried sooner than
 * intended, potentially exacerbating load — but the alternative (honoring an
 * arbitrarily large delay) lets a hostile provider stall the run indefinitely.
 * 30 seconds is long enough for legitimate transient backoffs while capping the
 * worst-case freeze from a malicious Retry-After header.
 */
const MAX_RETRY_AFTER_MS = 30_000;
/** Absolute ceiling (ms) on cumulative retry delay — breaks the loop even if individual retries haven't exhausted MAX_RETRIES. */
const MAX_RETRY_TOTAL_MS = 60_000;
/** Chunk size (ms) for the abort-aware sleep loop. */
const SLEEP_CHUNK_MS = 100;

/** Compiled once — reused on every retry attempt instead of recompiled inline. */
const ABORT_NAME_RE = /\b(abort|cancelled|canceled)/i;
const TOO_MANY_RE = /too many requests/i;
const STATUS_5XX_RE = /\b5\d\d\b/;
const NETWORK_RE = /fetch|network|econn|timeout/i;

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
  if (signal.aborted) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }
  const chunks = Math.ceil(ms / SLEEP_CHUNK_MS);
  for (let c = 0; c < chunks; c++) {
    if (signal.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
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
 * @param fn The async function to retry.
 * @param signal Optional abort signal — checked before every retry attempt
 * AND between chunks of the backoff sleep so a user-cancelled
 * run interrupts the retry promptly. When the signal is already
 * aborted at entry, the function throws immediately without
 * attempting `fn`. A deliberate abort (signal aborted, or an
 * `AbortError`/`TimeoutError`/`*abort*`-named error) is NEVER
 * retried — it propagates immediately so a user cancel is not
 * masked by an extra backoff.
 * @param runId Optional correlation/run id, included in retry log lines for
 * traceability. Defaults to undefined. Backward compatible — the
 * caller may omit it.
 */
function classifyError(
  err: Error,
  status: number | undefined,
  msg: string,
): { is429: boolean; is5xx: boolean; isNetwork: boolean } {
  const hasStatus = typeof status === "number";
  const statusKnownNonRetryable =
    hasStatus && status >= 400 && status < 500 && status !== 429;
  const is429 = hasStatus
    ? status === 429
    : msg.includes("429") || TOO_MANY_RE.test(msg);
  const is5xx = hasStatus
    ? status >= 500 && status < 600
    : STATUS_5XX_RE.test(msg);
  const isNetwork =
    !statusKnownNonRetryable && NETWORK_RE.test(msg);
  return { is429, is5xx, isNetwork };
}

export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  runId?: string
): Promise<T> {
  let totalDelay = 0;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!(e instanceof Error) && typeof (e as { name?: unknown })?.name === "string") {
        err.name = (e as { name: string }).name;
      }
      const msg = err.message;
      const status = (e as Error & { status?: number }).status;
      if (signal?.aborted) {
        const norm = e instanceof Error ? e : new Error(String(e));
        norm.name = "AbortError";
        throw norm;
      }
      if (
        err.name === "AbortError" ||
        err.name === "TimeoutError" ||
        ABORT_NAME_RE.test(err.name)
      ) throw e;
      const { is429, is5xx, isNetwork } = classifyError(err, status, msg);
      const retryable = is429 || is5xx || (isNetwork && !signal?.aborted);
      if (!retryable || attempt >= MAX_RETRIES) throw e;
      const retryAfterMs = (e as Error & { retryAfter?: number }).retryAfter;
      let delay: number;
      if (typeof retryAfterMs === "number" && retryAfterMs >= 0) {
        const capped = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
        delay = capped > 0
          ? capped + Math.random() * BACKOFF_JITTER_MS
          : 0;
      } else {
        delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BACKOFF_JITTER_MS;
      }
      const statusStr = typeof status === "number" ? `status=${status}` : "no-status";
      const retryAfterStr = typeof retryAfterMs === "number" && retryAfterMs >= 0
        ? `; retryAfter=${retryAfterMs}ms`
        : "";
      console.debug(
        `[withLLMRetry${runId ? ` run=${runId}` : ""}] attempt ` +
        `${attempt + 1}/${MAX_RETRIES + 1} failed (${statusStr}); ` +
        `retryable=${retryable}; delay=${Math.round(delay)}ms${retryAfterStr}`
      );
      totalDelay += delay;
      if (totalDelay >= MAX_RETRY_TOTAL_MS) throw e;
      await abortAwareSleep(delay, signal);
    }
  }
}
