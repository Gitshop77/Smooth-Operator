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
 * hijack the element an action resolves to. Keeping the registry off `window`
 * is purely a defense against a hostile page hijacking an action's target
 * element.
 *
 * NOTE: AX-tree `ref_NNN` identifiers are OBSERVATION-ONLY. The action executor
 * resolves action targets through `getSelectorMap()` (numeric indices) from
 * `page-state`, and never imports or calls `resolveRef`. The off-`window`
 * design is correct and good, but it does NOT provide cross-module action
 * resolution — AX-tree refs are not wired to the action executor.
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
import { getShadowRoot } from "../annotation/shadow-piercer";

/**
 * Module-scoped element-ref registry.
 *
 * Kept off `window` (see SECURITY note at the top of this file) so a hostile
 * page cannot read or overwrite an entry to hijack an action's target element.
 * AX-tree refs are observation-only (not wired to the action executor, which
 * uses numeric `getSelectorMap()` indices), so no `window` handle is needed
 * for cross-module action resolution.
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

// ─── Attribute serialization ────────────────────────────────────────────────

/**
 * Escape an attribute value for safe interpolation into a serialized AX-tree
 * line.
 *
 * SECURITY : the serialized tree's invariant is "one element per line"
 * and is consumed by the navigator LLM as ground-truth page structure. A page
 * controls attribute text (`href`/`type`/`placeholder`/option `value`), which
 * may contain literal newlines/tabs/carriage-returns. Quote-escaping alone
 * lets a hostile page inject line breaks and forge additional AX-tree rows
 * (e.g. a spoofed `link Approve transfer [ref_1] ...` line). Collapse all
 * `\r`/`\n`/`\t` runs to a single space *before* quote-escaping so a value can
 * never span or spoof a line.
 */
function escapeAttributeValue(s: string): string {
  return s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ").replace(/"/g, '\\"');
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
 // Hoist the (relatively expensive) sensitive-field scan once — it is
 // consulted several times below, and re-scanning every call was wasted work
 // on the hot path.
  const sensitive = isSensitive(el);

 // <select> — get selected option text (or redact if sensitive).
  if (tag === "select") {
    if (sensitive) {
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

 // aria-labelledby (per WAI-ARIA, higher priority than the implicit text
 // sources below): concatenate the direct text of each referenced element.
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const t = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((x) => directText(x as HTMLElement))
      .join(" ")
      .trim();
    if (t) return t;
  }

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
    if (sensitive) return input.value ? "[value redacted]" : "";
 // Truncate long values (e.g. search/address fields) instead of dropping
 // them — otherwise the navigator LLM can't see the field's current content.
    if (input.value && input.value.trim()) {
      const v = input.value.trim();
      return v.length > NAME_MAX_LENGTH ? v.substring(0, NAME_MAX_LENGTH) + "..." : v;
    }
  }

 // Textarea (non-sensitive): surface the live value, mirroring the indexed
 // tree which reads `el.value` for `<textarea>`. The sensitive case is
 // redacted separately below.
  if (tag === "textarea" && !sensitive) {
    const v = (el as HTMLTextAreaElement).value;
    if (v && v.trim()) {
      return v.length > NAME_MAX_LENGTH ? v.trim().substring(0, NAME_MAX_LENGTH) + "..." : v.trim();
    }
  }

 // Textarea sensitive redaction.
  if (tag === "textarea" && sensitive) {
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
    if (text?.trim()) return escapeAttributeValue(text.trim()).substring(0, NAME_MAX_LENGTH);
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
function shouldInclude(
  el: HTMLElement,
  filter: string,
  hasRefId: boolean,
  labelMap: Map<string, HTMLLabelElement>,
  name: string,
): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return false;
 // apply visibility + aria-hidden gating even in "all" mode so
 // hidden modals, off-screen duplicates, and aria-hidden decorative elements
 // don't inflate the AX payload with content the user can't see.
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (isLikelyHidden(el)) return false;
  if (filter !== "all") {
 // Reuse a single rect for both the visibility check and the viewport-bounds
 // test so we don't call getBoundingClientRect twice on the hot path.
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) return false;
    if (!hasRefId) {
 // When not extracting a specific subtree, only include viewport-visible els.
      if (!(rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0)) return false;
    }
  }
  if (filter === "interactive") return isInteractive(el);
  if (isInteractive(el)) return true;
  if (isStructural(el)) return true;
  if (name.length > 0) return true;
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

  const name = getName(el, labelMap);
  const included = shouldInclude(el, filter, !!refId, labelMap, name) || (!!refId && depth === 0);

  if (included) {
    const role = getRole(el);
    const displayName = escapeAttributeValue(name).substring(0, NAME_MAX_LENGTH);
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
 // escape `"` AND collapse `\r\n\t` in href/type/placeholder
 // attribute values via `escapeAttributeValue` (the `name` field is already
 // whitespace-collapsed at line 329). Quote-escaping alone let a page inject
 // literal newlines to forge extra AX-tree rows (line spoofing / prompt
 // injection into the navigator LLM's ground-truth page view).
    let line = indent + escapeAttributeValue(role);
    if (displayName) line += ` "${displayName}"`;
    line += ` [${ref}]`;
    const href = el.getAttribute("href");
    const type = el.getAttribute("type");
    const placeholder = el.getAttribute("placeholder");
    if (href) line += ` href="${escapeAttributeValue(href)}"`;
 // For sensitive fields (password, credit-card, OTP, hidden CSRF/session
 // tokens) the *value* is already redacted — but `type`/`placeholder` still
 // leak what secret the field holds. Suppress them so the field's semantics
 // aren't exposed to the LLM, consistent with the indexed-tree redactions.
    if (type && !isSensitive(el)) line += ` type="${escapeAttributeValue(type)}"`;
    if (placeholder && !isSensitive(el)) line += ` placeholder="${escapeAttributeValue(placeholder)}"`;
 // Surface a curated set of interactive state attributes so the navigator LLM
 // can avoid clicking disabled controls or mishandling collapsed/expanded
 // elements. Additive — emitted only when present (mirrors the indexed tree).
    if (isInteractive(el)) {
      for (const stateAttr of ["disabled", "aria-disabled", "aria-expanded", "aria-checked", "aria-selected", "readonly"] as const) {
        if (!el.hasAttribute(stateAttr)) continue;
        const raw = el.getAttribute(stateAttr) ?? "";
        line += ` ${stateAttr}="${escapeAttributeValue(raw || "true")}"`;
      }
    }
    lines.push(line);

 // For <select> (non-sensitive), emit child <option> elements.
    if (el.tagName.toLowerCase() === "select" && !isSensitive(el)) {
      const select = el as HTMLSelectElement;
      for (const option of Array.from(select.options)) {
        let optLine = " ".repeat(depth + 1) + "option";
        const optText = option.textContent?.trim() || "";
        if (optText) optLine += ` "${escapeAttributeValue(optText).substring(0, NAME_MAX_LENGTH)}"`;
        if (option.selected) optLine += " (selected)";
        if (option.value && option.value !== optText) optLine += ` value="${escapeAttributeValue(option.value)}"`;
        lines.push(optLine);
      }
    }
  }

 // Recurse into children (skip <option> children of non-sensitive <select> —
 // they were already emitted explicitly above to avoid duplication).
  if (depth < maxDepth) {
    if (el.tagName.toLowerCase() !== "select" && el.children) {
      for (const child of Array.from(el.children)) {
        buildTree(child as HTMLElement, included ? depth + 1 : depth, filter, refId, maxDepth, lines, counter, labelMap);
      }
    }
 // Pierce shadow DOM so controls rendered inside open/closed shadow roots
 // (web components, design systems) are visible to the AX tree — matching
 // the indexed-tree extractor's shadow-piercing behavior. Without this the
 // AX tree silently omits shadow-DOM content that the indexed tree sees.
    const sr = getShadowRoot(el);
    if (sr) {
      for (const child of Array.from(sr.children)) {
        buildTree(child as HTMLElement, included ? depth + 1 : depth, filter, refId, maxDepth, lines, counter, labelMap);
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate the accessibility tree for the current page.
 *
 * @param filter `"all"` (default) or `"interactive"` — limits which elements appear.
 * @param depth Max tree depth (default 15).
 * @param maxLength Optional cap on output character length; emits an error if exceeded.
 * @param refId If provided, only extract that element's subtree.
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

 // Validate `depth` with the same rigor as `filter`: reject NaN, negative,
 // non-finite, or non-positive values with a clear error instead of silently
 // degrading to the default. A fractional (but positive) depth is floored.
 // (The parameter already defaults to DEFAULT_MAX_DEPTH, so it is never
 // `undefined` here — the prior `depth ?? DEFAULT_MAX_DEPTH` was dead code.)
  if (!Number.isFinite(depth) || depth < 1) {
    throw new TypeError(
      `Invalid depth: ${JSON.stringify(depth)}. Expected a positive integer (>= 1).`
    );
  }
  const maxDepth = Math.floor(depth);

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
    for (const key of Object.keys(elementMap!)) {
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
