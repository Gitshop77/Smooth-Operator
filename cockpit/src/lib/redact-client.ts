/**
 * Client-safe secret redactor for cockpit browser surfaces.
 *
 * This is a deliberate, client-safe MIRROR of the server-side `redactSecrets`
 * (in `@/lib/cowork/api/http`) — the canonical implementation lives there, and
 * this file MUST stay byte-for-byte aligned with it on every regex so the two
 * redactors produce identical output (proven in `redact-client.test.ts`).
 *
 * WHY THIS CANNOT SIMPLY RE-EXPORT `redactSecrets` FROM `@/lib/cowork/api/http`:
 * that module is a server-only module. Its top-level import `node:crypto`
 * (`createHash`, used by `tokenPrincipal`) is a Node builtin unavailable in the
 * browser, and `redactSecrets` itself reads `process.env.COWORK_EVENT_TOKEN` /
 * `COWORK_UI_TOKEN` to mask the configured service/UI secrets. Bundling
 * `http.ts` into a client component would pull `node:crypto` into the browser
 * bundle and break the cockpit client build. Hence this faithful, standalone
 * copy — its masking rules are kept in lock-step with `redactSecrets` by the
 * parity test.
 *
 * It covers the same secret shapes: URL credentials, key=value secrets,
 * JSON-shaped secrets (preserving a `Bearer `/`Basic ` scheme prefix),
 * Bearer / Basic credentials, well-known provider key literals, and a bounded
 * additive fallback for bare high-entropy scalars. The one intentional
 * difference from the server guard is that it cannot mask the configured
 * COWORK_* token values (no `process.env` in the browser); the parity corpus
 * uses no such token, so outputs still match.
 */
export function redactClientSecrets(text: string): string {
  let out = text;
  // Credentials in URLs: scheme://user:pass@host -> scheme://***@host. Covers
  // any scheme (postgres://, mysql://, redis://, …), not just http(s).
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, "$1***@");
  // Secret-bearing key=value pairs in URLs / bodies / headers.
  out = out.replace(
    /(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation|private[_-]?key|passphrase|cvv|otp|ssn|pin)=[^&\s"'<>]+/gi,
    "$1=***",
  );
  // JSON-shaped secrets: `"password": "secret"` / `"api_key": "..."`. The value
  // matcher is quote-aware. A value shaped like `Bearer <token>` / `Basic <b64>`
  // keeps its scheme word so the redacted form (`"Bearer ***"`) still signals
  // the auth scheme without leaking the secret — mirroring the server guard.
  out = out.replace(
    /"(password|passwd|token|secret|api[_-]?key|access[_-]?token|authorization|authorisation|private[_-]?key|passphrase|cvv|otp|ssn|pin)"\s*:\s*"([^"]*)"/gi,
    (_m, key: string, val: string) => {
      const scheme = /^(Bearer|Basic)\s+[A-Za-z0-9._-]+$/i.exec(val);
      const inner = scheme ? `${scheme[1].trim()} ***` : "***";
      return `"${key}":"${inner}"`;
    },
  );
  // Bearer tokens.
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***");
  // HTTP Basic credentials: `Authorization: Basic <base64>`.
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic ***");
  // Well-known standalone credential literals that appear in logs without a
  // key=/Bearer prefix: Groq (gsk-), Slack (xox[baprs]-), AWS (AKIA…),
  // OpenAI/Anthropic keys, Google API keys, JWTs, GitHub/GitLab tokens. The
  // `\b` anchors keep a 35/36-char literal from matching 35 chars and leaving a
  // trailing char that the additive fallback would then miss.
  out = out.replace(
    /\b(gsk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20})\b/g,
    "***",
  );
  // Additive, bounded fallback for bare high-entropy scalars (no key=/Bearer/
  // provider-literal prefix) that would otherwise reach server error logs
  // unredacted — the EchoLeak-class gap. The alphabet deliberately EXCLUDES
  // `/` so a benign URL path such as `3000/api/cowork/tabs` is never mistaken
  // for a secret (matches the canonical `redactSecrets`). The trailing
  // `(?!"\s*:)` negative lookahead mirrors `redactSecrets` exactly: it prevents
  // a long JSON key name (e.g. `"aVeryLongKeyName":`) from being mistaken for a
  // bare secret value, keeping the two redactors byte-identical.
  out = out.replace(
    /(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{20,}(?![A-Za-z0-9+_-])(?!"\s*:)/g,
    "***",
  );
  return out;
}
