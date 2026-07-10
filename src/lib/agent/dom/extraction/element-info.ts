/**
 * Element-info helpers — attribute building + stable element hashing for the
 * indexed DOM-tree extractor ({@link ./page-state}).
 *
 * Extracted from the historical `dom/extractor.ts` so the walker (`page-state.ts`)
 * and any future caller can reach the attribute-serialisation + hashing logic
 * without pulling in the full page-walker.
 *
 * The hash is a SHA-style stable element identifier (FNV-1a of branch-path +
 * key attrs) so the agent can mark elements with `*` when they are new since
 * the last step. Two elements with the same hash are considered "the same
 * element" for `isNew` purposes.
 */

import { SKIP_TAGS, isSensitive } from "../utils/classification";

// ─── Configuration constants ────────────────────────────────────────────────

/**
 * Curated configuration for DOM extraction. All thresholds in one place.
 *
 * Exported so {@link ./page-state} (the walker) can read the same thresholds
 * without duplicating them — both files were originally a single
 * `dom/extractor.ts` module and shared these constants in closure.
 */
export const DOM_CONFIG = {
  /** Attributes surfaced to the LLM (curated subset of the DOM). */
  includeAttrs: [
    "type", "role", "name", "id", "placeholder", "value", "aria-label",
    "aria-checked", "aria-selected", "aria-expanded", "aria-disabled",
    "aria-required", "aria-placeholder", "aria-valuenow", "aria-valuemin",
    "aria-valuemax", "checked", "selected", "disabled", "required",
    "readonly", "href", "title", "alt", "for", "min", "max", "step",
    "pattern", "inputmode", "autocomplete", "contenteditable",
    "data-state", "multiple", "target", "rel",
  ],
  /** Tags whose subtrees we skip entirely. Canonical set lives in `../utils/classification`. */
  skipTags: SKIP_TAGS,
  /** Max options listed inline for a `<select>` (compact `options` attribute). */
  selectOptionLimit: 6,
  /** Max options rendered as virtual child `<option>` lines for a `<select>`. */
  compoundOptionLimit: 4,
  /** Min text length to include as a text node. */
  minTextLength: 2,
  /** Key attributes used to compute an element's identity hash. */
  identityKeyAttrs: ["role", "type", "name", "id", "placeholder", "aria-label", "href", "for"],
  /** FNV-1a offset basis (32-bit). */
  fnvOffsetBasis: 0x811c9dc5,
  /** FNV-1a prime (32-bit). */
  fnvPrime: 0x01000193,
  /** Max body-rect siblings considered for the branch path. */
  maxBranchDepth: 200,
} as const;

/**
 * Boolean attributes whose PRESENCE is the information — they serialize as
 * `attr=""` (empty string) per `getAttribute`, but their emptiness is NOT
 * "no value", it's "the attribute is set". {@link buildAttrs} keeps these
 * even when their value is `""`, so the navigator LLM can tell whether a
 * checkbox is checked, an input is required, etc.
 *
 * Source: HTML spec — these are the "boolean attributes" that the spec lists
 * (a subset relevant to form/interactive elements). Only those that also
 * appear in {@link DOM_CONFIG.includeAttrs} are actually surfaced, but the
 * full set is listed here for clarity and so future additions to
 * `includeAttrs` automatically do the right thing.
 *
 * Exported so {@link ./page-state} can share the same set.
 */
export const BOOLEAN_ATTRS: ReadonlySet<string> = new Set([
  "required", "checked", "selected", "disabled", "readonly",
  "multiple", "hidden", "autofocus", "formnovalidate",
]);

// ─── Attribute building ─────────────────────────────────────────────────────

/** Compute the implicit ARIA role for an element based on its tag (and type). */
function implicitRole(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    if (t === "checkbox" || t === "radio") return t;
    if (t === "submit" || t === "button" || t === "reset") return "button";
    return "textbox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  return null;
}

/**
 * Build the attribute map surfaced to the LLM for a single element.
 * Includes a curated subset of attributes, plus synthesized fields for
 * `<select>` (options list + count) and the implicit ARIA role.
 */
export function buildAttrs(el: HTMLElement): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of DOM_CONFIG.includeAttrs) {
    let val: string | null = null;
    if (name === "value") {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        // Never expose sensitive values to the LLM. `isSensitive` (shared
        // with the AX-tree extractor) redacts password, hidden (CSRF/session
        // tokens), and sensitive-autocomplete fields (credit-card, OTP).
        // Reading a non-sensitive `<select>`'s value is safe (chosen option).
        if (!isSensitive(el)) val = el.value;
      } else {
        const a = el.getAttribute("value");
        if (a !== null) val = a;
      }
    } else {
      val = el.getAttribute(name);
    }
    if (val !== null) {
      // Keep boolean attributes even when their value is "" — their presence
      // IS the information (e.g. `required` means "this field is required",
      // absence means "it isn't"). For all other attributes, an empty string
      // carries no information and is dropped to save tokens.
      if (val === "" && !BOOLEAN_ATTRS.has(name)) continue;
      attrs[name] = val;
    }
  }

  if (el instanceof HTMLSelectElement) {
    const opts = Array.from(el.options)
      .slice(0, DOM_CONFIG.selectOptionLimit)
      .map((o) => o.textContent?.trim() || o.value);
    attrs["options"] = opts.join(" | ");
    attrs["option_count"] = String(el.options.length);
  }

  if (!attrs["role"]) {
    const r = implicitRole(el);
    if (r) attrs["role"] = r;
  }

  return attrs;
}

// ─── Element hashing (for `isNew` tracking) ─────────────────────────────────

/**
 * Lightweight synchronous FNV-1a hash. Fast and good enough for change
 * detection — we don't need cryptographic strength here.
 */
function fnv1aHash(s: string): string {
  let h: number = DOM_CONFIG.fnvOffsetBasis;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, DOM_CONFIG.fnvPrime);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// WeakMap cache for the STABLE part of an element's identity (tag +
// key attrs). The ancestor path is NOT cached because it changes when the
// element moves. Only the expensive attribute-extraction is cached.
const stableIdentityCache = new WeakMap<HTMLElement, string>();

/**
 * Build a stable identity string for an element: tag + key attributes + the
 * branch path of tag+nth-of-type indices up to `document.body`. Two elements
 * with the same identity will hash the same, so we can detect "this element
 * was already here last step" reliably across re-renders.
 *
 * The tag+keyAttrs portion is cached (it doesn't change when the element
 * moves). The ancestor path is computed fresh each call (it changes when the
 * element moves, so caching it would produce stale hashes).
 */
function elementIdentity(el: HTMLElement): string {
  // Cache the stable portion (tag + key attrs).
  let stablePart = stableIdentityCache.get(el);
  if (stablePart === undefined) {
    const tag = el.tagName.toLowerCase();
    const attrs = buildAttrs(el);
    const keyAttrs = DOM_CONFIG.identityKeyAttrs
      .map((k) => attrs[k] ? `${k}=${attrs[k]}` : "")
      .filter(Boolean)
      .join("|");
    stablePart = `${tag}|${keyAttrs}`;
    stableIdentityCache.set(el, stablePart);
  }

  // Compute the path fresh each time (changes when the element moves).
  const path: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== document.body && cur.parentElement && depth < DOM_CONFIG.maxBranchDepth) {
    const siblings = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur!.tagName);
    const idx = siblings.indexOf(cur) + 1;
    path.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
    cur = cur.parentElement;
    depth++;
  }
  return `${stablePart}|${path.join(">")}`;
}

/**
 * Compute a stable hash for an element. Two elements with the same hash are
 * considered "the same element" for `isNew` purposes.
 */
export function hashElement(el: HTMLElement): string {
  return fnv1aHash(elementIdentity(el));
}
