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
 * ZERO-CONFIG policy (lets the cockpit connect with no env setup at all, since
 * the cockpit also defaults its token to `DEV_TOKEN`):
 *
 *  • A REAL secret (anything other than `DEV_TOKEN`) is always acceptable — the
 *    service boots. (A misconfigured/invalid real secret is a deploy concern,
 *    not a startup-refusal concern; the token-compare path stays fail-closed.)
 *  • The default `DEV_TOKEN` is accepted in ANY non-production environment
 *    (development, dev, local, test, staging, an unset/ambiguous NODE_ENV,
 *    etc.) WITHOUT requiring the `COWORK_ALLOW_DEV_TOKEN` opt-in. This is the
 *    zero-config happy path.
 *  • PRODUCTION stays strict: `NODE_ENV === 'production'` refuses the
 *    well-known dev-token and fails closed — even if `COWORK_ALLOW_DEV_TOKEN=1`
 *    is set — because the public default must never authenticate in prod.
 *
 * `nodeEnv` is normalized (trim + lowercase) so whitespace/case variance can't
 * fail open. `COWORK_ALLOW_DEV_TOKEN=1` is still honored if present (it was the
 * previous opt-in) but is no longer required for the non-prod default-token
 * path. The opt-in is injectable for tests.
 */
export function shouldRefuseStart(
  nodeEnv: string | undefined,
  sharedSecret: string,
  allowDevToken: boolean = process.env.COWORK_ALLOW_DEV_TOKEN === '1',
): boolean {
  // A real (non-default) secret is always acceptable — boot.
  if (sharedSecret !== DEV_TOKEN) return false;

  const env = (nodeEnv ?? "").trim().toLowerCase();
  // Production is always strict: the well-known dev-token must never
  // authenticate in prod, even with the opt-in (a real auth hole otherwise).
  if (env === 'production') return true;

  // Zero-config path: in any NON-production environment the default dev-token
  // is accepted WITHOUT requiring COWORK_ALLOW_DEV_TOKEN, so the cockpit can
  // connect with no env setup. `allowDevToken` is still honored but inert here.
  void allowDevToken;
  return false;
}

// Decides whether a socket may join the chat room named after `sessionId`:
// • `sessionId` must match a strict charset (alphanumerics, underscore, hyphen),
//   1-128 chars — defeats arbitrary room-name abuse.
// • A connection with a scoped `authorizedSessionId` (from the handshake auth
//   payload) may ONLY join that exact session's room (strict ownership).
// • A connection WITHOUT one is rejected (fail-closed) — it may not join any
//   room. Cross-session chat leakage is therefore not reachable even if the
//   shared token leaks. Per-session-HMAC ownership remains future work; until
//   then, scope via the handshake `auth.sessionId`.

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ChatJoinDecision =
  | { allowed: false; reason: 'invalid-session-id' | 'not-authorized-for-session' | 'no-scoped-session-id' }
  | { allowed: true; reason: 'ok' };

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
  // A socket may only join the chat room for the session it proved ownership of
  // at handshake time (`auth.sessionId`). A connection that presented no scoped
  // sessionId is rejected (fail-closed) rather than permitted to join any room,
  // so cross-session chat leakage is no longer reachable. Clients that need a
  // session's chat stream must connect with a scoped `auth.sessionId`.
  if (authorizedSessionId === undefined) {
    return { allowed: false, reason: 'no-scoped-session-id' };
  }
  if (sessionId === authorizedSessionId) {
    return { allowed: true, reason: 'ok' };
  }
  return { allowed: false, reason: 'not-authorized-for-session' };
}
