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
import {
  BOOLEAN_ATTRS,
  redactUrlTokens,
  capAttrValue,
  implicitRole,
  fnv1aHash,
} from "./element-info-utils";

// ─── Configuration constants ────────────────────────────────────────────────

export const DOM_CONFIG = {
  includeAttrs: [
    "type", "role", "name", "id", "placeholder", "value", "aria-label",
    "aria-checked", "aria-selected", "aria-expanded", "aria-disabled",
    "aria-required", "aria-placeholder", "aria-valuenow", "aria-valuemin",
    "aria-valuemax", "checked", "selected", "disabled", "required",
    "readonly", "href", "title", "alt", "for", "min", "max", "step",
    "pattern", "inputmode", "autocomplete", "contenteditable",
    "data-state", "multiple", "target", "rel", "part",
  ],
  skipTags: SKIP_TAGS,
  selectOptionLimit: 6,
  compoundOptionLimit: 4,
  minTextLength: 2,
  identityKeyAttrs: ["role", "type", "name", "id", "placeholder", "aria-label", "href", "for"],
  fnvOffsetBasis: 0x811c9dc5,
  fnvPrime: 0x01000193,
  maxBranchDepth: 200,
} as const;

// ─── Attribute building ─────────────────────────────────────────────────────

export function buildAttrs(el: HTMLElement): Record<string, string> {
  const attrs: Record<string, string> = {};
  const sensitive = isSensitive(el);
  for (const name of DOM_CONFIG.includeAttrs) {
    // Sensitive fields: skip autocomplete/placeholder/title/pattern — these
    // reveal what secret the field holds or its exact format (e.g.
    // `title="Password hint: MyDog123"` or `pattern="MyDog123|MyCat456"`),
    // matching the AX tree's title-suppression policy for sensitive fields.
    if (sensitive && (name === "autocomplete" || name === "placeholder" || name === "title" || name === "pattern")) {
      continue;
    }
    let val: string | null = null;
    if (name === "value") {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        if (!sensitive) val = capAttrValue(el.value);
      } else {
        const a = el.getAttribute("value");
        if (a !== null && !sensitive) val = capAttrValue(a);
      }
    } else if (name === "href") {
      const raw = el.getAttribute(name);
      if (raw !== null) val = redactUrlTokens(raw);
    } else {
      val = el.getAttribute(name);
    }
    if (val !== null) {
      if (val === "" && !BOOLEAN_ATTRS.has(name)) continue;
      attrs[name] = val;
    }
  }

  if (el instanceof HTMLSelectElement && !sensitive) {
    const opts = Array.from(el.options)
      .slice(0, DOM_CONFIG.selectOptionLimit)
      .map((o) => o.textContent?.trim() || o.value);
    attrs["options"] = opts.join(" | ");
    attrs["option_count"] = String(el.options.length);
    const selected = el.options[el.selectedIndex];
    if (selected) {
      const selectedText = (selected.textContent || "").replace(/\s+/g, " ").trim();
      if (selectedText) attrs["selected_text"] = selectedText;
    }
  }

  if (!attrs["role"]) {
    const r = implicitRole(el);
    if (r) attrs["role"] = r;
  }

  return attrs;
}

// ─── Element hashing (for `isNew` tracking) ─────────────────────────────────

/**
 * Stable identity string for an element: `tag|keyAttrs|branch-path` (plus a
 * collision-free uid when the element has no usable branch path).
 *
 * Exported so the stale-element execution guard (`tools/helpers/element-resolver.ts`)
 * can recompute the identity of a live element at EXECUTION time and compare it
 * against the identity captured at EXTRACTION time (`page-state.ts` records one
 * per selector-map index). Two references to the SAME node produce the same
 * string; a node replaced/re-ordered by the page produces a different one —
 * which fail-closes the handler instead of operating on a stale element.
 *
 * SECRECY NOTE: identity inputs are `identityKeyAttrs` (role/type/name/id/
 * placeholder/aria-label/href/for) + the tag + the branch path — never the
 * value of a password field (password values never enter `buildAttrs`), never
 * raw `textContent` (matching the `hashElement` contract the snapshot uses).
 */
export function elementIdentity(el: HTMLElement, attrs?: Record<string, string>): string {
  const tag = el.tagName.toLowerCase();
  const a = attrs ?? buildAttrs(el);
  const keyAttrs = DOM_CONFIG.identityKeyAttrs
    .map((k) => a[k] ? `${k}=${a[k]}` : "")
    .filter(Boolean)
    .join("|");
  const stablePart = `${tag}|${keyAttrs}`;

  const path: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== document.body && cur.parentElement && depth < DOM_CONFIG.maxBranchDepth) {
    const idx = nthOfTypeIndex(cur);
    path.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
    cur = cur.parentElement;
    depth++;
  }

  if (path.length === 0) {
    return `${stablePart}|#${collisionFreeId(el)}`;
  }
  return `${stablePart}|${path.join(">")}`;
}

const uidMap = new WeakMap<HTMLElement, string>();
let uidCounter = 0;

let nthOfTypeCache: WeakMap<Element, Map<Element, number>> = new WeakMap();

export function resetHashCaches(): void {
  nthOfTypeCache = new WeakMap();
}

function nthOfTypeIndex(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 1;
  let perParent = nthOfTypeCache.get(parent);
  if (!perParent) {
    perParent = new Map<Element, number>();
    const counts = new Map<string, number>();
    // Iterate via firstChild/nextSibling (element nodes only) instead of
    // `parent.children`: reading `children` instantiates a live collection
    // that jsdom re-snapshots on every child mutation, making bulk appends
    // into `parent` quadratic (see extractor.test.ts test 19).
    for (let sib = parent.firstChild; sib; sib = sib.nextSibling) {
      if (sib.nodeType !== 1) continue;
      const tag = (sib as Element).tagName;
      const next = (counts.get(tag) ?? 0) + 1;
      counts.set(tag, next);
      perParent.set(sib as Element, next);
    }
    nthOfTypeCache.set(parent, perParent);
  }
  return perParent.get(el) ?? 1;
}
function collisionFreeId(el: HTMLElement): string {
  let id = uidMap.get(el);
  if (!id) {
    id = `el${++uidCounter}`;
    uidMap.set(el, id);
  }
  return id;
}

export function hashElement(el: HTMLElement, attrs?: Record<string, string>): string {
  return fnv1aHash(elementIdentity(el, attrs), DOM_CONFIG.fnvOffsetBasis, DOM_CONFIG.fnvPrime);
}

// ─── Fallback identity matching ────────────────────────────────────────────

/**
 * Build fallback identity strings for an element. Used when the primary
 * uid/hash match fails (e.g. DOM restructured between steps). Each strategy
 * is progressively looser — callers should try them in order.
 */
export function buildIdentityFallbacks(el: HTMLElement): string[] {
  const tag = el.tagName.toLowerCase();
  const a = buildAttrs(el);
  const keyAttrs = DOM_CONFIG.identityKeyAttrs
    .map((k) => a[k] ? `${k}=${a[k]}` : "")
    .filter(Boolean)
    .join("|");

  const fallbacks: string[] = [];

  const visibleText = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (visibleText) {
    fallbacks.push(`text|${tag}|${visibleText}|${keyAttrs}`);
  }

  const ariaLabel = a["aria-label"] || "";
  const placeholder = a["placeholder"] || "";
  const name = a["name"] || "";
  if (ariaLabel || placeholder || name) {
    fallbacks.push(`label|${tag}|${ariaLabel}|${placeholder}|${name}`);
  }

  const parent = el.parentElement;
  if (parent) {
    const parentTag = parent.tagName.toLowerCase();
    const parentText = (parent.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
    fallbacks.push(`parent|${tag}|${parentTag}|${parentText}|${keyAttrs}`);
  }

  return fallbacks;
}

/**
 * Try to match a target identity string against a list of elements using
 * fallback strategies. Returns the matched element or null.
 *
 * Strategies (tried in order):
 * 1. tag + full visible text + visible position (normalized)
 * 2. tag + aria-label + placeholder/name attributes
 * 3. tag + parent context (parent tag + parent text)
 *
 * If multiple elements match the same strategy, returns null (ambiguous).
 */
export function matchElementByFallbacks(
  targetId: string,
  elements: HTMLElement[],
): HTMLElement | null {
  if (!targetId || elements.length === 0) return null;

  const tagMatch = targetId.match(/^(\w+)\|/);
  const targetTag = tagMatch ? tagMatch[1] : null;

  const candidates = targetTag
    ? elements.filter((el) => el.tagName.toLowerCase() === targetTag)
    : elements;

  if (candidates.length === 0) return null;

  for (const el of candidates) {
    const fallbacks = buildIdentityFallbacks(el);
    for (const fb of fallbacks) {
      if (fb === targetId) return el;
    }
  }

  const targetTextMatch = targetId.match(/^text\|\w+\|(.+?)\|/);
  if (targetTextMatch && targetTag) {
    const targetText = targetTextMatch[1].toLowerCase();
    const matches = candidates.filter((el) => {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return text.includes(targetText) || targetText.includes(text);
    });
    if (matches.length === 1) return matches[0];
  }

  const targetLabelMatch = targetId.match(/^label\|\w+\|(.+?)\|(.+?)\|(.+)$/);
  if (targetLabelMatch && targetTag) {
    const [, targetAriaLabel, targetPlaceholder, targetName] = targetLabelMatch;
    const matches = candidates.filter((el) => {
      const a = buildAttrs(el);
      return (
        (targetAriaLabel && a["aria-label"] === targetAriaLabel) ||
        (targetPlaceholder && a["placeholder"] === targetPlaceholder) ||
        (targetName && a["name"] === targetName)
      );
    });
    if (matches.length === 1) return matches[0];
  }

  return null;
}
