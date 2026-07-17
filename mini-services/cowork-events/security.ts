// Pure, dependency-light security helpers for the cowork-events mini-service.
// Split out of `index.ts` so the root vitest config can unit-test them without
// pulling in the socket.io / z-ai-web-dev-sdk runtime. Every function is pure
// with no module-level state or I/O; the security-sensitive ones return `false`
// on bad input rather than throwing.

import { timingSafeEqual } from 'node:crypto';

/**
 * The well-known dev-only shared secret, used as the default when
 * `COWORK_EVENT_TOKEN` is unset. The service refuses to start in production with
 * this value (see {@link shouldRefuseStart}).
 */
export const DEV_TOKEN = 'dev-token';

/**
 * Compare a received token against the expected shared secret in constant time.
 * Returns `false` (never throws) when `received` is not a string, is empty, or
 * the comparison fails.
 *
 * The compare runs over the EXPECTED secret's length only — never the
 * attacker-controlled input length — so the cost cannot leak the secret's byte
 * length, and `timingSafeEqual` never throws `RangeError`. The length-mismatch
 * result is folded in AFTER the timing-safe compare, so it creates no side
 * channel.
 */
export function tokenMatches(
  received: string | undefined,
  expected: string,
): boolean {
  if (typeof received !== 'string' || received.length === 0) return false;
  // Fail-closed length cap (independent of `expected`, so it adds no length
  // side-channel) to bound per-attempt allocation cost.
  const MAX_TOKEN_LEN = 4096;
  if (received.length > MAX_TOKEN_LEN) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const len = b.length;
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded, 0, 0, Math.min(a.length, len));
  b.copy(bPadded);
  const equal = timingSafeEqual(aPadded, bPadded);
  return equal && a.length === b.length;
}

/**
 * Apply the configured CORS allowlist to an outgoing HTTP response.
 *
 * If `origin` matches `allowedOrigin`, mirror it back as
 * `Access-Control-Allow-Origin` and add `Vary: Origin` (so caches don't serve
 * an allowlisted response to a non-allowlisted origin). Otherwise set nothing.
 *
 * @returns `true` if the origin was allowlisted (headers were set).
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

/**
 * Decide whether the mini-service should refuse to start.
 *
 * The default `DEV_TOKEN` is only acceptable with an explicit opt-in
 * (`COWORK_ALLOW_DEV_TOKEN=1`) AND outside production — even if an operator sets
 * the opt-in in production, the dev-token still fails closed. `nodeEnv` is
 * normalized (trim + lowercase) so whitespace/case variance can't fail open.
 * The opt-in is injectable for tests.
 */
export function shouldRefuseStart(
  nodeEnv: string | undefined,
  sharedSecret: string,
  allowDevToken: boolean = process.env.COWORK_ALLOW_DEV_TOKEN === '1',
): boolean {
  if (sharedSecret !== DEV_TOKEN) return false;
  const isProduction = nodeEnv?.trim().toLowerCase() === 'production';
  if (allowDevToken && !isProduction) return false;
  return true;
}

// Decides whether a socket may join the chat room named after `sessionId`:
// • `sessionId` must match a strict charset (alphanumerics, underscore, hyphen),
//   1-128 chars — defeats arbitrary room-name abuse.
// • A connection with a scoped `authorizedSessionId` (from the handshake auth
//   payload) may ONLY join that exact session's room (strict ownership).
// • A connection without one (legacy clients presenting only the shared token,
//   e.g. the current cockpit) may join any room, flagged `permissive-legacy`.
//   Per-session-HMAC ownership is future work; the deployment assumes a single
//   trusted user on loopback.

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ChatJoinDecision =
  | { allowed: false; reason: 'invalid-session-id' | 'not-authorized-for-session' }
  | { allowed: true; reason: 'ok' | 'permissive-legacy' };

/**
 * Pure decision helper for the socket.io `chat:join` handler.
 * `authorizedSessionId` is captured from the connection's handshake auth
 * payload (`socket.data.authorizedSessionId`); pass `undefined` for legacy
 * clients.
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
