/**
 * Shared LLM retry helper — exponential backoff + jitter for transient errors
 * (429 / 5xx / network / context-overflow). Used by the HTTP transport
 * ({@link ./route/transport-http.ts}) so every provider has consistent
 * transient-error resilience.
 *
 * Non-retryable errors (4xx except 429, plus the gateway-auth cases below)
 * propagate immediately.
 *
 * Abort-handling: this helper accepts an optional `AbortSignal` and chunks its
 * backoff sleep (100ms slices) so a user-initiated abort mid-retry is observed
 * promptly. The chunked-sleep pattern lets a user cancel mid-backoff without
 * waiting for the full delay to elapse.
 *
 * Retry policy: retries ONLY on 429/5xx/network/context-overflow patterns and
 * propagates all other errors immediately (including 4xx except 429 and the
 * OpenAI-404 quirk below). Cancelled/aborted errors propagate without retry.
 * When a 429 response carries a `Retry-After` header, the header's value (in
 * ms) replaces the exponential backoff delay.
 *
 * Provider error taxonomy (opencode parity):
 * - Context-overflow has THREE independent triggers: an overflow phrase in
 *   the message, an HTTP 413 status, and a nested JSON error body carrying
 *   `"code": "context_length_exceeded"`. Context-overflow is retried here
 *   (opencode truncates the prompt and retries at the loop level; the local
 *   transport-level retry re-issues the request and the loop's own truncation
 *   logic remains the caller's responsibility).
 * - The OpenAI-family 404 quirk (some OpenAI endpoints return 404 for models
 *   that are actually available) is scoped to the explicit provider ids
 *   "openai" / "azure" / "openrouter" — NOT a prefix test, so aliases like
 *   "openai-compatible" stay non-retryable on 404.
 * - HTML gateway auth pages (401/403 whose body is an HTML page, e.g. from a
 *   proxy/gateway in front of the provider) are classified as gateway-auth
 *   and NEVER retried; they are also excluded from context-overflow
 *   classification so a gateway page mentioning "too many tokens" cannot be
 *   mistaken for a real overflow.
 */

import { MAX_RETRY_AFTER_MS } from "./constants";

/** Max retry attempts for transient errors (429/5xx/network/overflow). */
const MAX_RETRIES = 3;
/** Base delay for exponential backoff (doubles each attempt, in ms). */
const BASE_DELAY_MS = 1_500;
/** Max jitter added to each backoff delay (ms). */
const BACKOFF_JITTER_MS = 500;
/** Absolute ceiling (ms) on cumulative retry delay — breaks the loop even if individual retries haven't exhausted MAX_RETRIES. */
const MAX_RETRY_TOTAL_MS = 60_000;
/** Chunk size (ms) for the abort-aware sleep loop. */
const SLEEP_CHUNK_MS = 100;

/** Compiled once — reused on every retry attempt instead of recompiled inline. */
const ABORT_NAME_RE = /\b(abort|cancelled|canceled)/i;
const TOO_MANY_RE = /too many requests/i;
const STATUS_5XX_RE = /\b5\d\d\b/;
const NETWORK_RE = /fetch|network|econn|timeout/i;

/**
 * Context-overflow phrase patterns (mirrors opencode's provider-error list,
 * plus a literal `max_tokens` marker). A match signals the request exceeded
 * the model's context window — retryable because opencode truncates + retries.
 */
const CONTEXT_OVERFLOW_PHRASE_RE =
  /prompt is too long|request_too_large|input is too long for requested model|exceeds the context window|exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))|input token count.*exceeds the maximum|tokens in request more than max tokens allowed|maximum prompt length is \d+|reduce the length of the messages|maximum context length is \d+ tokens|exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?|input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)|exceeds the limit of \d+|exceeds the available context size|greater than the context length|context window exceeds limit|exceeded model token limit|context[_ ]length[_ ]exceeded|request entity too large|context length is only \d+ tokens|input length.*exceeds.*context length|prompt too long; exceeded (?:max )?context length|too large for model with \d+ maximum context length|prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?|model_context_window_exceeded|too many tokens|token limit exceeded|max_tokens/i;

/**
 * Messages that LOOK overflow-flavored but are actually rate-limit / server
 * issues must not be classified as context overflow (mirrors opencode).
 */
const CONTEXT_OVERFLOW_EXCLUSION_RE = /^(?:throttling error|service unavailable):|rate limit|too many requests/i;

/** HTML markers for a gateway/proxy error page (doctype or `<html`). */
const HTML_GATEWAY_RE = /<!doctype\s+html|<html[\s>]/i;

/**
 * Provider ids that treat a 404 as retryable (the OpenAI-404 quirk). An
 * explicit set — NOT a prefix test — so "openai-compatible" stays excluded.
 */
const OPENAI_404_RETRYABLE_PROVIDERS: ReadonlySet<string> = new Set(["openai", "azure", "openrouter"]);

/** Sleep helper. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Best-effort extraction of the first balanced JSON object from a message.
 * The transport prefixes error bodies with `LLM API <status>: ` and caps the
 * preview, so a strict whole-message `JSON.parse` fails on the prefix and on
 * truncated bodies. This extracts the leading `{...}` (string-aware) and
 * parses it; truncated/invalid JSON degrades to `null`.
 */
function extractErrorBodyJson(msg: string): unknown {
  const start = msg.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < msg.length; i++) {
    const ch = msg[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(msg.slice(start, end));
  } catch {
    return null;
  }
}

/**
 * Context-overflow classification — three independent triggers (opencode
 * parity): an HTTP 413 status, a nested JSON error body carrying
 * `error.code === "context_length_exceeded"`, or an overflow phrase in the
 * message (rate-limit exclusions win over the phrase).
 *
 * @param err The thrown error (used for a `status` fallback when `status` is
 * undefined, mirroring how the transport attaches it).
 */
export function classifyContextOverflow(
  err: unknown,
  status: number | undefined,
  msg: string,
): boolean {
  const effectiveStatus = status ?? (err as { status?: number } | null)?.status;
  if (effectiveStatus === 413) return true;
  const body = extractErrorBodyJson(msg);
  if (
    body !== null &&
    typeof body === "object" &&
    (body as { error?: { code?: unknown } }).error?.code === "context_length_exceeded"
  ) {
    return true;
  }
  return CONTEXT_OVERFLOW_PHRASE_RE.test(msg) && !CONTEXT_OVERFLOW_EXCLUSION_RE.test(msg);
}

/**
 * HTML gateway auth-page detection. Some providers sit behind a gateway that
 * answers 401/403 with an HTML page. The classifier only sees the message (the
 * transport builds `LLM API <status>: <body preview>`), so the practical
 * signal is the HTML markers in the message. A parseable JSON body is never an
 * HTML gateway page.
 */
export function isGatewayHtmlAuthError(
  err: unknown,
  status: number | undefined,
  msg: string,
): boolean {
  const effectiveStatus = status ?? (err as { status?: number } | null)?.status;
  if (effectiveStatus !== 401 && effectiveStatus !== 403) return false;
  if (extractErrorBodyJson(msg) !== null) return false;
  return HTML_GATEWAY_RE.test(msg);
}

/**
 * OpenAI-404 retry quirk, scoped to the explicit provider ids
 * "openai" / "azure" / "openrouter". All other providers (and unknown ids)
 * keep 404 non-retryable.
 */
export function isRetryableOpenAI404(
  status: number | undefined,
  providerId: string | undefined,
): boolean {
  return status === 404 && providerId !== undefined && OPENAI_404_RETRYABLE_PROVIDERS.has(providerId);
}

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
 * Retry a function with exponential backoff + jitter on transient errors:
 * 429, 5xx, network, context-overflow, and (for the OpenAI-family provider
 * ids) 404. All other errors — including non-429 4xx, HTML gateway auth
 * pages, and aborts — propagate immediately.
 *
 * The error message is inspected (case-insensitive) for retry signals — this
 * works across providers because HTTP error messages consistently include the
 * status code or canonical text ("429", "Too many requests", "500", "fetch",
 * "network", "ECONN", "timeout", "context length", "too many tokens").
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
 * @param providerId Optional provider id scoping the OpenAI-404 quirk
 * ("openai"/"azure"/"openrouter" treat a 404 as retryable). When
 * omitted, a 404 is never retried. The HTTP transport does not
 * pass it today; wire it from the calling layer when the provider
 * is known.
 */
function classifyError(
  err: Error,
  status: number | undefined,
  msg: string,
): {
  is429: boolean;
  is5xx: boolean;
  isNetwork: boolean;
  isContextOverflow: boolean;
  isGatewayAuth: boolean;
} {
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
    status === undefined && !statusKnownNonRetryable && NETWORK_RE.test(msg);
  // An HTML gateway auth page is never context overflow — a gateway page that
  // happens to mention "too many tokens" must not be retried as an overflow.
  const isGatewayAuth = isGatewayHtmlAuthError(err, status, msg);
  const isContextOverflow = !isGatewayAuth && classifyContextOverflow(err, status, msg);
  return { is429, is5xx, isNetwork, isContextOverflow, isGatewayAuth };
}

export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  runId?: string,
  providerId?: string
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
      const { is429, is5xx, isNetwork, isContextOverflow } = classifyError(err, status, msg);
      const retryable =
        is429 ||
        is5xx ||
        isContextOverflow ||
        (isNetwork && !signal?.aborted) ||
        isRetryableOpenAI404(status, providerId);
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
