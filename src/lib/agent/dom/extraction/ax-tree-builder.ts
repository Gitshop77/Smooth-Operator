/**
 * Accessibility-tree extraction — produces a semantic, token-cheap view of the
 * page by ARIA role + accessible name. This is more stable across React
 * re-renders than raw DOM indexes and lets the LLM navigate by meaning.
 *
 * Elements are identified by `ref_NNN` identifiers backed by `WeakRef`s so GC'd
 * or removed elements don't leak the page-level element map. A reverse
 * `WeakMap<HTMLElement, string>` dedupes refs across calls.
 *
 * SECURITY: the element-ref map, reverse map, and ref counter are kept in
 * module-scoped variables (NOT on `window`). Content scripts share the same
 * `window` object as the page (only the JS execution context differs), so any
 * page could read or overwrite a `window.__openCoworkElementMap` entry and
 * hijack the element an action resolves to. Because the action executor and
 * this extractor share the same module instance in the isolated world, no
 * `window` handle is needed for cross-module access.
 *
 * Shared DOM classification helpers (`isInteractive`, `isVisible`,
 * `directText`, `SKIP_TAGS`) live in {@link ../utils} (extracted from the
 * historical `dom/dom-utils.ts`) and are shared with the indexed-tree
 * extractor ({@link ./page-state}) so the two trees classify elements
 * consistently.
 */

import {
  isInteractive,
  isVisibleFull as isVisible,
  isLikelyHidden,
  directText,
  SKIP_TAGS,
  isSensitive,
} from "../utils";

/**
 * Module-scoped element-ref registry.
 *
 * Kept off `window` (see SECURITY note at the top of this file) so a hostile
 * page cannot read or overwrite an entry to hijack an action's target element.
 * The action executor and this extractor share the same module instance in the
 * content-script isolated world, which is sufficient for cross-module access.
 */
let elementMap: Record<string, WeakRef<HTMLElement>> | null = null;
let elementReverseMap: WeakMap<HTMLElement, string> | null = null;
let refCounter = 0;

/** Result of {@link generateAccessibilityTree}. */
export interface AXTreeResult {
  /** The serialized accessibility tree (one element per line). */
  pageContent: string;
  /** Current viewport dimensions (sent to the LLM for context). */
  viewport: { width: number; height: number };
  /** Optional error message (e.g. unknown ref, output truncated). */
  error?: string;
}

/**
 * Initialize the element-ref registry. Safe to call multiple times — only
 * initializes once per page load.
 */
export function initElementMap(): void {
  if (!elementMap) {
    elementMap = {};
    elementReverseMap = new WeakMap();
    refCounter = 0;
  }
}

/**
 * Resolve a `ref_NNN` identifier back to its live `HTMLElement`. Returns
 * `null` if the element was GC'd or removed (the dead ref is cleaned up).
 */
export function resolveRef(refId: string): HTMLElement | null {
  const map = elementMap;
  if (!map) return null;
  const ref = map[refId];
  if (!ref) return null;
  const el = ref.deref();
  if (!el) {
    // Clean up dead ref.
    delete map[refId];
    return null;
  }
  return el;
}

// ─── Role detection ─────────────────────────────────────────────────────────

/** Implicit ARIA roles for tags that don't need an explicit `role` attribute. */
const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
  h1: "heading", h2: "heading", h3: "heading",
  h4: "heading", h5: "heading", h6: "heading",
  img: "image",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  section: "region",
  article: "article",
  aside: "complementary",
  form: "form",
  table: "table",
  ul: "list", ol: "list",
  li: "listitem",
  label: "label",
};

/** Compute the ARIA role for an element (explicit attribute wins, else implicit). */
function getRole(el: HTMLElement): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const type = el.getAttribute("type");
    if (type === "submit" || type === "button") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file") return "button";
    return "textbox";
  }
  return IMPLICIT_ROLES[tag] || "generic";
}

// ─── Sensitive field detection ──────────────────────────────────────────────
// `isSensitive` + `SENSITIVE_AUTOCOMPLETE` now live in `../utils/classification`
// (shared with `element-info.buildAttrs` so the indexed tree + AX tree redact
// consistently).

// ─── Accessible name extraction ─────────────────────────────────────────────

/** Name max length before truncation (with ellipsis). */
const NAME_MAX_LENGTH = 100;
/** Minimum direct-text length to be considered a useful name. */
const NAME_MIN_TEXT_LENGTH = 3;

/**
 * Compute the accessible name for an element using the standard priority
 * order: aria-label → placeholder → title → alt → associated `<label>` →
 * input value → direct text → heading text. Sensitive values are redacted.
 *
 * The `<label for="id">` lookup uses the pre-built `labelMap`
 * (captured at the start of {@link generateAccessibilityTree}) instead of a
 * per-element `document.querySelector` — was O(N²) on pages with many IDs.
 */
function getName(el: HTMLElement, labelMap: Map<string, HTMLLabelElement>): string {
  const tag = el.tagName.toLowerCase();

  // <select> — get selected option text (or redact if sensitive).
  if (tag === "select") {
    if (isSensitive(el)) {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel?.trim()) return ariaLabel.trim();
      const title = el.getAttribute("title");
      if (title?.trim()) return title.trim();
      if (el.id) {
        const label = labelMap.get(el.id);
        if (label) { const t = directText(label); if (t) return t; }
      }
      return "[value redacted]";
    }
    const select = el as HTMLSelectElement;
    const selected = select.options[select.selectedIndex] || select.querySelector("option[selected]");
    if (selected?.textContent) return selected.textContent.trim();
  }

  // Standard accessible name sources (in priority order).
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const placeholder = el.getAttribute("placeholder");
  if (placeholder?.trim()) return placeholder.trim();

  const title = el.getAttribute("title");
  if (title?.trim()) return title.trim();

  const alt = el.getAttribute("alt");
  if (alt?.trim()) return alt.trim();

  // <label for="id">
  if (el.id) {
    const label = labelMap.get(el.id);
    if (label) { const t = directText(label); if (t) return t; }
  }

  // Input-specific.
  if (tag === "input") {
    const input = el as HTMLInputElement;
    const type = input.getAttribute("type") || "";
    const value = input.getAttribute("value");
    if (type === "submit" && value?.trim()) return value.trim();
    if (isSensitive(el)) return input.value ? "[value redacted]" : "";
    if (input.value && input.value.length < 50 && input.value.trim()) return input.value.trim();
  }

  // Textarea sensitive redaction.
  if (tag === "textarea" && isSensitive(el)) {
    return (el as HTMLTextAreaElement).value ? "[value redacted]" : "";
  }

  // Button/link/summary — direct text.
  if (tag === "button" || tag === "a" || tag === "summary") {
    const t = directText(el);
    if (t) return t;
  }

  // Headings — text content (truncated).
  if (tag.match(/^h[1-6]$/)) {
    const text = el.textContent;
    if (text?.trim()) return text.trim().substring(0, NAME_MAX_LENGTH);
  }

  // Images — no name (alt already checked).
  if (tag === "img") return "";

  // Fallback: direct text content (truncated).
  const text = directText(el);
  if (text.length >= NAME_MIN_TEXT_LENGTH) {
    return text.length > NAME_MAX_LENGTH
      ? text.substring(0, NAME_MAX_LENGTH) + "..."
      : text;
  }

  return "";
}

// ─── Visibility + interactivity checks ──────────────────────────────────────
//
// `isVisible`, `isInteractive`, and `SKIP_TAGS` are imported from `../utils`
// so that the AX tree and the indexed DOM tree (`page-state.ts`) classify
// elements identically. See that module for the rationale (the two had
// drifted before unification). `isVisible` here is `isVisibleFull` aliased —
// the AX-tree path is not as hot as the indexed-tree walk, so we don't bother
// with the `isLikelyHidden` pre-check.

/** Structural tags (headings, landmarks) we include for context even if not interactive. */
const STRUCTURAL_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "nav", "main", "header", "footer", "section", "article", "aside"];

/** Determine whether an element is a structural landmark worth surfacing. */
function isStructural(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  return STRUCTURAL_TAGS.includes(tag) || el.getAttribute("role") !== null;
}

// `SKIP_TAGS` (used below in `shouldInclude`) is imported from ../utils.

/**
 * Decide whether to include an element in the AX tree. Honors the `filter`
 * mode (all vs interactive), visibility, viewport bounds, and the element's
 * role / name significance.
 */
function shouldInclude(el: HTMLElement, filter: string, hasRefId: boolean, labelMap: Map<string, HTMLLabelElement>): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return false;
  // apply visibility + aria-hidden gating even in "all" mode so
  // hidden modals, off-screen duplicates, and aria-hidden decorative elements
  // don't inflate the AX payload with content the user can't see.
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (isLikelyHidden(el)) return false;
  if (filter !== "all" && !isVisible(el)) return false;
  if (filter !== "all" && !hasRefId) {
    // When not extracting a specific subtree, only include viewport-visible els.
    const rect = el.getBoundingClientRect();
    if (!(rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0)) return false;
  }
  if (filter === "interactive") return isInteractive(el);
  if (isInteractive(el)) return true;
  if (isStructural(el)) return true;
  if (getName(el, labelMap).length > 0) return true;
  const role = getRole(el);
  return role !== "generic" && role !== "image";
}

// ─── Tree builder ───────────────────────────────────────────────────────────

/** Hard cap on the number of elements emitted (prevents runaway output). */
const MAX_ELEMENTS = 10_000;
/** Default max tree depth (overridable by the caller). */
const DEFAULT_MAX_DEPTH = 15;

/**
 * Recursively build the accessibility tree under `el`. Appends serialized
 * lines to `lines` and increments `counter.count` for each emitted element.
 */
function buildTree(
  el: HTMLElement,
  depth: number,
  filter: string,
  refId: string | undefined,
  maxDepth: number,
  lines: string[],
  counter: { count: number },
  labelMap: Map<string, HTMLLabelElement>
): void {
  if (counter.count >= MAX_ELEMENTS) return;
  if (depth > maxDepth) return;
  if (!el || !el.tagName) return;

  const included = shouldInclude(el, filter, !!refId, labelMap) || (!!refId && depth === 0);

  if (included) {
    const role = getRole(el);
    const name = getName(el, labelMap)
      .replace(/\s+/g, " ")
      .substring(0, NAME_MAX_LENGTH)
      .replace(/"/g, '\\"');
    const indent = " ".repeat(depth);

    // Get or assign ref ID (with WeakRef + reverse WeakMap for dedup).
    let ref = elementReverseMap!.get(el) || null;
    if (ref) {
      // Verify the ref still points to this element.
      const existing = elementMap![ref];
      if (!existing || existing.deref() !== el) ref = null;
    }
    if (!ref) {
      ref = "ref_" + ++refCounter;
      elementMap![ref] = new WeakRef(el);
      elementReverseMap!.set(el, ref);
    }
    counter.count++;

    // Build the line: `role "name" [ref_N] href="..." type="..." placeholder="..."`
    // LOW-2 fix: escape `"` in href/type/placeholder attribute values (the
    // `name` field was already escaped at line 299, but these three were
    // interpolated raw — a `"` in the value would break the line format).
    let line = indent + role;
    if (name) line += ` "${name}"`;
    line += ` [${ref}]`;
    const href = el.getAttribute("href");
    const type = el.getAttribute("type");
    const placeholder = el.getAttribute("placeholder");
    if (href) line += ` href="${href.replace(/"/g, '\\"')}"`;
    if (type) line += ` type="${type.replace(/"/g, '\\"')}"`;
    if (placeholder) line += ` placeholder="${placeholder.replace(/"/g, '\\"')}"`;
    lines.push(line);

    // For <select> (non-sensitive), emit child <option> elements.
    if (el.tagName.toLowerCase() === "select" && !isSensitive(el)) {
      const select = el as HTMLSelectElement;
      for (const option of Array.from(select.options)) {
        let optLine = " ".repeat(depth + 1) + "option";
        const optText = option.textContent?.trim() || "";
        if (optText) optLine += ` "${optText.replace(/\s+/g, " ").substring(0, NAME_MAX_LENGTH).replace(/"/g, '\\"')}"`;
        if (option.selected) optLine += " (selected)";
        if (option.value && option.value !== optText) optLine += ` value="${option.value.replace(/"/g, '\\"')}"`;
        lines.push(optLine);
      }
    }
  }

  // Recurse into children (skip <option> children of non-sensitive <select> —
  // they were already emitted explicitly above to avoid duplication).
  if (el.tagName.toLowerCase() !== "select"

      && el.children && depth < maxDepth) {
    for (const child of Array.from(el.children)) {
      buildTree(child as HTMLElement, included ? depth + 1 : depth, filter, refId, maxDepth, lines, counter, labelMap);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate the accessibility tree for the current page.
 *
 * @param filter `"all"` (default) or `"interactive"` — limits which elements appear.
 * @param depth  Max tree depth (default 15).
 * @param maxLength Optional cap on output character length; emits an error if exceeded.
 * @param refId  If provided, only extract that element's subtree.
 * @returns Serialized tree content + viewport metadata, or an error message.
 */
export function generateAccessibilityTree(
  filter: string = "all",
  depth: number = DEFAULT_MAX_DEPTH,
  maxLength?: number,
  refId?: string
): AXTreeResult {
  initElementMap();

  // Validate `filter` against the allowed set so a mistyped value produces a
  // clear error instead of silently degraded (hybrid) output.
  if (filter !== "all" && filter !== "interactive") {
    throw new TypeError(
      `Invalid filter: ${JSON.stringify(filter)}. Expected "all" or "interactive".`
    );
  }

  // Validate / clamp `depth` to a sane positive integer. Rejects NaN, negative,
  // and non-integer values that would otherwise yield empty or runaway output.
  const rawDepth = depth ?? DEFAULT_MAX_DEPTH;
  const maxDepth =
    Number.isFinite(rawDepth) && rawDepth >= 1
      ? Math.floor(rawDepth)
      : DEFAULT_MAX_DEPTH;

  try {
    const lines: string[] = [];
    const counter = { count: 0 };

    // pre-build a Map of all <label for="..."> elements ONCE per
    // generateAccessibilityTree call. Previously, getName() called
    // `document.querySelector('label[for="<id>"]')` per element — O(N²) on
    // pages with many IDs (React apps auto-generate id=":r1:" etc.). A single
    // querySelectorAll + Map lookup is O(N) + O(1) per element.
    const labelMap = new Map<string, HTMLLabelElement>();
    if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
      for (const label of Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]"))) {
        // First-write-wins: if multiple labels point at the same `for`, the
        // first one in document order wins (matches the old querySelector
        // behavior, which returns the first match).
        if (!labelMap.has(label.htmlFor)) labelMap.set(label.htmlFor, label);
      }
    }

    if (refId) {
      // Extract only the subtree for the given ref.
      const ref = elementMap![refId];
      if (!ref) {
        return {
          error: `Element with ref_id '${refId}' not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.`,
          pageContent: "",
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      }
      const el = ref.deref();
      if (!el) {
        return {
          error: `Element with ref_id '${refId}' no longer exists. It may have been removed from the page.`,
          pageContent: "",
          viewport: { width: window.innerWidth, height: window.innerHeight },
        };
      }
      buildTree(el as HTMLElement, 0, filter, refId, maxDepth, lines, counter, labelMap);
    } else if (document.body) {
      buildTree(document.body, 0, filter, undefined, maxDepth, lines, counter, labelMap);
    }

    // Cleanup dead WeakRefs to avoid unbounded map growth.
    for (const key in elementMap!) {
      if (!elementMap![key].deref()) {
        delete elementMap![key];
      }
    }

    let pageContent = lines.join("\n");

    // Truncation warnings.
    if (counter.count >= MAX_ELEMENTS) {
      const hint = refId
        ? "use a smaller depth or focus on a more specific child element"
        : "use a refId or smaller depth to focus";
      pageContent += `\n[truncated at ${MAX_ELEMENTS} elements — page is very large; ${hint}]`;
    }

    if (maxLength && pageContent.length > maxLength) {
      return {
        error: `Output exceeds ${maxLength} character limit (${pageContent.length} characters). Try specifying a depth parameter (e.g., depth: 5) or use ref_id to focus on a specific element.`,
        pageContent: "",
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    }

    return {
      pageContent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  } catch (e) {
    // Preserve the original error's type and stack; only prefix the message so
    // field debugging can still distinguish TypeError/RangeError etc.
    const err = e instanceof Error ? e : new Error(String(e));
    err.message = `Error generating accessibility tree: ${err.message}`;
    throw err;
  }
}

// ─── Test-only accessors ─────────────────────────────────────────────────────
//
// The element-ref registry is intentionally module-scoped (off `window`) for
// security. These accessors exist SOLELY so the unit tests can observe /
// populate the registry without reaching into a `window` global that no longer
// exists. They are not part of the public runtime API.
/** @internal Test-only: snapshot of the registry state. */
export function __test_registry(): {
  initialized: boolean;
  size: number;
  counter: number;
} {
  return {
    initialized: elementMap !== null,
    size: elementMap ? Object.keys(elementMap).length : 0,
    counter: refCounter,
  };
}

/** @internal Test-only: register an element under a ref (mirrors buildTree). */
export function __test_registerElement(refId: string, el: HTMLElement): void {
  initElementMap();
  elementMap![refId] = new WeakRef(el);
  elementReverseMap!.set(el, refId);
}

/** @internal Test-only: reset the registry (so ref_N assignments are deterministic across tests). */
export function __test_resetRegistry(): void {
  elementMap = null;
  elementReverseMap = null;
  refCounter = 0;
}
