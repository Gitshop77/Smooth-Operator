/**
 * Validate a `file_name` the LLM supplied for a `screenshot` / `save_as_pdf`
 * action before it is forwarded to the background SW. This is defense-in-depth
 * at the egress boundary: the SW itself re-sanitizes on receipt (coercing to a
 * string, collapsing `..` segments, stripping non-`[\w.-]` characters and
 * truncating — see message-routing.ts). We reject only path-traversal /
 * separator attempts here so the agent receives a clear error rather than a file
 * silently renamed by the sanitizer.
 *
 * Returns `null` when the value is safe to forward (including `undefined` /
 * `null`, in which case the SW falls back to a title-derived default name), or
 * a human-readable reason string when it must be rejected.
 */
export function validateFileName(fileName: unknown): string | null {
  if (fileName === undefined || fileName === null) return null;
  if (typeof fileName !== "string" || fileName.length === 0) {
    return "file_name must be a non-empty string";
  }
  if (/[\x00-\x1f\x7f]/.test(fileName)) {
    return "file_name contains invalid control characters";
  }
  if (/[\\/]/.test(fileName) || fileName.includes("..")) {
    return "file_name must be a bare filename (no path separators or '..')";
  }
  return null;
}
