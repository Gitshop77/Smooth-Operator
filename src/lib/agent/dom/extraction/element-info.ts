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
    "data-state", "multiple", "target", "rel", "part",
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

// ─── URL token redaction ─────────────────────────────────────────────────────

/**
 * Whether a single URL path segment looks like a high-entropy secret (reset /
 * confirmation / session token) rather than a human-readable route. Mirrors the
 * conservative length + mixed-character-class heuristic used by the debug-log
 * redactor so ordinary route words (`documentation`, `reset-password`) survive
 * while opaque tokens are masked.
 */
export function looksLikeSecretSegment(seg: string): boolean {
  if (seg.length < 16) return false;
 // A segment carrying whitespace / quotes / angle-brackets is human-readable
 // text or hostile markup (e.g. an injected attribute trying to forge a
 // delimiter), not an opaque path token — never redact it.
  if (/[\s"'<>]/.test(seg)) return false;
  const hasLower = /[a-z]/.test(seg);
  const hasUpper = /[A-Z]/.test(seg);
  const hasDigit = /[0-9]/.test(seg);
  const hasSpecial = /[^A-Za-z0-9]/.test(seg);
  const classes = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
 // Require genuine high entropy: a mix of at least three character classes
 // (lower + upper + digit, etc.). This keeps real opaque tokens masked while
 // not flagging single-class runs (e.g. a 5000-char repeated path) or ordinary
 // hyphenated route words like `getting-started`.
  if (classes >= 3) return true;
  return false;
}

/**
 * Redact high-entropy secret-bearing PATH segments (e.g. `/reset/<token>`)
 * while preserving the rest of the path so the link stays navigable. Only
 * individual opaque segments are replaced; the path structure is kept.
 */
export function redactPathSecrets(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => (looksLikeSecretSegment(seg) ? "[redacted]" : seg))
    .join("/");
}

/**
 * Strip query-string and fragment tokens from a URL so secret-bearing tokens
 * (reset/session/2FA, PII) aren't forwarded to the LLM. Keeps scheme + host +
 * path so the link stays identifiable for navigation, but masks high-entropy
 * secret path segments. Mirrors the iframe `src` redaction in `page-state.ts`.
 * Falls back to a defensive `?…/#…` strip for relative / unparseable URLs.
 */
export function redactUrlTokens(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "[non-http url redacted]";
    }
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    u.pathname = redactPathSecrets(u.pathname);
    return u.toString();
  } catch {
    return redactPathSecrets(url.replace(/[?#].*$/, ""));
  }
}

/**
 * Bound a (non-sensitive) attribute value to the same 200-char cap the rendered
 * DOM line already applies via `escapeAttr`, so the raw value the indexed tree
 * forwards to the navigator LLM can't balloon the serialized payload. Mirrors
 * {@link ./page-state} `MAX_ATTR_VALUE_LENGTH`.
 */
const MAX_ATTR_VALUE_LENGTH = 200;

function capAttrValue(v: string): string {
  return v.length > MAX_ATTR_VALUE_LENGTH
    ? v.slice(0, MAX_ATTR_VALUE_LENGTH) + "..."
    : v;
}

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
 // Sensitive-field scan is (relatively) expensive and consulted several times
 // below per element — hoist it once for the whole attribute loop.
  const sensitive = isSensitive(el);
  for (const name of DOM_CONFIG.includeAttrs) {
 // Sensitive fields: never surface `autocomplete` / `placeholder`. These
 // reveal what *secret* the field holds (e.g. `autocomplete="cc-number"`),
 // undermining the value redaction. The value itself is already redacted
 // (see the `value` branch below — `isSensitive(el)` short-circuits it to
 // `undefined`), so the two extractors (AX tree + indexed tree) redact
 // consistently. We deliberately DO still surface `type` (e.g.
 // `type="password"`) because it is non-secret semantic metadata the
 // navigator LLM needs to classify the field — only the *value* is secret.
    if (sensitive && (name === "autocomplete" || name === "placeholder")) {
      continue;
    }
    let val: string | null = null;
    if (name === "value") {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
 // Never expose sensitive values to the LLM. `isSensitive` (shared
 // with the AX-tree extractor) redacts password, hidden (CSRF/session
 // tokens), and sensitive-autocomplete fields (credit-card, OTP).
 // Reading a non-sensitive `<select>`'s value is safe (chosen option).
        if (!sensitive) val = capAttrValue(el.value);
      } else {
        const a = el.getAttribute("value");
        if (a !== null && !sensitive) val = capAttrValue(a);
      }
    } else if (name === "href") {
 // Strip query/fragment tokens (reset/session/2FA/PII) before the URL is
 // forwarded to the LLM — mirrors the iframe `src` redaction in page-state.
      const raw = el.getAttribute(name);
      if (raw !== null) val = redactUrlTokens(raw);
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

  if (el instanceof HTMLSelectElement && !sensitive) {
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

// NOTE: we deliberately do NOT cache the stable portion of an element's
// identity. A cached `tag + keyAttrs` string goes stale when a tracked key
// attribute changes in place (e.g. a button's `aria-label` updates, a tab's
// `aria-selected` flips), so `isNew` would miss meaningful UI changes. The
// ancestor path is already recomputed per call; recomputing the (cheap)
// attribute portion too keeps the hash correct at the cost of a tiny amount of
// redundant work.

/**
 * Build a stable identity string for an element: tag + key attributes + the
 * branch path of tag+nth-of-type indices up to `document.body`. Two elements
 * with the same identity will hash the same, so we can detect "this element
 * was already here last step" reliably across re-renders.
 *
 * The tag+keyAttrs portion is recomputed FRESH every call (it is NOT cached —
 * see the note above `elementIdentity`: caching it would let in-place edits to
 * a tracked key attribute slip past `isNew`). The ancestor path is also computed
 * fresh each call (it changes when the element moves, so caching it would
 * produce stale hashes).
 */
function elementIdentity(el: HTMLElement, attrs?: Record<string, string>): string {
 // Compute the stable portion (tag + key attrs) fresh every call. Not cached,
 // so in-place edits to a tracked key attribute are reflected (see note above).
  const tag = el.tagName.toLowerCase();
  const a = attrs ?? buildAttrs(el);
  const keyAttrs = DOM_CONFIG.identityKeyAttrs
    .map((k) => a[k] ? `${k}=${a[k]}` : "")
    .filter(Boolean)
    .join("|");
  const stablePart = `${tag}|${keyAttrs}`;

 // Compute the path fresh each time (changes when the element moves).
  const path: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== document.body && cur.parentElement && depth < DOM_CONFIG.maxBranchDepth) {
    const idx = nthOfTypeIndex(cur);
    path.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
    cur = cur.parentElement;
    depth++;
  }

 // Defensive: if the path ended up empty (e.g. a detached element, or an
 // element whose parent is `document.body` with no ancestor chain), append a
 // per-element discriminator so two distinct empty-path elements never
 // collide and are wrongly reported as "not new".
  if (path.length === 0) {
    return `${stablePart}|#${collisionFreeId(el)}`;
  }
  return `${stablePart}|${path.join(">")}`;
}

// Stable per-element unique id used to disambiguate elements that yield an
// empty ancestor path (defensive against hash collisions — see `elementIdentity`).
const uidMap = new WeakMap<HTMLElement, string>();
let uidCounter = 0;

/**
 * Cache of per-element nth-of-type index (1-based position among same-tag
 * siblings), keyed by the parent element. Built lazily on first use within a
 * single `extractBrowserState` snapshot (see {@link resetHashCaches}) and
 * therefore always reflects the current DOM.
 *
 * This replaces the previous per-element
 * `Array.from(parent.children).filter(tag).indexOf(el) + 1`, which was
 * O(#siblings) per element and therefore O(n^2) on pages with many same-tag
 * siblings. A pathological page (e.g. thousands of <button>s) would make
 * `extractBrowserState` — which runs on every agent step — do O(n^2) work and
 * freeze the extension. The cache turns the per-parent work into a single
 * O(#siblings) pass that every element under that parent then looks up in O(1),
 * so the whole walk is O(n). Hash *values* are unchanged (same nth-of-type
 * index as before), so `isNew` tracking is unaffected.
 */
let nthOfTypeCache: WeakMap<Element, Map<Element, number>> = new WeakMap();

/** Reset the nth-of-type cache. Call at the start of each `extractBrowserState` so the cached indices reflect the current DOM snapshot. */
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
    for (const sib of Array.from(parent.children)) {
      const tag = sib.tagName;
      const next = (counts.get(tag) ?? 0) + 1;
      counts.set(tag, next);
      perParent.set(sib, next);
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

/**
 * Compute a stable hash for an element. Two elements with the same hash are
 * considered "the same element" for `isNew` purposes.
 */
export function hashElement(el: HTMLElement, attrs?: Record<string, string>): string {
  return fnv1aHash(elementIdentity(el, attrs));
}
