import type { BrowserState, ExtractedElement, TabInfo } from "../../types";
import {
  isInteractive,
  isInteractiveContainer,
  isVisibleFull,
  isLikelyHidden,
  beginVisibilityCache,
  endVisibilityCache,
  directText,
} from "../utils";
import { buildAttrs, hashElement, elementIdentity, DOM_CONFIG, resetHashCaches } from "./element-info";
import { redactUrlTokens } from "./element-info-utils";
import { getShadowRoot } from "../annotation/shadow-piercer";
import { escapeAttr, attrString, buildPageInfo, buildCompoundChildren } from "./page-state-utils";

export function isVisible(el: HTMLElement): boolean {
  return isVisibleFull(el);
}

const MAX_WALK_DEPTH = 100;
const MAX_ELEMENTS = 10_000;
const MAX_LINES = 10_000;

/** Char budget for the serialized snapshot handed to the model per window. */
export const MAX_SNAPSHOT_CHARS = 80_000;
/** Keep the last N chars (pagination/nav links) in every window. */
export const SNAPSHOT_TAIL_CHARS = 5_000;
/** Room reserved inside the window budget for the truncation marker. */
const SNAPSHOT_MARKER_ROOM = 200;

/** One paged window of a serialized snapshot. */
export interface SnapshotWindow {
  text: string;
  truncated: boolean;
  totalChars: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/**
 * Window a serialized snapshot: `offset=0` returns the head of the page,
 * `offset=N` resumes at char N. When the snapshot fits under
 * {@link MAX_SNAPSHOT_CHARS} it is returned unchanged. The tail is always
 * included so pagination/nav links stay available in every window.
 *
 * The marker sits at the HEAD of the window: the message layer re-caps
 * `elementsText` at 60k from the start (loop/messages.ts), which would
 * otherwise cut a mid-window marker and hide the resume offset from the model.
 * The tail is placed BEFORE the chunk for the same reason — a trailing tail
 * falls outside the 60k visible budget (and outside the history render
 * window for `page_next` results), which would silently drop the nav links
 * the tail exists to preserve.
 */
export function windowSnapshot(yaml: string, offset = 0): SnapshotWindow {
  if (!yaml) {
    return { text: "", truncated: false, totalChars: 0, offset: 0, hasMore: false, nextOffset: null };
  }
  const total = yaml.length;
  if (total <= MAX_SNAPSHOT_CHARS) {
    return { text: yaml, truncated: false, totalChars: total, offset: 0, hasMore: false, nextOffset: null };
  }
  const contentBudget = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - SNAPSHOT_MARKER_ROOM;
  const tail = yaml.slice(-SNAPSHOT_TAIL_CHARS);
  const clampedOffset = Math.min(Math.max(0, offset), total - SNAPSHOT_TAIL_CHARS);
  const chunk = yaml.slice(clampedOffset, clampedOffset + contentBudget);
  const chunkEnd = clampedOffset + contentBudget;
  const hasMore = chunkEnd < total - SNAPSHOT_TAIL_CHARS;
  const marker = hasMore
    ? `[... truncated at char ${chunkEnd} of ${total}. Call page_next with offset=${chunkEnd} to see more. Pagination links below. ...]\n`
    : "";
  return {
    text: marker + tail + "\n" + chunk,
    truncated: true,
    totalChars: total,
    offset: clampedOffset,
    hasMore,
    nextOffset: hasMore ? chunkEnd : null,
  };
}

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

interface WalkAccumulator {
  index: number;
  selectorMap: Record<number, HTMLElement>;
  /**
   * Per-index element identity (`elementIdentity(el)`) captured at the same
   * moment the element enters the selector map. The executor re-verifies a
   * live element against this at action time — see
   * `tools/helpers/element-resolver.ts` — so a node that was replaced or
   * re-ordered since extraction fail-closes instead of being operated on.
   */
  identities: Record<number, string>;
  elements: ExtractedElement[];
  lines: string[];
  prevHashes: Set<string>;
  newElementCount: number;
  truncated: boolean;
  elementTruncated: boolean;
}

let visibilityCache: WeakMap<HTMLElement, boolean> = new WeakMap<HTMLElement, boolean>();

function serializeText(node: Text, depth: number, acc: WalkAccumulator): void {
  const parent = node.parentElement;
  if (!parent) return;
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

/** Walk an element's light-DOM children then pierce into its shadow root. */
function walkLightAndShadowChildren(el: HTMLElement, depth: number, acc: WalkAccumulator): void {
  for (let child = el.firstChild; child; child = child.nextSibling) {
    walkNode(child, depth + 1, acc);
  }
  const sr = getShadowRoot(el);
  if (sr) {
    for (let child = sr.firstChild; child; child = child.nextSibling) {
      walkNode(child, depth + 1, acc);
    }
  }
}

function serializeElement(el: HTMLElement, depth: number, acc: WalkAccumulator): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (acc.elements.length >= MAX_ELEMENTS) {
    if (!acc.elementTruncated) {
      acc.elementTruncated = true;
      acc.lines.push(`\t[truncated at ${MAX_ELEMENTS} elements — page is very large; focus on a more specific element]`);
    }
    return;
  }
  const tag = el.tagName.toLowerCase();

  if (isLikelyHidden(el)) return;

  if (DOM_CONFIG.skipTags.has(tag) || tag === "iframe") {
    if (tag === "iframe") trySerializeIframe(el as HTMLIFrameElement, depth, acc);
    if (tag === "svg" && isInteractive(el)) {
      const idx = ++acc.index;
      const attrs = buildAttrs(el);
      const hash = hashElement(el, attrs);
      const isNew = !acc.prevHashes.has(hash);
      if (isNew) acc.newElementCount++;
      const text = directText(el) || el.getAttribute("aria-label") || "";
      acc.selectorMap[idx] = el;
      acc.identities[idx] = elementIdentity(el, attrs);
      acc.elements.push({ index: idx, tag, text, attributes: attrs, hash, rect: el.getBoundingClientRect() });
      const prefix = isNew ? "*" : "";
      pushLine(acc, "\t".repeat(depth) + `${prefix}[${idx}]<${tag}${attrString(attrs)} />`);
    }
    return;
  }

  let rect: DOMRect | undefined;
  let interactive = false;
  if (isInteractive(el)) {
    rect = el.getBoundingClientRect();
    const visible = isVisibleFull(el, rect);
    visibilityCache.set(el, visible);
    if (!visible) return;
    interactive = true;
  }

  if (interactive) {
    const idx = ++acc.index;
    const attrs = buildAttrs(el);
    const hash = hashElement(el, attrs);
    const isNew = !acc.prevHashes.has(hash);
    if (isNew) acc.newElementCount++;
    const text = directText(el) || el.getAttribute("aria-label") || "";
    acc.selectorMap[idx] = el;
    acc.identities[idx] = elementIdentity(el, attrs);
    acc.elements.push({ index: idx, tag, text, attributes: attrs, hash, rect: rect! });
    const prefix = isNew ? "*" : "";
    pushLine(acc, "\t".repeat(depth) + `${prefix}[${idx}]<${tag}${attrString(attrs)} />`);
    serializeCompoundChildren(el, depth, acc);
    if (tag === "select") return;
    if (tag === "details") {
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if ((child as HTMLElement)?.tagName?.toLowerCase?.() === "summary") continue;
        walkNode(child, depth + 1, acc);
      }
      return;
    }
  }

  if (isInteractiveContainer(el)) {
    const idx = ++acc.index;
    const attrs = buildAttrs(el);
    const hash = hashElement(el, attrs);
    const isNew = !acc.prevHashes.has(hash);
    if (isNew) acc.newElementCount++;
    const text = directText(el) || el.getAttribute("aria-label") || "";
    const containerRect = el.getBoundingClientRect();
    acc.selectorMap[idx] = el;
    acc.identities[idx] = elementIdentity(el, attrs);
    acc.elements.push({ index: idx, tag, text, attributes: attrs, hash, rect: containerRect });
    const prefix = isNew ? "*" : "";
    pushLine(acc, "\t".repeat(depth) + `${prefix}[${idx}]<${tag}${attrString(attrs)} />`);
  }

  walkLightAndShadowChildren(el, depth + 1, acc);
}

function redactIframeSrc(src: string): string {
  return redactUrlTokens(src);
}

function trySerializeIframe(iframe: HTMLIFrameElement, depth: number, acc: WalkAccumulator): void {
  try {
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) {
      pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "(blank)"))} (cross-origin or not loaded)|`);
      return;
    }
    pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "same-origin"))}|`);
    try {
      for (let child = doc.body.firstChild; child; child = child.nextSibling) {
        walkNode(child, depth + 1, acc);
      }
    } catch {
      pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "same-origin"))} (error reading contents)|`);
    }
  } catch {
    pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src))} (cross-origin)|`);
  }
}

function walkNode(node: Node, depth: number, acc: WalkAccumulator): void {
  if (acc.elementTruncated) return;
  if (node.nodeType === Node.ELEMENT_NODE) {
    serializeElement(node as HTMLElement, depth, acc);
  } else if (node.nodeType === Node.TEXT_NODE) {
    serializeText(node as Text, depth, acc);
  }
}

let cachedSelectorMap: Record<number, HTMLElement> = {};
let cachedIdentities: Record<number, string> = {};
let cachedHashes: Set<string> = new Set();
/** Full serialized snapshot from the last successful extract (paging cache). */
let snapshotCacheText: string | null = null;

export function resetDomBaseline(): void {
  cachedHashes = new Set();
}

/**
 * Return the next window of the cached snapshot serialization (or null when
 * no snapshot has been extracted in this content-script instance). The
 * `page_next` action consumes this to page through a truncated page.
 */
export function pageSnapshotChunk(offset?: number): SnapshotWindow | null {
  if (snapshotCacheText === null) return null;
  return windowSnapshot(snapshotCacheText, offset ?? 0);
}

export function extractBrowserState(tabs: TabInfo[]): BrowserState {
  visibilityCache = new WeakMap<HTMLElement, boolean>();
  resetHashCaches();
  beginVisibilityCache();
  // Redact each tab URL at the boundary, the same way `location.href` below is
  // redacted — a tab open on an OAuth callback (or a share link carrying a
  // token) would otherwise leak its query-string secrets into page state.
  const redactedTabs = tabs.map((t) => (t.url ? { ...t, url: redactUrlTokens(t.url) } : t));
  const acc: WalkAccumulator = {
    index: 0,
    selectorMap: {},
    identities: {},
    elements: [],
    lines: [],
    prevHashes: cachedHashes,
    newElementCount: 0,
    truncated: false,
    elementTruncated: false,
  };
  let walkFailed = false;
  if (document.body) {
    try {
      // Iterate via firstChild/nextSibling instead of `document.body.childNodes`:
      // reading `childNodes` instantiates a live NodeList on body, and jsdom
      // re-snapshots that list on every child insert/removal (O(children) each),
      // making bulk appends quadratic — see extractor.test.ts test 19.
      for (let child = document.body.firstChild; child; child = child.nextSibling) {
        walkNode(child, 0, acc);
      }
    } catch (e) {
      console.warn("[page-state] DOM walk threw mid-extract (resetting selectorMap to avoid stale indices):", e);
      acc.selectorMap = {};
      acc.identities = {};
      acc.elements = [];
      acc.lines = [];
      walkFailed = true;
    } finally {
      endVisibilityCache();
    }
  } else {
    walkFailed = true;
    endVisibilityCache();
  }
  cachedHashes = new Set(acc.elements.map((e) => e.hash));
  cachedSelectorMap = acc.selectorMap;
  cachedIdentities = acc.identities;
  const scrollTop = window.scrollY || 0;
  const scrollHeight = document.documentElement.scrollHeight;
  const vh = window.innerHeight;
  const rawElementsText = acc.lines.join("\n");
  // Cache only SUCCESSFUL serializations. A failed walk (or a missing body)
  // leaves the page-state degraded; page_next must surface "extract first"
  // instead of paging an empty or stale snapshot.
  snapshotCacheText = walkFailed ? null : rawElementsText;
  const windowedText = windowSnapshot(rawElementsText, 0).text;
  return {
    url: redactUrlTokens(location.href),
    title: document.title,
    tabs: redactedTabs,
    elements: acc.elements,
    elementsText: windowedText.trim().length > 0
      ? `<untrusted_page_state>\n${windowedText}\n</untrusted_page_state>`
      : "[empty page]",
    pageInfo: buildPageInfo(scrollTop, scrollHeight, vh),
    newElementCount: acc.newElementCount,
    scrollTop,
    scrollHeight,
    viewportHeight: vh,
    selectorMap: acc.selectorMap,
    elementIdentities: acc.identities,
  };
}

export function getSelectorMap(): Record<number, HTMLElement> {
  return cachedSelectorMap;
}

/**
 * Per-index element identities captured with the last successful
 * `extractBrowserState` walk. The content-script executor stitches these into
 * the execution-time `BrowserState` so `resolveElement` can reject an action
 * whose target element changed since the observation snapshot (stale-element
 * guard) — see `tools/helpers/element-resolver.ts`.
 */
export function getElementIdentities(): Record<number, string> {
  return cachedIdentities;
}

function serializeCompoundChildren(el: HTMLElement, depth: number, acc: WalkAccumulator): void {
  const children = buildCompoundChildren(el);
  if (children.length === 0) return;
  const indent = "\t".repeat(depth + 1);
  for (const vc of children) {
    const safeText = vc.text ? " " + escapeAttr(vc.text) : "";
    pushLine(acc, `${indent}<${vc.tag}${attrString(vc.attributes)} />${safeText}`);
  }
}
