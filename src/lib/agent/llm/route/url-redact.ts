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
