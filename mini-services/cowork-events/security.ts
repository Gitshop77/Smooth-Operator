// Pure, dependency-light security helpers for the cowork-events mini-service.
//
// These helpers are split out of `index.ts` so they can be unit-tested in
// isolation by the root vitest config (`tests/cowork-events.test.ts`) without
// dragging in the socket.io / z-ai-web-dev-sdk runtime, which is only
// installed under `mini-services/cowork-events/node_modules/`.
//
// Everything in this file is a pure function with no module-level state and no
// I/O — given the same inputs, it always returns the same output and never
// throws (the security-sensitive helpers return `false` on bad input instead
// of leaking information via an exception).

import { timingSafeEqual } from 'node:crypto';

/**
 * The well-known dev-only shared secret. Used as the default when
 * `COWORK_EVENT_TOKEN` is unset. The mini-service refuses to start in
 * production with this value (see {@link shouldRefuseStart}).
 */
export const DEV_TOKEN = 'dev-token';

// ---------------------------------------------------------------------------
// Constant-time token comparison
// ---------------------------------------------------------------------------
//
// `crypto.timingSafeEqual` throws RangeError when the input lengths differ,
// which would leak the expected token's length via the error path. This
// helper returns `false` (never throws) on length mismatch.

/**
 * Compare a received token against the expected shared secret in constant
 * time. Returns `false` (never throws) when:
 * - `received` is `undefined` or not a string
 * - `received` is the empty string
 * - the byte-wise comparison fails
 *
 * Length handling: never throws on length mismatch (which would otherwise leak
 * the expected token's length via an exception). We compare over the EXPECTED
 * secret's length only — never over the attacker-controlled input length — so
 * the comparison cost cannot scale with the guessed token and cannot reveal the
 * secret's byte length. A longer `received` is simply ignored beyond
 * `expected.length` (it can never equal the secret). `crypto.timingSafeEqual`
 * therefore always executes the same number of iterations regardless of the
 * input and never throws `RangeError`. The `false` for a genuine length mismatch
 * is computed AFTER the timing-safe compare, so it does not leak whether the
 * lengths matched.
 *
 * @param received The token presented by the caller (e.g. from the
 * `X-Cowork-Token` HTTP header or `socket.handshake.auth.token`).
 * @param expected The configured shared secret.
 */
export function tokenMatches(
  received: string | undefined,
  expected: string,
): boolean {
  if (typeof received !== 'string' || received.length === 0) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
 // Compare over the EXPECTED secret's length only — never over the
 // attacker-controlled input length — so the comparison cost cannot leak the
 // secret's byte length. Pad `received` to `b.length`; if `received` is longer
 // it is truncated (it can never equal `expected` anyway).
  const len = b.length;
  const aPadded = Buffer.alloc(len); // zero-filled
  const bPadded = Buffer.alloc(len); // zero-filled
  a.copy(aPadded, 0, 0, Math.min(a.length, len));
  b.copy(bPadded);
 // Never throws (equal-length buffers). The length mismatch is folded into
 // the final boolean AFTER the timing-safe compare, so it does not create a
 // timing side-channel.
  const equal = timingSafeEqual(aPadded, bPadded);
  return equal && a.length === b.length;
}

// ---------------------------------------------------------------------------
// CORS allowlist application
// ---------------------------------------------------------------------------

/**
 * Apply the configured CORS allowlist to an outgoing HTTP response.
 *
 * If `origin` matches `allowedOrigin`, mirror it back as
 * `Access-Control-Allow-Origin` and add a `Vary: Origin` header (so CDN/browser
 * caches don't accidentally serve an allowlisted response to a non-allowlisted
 * origin). Otherwise set nothing — the browser will block the response from
 * being read by the cross-origin caller.
 *
 * The `res` parameter is typed structurally (any object with a `setHeader`
 * method) so this function can be unit-tested with a minimal mock instead of
 * a real Node.js `ServerResponse`.
 *
 * @returns `true` if the origin was allowlisted (headers were set), `false`
 * otherwise. The caller can use this to make preflight decisions
 * consistently.
 */
export function applyCorsHeaders(
  res: { setHeader: (name: string, value: string) => unknown },
  origin: string | null | undefined,
  allowedOrigin: string,
): boolean {
  if (origin && origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Production dev-token refusal
// ---------------------------------------------------------------------------

/**
 * Decide whether the mini-service should refuse to start.
 *
 * The well-known default `DEV_TOKEN` ("dev-token") is only acceptable with an
 * EXPLICIT opt-in (`COWORK_ALLOW_DEV_TOKEN=1`) — AND only when not running in
 * production (`nodeEnv !== 'production'`). This adds a second, fail-closed
 * layer: even if an operator mistakenly sets the opt-in in a production
 * deployment, the publicly-documented dev-token still refuses to start, so the
 * service can never run unauthenticated in production via this flag.
 *
 * `nodeEnv` is now a meaningful input (defense-in-depth): the dev-token opt-in
 * is ignored when `nodeEnv === 'production'`. The deployment is still expected
 * to set a real secret (`COWORK_EVENT_TOKEN`) in production; this guard is an
 * additional backstop, not a replacement for a real secret.
 *
 * This is split out as a pure function so the policy can be unit-tested
 * without spawning the service or manipulating `process.env` (the opt-in
 * defaults to reading `process.env.COWORK_ALLOW_DEV_TOKEN`, but can be
 * injected for tests).
 */
export function shouldRefuseStart(
  nodeEnv: string | undefined,
  sharedSecret: string,
  allowDevToken: boolean = process.env.COWORK_ALLOW_DEV_TOKEN === '1',
): boolean {
  if (sharedSecret !== DEV_TOKEN) return false;
 // Honor the dev-token opt-in ONLY outside production. In production the
 // well-known default must always fail closed, even if the opt-in is set.
 // Make the production determination explicit/fail-closed: only the exact
 // string `'production'` counts as production — but see the warning below
 // about ambiguous NODE_ENV values. Anything else (unset, 'development',
 // 'staging', …) is treated as non-production and may honor the opt-in.
 // Normalize (trim + lowercase) before comparing so that whitespace/case
 // variance in NODE_ENV (e.g. " Production ", "PRODUCTION") is still treated
 // as production and cannot fail open into honoring the dev-token opt-in.
  const isProduction = nodeEnv?.trim().toLowerCase() === 'production';
  if (allowDevToken && !isProduction) return false;
  return true;
}

// ---------------------------------------------------------------------------
// chat:join room-scoping
// ---------------------------------------------------------------------------
//
// Decides whether a socket may join the chat room named after `sessionId`.
//
// Scoping model:
// • `sessionId` MUST be a non-empty string matching a strict charset
// (alphanumerics, underscore, hyphen), max 128 chars. Anything else is
// rejected — this defeats injection / abuse of arbitrary room names.
// • If the connection authenticated with a specific `authorizedSessionId`
// (echoed from the handshake auth payload), the socket may ONLY join that
// exact session's room (strict ownership). Attempts to join any other
// session are rejected.
// • If the connection did NOT authenticate with a sessionId (legacy clients
// that only present the shared token — e.g. the current cockpit), the join
// is allowed but flagged `permissive-legacy` so the caller can log a
// warning. This preserves backward compatibility for the single-trusted-
// user loopback deployment while closing the cross-session read for
// clients that DO present a scoped sessionId.
//
// The full per-session-HMAC ownership model (so a hostile client can't simply
// omit the scoped sessionId) is tracked as future work — the current
// deployment assumes a single trusted user on loopback.

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ChatJoinDecision =
  | { allowed: false; reason: 'invalid-session-id' | 'not-authorized-for-session' }
  | { allowed: true; reason: 'ok' | 'permissive-legacy' };

/**
 * Pure decision helper for the socket.io `chat:join` handler. See the model
 * described above. `authorizedSessionId` is the sessionId captured from the
 * connection's handshake auth payload (`socket.data.authorizedSessionId`);
 * pass `undefined` for legacy clients.
 */
export function evaluateChatJoin(
  authorizedSessionId: string | undefined,
  sessionId: unknown,
): ChatJoinDecision {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return { allowed: false, reason: 'invalid-session-id' };
  }
  if (authorizedSessionId !== undefined) {
    if (sessionId === authorizedSessionId) {
      return { allowed: true, reason: 'ok' };
    }
    return { allowed: false, reason: 'not-authorized-for-session' };
  }
  return { allowed: true, reason: 'permissive-legacy' };
}
