/**
 * Low-level CSS selector utilities shared by the {@link By} locator factories
 * and the {@link findByLocator} resolver.
 */

/** Upper bound on a locator value (CSS selector or XPath expression) length. */
export const MAX_LOCATOR_VALUE_LENGTH = 8192;

/** Upper bound on nodes returned by a single locator resolution (anti-DoS cap). */
export const MAX_NODES = 100_000;

/**
 * Strict CSSOM-identifier escaper. Escapes a string so it can be safely
 * embedded inside a CSS attribute selector (`[id="…"]`, `[name="…"]`) or a
 * class-name fragment (`.foo`). Mirrors the CSSOM `escape(...)` algorithm
 * used by the source `By.id` / `By.name` / `By.className` factories.
 *
 * Falls back to the platform `CSS.escape` when available (all modern
 * browsers + jsdom) — the hand-rolled loop covers the rare environments
 * where `CSS.escape` is missing.
 *
 * This utility never throws on input content (including NUL bytes): NUL is
 * replaced with U+FFFD, matching `CSS.escape`. This keeps the factories and
 * the {@link findByLocator} resolver consistent — the same input produces the
 * same (non-throwing) result whether `escapeCss` runs at construction time or
 * inside the resolver's try/catch.
 */
export function escapeCss(css: string): string {
  if (typeof css !== "string") {
    throw new TypeError("escapeCss: input must be a string");
  }
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(css);
  }
  const out: string[] = [];
  const n = css.length;
  for (let i = 0; i < n; i++) {
    const c = css.charCodeAt(i);
    if (c === 0x0) {
      out.push("\uFFFD");
      continue;
    }
    if (
      (c >= 0x0001 && c <= 0x001f) ||
      c === 0x007f ||
      (i === 0 && c >= 0x0030 && c <= 0x0039) ||
      (i === 1 && c >= 0x0030 && c <= 0x0039 && css.charCodeAt(0) === 0x002d)
    ) {
      out.push("\\" + c.toString(16) + " ");
      continue;
    }
    if (i === 0 && c === 0x002d && n === 1) {
      out.push("\\" + css.charAt(i));
      continue;
    }
    if (
      c >= 0x0080 ||
      c === 0x002d ||
      c === 0x005f ||
      (c >= 0x0030 && c <= 0x0039) ||
      (c >= 0x0041 && c <= 0x005a) ||
      (c >= 0x0061 && c <= 0x007a)
    ) {
      out.push(css.charAt(i));
      continue;
    }
    out.push("\\" + css.charAt(i));
  }
  return out.join("");
}
