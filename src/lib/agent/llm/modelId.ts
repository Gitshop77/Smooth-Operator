/**
 * Safe model-id → URL-path encoding.
 *
 * Several providers embed the model id directly in the request URL path
 * (Gemini: `/models/{model}:streamGenerateContent`; Azure:
 * `/openai/deployments/{model}/chat/completions`). A model id interpolated
 * raw into that path lets a malicious or garbage id inject path separators,
 * query characters, or other URL metacharacters — silently rewriting the
 * request endpoint.
 *
 * `encodeURIComponent` keeps normal ids identical (alphanumerics, `.` and `-`
 * are left untouched) but neutralizes any injection. We additionally validate
 * the RAW id against `[\w.:-]+` and throw on invalid input, so a clearly
 * malformed id fails fast instead of producing a subtly-wrong URL.
 */

/** Allowed characters in a model id (letters, digits, `_`, `.`, `:`, `-`). */
const MODEL_ID_RE = /^[\w.:-]+$/;

/**
 * Encode a model id for safe embedding in a request URL path.
 *
 * @throws if the raw id contains characters outside `[\w.:-]+` (a malformed
 * or potentially-hostile model id).
 */
export function encodeModelIdForUrl(model: string): string {
  if (
    typeof model !== "string" ||
    model === "." ||
    model === ".." ||
    model.includes("..") ||
    !MODEL_ID_RE.test(model)
  ) {
    throw new Error(
      `Invalid model id "${model}": model ids may only contain letters, digits, ` +
        `'_', '.', ':' and '-'.`
    );
  }
  return encodeURIComponent(model);
}
