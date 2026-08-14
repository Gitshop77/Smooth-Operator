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
  beginVisibilityCache,
  endVisibilityCache,
  directText,
  SKIP_TAGS,
  isSensitive,
} from "../utils";
import { getRole, escapeAttributeValue, isStructural } from "./ax-tree-utils";
import { redactUrlTokens } from "./element-info-utils";
import { getShadowRoot } from "../annotation/shadow-piercer";
import { ReadCache } from "../utils/read-cache";

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
  if (!Object.hasOwn(map, refId)) return null;
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

// ─── Sensitive field detection ──────────────────────────────────────────────
// `isSensitive` (in `../utils/classification`) + `SENSITIVE_AUTOCOMPLETE_SET`
// (in `../utils/classification-helpers`) are shared with
// `element-info.buildAttrs` so the indexed tree + AX tree redact consistently.

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
      // `title` is deliberately skipped here: it can reveal what secret the
      // field holds (e.g. `title="Card number field"`), matching the
      // sensitive input/textarea policy below.
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

 // Sensitive fields: skip placeholder/title/alt — these reveal what secret
 // the field holds (matching buildAttrs parity, which omits placeholder for
 // sensitive fields). The value itself stays redacted below; only non-secret
 // `type` semantics survive via the input/textarea branches.
  if (!sensitive) {
    const placeholder = el.getAttribute("placeholder");
    if (placeholder?.trim()) return placeholder.trim();

    const title = el.getAttribute("title");
    if (title?.trim()) return title.trim();

    const alt = el.getAttribute("alt");
    if (alt?.trim()) return alt.trim();
  }

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
  name: string,
  readCache: ReadCache,
): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return false;
 // apply visibility + aria-hidden gating even in "all" mode so
 // hidden modals, off-screen duplicates, and aria-hidden decorative elements
 // don't inflate the AX payload with content the user can't see. `aria-hidden`
 // is matched case-insensitively (ARIA attribute values are ASCII case-insensitive).
  if ((el.getAttribute("aria-hidden") || "").toLowerCase() === "true") return false;

  if (filter === "interactive") {
    if (!isInteractive(el)) return false;
    // Visibility gate (same as the "all" path below): a hidden element is
    // never included, even when interactive.
    if (isLikelyHidden(el)) return false;
    // Batch this element's rect + style reads once, then reuse a single rect
    // for both the visibility check and the viewport-bounds test so we never
    // call getBoundingClientRect more than once per element.
    readCache.batchRead(el);
    const rect = readCache.getRect(el);
    if (!(readCache.getVisible(el, rect) ?? isVisible(el, rect))) return false;
    if (!hasRefId && !intersectsViewport(rect!)) return false;
    return true;
  }

 // "all" mode: cheap classification first, visibility last. `isLikelyHidden`
 // resolves computed style, and style resolution cost grows with ancestor
 // depth (in jsdom the cascade walks the ancestor chain per element; real
 // browsers pay a style recalc). A chain of excluded wrappers (plain divs
 // with no role, name, or interactivity) fails the cheap gates and is
 // excluded without ever consulting the style system, so a hostile page's
 // arbitrarily deep excluded chain costs O(cap) instead of O(cap² × rules).
  const interactive = isInteractive(el);
  if (interactive || isStructural(el) || name.length > 0) {
    if (isLikelyHidden(el)) return false;
    // The automatic per-step AX channel is a VIEWPORT observation. Without
    // this gate, `filter="all"` serialized the whole document in DOM order;
    // the low-context cap then kept the same page header on every step, so
    // scrolling produced no new evidence and agents could loop indefinitely.
    // Explicit ref_id reads remain subtree reads and intentionally bypass the
    // viewport gate.
    readCache.batchRead(el);
    if (!hasRefId && !intersectsViewport(readCache.getRect(el)!)) return false;
    return true;
  }
  const role = getRole(el);
  if (role !== "generic" && role !== "image") {
    if (isLikelyHidden(el)) return false;
    return true;
  }
  return false;
}

function intersectsViewport(rect: DOMRect | Pick<DOMRect, "top" | "bottom" | "left" | "right">): boolean {
  return rect.top < window.innerHeight && rect.bottom > 0 &&
    rect.left < window.innerWidth && rect.right > 0;
}

/**
 * Build the AX-tree error envelope for an unresolved ref (missing/GC'd element).
 * Messages are preserved verbatim for the refId error-path contract.
 */
function refNotFound(refId: string, detail: string): AXTreeResult {
  return {
    error: `Element with ref_id '${refId}' ${detail}`,
    pageContent: "",
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

// ─── Tree builder ───────────────────────────────────────────────────────────

/** Hard cap on the number of elements emitted (prevents runaway output). */
const MAX_ELEMENTS = 10_000;
/** Default max tree depth (overridable by the caller). */
const DEFAULT_MAX_DEPTH = 15;
/** Absolute recursion cap — bounds stack depth even for hostile DOM trees. */
const MAX_ABSOLUTE_DEPTH = 512;

/**
 * Recursively build the accessibility tree under `el`. Appends serialized
 * lines to `lines` and increments `counter.count` for each emitted element.
 *
 * `depth` is the EMITTED depth (indentation; advances only for included
 * elements so skipped wrappers don't inflate the output tree). `absDepth`
 * ALWAYS increments per DOM level, so a chain of excluded elements (e.g. a
 * DOM-API-built stack of thousands of `<div>`s) hits {@link MAX_ABSOLUTE_DEPTH}
 * and truncates instead of overflowing the call stack — the emitted-depth
 * guard alone can't stop it because excluded elements never advance `depth`.
 */
function buildTree(
  el: HTMLElement,
  depth: number,
  absDepth: number,
  filter: string,
  refId: string | undefined,
  maxDepth: number,
  lines: string[],
  counter: { count: number },
  labelMap: Map<string, HTMLLabelElement>,
  readCache: ReadCache,
): void {
  if (counter.count >= MAX_ELEMENTS) return;
  if (absDepth > MAX_ABSOLUTE_DEPTH) return;
  if (depth > maxDepth) return;
  if (!el || !el.tagName) return;

  const name = getName(el, labelMap);
  const included = shouldInclude(el, filter, !!refId, name, readCache) || (!!refId && depth === 0);

  if (included) {
    const role = getRole(el);
    const displayName = escapeAttributeValue(name.substring(0, NAME_MAX_LENGTH));
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
    if (href) line += ` href="${escapeAttributeValue(redactUrlTokens(href))}"`;
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
  if (depth < maxDepth && absDepth < MAX_ABSOLUTE_DEPTH) {
    if (el.tagName.toLowerCase() !== "select") {
      // firstChild/nextSibling instead of `el.children` so we never
      // instantiate the live children collection on body (jsdom re-snapshots
      // it on every child mutation — O(n^2) for bulk appends, see
      // extractor.test.ts test 19).
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) continue;
        buildTree(child as HTMLElement, included ? depth + 1 : depth, absDepth + 1, filter, refId, maxDepth, lines, counter, labelMap, readCache);
      }
    }
 // Pierce shadow DOM so controls rendered inside open/closed shadow roots
 // (web components, design systems) are visible to the AX tree — matching
 // the indexed-tree extractor's shadow-piercing behavior. Without this the
 // AX tree silently omits shadow-DOM content that the indexed tree sees.
    const sr = getShadowRoot(el);
    if (sr) {
      for (const child of Array.from(sr.children)) {
        buildTree(child as HTMLElement, included ? depth + 1 : depth, absDepth + 1, filter, refId, maxDepth, lines, counter, labelMap, readCache);
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
    beginVisibilityCache();
    // Per-walk read cache: batch rect/style reads once per element (see
    // `read-cache.ts`). Scoped to this call — never reused across calls.
    const readCache = new ReadCache();

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
      // Extract only the subtree for the given ref. Guard a null `elementMap`
      // (e.g. a fresh page where init hasn't populated refs yet) so we return the
      // graceful "not found" error instead of dereferencing a null map and throwing
      // a TypeError (the refId path dereferenced a potentially-null elementMap).
      if (!elementMap || !Object.hasOwn(elementMap, refId)) {
        return refNotFound(
          refId,
          "not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.",
        );
      }
      const ref = elementMap[refId];
      if (!ref) {
        return refNotFound(
          refId,
          "not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.",
        );
      }
      const el = ref.deref();
      if (!el) {
        return refNotFound(refId, "no longer exists. It may have been removed from the page.");
      }
      buildTree(el as HTMLElement, 0, 0, filter, refId, maxDepth, lines, counter, labelMap, readCache);
    } else if (document.body) {
      buildTree(document.body, 0, 0, filter, undefined, maxDepth, lines, counter, labelMap, readCache);
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

    const wrappedPageContent =
      pageContent.length > 0
        ? `<untrusted_page_state>\n${pageContent}\n</untrusted_page_state>`
        : pageContent;
    return {
      pageContent: wrappedPageContent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      // `error` is left undefined on the success path but is always present in
      // the `AXTreeResult` envelope, so a consumer that forwards the whole
      // payload (e.g. the content script → orchestrator) can surface a
      // truncation/ref error uniformly without special-casing. The `pageContent`
      // shape is unchanged (still `""` when `error` is set) so existing readers
      // that depend on `axTree.pageContent` keep working (see L9).
      error: undefined,
    };
  } catch (e) {
 // Preserve the original error's type and stack; only prefix the message so
 // field debugging can still distinguish TypeError/RangeError etc.
    const err = e instanceof Error ? e : new Error(String(e));
    err.message = `Error generating accessibility tree: ${err.message}`;
    throw err;
  } finally {
    endVisibilityCache();
  }
}

// ─── Test-only accessors ─────────────────────────────────────────────────────
//
// The element-ref registry is intentionally module-scoped (off `window`) for
// security. These accessors exist SOLELY so the unit tests can observe /
// populate the registry without reaching into a `window` global that no longer
// exists. They are exported deliberately rather than gated behind a build flag
// because the test suite imports them from the production module path; they
// are tree-shaken out of the extension bundle (only tests reference them) and
// are not exposed on `window`, so a hostile page cannot reach them.
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
