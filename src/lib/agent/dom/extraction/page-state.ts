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
import { ReadCache, getSharedReadCache } from "../utils/read-cache";
import { bumpDomEpoch, getDomEpoch, installMutationSignal, isMutationSignalArmed } from "../mutation-signal";
import { clearDirtyRoots, getDirtyRoots } from "../dirty-subtrees";
import { getViewportTracker } from "../viewport-tracker";

/**
 * Inversion of the state-cache dependency: the skip-if-unchanged cache
 * (`./state-cache`) registers its invalidator here, so this extraction-base
 * module never imports the cache layer (a `state-cache -> page-state`
 * dependency already exists for the raw extractor — importing back would form
 * a runtime import cycle). Null in graphs where the cache is not loaded
 * (raw-only callers): invalidation is then a no-op, which is correct because
 * there is no snapshot to drop.
 */
let invalidateStateCacheHook: (() => void) | null = null;
export function setStateCacheInvalidator(invalidator: () => void): void {
  invalidateStateCacheHook = invalidator;
}

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
 * `elementsText` at the derived cap from the start (ELEMENTS_TEXT_CHAR_CAP,
 * loop/messages.ts), which would otherwise cut a mid-window marker and hide
 * the resume offset from the model. The tail is placed BEFORE the chunk for
 * the same reason — a trailing tail falls outside the visible budget (and
 * outside the history render window for `page_next` results), which would
 * silently drop the nav links the tail exists to preserve.
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

/**
 * Rolling windowed-snapshot buffers fed one line at a time by
 * {@link appendWindowLine}: `head` holds the first MAX_SNAPSHOT_CHARS chars of
 * the joined serialization (the FULL text on sub-cap pages, so
 * windowSnapshot's raw-return case is reproduced byte-for-byte), `tail` the
 * last SNAPSHOT_TAIL_CHARS, `totalChars` the running joined length. The
 * per-step `elementsText` is assembled from these buffers instead of joining
 * the full text, so a huge page never materializes its full serialization on
 * the hot path.
 */
interface SnapshotWindowBuffer {
  head: string;
  tail: string;
  totalChars: number;
}

/** Append one serialized line to a {@link SnapshotWindowBuffer} — byte-identical
 * to appending `line` (first line) or `"\n" + line` (later lines) to the joined
 * text, with the head capped at MAX_SNAPSHOT_CHARS and the tail keeping the
 * last SNAPSHOT_TAIL_CHARS. */
function appendWindowLine(w: SnapshotWindowBuffer, line: string, isFirstLine: boolean): void {
  if (w.head.length < MAX_SNAPSHOT_CHARS) {
    w.head = isFirstLine ? line : w.head + "\n" + line;
    if (w.head.length > MAX_SNAPSHOT_CHARS) w.head = w.head.slice(0, MAX_SNAPSHOT_CHARS);
  }
  if (line.length >= SNAPSHOT_TAIL_CHARS) {
    w.tail = line.slice(-SNAPSHOT_TAIL_CHARS);
  } else if (isFirstLine) {
    w.tail = line;
  } else {
    w.tail = (w.tail + "\n" + line).slice(-SNAPSHOT_TAIL_CHARS);
  }
  w.totalChars += line.length + (isFirstLine ? 0 : 1);
}

/** Assemble the windowed slice from a {@link SnapshotWindowBuffer} —
 * byte-identical to `windowSnapshot(joinedText, 0).text`: the raw join for
 * sub-cap pages, otherwise `marker + tail + "\n" + head-chunk` with the
 * marker at the HEAD (the message layer re-caps `elementsText` at the derived
 * cap from the start — ELEMENTS_TEXT_CHAR_CAP, loop/messages.ts — which would
 * otherwise cut a mid-window marker and hide the resume offset from the model;
 * see `windowSnapshot`). */
function assembleWindowedText(w: SnapshotWindowBuffer): string {
  if (w.totalChars <= MAX_SNAPSHOT_CHARS) return w.head;
  const contentBudget = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - SNAPSHOT_MARKER_ROOM;
  return (
    `[... truncated at char ${contentBudget} of ${w.totalChars}. Call page_next with offset=${contentBudget} to see more. Pagination links below. ...]\n` +
    w.tail + "\n" + w.head.slice(0, contentBudget)
  );
}

function pushLine(acc: WalkAccumulator, line: string, force = false): void {
  if (!force && acc.lines.length >= MAX_LINES) {
    if (!acc.truncated) {
      acc.truncated = true;
      const marker = `\t[truncated at ${MAX_LINES} lines — page is very large; focus on a more specific element]`;
      acc.lines.push(marker);
      acc.linesWritten++;
      appendWindowLine(acc.window, marker, acc.linesWritten === 1);
    }
    return;
  }
  acc.lines.push(line);
  acc.linesWritten++;
  appendWindowLine(acc.window, line, acc.linesWritten === 1);
}

/**
 * Index an element into the walk: bump the (relative) index counter, record
 * the selector-map entry + identity, push the element and its serialized
 * line. In a partial re-walk the display index is remapped by the
 * accumulator's `indexAssigner` (identity match / freed slot / appended) so
 * the merged arrays keep stable indices for untouched elements.
 */
function pushIndexedElement(
  acc: WalkAccumulator,
  el: HTMLElement,
  tag: string,
  attrs: Record<string, string>,
  identity: string,
  hash: string,
  depth: number,
  rect: DOMRect,
): void {
  const idx = ++acc.index;
  const isNew = !acc.prevHashes.has(hash);
  if (isNew) acc.newElementCount++;
  const text = directText(el) || el.getAttribute("aria-label") || "";
  const displayIdx = acc.indexAssigner ? acc.indexAssigner(idx, identity) : idx;
  acc.selectorMap[displayIdx] = el;
  acc.identities[displayIdx] = identity;
  acc.elements.push({ index: displayIdx, tag, text, attributes: attrs, hash, rect });
  const prefix = isNew ? "*" : "";
  pushLine(acc, "\t".repeat(depth) + `${prefix}[${displayIdx}]<${tag}${attrString(attrs)} />`);
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
  /**
   * Rolling windowed-snapshot buffers fed by pushLine (see
   * {@link appendWindowLine}): `head` holds the first MAX_SNAPSHOT_CHARS chars
   * of the serialized text (the full text on sub-cap pages — byte-identical to
   * windowSnapshot's raw return), `tail` the last SNAPSHOT_TAIL_CHARS. The
   * per-step `elementsText` is assembled from these instead of joining the
   * full text.
   */
  window: SnapshotWindowBuffer;
  /** Running line count (separator bookkeeping for the window buffers). */
  linesWritten: number;
  prevHashes: Set<string>;
  newElementCount: number;
  truncated: boolean;
  elementTruncated: boolean;
  /**
   * Partial re-walk support: when set, line/element positions recorded for
   * this walk are offset by these amounts so `currentWalkRanges` entries
   * stay in GLOBAL coordinates (the sub-walker's accumulator is relative to
   * its dirty root's splice region).
   */
  rangeOffset?: { line: number; el: number };
  /**
   * Partial re-walk support: maps a sub-walk's relative element index to the
   * index the element keeps in the merged arrays (identity match against the
   * previous walk, a freed slot inside the dirty root's range, or an
   * appended index). Absent in full walks — indices are then the walk order.
   */
  indexAssigner?: (relativeIndex: number, identity: string) => number;
}

/**
 * The output region of one element's subtree in the arrays of the walk that
 * visited it: half-open `[startLine, endLine)` into the walk's lines array
 * and `[startEl, endEl)` into its elements array (element indices within the
 * region are `startEl+1 .. endEl`), plus the depth the element was walked at.
 * Recorded for every element node of every walk; the partial re-walk uses a
 * dirty root's region to splice fresh serialization in place.
 */
interface WalkRange {
  startLine: number;
  endLine: number;
  startEl: number;
  endEl: number;
  depth: number;
}

/**
 * Cross-step per-element visibility memo (the `isVisibleFull` result for
 * every element the walk classified). Stamped with the DOM epoch: on an
 * unchanged page the next walk serves every lookup (0 forced reflows); any
 * DOM mutation bumps the epoch and rebuilds the memo. The viewport-bounds
 * check (`intersectsObservationViewport`) is folded into the cached value
 * today, so the memo is only valid for the epoch that produced it — the epoch
 * stamp is exactly that guarantee.
 */
let visibilityCache: { epoch: number; map: WeakMap<HTMLElement, boolean> } = {
  epoch: -1,
  map: new WeakMap(),
};

/** The epoch-valid visibility memo, rebuilt lazily when the epoch moved
 * (or always, when the mutation signal is unarmed — a frozen epoch then
 * can't be trusted, so each use gets a fresh memo). */
function visibilityCacheMap(): WeakMap<HTMLElement, boolean> {
  const epoch = getDomEpoch();
  if (!isMutationSignalArmed() || visibilityCache.epoch !== epoch) {
    visibilityCache = { epoch, map: new WeakMap<HTMLElement, boolean>() };
  }
  return visibilityCache.map;
}

/** Automatic observations describe the current viewport, not the whole
 * document. Full-page evidence is available through extract/search_page and
 * paged snapshots. A one-quarter viewport margin prevents elements at the
 * fold from flickering in and out because of fractional layout changes.
 *
 * The IntersectionObserver membership cache (one IO on the document root)
 * short-circuits the rect math once the browser has reported the element's
 * viewport membership; while membership is unknown (not yet observed, or IO
 * unavailable) the gate falls back to the exact rect math below. */
function intersectsObservationViewport(el: HTMLElement, rect?: DOMRect): boolean {
  const tracker = getViewportTracker();
  const membership = tracker.isInViewport(el);
  if (membership !== undefined) return membership;
  tracker.observe(el);
  const r = rect ?? el.getBoundingClientRect();
  const marginY = Math.max(100, window.innerHeight * 0.25);
  const marginX = Math.max(50, window.innerWidth * 0.1);
  return r.bottom >= -marginY && r.top <= window.innerHeight + marginY &&
    r.right >= -marginX && r.left <= window.innerWidth + marginX;
}

function serializeText(node: Text, depth: number, acc: WalkAccumulator, readCache: ReadCache): void {
  const parent = node.parentElement;
  if (!parent) return;
  const vc = visibilityCacheMap();
  let visible = vc.get(parent);
  if (visible === undefined) {
    visible = readCache.getVisible(parent) ?? isVisibleFull(parent);
    vc.set(parent, visible);
  }
  if (!visible) return;
  if (!intersectsObservationViewport(parent, readCache.getRect(parent))) return;

  const t = (node.textContent || "").replace(/\s+/g, " ").trim();
  if (t.length >= DOM_CONFIG.minTextLength) {
    pushLine(acc, "\t".repeat(depth) + escapeAttr(t));
  }
}

/** Walk an element's light-DOM children then pierce into its shadow root. */
function walkLightAndShadowChildren(el: HTMLElement, depth: number, acc: WalkAccumulator, readCache: ReadCache): void {
  for (let child = el.firstChild; child; child = child.nextSibling) {
    walkNode(child, depth + 1, acc, readCache);
  }
  const sr = getShadowRoot(el);
  if (sr) {
    for (let child = sr.firstChild; child; child = child.nextSibling) {
      walkNode(child, depth + 1, acc, readCache);
    }
  }
}

function serializeElement(el: HTMLElement, depth: number, acc: WalkAccumulator, readCache: ReadCache): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (acc.elements.length >= MAX_ELEMENTS) {
    if (!acc.elementTruncated) {
      acc.elementTruncated = true;
      // `force` bypasses the MAX_LINES gate exactly as the direct
      // `acc.lines.push` did before stream-windowed assembly — the element
      // cap can trip with lines already at
      // MAX_LINES, and the marker must still land (and reach the window
      // buffers) byte-for-byte.
      pushLine(acc, `\t[truncated at ${MAX_ELEMENTS} elements — page is very large; focus on a more specific element]`, true);
    }
    return;
  }
  const tag = el.tagName.toLowerCase();

  if (isLikelyHidden(el)) return;

  // Batch this element's rect + computed-style reads once, before any
  // classification; every consumer below (and later serializeText lookups for
  // this element as a parent) serves from the cache. The walk never writes the
  // DOM, so the cached values stay fresh for its whole duration.
  readCache.batchRead(el);

  if (DOM_CONFIG.skipTags.has(tag) || tag === "iframe") {
    if (tag === "iframe") trySerializeIframe(el as HTMLIFrameElement, depth, acc, readCache);
    if (tag === "svg" && isInteractive(el)) {
      const attrs = buildAttrs(el);
      const identity = elementIdentity(el, attrs);
      const hash = hashElement(el, attrs, identity);
      pushIndexedElement(acc, el, tag, attrs, identity, hash, depth, readCache.getRect(el)!);
    }
    return;
  }

  let rect: DOMRect | undefined;
  let interactive = false;
  if (isInteractive(el)) {
    rect = readCache.getRect(el);
    const visible = (readCache.getVisible(el, rect) ?? isVisibleFull(el, rect)) && intersectsObservationViewport(el, rect);
    visibilityCacheMap().set(el, visible);
    if (!visible) return;
    interactive = true;
  }

  if (interactive) {
    const attrs = buildAttrs(el);
    const identity = elementIdentity(el, attrs);
    const hash = hashElement(el, attrs, identity);
    pushIndexedElement(acc, el, tag, attrs, identity, hash, depth, rect!);
    serializeCompoundChildren(el, depth, acc);
    if (tag === "select") return;
    if (tag === "details") {
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if ((child as HTMLElement)?.tagName?.toLowerCase?.() === "summary") continue;
        walkNode(child, depth + 1, acc, readCache);
      }
      return;
    }
  }

  // Populate the per-extract visibility cache for EVERY element we walk (not
  // just interactive ones and text parents) so `serializeText`'s per-text-node
  // parent lookup and the container branch below hit the cache instead of
  // re-running the expensive `isVisibleFull` (computed-style resolution +
  // layout flush). The walk is depth-first, so a parent element is always
  // serialized before its text children — every `serializeText` lookup finds
  // its parent already cached.
  if (!interactive && visibilityCacheMap().get(el) === undefined) {
    visibilityCacheMap().set(el, readCache.getVisible(el) ?? isVisibleFull(el));
  }

  if (isInteractiveContainer(el)) {
    // Full visibility check before indexing: a container that is hidden
    // (opacity:0, aria-hidden, zero-size rect, clipped, …) must not surface as
    // a phantom click target. Children are still walked — their own visibility
    // checks decide what they contribute.
    const vc = visibilityCacheMap();
    let containerVisible = vc.get(el);
    if (containerVisible === undefined) {
      containerVisible = readCache.getVisible(el) ?? isVisibleFull(el);
      vc.set(el, containerVisible);
    }
    if (containerVisible && intersectsObservationViewport(el, readCache.getRect(el))) {
      const attrs = buildAttrs(el);
      const identity = elementIdentity(el, attrs);
      const hash = hashElement(el, attrs, identity);
      const containerRect = readCache.getRect(el)!;
      pushIndexedElement(acc, el, tag, attrs, identity, hash, depth, containerRect);
    }
  }

  walkLightAndShadowChildren(el, depth + 1, acc, readCache);
}

function redactIframeSrc(src: string): string {
  return redactUrlTokens(src);
}

function trySerializeIframe(iframe: HTMLIFrameElement, depth: number, acc: WalkAccumulator, readCache: ReadCache): void {
  try {
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) {
      pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "(blank)"))} (cross-origin or not loaded)|`);
      return;
    }
    pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "same-origin"))}|`);
    try {
      for (let child = doc.body.firstChild; child; child = child.nextSibling) {
        walkNode(child, depth + 1, acc, readCache);
      }
    } catch {
      pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src || "same-origin"))} (error reading contents)|`);
    }
  } catch {
    pushLine(acc, "\t".repeat(depth) + `|IFRAME src=${escapeAttr(redactIframeSrc(iframe.src))} (cross-origin)|`);
  }
}

function walkNode(node: Node, depth: number, acc: WalkAccumulator, readCache: ReadCache): void {
  if (acc.elementTruncated) return;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    const offset = acc.rangeOffset ?? { line: 0, el: 0 };
    const startLine = offset.line + acc.lines.length;
    const startEl = offset.el + acc.elements.length;
    serializeElement(el, depth, acc, readCache);
    // Record the element's output region in GLOBAL coordinates so a later
    // partial re-walk can splice this subtree's output in place. In a partial
    // walk the sub-accumulator's offset keeps the recorded positions aligned
    // with the merged arrays.
    currentWalkRanges.set(el, {
      startLine,
      endLine: offset.line + acc.lines.length,
      startEl,
      endEl: offset.el + acc.elements.length,
      depth,
    });
  } else if (node.nodeType === Node.TEXT_NODE) {
    serializeText(node as Text, depth, acc, readCache);
  }
}

let cachedSelectorMap: Record<number, HTMLElement> = {};
let cachedIdentities: Record<number, string> = {};
let cachedHashes: Set<string> = new Set();
/**
 * The last successful walk's raw outputs — the splice base of a partial
 * re-walk. `cachedElements` mirrors `cachedSelectorMap`'s indices,
 * `cachedLines` is the unwindowed lines array; `pageSnapshotChunk` joins it
 * on demand for paging (the join is only materialized when the model actually
 * pages, never per extraction step). Kept here (not in the skip-if-unchanged
 * extraction cache) because the raw loop path (`observe-state.ts`) and the cached path
 * interleave: the previous walk's arrays must always be THIS walk's
 * predecessor, and the cache's JSON-safe snapshot may be older.
 */
let cachedElements: ExtractedElement[] = [];
let cachedLines: string[] = [];
/**
 * Output regions recorded by the last walk (see {@link WalkRange}). After a
 * FULL walk this covers every element (all coordinates current). After a
 * PARTIAL walk it covers ONLY the re-walked dirty subtrees — a size-changing
 * splice invalidates the older coordinates of every untouched region, so
 * they are deliberately dropped (fail closed: a later mutation inside one
 * hits the `previousRanges` gate and falls back to a full walk).
 */
let previousRanges: WeakMap<Element, WalkRange> = new WeakMap();
/** Regions being recorded by the walk in progress (published on completion). */
let currentWalkRanges: WeakMap<Element, WalkRange> = new WeakMap();
/** The DOM epoch at the end of the last walk (full or partial). */
let lastExtractEpoch = -1;

/**
 * Merge a fresh walk's indexed cache (`next`) into the persistent cache
 * (`previous`) IN PLACE instead of replacing it wholesale, so the cached
 * object's identity survives across extractions (the walk accumulator is
 * ephemeral; the cache is the long-lived copy). Elements are indexed by walk
 * order, so a removed element's index is simply absent from `next` — delete
 * those indices once, keep the still-present entries on the same object, then
 * assign the new walk's entries. A fresh object is only built when the
 * previous cache is empty (first extraction or a prior full eviction).
 *
 * Stale entries are harmless by design: `selectorMap` never crosses IPC
 * (content-utils.ts) and the executor re-verifies a live element's identity
 * at action time (stale-element-guard) — no invalidation beyond the delete.
 */
function commitIndexedCache<T>(previous: Record<number, T>, next: Record<number, T>): Record<number, T> {
  if (Object.keys(previous).length === 0) {
    return { ...next };
  }
  const prevKeys = Object.keys(previous);
  for (const key of prevKeys) {
    if (!(key in next)) {
      delete previous[Number(key)];
    }
  }
  for (const key of Object.keys(next)) {
    previous[Number(key)] = next[Number(key)];
  }
  return previous;
}

export function resetDomBaseline(): void {
  // The DOM baseline changed (e.g. after pageChanged) — the skip-if-unchanged
  // observation cache must not serve its pre-change snapshot even before the
  // observer's records land (the epoch bump below also invalidates it, but
  // the explicit drop covers the unarmed-signal case where the epoch is
  // frozen).
  invalidateStateCacheHook?.();
  cachedHashes = new Set();
  // The DOM baseline changed (e.g. after pageChanged) — drop the identity
  // memo so nth-of-type indices are recomputed against the new structure,
  // and bump the epoch so the epoch-stamped visibility/read caches
  // invalidate synchronously (they can't wait for the observer's record
  // delivery, and there may be nothing to deliver when the baseline was
  // replaced wholesale).
  bumpDomEpoch();
  // The bump carries no mutation records (a wholesale replacement) — drop any
  // pending dirty-root buckets so the next extraction runs a full walk
  // instead of splicing pre-change records into post-change arrays.
  clearDirtyRoots(getDomEpoch());
  resetHashCaches();
}

/**
 * Return the next window of the cached snapshot serialization (or null when
 * no snapshot has been extracted in this content-script instance). The
 * `page_next` action consumes this to page through a truncated page.
 */
export function pageSnapshotChunk(offset?: number): SnapshotWindow | null {
  if (cachedLines.length === 0) return null;
  return windowSnapshot(cachedLines.join("\n"), offset ?? 0);
}

export function extractBrowserState(tabs: TabInfo[]): BrowserState {
  if (tabs.length === 0) {
    // A caller invoking the RAW extractor with empty tab evidence (the
    // executor's action-time fallback in content-utils, in-page contexts
    // without a tab source) is a context that proves nothing about the
    // observation cache's tabs/url/title legs — drop the snapshot so the
    // next cachedExtractBrowserState falls back to a fresh extract instead
    // of serving a state whose tab evidence was never re-verified.
    invalidateStateCacheHook?.();
  }
  // Ensure the DOM-epoch mutation signal is installed (idempotent) so the
  // persistent caches below can rely on it — covers in-page demo mode and
  // tests; the content script also installs it at module init.
  installMutationSignal();
  // Epoch-stamped persistent read cache: on an unchanged DOM this walk serves
  // every element's rect/style/visibility from the previous walk's batch
  // reads (0 forced reflows). Any DOM mutation bumps the epoch (mutation
  // signal) and rebuilds the cache.
  const readCache = getSharedReadCache();
  // Redact each tab URL at the boundary, the same way `location.href` below is
  // redacted — a tab open on an OAuth callback (or a share link carrying a
  // token) would otherwise leak its query-string secrets into page state.
  const redactedTabs = tabs.map((t) => (t.url ? { ...t, url: redactUrlTokens(t.url) } : t));

  // Partial re-walk: when the page changed in a bounded set of subtrees,
  // re-serialize ONLY those and splice the results into the previous walk's
  // arrays instead of re-walking the document. Falls back to a full walk on
  // any doubt (unarmed signal, empty dirty-root set with a moved epoch,
  // >50% of elements dirty, missing/overlapping regions, or any sub-walk
  // error) — the partial path must never serve a corrupt splice.
  const partial = tryPartialExtract(getDomEpoch(), redactedTabs, readCache);
  if (partial) return partial;

  currentWalkRanges = new WeakMap();
  beginVisibilityCache();
  const acc: WalkAccumulator = {
    index: 0,
    selectorMap: {},
    identities: {},
    elements: [],
    lines: [],
    window: { head: "", tail: "", totalChars: 0 },
    linesWritten: 0,
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
        walkNode(child, 0, acc, readCache);
      }
    } catch (e) {
      console.warn("[page-state] DOM walk threw mid-extract (resetting selectorMap to avoid stale indices):", e);
      acc.selectorMap = {};
      acc.identities = {};
      acc.elements = [];
      acc.lines = [];
      acc.window = { head: "", tail: "", totalChars: 0 };
      acc.linesWritten = 0;
    } finally {
      endVisibilityCache();
    }
  } else {
    endVisibilityCache();
  }
  cachedHashes = new Set(acc.elements.map((e) => e.hash));
  cachedSelectorMap = commitIndexedCache(cachedSelectorMap, acc.selectorMap);
  cachedIdentities = commitIndexedCache(cachedIdentities, acc.identities);
  cachedElements = acc.elements;
  cachedLines = acc.lines;
  previousRanges = currentWalkRanges;
  lastExtractEpoch = getDomEpoch();
  clearDirtyRoots(lastExtractEpoch);
  const scrollTop = window.scrollY || 0;
  const scrollHeight = document.documentElement.scrollHeight;
  const vh = window.innerHeight;
  // A failed walk (or a missing body) leaves the page-state degraded: the
  // window buffers were reset, so the slice is empty and page_next must
  // surface "extract first" instead of paging an empty or stale snapshot.
  const windowedText = assembleWindowedText(acc.window);
  return {
    url: redactUrlTokens(location.href),
    title: document.title,
    tabs: redactedTabs,
    elements: acc.elements,
    elementsText: windowedText.trim().length > 0 ? windowedText : "[empty page]",
    pageInfo: buildPageInfo(scrollTop, scrollHeight, vh),
    newElementCount: acc.newElementCount,
    scrollTop,
    scrollHeight,
    viewportHeight: vh,
    selectorMap: acc.selectorMap,
    elementIdentities: acc.identities,
  };
}

/**
 * Partial re-walk: re-serialize only the subtrees mutated since the last walk
 * and splice the results into the cached elements/lines arrays, rebuilding
 * `elementsText` by concatenation. Returns null (→ full walk) unless every
 * gate below holds:
 *
 *  - the mutation signal is armed (an unarmed epoch/dirty-set proves nothing);
 *  - the epoch moved since the last walk AND dirty roots were recorded for
 *    the window (an explicit bump or an observer delivery gap leaves an empty
 *    set — fail closed);
 *  - the previous walk produced elements/lines to splice into;
 *  - every dirty root has a recorded previous output region, and the regions
 *    are pairwise disjoint (a root whose region nests inside another's is
 *    skipped — its subtree's re-walk covers it; overlapping regions — e.g. a
 *    detached fragment mutated after removal — fail closed);
 *  - the dirty element share is ≤50% (beyond that a full rebuild is cheaper);
 *  - the merged result stays within the walk limits.
 */
function tryPartialExtract(
  epoch: number,
  redactedTabs: TabInfo[],
  readCache: ReadCache,
): BrowserState | null {
  if (!isMutationSignalArmed()) return null;
  if (epoch === lastExtractEpoch) return null;
  const dirtyRoots = getDirtyRoots(epoch);
  if (dirtyRoots.length === 0) return null;
  if (cachedElements.length === 0 || cachedLines.length === 0) return null;

  // Fresh range map for this attempt: a partial splice with a size delta
  // invalidates every range recorded in the older arrays' coordinates
  // (sub-walks only refresh the re-walked elements' regions). Reusing the
  // stale map would let a later partial splice at a wrong position pass the
  // `previousRanges` gate, so fail closed instead — untouched subtrees lose
  // their ranges and fall back to a full walk. The full-walk path also
  // resets it (its own fresh map).
  currentWalkRanges = new WeakMap();

  const withRanges: { root: Element; range: WalkRange }[] = [];
  for (const root of dirtyRoots) {
    const range = previousRanges.get(root);
    if (!range) return null;
    withRanges.push({ root, range });
  }
  // Drop roots whose region nests inside another root's (their re-walk is
  // covered by the outer root); sorted so the outer region is kept first.
  withRanges.sort((a, b) => a.range.startLine - b.range.startLine || a.range.endLine - b.range.endLine);
  const kept: { root: Element; range: WalkRange }[] = [];
  for (const candidate of withRanges) {
    const nested = kept.some(
      (k) =>
        candidate.range.startLine >= k.range.startLine &&
        candidate.range.endLine <= k.range.endLine,
    );
    if (!nested) kept.push(candidate);
  }
  if (kept.length === 0) return null;

  // >50% of elements dirty → a splice costs more than a full rebuild.
  const dirtyElementCount = kept.reduce((sum, k) => sum + (k.range.endEl - k.range.startEl), 0);
  if (dirtyElementCount > cachedElements.length / 2) return null;

  // Identity → previous index map of the LAST walk (cachedIdentities is
  // committed per walk, so it maps exactly the cached elements' indices).
  const identityToIndex = new Map<string, number>();
  for (const [idx, identity] of Object.entries(cachedIdentities)) {
    if (!identityToIndex.has(identity)) identityToIndex.set(identity, Number(idx));
  }
  const maxPrevIndex = cachedElements.reduce((max, e) => Math.max(max, e.index), 0);

  // Re-walk every kept dirty root with the same serializers. Sub-walks run
  // BEFORE any splice (they read the cached arrays only through the offsets),
  // ordered by ascending position so the recorded ranges account for the
  // position shifts that earlier splices will introduce.
  interface SubWalk {
    range: WalkRange;
    elements: ExtractedElement[];
    lines: string[];
    selectorMap: Record<number, HTMLElement>;
    identities: Record<number, string>;
    newElementCount: number;
  }
  const subWalks: SubWalk[] = [];
  let lineShift = 0;
  let elShift = 0;
  beginVisibilityCache();
  try {
    for (const { root, range } of kept) {
      const offset = { line: range.startLine + lineShift, el: range.startEl + elShift };
      const subAcc: WalkAccumulator = {
        index: 0,
        selectorMap: {},
        identities: {},
        elements: [],
        lines: [],
        window: { head: "", tail: "", totalChars: 0 },
        linesWritten: 0,
        prevHashes: cachedHashes,
        newElementCount: 0,
        truncated: false,
        elementTruncated: false,
        rangeOffset: offset,
        indexAssigner: makeIndexAssigner(range, identityToIndex, maxPrevIndex),
      };
      walkNode(root, range.depth, subAcc, readCache);
      lineShift += subAcc.lines.length - (range.endLine - range.startLine);
      elShift += subAcc.elements.length - (range.endEl - range.startEl);
      subWalks.push({
        range,
        elements: subAcc.elements,
        lines: subAcc.lines,
        selectorMap: subAcc.selectorMap,
        identities: subAcc.identities,
        newElementCount: subAcc.newElementCount,
      });
    }
  } catch {
    return null;
  } finally {
    endVisibilityCache();
  }

  const projectedLines =
    cachedLines.length + subWalks.reduce((d, s) => d + s.lines.length - (s.range.endLine - s.range.startLine), 0);
  const projectedElements =
    cachedElements.length + subWalks.reduce((d, s) => d + s.elements.length - (s.range.endEl - s.range.startEl), 0);
  if (projectedLines > MAX_LINES || projectedElements > MAX_ELEMENTS) return null;

  // Splice back-to-front so an earlier splice never shifts a later region's
  // insertion point (regions are pairwise disjoint). Cached lines are
  // re-emitted WITHOUT the `*` new-element marker first: an element that
  // existed in the previous walk is definitionally not new (a line written
  // while it was then-new would otherwise scream "new" every step forever);
  // the freshly re-serialized sub-walk lines carry their naturally-computed
  // markers and are spliced in afterwards. The strip matches ONLY the
  // element-line shape (`\t*[index]<…` — the marker always precedes the
  // display index) so a TEXT line whose content begins with `*` (escapeAttr
  // doesn't escape it) is never rewritten.
  for (let i = 0; i < cachedLines.length; i++) {
    cachedLines[i] = cachedLines[i].replace(/^(\t*)\*(\[\d+\]<)/, "$1$2");
  }
  subWalks.sort((a, b) => b.range.startLine - a.range.startLine);
  for (const s of subWalks) {
    cachedLines.splice(s.range.startLine, s.range.endLine - s.range.startLine, ...s.lines);
    cachedElements.splice(s.range.startEl, s.range.endEl - s.range.startEl, ...s.elements);
    for (let idx = s.range.startEl + 1; idx <= s.range.endEl; idx++) {
      delete cachedSelectorMap[idx];
      delete cachedIdentities[idx];
    }
    Object.assign(cachedSelectorMap, s.selectorMap);
    Object.assign(cachedIdentities, s.identities);
  }
  cachedHashes = new Set(cachedElements.map((e) => e.hash));
  previousRanges = currentWalkRanges;
  lastExtractEpoch = epoch;
  clearDirtyRoots(epoch);

  const scrollTop = window.scrollY || 0;
  const scrollHeight = document.documentElement.scrollHeight;
  const vh = window.innerHeight;
  // Stream the spliced lines into the windowed slice — byte-identical to
  // `windowSnapshot(cachedLines.join("\n"), 0).text` but without materializing
  // the full joined string (the paging cache below joins on demand instead).
  const windowBuf: SnapshotWindowBuffer = { head: "", tail: "", totalChars: 0 };
  for (let i = 0; i < cachedLines.length; i++) {
    appendWindowLine(windowBuf, cachedLines[i], i === 0);
  }
  const windowedText = assembleWindowedText(windowBuf);
  return {
    url: redactUrlTokens(location.href),
    title: document.title,
    tabs: redactedTabs,
    elements: cachedElements,
    elementsText: windowedText.trim().length > 0 ? windowedText : "[empty page]",
    pageInfo: buildPageInfo(scrollTop, scrollHeight, vh),
    newElementCount: subWalks.reduce((sum, s) => sum + s.newElementCount, 0),
    scrollTop,
    scrollHeight,
    viewportHeight: vh,
    selectorMap: cachedSelectorMap,
    elementIdentities: cachedIdentities,
  };
}

/**
 * Per-dirty-root index assignment for a partial re-walk. Each re-walked
 * element's display index is:
 *  1. its previous index when its identity matches a previous element within
 *     the root's region (unchanged elements keep their indices);
 *  2. otherwise the next free slot inside the region (a removed element's
 *     index, reused by a new element in walk order);
 *  3. otherwise an appended index beyond the previous maximum.
 */
function makeIndexAssigner(
  range: WalkRange,
  identityToIndex: Map<string, number>,
  maxPrevIndex: number,
): (relativeIndex: number, identity: string) => number {
  let nextFree = range.startEl + 1;
  let appendNext = maxPrevIndex + 1;
  const claimed = new Set<number>();
  return (_relativeIndex, identity) => {
    const prevIdx = identityToIndex.get(identity);
    if (
      prevIdx !== undefined &&
      !claimed.has(prevIdx) &&
      prevIdx > range.startEl &&
      prevIdx <= range.endEl
    ) {
      claimed.add(prevIdx);
      return prevIdx;
    }
    while (nextFree <= range.endEl && claimed.has(nextFree)) nextFree++;
    if (nextFree <= range.endEl) {
      const index = nextFree++;
      claimed.add(index);
      return index;
    }
    const index = appendNext++;
    claimed.add(index);
    return index;
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
