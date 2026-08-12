/**
 * Shared URL redaction for error messages and logs.
 *
 * Strips userinfo (`user:pass@`) and optionally query/fragment from a URL
 * string before embedding into error output.
 */

/**
 * Redact credentials from a URL, optionally stripping query/fragment.
 *
 * Anchors the userinfo strip to the authority component: `[^/]*` cannot
 * cross the first `/`, and is greedy up to the LAST `@` before it, so a
 * multi-`@` password (`user:pa@ss@host`) is fully stripped while a
 * legitimate `@` inside the path (e.g. `…/@user/repo`) is preserved.
 *
 * @param stripQuery When true (default), removes `?…` and `#…` entirely.
 *   When false, replaces the query with `[redacted-query]` so log lines
 *   preserve the fact that a query existed without leaking its contents.
 */
export function redactUrl(u: string, stripQuery = true): string {
  const stripped = u.replace(/\/\/[^/]*@/, "//");
  if (stripQuery) return stripped.replace(/[?#].*$/, "");
  return stripped.replace(/[?#].*$/, "[redacted-query]");
}

/** C0 control chars plus CR/LF/tab — neutralized before page-derived text
 * enters any console/event message (CWE-117: a hostile page must not be able
 * to forge log entries or inject control text into the panel). */
const LOG_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r\n\t]/g;

/**
 * Shared log sanitizer: strip CR/LF/tab and control characters from
 * page-derived text before it is embedded in any console/event message.
 * Prevents newline forgery of log lines and terminal/panel control injection.
 */
export function sanitizeForLog(text: string): string {
  return text.replace(LOG_CONTROL_CHARS_RE, " ");
}
