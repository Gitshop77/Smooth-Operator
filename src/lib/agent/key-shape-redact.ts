/**
 * Key-shape secret redaction — masks well-known credential formats that may
 * appear in page-derived content (raw API keys, JWTs, bearer tokens, DB
 * connection URLs).
 *
 * This is ADDITIVE to the stored-secret redactor in `secrets.ts`. That one only
 * masks secrets the user explicitly registered in the vault (by value). This one
 * masks credentials by *shape* regardless of whether they were stored — a real
 * key rendered in the DOM (dev dashboards, token-preview pages, config screens)
 * would otherwise reach the LLM provider verbatim.
 *
 * Patterns are intentionally conservative (well-known key formats) to avoid
 * wiping legitimate extracted data (prices, ids, etc.). Every quantifier is
 * bounded (no nested/overlapping quantifiers) so none of these can cause ReDoS.
 *
 * Fails CLOSED: a throw during redaction masks the whole input rather than
 * returning the original credential-bearing text.
 */

/** Secret-detection patterns, compiled once at module scope (hot path). */
const SECRET_SK_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const SECRET_AKIA_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const SECRET_XOX_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi;
const SECRET_AIZA_RE = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const SECRET_GSK_RE = /\bgsk-[A-Za-z0-9]{20,}\b/gi;
const SECRET_GHP_RE = /\bghp_[A-Za-z0-9]{36}\b/g;
const SECRET_GLPAT_RE = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const SECRET_DBURL_RE =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^\s:@/]*)(?::([^\s]*))?@([^\s:@/]+)(?::\d+)?(?:\/([^\s]*))?/gi;
const SECRET_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi;
const SECRET_JWT_RE =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** Combined key-shape alternation — single full-text pass. */
const SECRET_COMBINED_RE = new RegExp(
  `(?:${SECRET_SK_RE.source}|${SECRET_AKIA_RE.source}|${SECRET_XOX_RE.source}|${SECRET_AIZA_RE.source}|${SECRET_GSK_RE.source}|${SECRET_GHP_RE.source}|${SECRET_GLPAT_RE.source}|${SECRET_DBURL_RE.source}|${SECRET_JWT_RE.source})`,
  "gi",
);

/** Marker substituted for a key-shape credential. */
const KEY_SHAPE_MASK = "[redacted]";
/** Marker substituted for the credential half of a `Bearer` token. */
const KEY_SHAPE_BEARER_MASK = "Bearer [redacted]";
/** Marker substituted for text whose key-shape redaction threw. */
const KEY_SHAPE_FAILED = "[REDACTED: key-shape redaction failed]";

/**
 * Mask well-known credential shapes in a string. Synchronous and pure; never
 * throws (any internal error degrades to a fully-masked string rather than
 * leaking the original input).
 */
export function redactKeyShapes(text: string): string {
  try {
    return text
      .replace(SECRET_COMBINED_RE, KEY_SHAPE_MASK)
      .replace(SECRET_BEARER_RE, KEY_SHAPE_BEARER_MASK);
  } catch {
    return KEY_SHAPE_FAILED;
  }
}
