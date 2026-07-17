/**
 * Page-state extraction — produces the `[index]<tag attrs />` tree text that
 * the navigator LLM reads each step, along with a {@link selectorMap} that
 * lets the action executor resolve an `[index]` back to its live
 * `HTMLElement`.
 *
 * Capabilities:
 * - Shadow DOM traversal (open roots, and closed roots via
 * {@link ../annotation/shadow-piercer}'s patch)
 * - Same-origin iframe traversal
 * - SHA-style stable element hashing (FNV-1a of branch-path + key attrs) so
 * the agent can mark elements with `*` when they are new since the last step
 * - Visibility and interactivity filtering (interactive elements get an index)
 *
 * The module keeps the last selectorMap and hash set in closure so successive
 * calls can compute `isNew` correctly across steps.
 *
 * Element classification (`isInteractive`, `isVisible`, `directText`, the
 * SKIP_TAGS list) lives in {@link ../utils} (extracted from the historical
 * `dom/dom-utils.ts`) and is shared with the AX-tree builder
 * ({@link ./ax-tree-builder}). This file re-exports `isVisible` (the cheap
 * wrapper around `isVisibleFull`) so consumers that historically imported it
 * from `dom/extractor` keep working — the legacy `dom/extractor.ts` is now a
 * thin re-export shim that pulls from this file plus
 * {@link ./element-info} and `../utils/classification`.
 */

import type { BrowserState, ExtractedElement, TabInfo } from "../../types";
import {
  isInteractive,
  isVisibleFull,
  isLikelyHidden,
  directText,
  isSensitive,
} from "../utils";
import { buildAttrs, hashElement, DOM_CONFIG, redactUrlTokens, redactPathSecrets, resetHashCaches } from "./element-info";
import { getShadowRoot, installShadowPiercer } from "../annotation/shadow-piercer";

// ─── Backwards-compat re-exports ────────────────────────────────────────────
//
// The historical `extractor.ts` re-exported `isInteractive` (as a
// `const isInteractive = isInteractiveImpl` alias) and provided a thin
// `isVisible(el)` wrapper around `isVisibleFull`. The thin wrapper is kept
// here for callers that import it from `dom/extractor` via the shim. The
// `isInteractive` re-export is NOT done here (to avoid a name collision in
// the re-export shim set, which also re-exports `isInteractive` from
// `./utils/classification`) — the `dom/extractor.ts` shim re-exports it
// directly from `./utils/classification`.

/**
 * Determine whether an element is currently visible to the user. Combines
 * computed style, opacity, bounding-box, and `aria-hidden` checks.
 *
 * Re-export of {@link isVisibleFull} from {@link ../utils/visibility}. Callers that
 * already hold a `DOMRect` (e.g. the walker, which needs the rect for the
 * `ExtractedElement` payload anyway) should call `isVisibleFull(el, rect)`
 * directly to skip the second layout flush.
 */
export function isVisible(el: HTMLElement): boolean {
  return isVisibleFull(el);
}

// ─── Walker ──────────────────────────────────────────────────────────────────

/** Max length for a single attribute value rendered into the tree text. */
const MAX_ATTR_VALUE_LENGTH = 200;

/**
 * Hard cap on DOM-walk recursion depth. The AX tree bounds its walk at
 * `DEFAULT_MAX_DEPTH`; this mirrors that guard so a pathologically deep or
 * adversarial (cyclic) DOM can't drive unbounded recursion. Only extremely
 * deep subtrees are truncated — the cap is configurable.
 */
const MAX_WALK_DEPTH = 100;

/**
 * Hard cap on the number of elements emitted (prevents runaway output on a
 * pathological or adversarial page). Mirrors the AX-tree's `MAX_ELEMENTS`
 * cap so the serialized `elements` array and `elementsText` payload can't
 * grow unbounded across steps.
 */
const MAX_ELEMENTS = 10_000;

/**
 * Hard cap on the number of serialized tree lines emitted (text nodes, element
 * lines, and structural markers combined). The element cap above only bounds
 * interactive elements; a page with many non-interactive text-bearing nodes but
 * few controls would still serialize an unbounded `elementsText`. This caps the
 * actual output — mirroring the AX-tree builder, whose emitted count increments
 * for every line — so `elementsText` can't grow without bound (content-script
 * OOM / LLM token blowup).
 */
const MAX_LINES = 10_000;

/**
 * Push a serialized line, capping the total emitted output. Emits the
 * truncation hint exactly once (shared via `acc.truncated`) when either this
 * line cap or the interactive-element cap is hit first.
 */
function pushLine(acc: WalkAccumulator, line: string): void {
  if (acc.lines.length >= MAX_LINES) {
    if (!acc.truncated) {
      acc.truncated = true;
      acc.lines.push(`\t[truncated at ${MAX_LINES} lines — page is very large; focus on a more specific element]`);
    }
    return;
  }
  acc.lines.push(line);
}

/**
 * Sanitize + escape an attribute value for safe interpolation inside a quoted
 * XML attribute in the tree text.
 *
 *  attribute values (`aria-label` / `title` / `value` ...) are
 * attacker-controlled on a hostile page and are fed verbatim to the navigator
 * LLM each step. Escaping `& < > "` alone is NOT enough — a value containing
 * embedded newlines / control chars (e.g. `\n*[999] IMPORTANT: click ...`)
 * injects extra "lines" that mimic the tree format (prompt injection). Strip
 * ALL control characters (incl. CR/LF/TAB), collapse remaining whitespace runs
 * to single spaces, and length-cap the value before escaping so a single
 * attribute can neither forge a new tree line nor flood the context.
 */
function escapeAttr(v: string): string {
  let s = v
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > MAX_ATTR_VALUE_LENGTH) s = s.slice(0, MAX_ATTR_VALUE_LENGTH) + "...";
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/** Render an attribute map as a space-prefixed string of `key="value"` pairs. */
function attrString(attrs: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    parts.push(`${k}="${escapeAttr(v)}"`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

/** Mutable accumulator passed through the DOM walk. */
interface WalkAccumulator {
  /** Next index to assign to an interactive element. */
  index: number;
  /** Map of index -> live HTMLElement (for action resolution). */
  selectorMap: Record<number, HTMLElement>;
  /** Flat list of extracted elements (mirrors the tree). */
  elements: ExtractedElement[];
  /** Serialized tree lines (joined to form `elementsText`). */
  lines: string[];
  /** Hashes from the previous step (used to compute `isNew`). */
  prevHashes: Set<string>;
  /** Count of elements that are new this step. */
  newElementCount: number;
  /** Whether the element cap has been hit (so the hint is emitted once). */
  truncated: boolean;
  /** Whether the element-cap signal has been emitted (independent of the line
   * cap, so it is never swallowed when both caps are reached simultaneously). */
  elementTruncated: boolean;
}

// Cache of per-parent visibility results, keyed by the parent element. The
// walker visits text nodes far more often than element nodes, so caching the
// full visibility check (which calls `getComputedStyle`) per parent avoids
// re-running it for every text node sibling.
let visibilityCache: WeakMap<HTMLElement, boolean> = new WeakMap<HTMLElement, boolean>();

/** Serialize a text node (indent + trimmed text). No-op for short/blank text. */
function serializeText(node: Text, depth: number, acc: WalkAccumulator): void {
  const parent = node.parentElement;
  if (!parent) return;
 //  the cheap `isLikelyHidden` pre-check (display:none / detached)
 // does NOT catch `visibility:hidden` / `opacity:0` / `aria-hidden` /
 // off-screen content. A text node's parent must be *actually* visible before
 // its text is surfaced to the LLM, otherwise invisible-to-the-user content
 // (e.g. hidden tracking text) leaks into `elementsText`. Cache per-parent.
  let visible = visibilityCache.get(parent);
  if (visible === undefined) {
    visible = isVisibleFull(parent);
    visibilityCache.set(parent, visible);
  }
  if (!visible) return;

  const t = (node.textContent || "").replace(/\s+/g, " ").trim();
  if (t.length >= DOM_CONFIG.minTextLength) {
    pushLine(acc, "\t".repeat(depth) + escapeAttr(t));
  }
}

/** Serialize an element node (and recursively its children + shadow DOM). */
function serializeElement(el: HTMLElement, depth: number, acc: WalkAccumulator): void {
 // Bail out past the depth cap so a pathologically deep / cyclic DOM can't
 // drive unbounded recursion (mirrors the AX-tree maxDepth guard).
  if (depth > MAX_WALK_DEPTH) return;
 // Bail out once the element cap is reached so a pathological / adversarial
 // DOM can't drive an unbounded `elements` array or `elementsText` payload.
  if (acc.elements.length >= MAX_ELEMENTS) {
   // Emit the element-cap signal directly (not via `pushLine`) so the line
   // cap can never swallow it when both caps are reached on the same element
   // (e.g. when `MAX_LINES === MAX_ELEMENTS` and the Nth line lands exactly on
   // the cap). The signal must always be surfaced so a regression that stops
   // clamping the `elements` array is caught.
    if (!acc.elementTruncated) {
      acc.elementTruncated = true;
      acc.lines.push(`\t[truncated at ${MAX_ELEMENTS} elements — page is very large; focus on a more specific element]`);
    }
    return;
  }
  const tag = el.tagName.toLowerCase();

 // LOW-1 check isLikelyHidden BEFORE the skipTags/iframe check so a
 // `display: none` iframe doesn't bypass the visibility pre-check and walk
 // its contentDocument (surfacing hidden iframe content to the LLM).
  if (isLikelyHidden(el)) return;

  if (DOM_CONFIG.skipTags.has(tag) || tag === "iframe") {
 // iframes are handled separately for same-origin traversal.
    if (tag === "iframe") trySerializeIframe(el as HTMLIFrameElement, depth, acc);
    return;
  }

 // For interactive elements, do the full visibility check (which may invoke
 // `getComputedStyle`) AND capture the rect once for reuse below. The rect
 // is passed to `isVisibleFull` so it doesn't have to fetch it again.
  let rect: DOMRect | undefined;
  let interactive = false;
  if (isInteractive(el)) {
    rect = el.getBoundingClientRect();
    if (!isVisibleFull(el, rect)) return;
    interactive = true;
  }
 // For non-interactive elements we deliberately skip the expensive
 // `isVisibleFull` check — `isLikelyHidden` already caught display:none /
 // detached, and a non-interactive parent with opacity:0 / visibility:hidden
 // emits no line itself. Its interactive descendants will be filtered by
 // their own `isVisibleFull` check when they're visited.
 //
 // Note on behavior: this is a small, intentional change from the previous
 // unconditional `isVisible` call. Previously, a non-interactive parent with
 // `opacity:0` would short-circuit the whole subtree (its interactive
 // children were never visited). Now we visit the subtree; an interactive
 // child whose own computed `opacity` is "1" (CSS `opacity` doesn't inherit
 // in computed-value terms — only its visual effect multiplies) will be
 // emitted. This is rare (opacity:0 parents are uncommon) and the win —
 // skipping `getComputedStyle` for the vast majority of non-interactive
 // nodes — is large.

  if (interactive) {
    const idx = ++acc.index;
    const attrs = buildAttrs(el);
    const hash = hashElement(el, attrs);
    const isNew = !acc.prevHashes.has(hash);
    if (isNew) acc.newElementCount++;
    const text = directText(el) || el.getAttribute("aria-label") || "";
    acc.selectorMap[idx] = el;
    acc.elements.push({ index: idx, tag, text, attributes: attrs, hash, rect: rect! });
    const prefix = isNew ? "*" : "";
    pushLine(
      acc,
      "\t".repeat(depth) + `${prefix}[${idx}]<${tag}${attrString(attrs)} />`
    );
 // Compound controls (select, range, details, file input) get virtual
 // child lines describing their internal structure (e.g. the first 4
 // options of a select). Emitted BEFORE descending into real children so
 // the virtual structure sits right under the parent's indexed line.
    serializeCompoundChildren(el, depth, acc);
 // Sensitive <select> elements must not leak their real <option> text into
 // elementsText. buildCompoundChildren already emits a redacted virtual
 // <option>[value redacted]</option> line, so skip the real children / shadow
 // DOM descent here — each visible <option> is itself interactive and would
 // otherwise emit its secret text. Mirrors the AX-tree's sensitive-option guard.
    if (!(el.tagName.toLowerCase() === "select" && isSensitive(el))) {
 // Descend into children (so nested text/elements render as children).
      for (const child of Array.from(el.childNodes)) {
        walkNode(child, depth + 1, acc);
      }
 // Descend into shadow DOM if present (pierces closed roots via the
 // shadow-piercer module when installed).
      const sr = getShadowRoot(el);
      if (sr) {
        for (const child of Array.from(sr.childNodes)) {
          walkNode(child, depth + 1, acc);
        }
      }
    }
    return;
  }

 // Non-interactive: descend without emitting a tag line.
  for (const child of Array.from(el.childNodes)) {
    walkNode(child, depth + 1, acc);
  }
  const sr = getShadowRoot(el);
  if (sr) {
    for (const child of Array.from(sr.childNodes)) {
      walkNode(child, depth + 1, acc);
    }
  }
}

/**
 * Redact query-string / fragment tokens from an iframe `src` before it is
 * forwarded to the LLM. The URL often carries session / PII / tracking tokens
 * (ads, payments, reCAPTCHA) in its query or fragment; stripping them keeps
 * the frame identifiable (scheme + host + path) for navigation without leaking
 * embedded secrets. Falls back to a defensive `?…/#…` strip for relative /
 * unparseable URLs.
 */
function redactIframeSrc(src: string): string {
  try {
    const u = new URL(src);
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
    return redactPathSecrets(src.replace(/[?#].*$/, ""));
  }
}

/** Attempt to serialize the contents of a same-origin iframe. */
function trySerializeIframe(iframe: HTMLIFrameElement, depth: number, acc: WalkAccumulator): void {
  try {
    const doc = iframe.contentDocument;
 // MEDIUM-2 `contentDocument` returns null for cross-origin iframes
 // (per HTML spec — does NOT throw). The previous code's catch block
 // (which emits the cross-origin marker) was dead code for the common case.
 // Emit the marker in the null branch so the LLM is aware of cross-origin
 // iframes (ads, payment embeds, reCAPTCHA, etc.).
    if (!doc || !doc.body) {
      pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "(blank)"))} (cross-origin or not loaded)|`);
      return;
    }
    pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "same-origin"))}|`);
    try {
      for (const child of Array.from(doc.body.childNodes)) {
        walkNode(child, depth + 1, acc);
      }
    } catch {
 // A misbehaving same-origin subframe (e.g. a getter that throws, a
 // unusual custom element, or a detached-node race) must not abort the
 // whole page-state read — emit a marker and continue, matching the
 // cross-origin fallback style.
      pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "same-origin"))} (error reading contents)|`);
    }
  } catch {
 // Cross-origin security exception — can't read contents. Surface the URL only.
    pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src))} (cross-origin)|`);
  }
}

/** Dispatch a node to the correct serializer based on its node type. */
function walkNode(node: Node, depth: number, acc: WalkAccumulator): void {
  if (node.nodeType === Node.ELEMENT_NODE) {
    serializeElement(node as HTMLElement, depth, acc);
  } else if (node.nodeType === Node.TEXT_NODE) {
    serializeText(node as Text, depth, acc);
  }
}

// ─── Page info ──────────────────────────────────────────────────────────────

/** Build the "N pages above, M pages below" string for the LLM. */
function buildPageInfo(scrollTop: number, scrollHeight: number, vh: number): string {
  const above = vh > 0 ? scrollTop / vh : 0;
  const below = vh > 0 ? Math.max(0, scrollHeight - scrollTop - vh) / vh : 0;
  let info = `${above.toFixed(1)} pages above, ${below.toFixed(1)} pages below`;
  if (below > 0.1) info += " — scroll down to reveal more content";
  return info;
}

// ─── Module-level state ─────────────────────────────────────────────────────
// The content script keeps the last selectorMap + hashes in closure so
// EXECUTE_ACTIONS can resolve indexes and `isNew` works across steps.

let cachedSelectorMap: Record<number, HTMLElement> = {};
let cachedHashes: Set<string> = new Set();

// Install the shadow-DOM piercer at module load so `attachShadow` calls made
// AFTER this module is imported are captured (both open and closed roots).
// `tagExisting: true` also records open shadow roots that pre-date the import.
// Idempotent — safe to call again from the MAIN-world entry point. The guard
// catches non-DOM environments (Node.js without jsdom) where `Element` is
// undefined and there's nothing to patch.
//
// PRESERVED FROM THE ORIGINAL `dom/extractor.ts` — the side effect runs when
// this module is first imported (e.g. when the legacy `dom/extractor.ts` shim
// re-exports from here, importing the shim triggers this module's
// evaluation).
try {
  installShadowPiercer({ tagExisting: true });
} catch {
  /* non-DOM environment (e.g. Node.js without jsdom) — nothing to pierce */
}

/**
 * Reset the `isNew` baseline (e.g. after a navigation, when the whole page is
 * effectively "new").
 */
export function resetDomBaseline(): void {
  cachedHashes = new Set();
}

/**
 * Extract the full browser state from the current document.
 *
 * @param tabs open tabs (extension: chrome.tabs query; in-page demo: [current]).
 * @returns a {@link BrowserState} whose serialisable fields (`url`, `title`,
 * `elements` (with `text`/`attributes`/`hash`), `elementsText`, `pageInfo`,
 * `newElementCount`, `scroll*`, `viewportHeight`) are safe to forward to the
 * LLM. **Runtime-only fields** — `selectorMap` (live `HTMLElement`s) and each
 * `elements[].rect` (a `DOMRect`) — must be STRIPPED before serialisation:
 * a live `HTMLElement`/`DOMRect` JSON-stringifies to `{}`, so forwarding the
 * raw object ships useless `{}` bloat (no secret leak, but a latent
 * payload/contract bug for any future caller that forgets to strip). The
 * action executor resolves an `[index]` back to its live element via
 * {@link getSelectorMap}, which returns this same map.
 */
export function extractBrowserState(tabs: TabInfo[]): BrowserState {
 // Visibility can change between agent steps (a container gains
 // `visibility:hidden`/`opacity:0`/`aria-hidden`, or a hidden modal becomes
 // visible). The module-level `visibilityCache` is keyed by parent element but
 // is otherwise shared mutable state; reset it each read so visibility is
 // recomputed fresh and no stale result leaks hidden text or drops visible text.
  visibilityCache = new WeakMap<HTMLElement, boolean>();
 // Reset the nth-of-type index cache so it reflects THIS snapshot's DOM
 // (see `nthOfTypeIndex` in element-info.ts). The walk is otherwise O(n^2) on
 // pages with many same-tag siblings.
  resetHashCaches();
  const acc: WalkAccumulator = {
    index: 0,
    selectorMap: {},
    elements: [],
    lines: [],
    prevHashes: cachedHashes,
    newElementCount: 0,
    truncated: false,
    elementTruncated: false,
  };

  if (document.body) {
    try {
      for (const child of Array.from(document.body.childNodes)) {
        walkNode(child, 0, acc);
      }
    } catch (e) {
 // A single misbehaving node/subframe shouldn't blank the whole page-state
 // read (finding: extractBrowserState had no error guard — a mid-walk throw
 // left a stale selectorMap + aborted the run). However, a mid-walk throw
 // can leave a half-built `selectorMap` referencing detached nodes or a
 // partial/garbled index (finding: mid-walk throw leaves the faulting
 // element in selectorMap). Drop whatever was partially collected so a
 // subsequent action resolution falls back to a FRESH full extract instead
 // of acting on stale/garbled indices.
      console.warn("[page-state] DOM walk threw mid-extract (resetting selectorMap to avoid stale indices):", e);
      acc.selectorMap = {};
      acc.elements = [];
      acc.lines = [];
    }
  }

 // Update the baseline for next step's `isNew` computation. Always refresh the
 // cached map from THIS run (even on a partial extract) so a prior run's stale
 // selectorMap is never left behind for action resolution.
  cachedHashes = new Set(acc.elements.map((e) => e.hash));
  cachedSelectorMap = acc.selectorMap;

  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  const scrollHeight = document.documentElement.scrollHeight;
  const vh = window.innerHeight;
  const elementsText = acc.lines.join("\n");

  return {
    url: redactUrlTokens(location.href),
    title: document.title,
    tabs,
    elements: acc.elements,
    elementsText: elementsText.trim().length > 0
      ? `<untrusted_page_state>\n${elementsText}\n</untrusted_page_state>`
      : "[empty page]",
    pageInfo: buildPageInfo(scrollTop, scrollHeight, vh),
    newElementCount: acc.newElementCount,
    scrollTop,
    scrollHeight,
    viewportHeight: vh,
    selectorMap: acc.selectorMap,
  };
}

/**
 * Get the cached selector map from the last {@link extractBrowserState} call.
 * The action executor uses this to resolve an `[index]` to a live element.
 */
export function getSelectorMap(): Record<number, HTMLElement> {
  return cachedSelectorMap;
}

// The `extractBrowserState` function above produces a flat
// `[index]<tag attrs />` tree the navigator LLM reads each step.

// ─── Compound control virtual children ─────────────────────────────────────
//
// Compound controls (select, range, details, file input) have internal
// structure the LLM can't see from the single indexed line. Virtual children
// are rendered as indented `<tag attrs /> text` lines WITHOUT an index — they
// describe the control's structure so the LLM knows what to expect when it
// interacts with the parent (e.g. "this select has 4 options: US, CA, MX, UK").
// The LLM references the PARENT's `[index]` to interact; the `select_dropdown`
// action takes a `text` parameter to pick the right option.

/** A virtual child descriptor — rendered as `<tag attrs /> text` (no index). */
interface VirtualChild {
  /** Lowercased tag name (e.g. "option", "slider", "summary", "button"). */
  tag: string;
  /** Inline text label (e.g. the option's text, "Browse Files", "Toggle"). */
  text: string;
  /** Selected attributes surfaced to the LLM (e.g. value, valuemin, valuemax). */
  attributes: Record<string, string>;
}

/**
 * Build the virtual children for a compound control element. Returns an empty
 * array for non-compound elements. The virtual children describe the control's
 * internal structure so the LLM can reason about it without first clicking.
 *
 * Supported compound controls:
 * - `<select>`: first N `<option>` children as `<option value="..." /> text`
 * - `<input type="range">`: a `<slider valuemin valuemax valuenow />` line
 * - `<details>`: a `<summary /> Toggle` line (or the summary's text)
 * - `<input type="file">`: a `<button /> Browse Files` line
 */
function buildCompoundChildren(el: HTMLElement): VirtualChild[] {
  const tag = el.tagName.toLowerCase();
  const children: VirtualChild[] = [];

  if (el instanceof HTMLSelectElement) {
 // Sensitive selects (autocomplete=cc-*, one-time-code, etc.) must NOT emit
 // the `selected` flag or option values — the LLM could infer the user's
 // card expiry month / OTP from which option is selected. The AX tree
 // (ax-tree-builder.ts) already skips option emission for sensitive selects;
 // this brings the indexed tree in line. Mirrors the sensitive-value
 // redaction in element-info.buildAttrs.
    if (isSensitive(el)) {
      children.push({ tag: "option", text: "[value redacted]", attributes: {} });
      return children;
    }
    const opts = Array.from(el.options);
    const limit = Math.min(DOM_CONFIG.compoundOptionLimit, opts.length);
    for (let i = 0; i < limit; i++) {
      const o = opts[i];
      const text =
        (o.textContent || "").replace(/\s+/g, " ").trim() ||
        (o.value || "").replace(/\s+/g, " ");
      const attrs: Record<string, string> = { value: o.value };
      if (o.selected) attrs.selected = "";
      if (o.disabled) attrs.disabled = "";
      children.push({ tag: "option", text, attributes: attrs });
    }
    if (opts.length > limit) {
      const more = opts.length - limit;
      children.push({
        tag: "option",
        text: `... ${more} more option${more === 1 ? "" : "s"}`,
        attributes: {},
      });
    }
    return children;
  }

  if (tag === "input" && el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === "range") {
      const min = el.getAttribute("min") ?? "0";
      const max = el.getAttribute("max") ?? "100";
      const now = el.value || "";
      children.push({
        tag: "slider",
        text: "Value",
        attributes: { valuemin: min, valuemax: max, valuenow: now },
      });
    } else if (type === "file") {
      const files = el.files;
      let fileText = "No file chosen";
      if (files && files.length > 0) {
        fileText =
          files.length === 1
            ? (files[0].name || "").replace(/\s+/g, " ")
            : `${files.length} files selected`;
      }
      children.push({ tag: "button", text: "Browse Files", attributes: {} });
      children.push({ tag: "textbox", text: fileText, attributes: { label: "File Selected" } });
    }
    return children;
  }

  if (tag === "details") {
 // If a <summary> child exists, surface its text; otherwise emit a generic
 // "Toggle" label so the LLM knows the details element is expandable.
    const summary = el.querySelector("summary");
    const summaryText = summary
      ? (summary.textContent || "").replace(/\s+/g, " ").trim()
      : "";
    const open: Record<string, string> = el.hasAttribute("open") ? { open: "" } : {};
    children.push({
      tag: "summary",
      text: summaryText || "Toggle",
      attributes: open,
    });
    return children;
  }

  return children;
}

/**
 * Serialize the virtual children of a compound control as indented
 * `<tag attrs /> text` lines (no index). Virtual children are informational —
 * they don't go in the selectorMap or elements array, so the LLM references
 * the parent's `[index]` to interact with the control.
 */
function serializeCompoundChildren(el: HTMLElement, depth: number, acc: WalkAccumulator): void {
  const children = buildCompoundChildren(el);
  if (children.length === 0) return;
  const indent = "\t".repeat(depth + 1);
  for (const vc of children) {
 // Escape the trailing text (and collapse any stray newlines) so a value
 // containing `<`, `>`, `&`, or a newline can't break the one-line-per-
 // element contract after the `/>` token.
    const safeText = vc.text ? " " + escapeAttr(vc.text) : "";
    pushLine(acc, `${indent}<${vc.tag}${attrString(vc.attributes)} />${safeText}`);
  }
}
