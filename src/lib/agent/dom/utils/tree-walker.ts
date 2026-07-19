/**
 * Tree-walker text helpers — direct-text extraction used by the indexed
 * DOM-tree extractor ({@link ../extraction/page-state}) and the AX-tree
 * builder ({@link ../extraction/ax-tree-builder}).
 *
 * Extracted from `dom/dom-utils.ts` so both extractors share a single
 * canonical definition (the two had drifted before unification).
 */

/**
 * Concatenate the direct text-node children of an element, collapsing
 * internal whitespace runs to a single space and trimming.
 *
 * Canonical version — the historical `extractor.ts` definition (which
 * collapsed whitespace) is used as-is. The historical `ax-tree.ts` version
 * only trimmed; switching it to the collapsing variant is a no-op in
 * practice because every `ax-tree.ts` caller either feeds the result to
 * `getName` (which collapses whitespace again before emitting the line) or
 * compares against a min-length threshold after a trim.
 */
/**
 * Strip C0/C1 control characters (everything except the common whitespace
 * tab/LF/CR) from a string. Page-controlled DOM text/attributes are
 * serialized verbatim into the LLM prompt; control characters (NUL, DEL, ESC,
 * …) can smuggle delimiter-breaking or otherwise injection-prone content into
 * that prompt. We strip them here, at the extraction boundary, so no
 * downstream serialization step has to remember to.
 */
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHAR_RE, "");
}

/**
 * Mark a piece of page-controlled DOM content as untrusted before it is
 * embedded in the LLM prompt. Strips control characters and wraps the value
 * in explicit XML markers so the model is told (and can be instructed) that
 * the enclosed text is attacker-influenceable page content, not instructions.
 */
export function sanitizeDomText(s: string): string {
  return `<untrusted_dom>${stripControlChars(s)}</untrusted_dom>`;
}

export function directText(el: Element): string {
  const parts: string[] = [];
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.nodeValue ?? "");
  }
  return stripControlChars(parts.join("").replace(/\s+/g, " ").trim());
}
