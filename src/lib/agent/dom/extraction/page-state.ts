import type { BrowserState, ExtractedElement, TabInfo } from "../../types";
import {
  isInteractive,
  isVisibleFull,
  isLikelyHidden,
  beginVisibilityCache,
  endVisibilityCache,
  directText,
} from "../utils";
import { buildAttrs, hashElement, DOM_CONFIG, resetHashCaches } from "./element-info";
import { redactUrlTokens } from "./element-info-utils";
import { getShadowRoot, installShadowPiercer } from "../annotation/shadow-piercer";
import { escapeAttr, attrString, buildPageInfo, buildCompoundChildren } from "./page-state-utils";

export function isVisible(el: HTMLElement): boolean {
  return isVisibleFull(el);
}

const MAX_WALK_DEPTH = 100;
const MAX_ELEMENTS = 10_000;
const MAX_LINES = 10_000;

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
let cachedHashes: Set<string> = new Set();

try {
  installShadowPiercer({ tagExisting: true });
} catch {
  /* non-DOM environment */
}

export function resetDomBaseline(): void {
  cachedHashes = new Set();
}

export function extractBrowserState(tabs: TabInfo[]): BrowserState {
  visibilityCache = new WeakMap<HTMLElement, boolean>();
  resetHashCaches();
  beginVisibilityCache();
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
      acc.elements = [];
      acc.lines = [];
    } finally {
      endVisibilityCache();
    }
  } else {
    endVisibilityCache();
  }
  cachedHashes = new Set(acc.elements.map((e) => e.hash));
  cachedSelectorMap = acc.selectorMap;
  const scrollTop = window.scrollY || 0;
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

export function getSelectorMap(): Record<number, HTMLElement> {
  return cachedSelectorMap;
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
