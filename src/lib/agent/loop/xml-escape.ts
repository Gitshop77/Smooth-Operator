/**
 * XML-escape untrusted text. Escapes `&`, `<`, `>` always, and `"` in
 * attribute context (`attr = true`). A single-pass helper keeps the attribute
 * and text variants from drifting apart.
 */
export function escapeXml(s: string, attr = false): string {
  let out = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (attr) out = out.replace(/"/g, "&quot;");
  return out;
}
