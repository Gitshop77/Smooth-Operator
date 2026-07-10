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
export function directText(el: HTMLElement): string {
  let text = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent || "";
  }
  return text.replace(/\s+/g, " ").trim();
}
