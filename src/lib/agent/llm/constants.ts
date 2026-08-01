/**
 * Shared constants for LLM retry and transport.
 *
 * Single source of truth for `MAX_RETRY_AFTER_MS` — both the transport
 * (which caps the `Retry-After` header before attaching it to errors) and the
 * retry helper (which caps it again when consuming) must agree on the same
 * ceiling so a future maintainer cannot accidentally widen the stall window.
 */

/**
 * Ceiling (ms) for a `Retry-After` header so a hostile/buggy 429 can't freeze
 * the run. 30 seconds is long enough for legitimate transient backoffs while
 * capping the worst-case freeze from a malicious Retry-After header.
 */
export const MAX_RETRY_AFTER_MS = 30_000;
