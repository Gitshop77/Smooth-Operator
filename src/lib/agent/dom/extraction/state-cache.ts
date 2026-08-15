/**
 * Skip-if-unchanged extraction cache (B1).
 *
 * `cachedExtractBrowserState` serves the LAST successful extraction's
 * serialized snapshot when the page is provably unchanged since then. The
 * gate (ALL FOUR legs must hold):
 *
 *   1. the DOM-epoch mutation signal has not moved since the snapshot was
 *      taken (`lastEpoch === getDomEpoch()`) AND is armed — an unarmed epoch
 *      proves nothing, so the cache fails closed and re-extracts (same
 *      fail-closed rule as the visibility/read caches in page-state.ts);
 *   2. `domFingerprint()` still equals the fingerprint captured at extract
 *      time (defense-in-depth against observer delivery gaps, and the exact
 *      `GET_DOM_FINGERPRINT` value the vision path uses);
 *   3. `tabs`/`url`/`title` are unchanged (cheap reads, compared by value);
 *   4. scroll metrics (scrollTop / scrollHeight / viewportHeight) are
 *      unchanged. Scroll mutates no DOM and no fingerprint, but a stale
 *      scrollTop would mis-position the snapshot's viewport-relative
 *      elementRects against a freshly captured screenshot (mislabeling every
 *      annotation box and steering the vision path at wrong click targets)
 *      and stale pageInfo/scrollTop would lie to the model — so scroll
 *      staleness is NOT accepted and the scroll legs are part of the gate
 *      (plain reads, no layout beyond a fresh extract).
 *
 * The cache stores ONLY JSON-safe serialized state — elements with plain
 * rects, elementsText, pageInfo, tabs, url, title, scroll metrics — plus the
 * serialized AX tree from the last successful EXTRACT_STATE accessibility
 * walk (`setCachedAxTree`). Live runtime-only fields (`selectorMap`,
 * `elementIdentities`) never enter the cache: the ONLY consumer of
 * `cachedExtractBrowserState` is the extension's EXTRACT_STATE handler
 * (content-utils.ts), which strips `selectorMap` before messaging and builds
 * `elementRects` from the cached plain rects. The built-in loop path uses the
 * RAW `extractBrowserState` (observe-state.ts — its state flows into the
 * built-in executor, which resolves action indices through the state's live
 * `selectorMap`), and the extension executor path rebuilds `selectorMap`
 * from `getSelectorMap()` — neither ever receives a cache-served state. A
 * cache-served state is DEEP-FROZEN (a single frozen object is reused across
 * hits) so no caller can mutate a snapshot shared between steps.
 *
 * On a cache hit NOTHING is walked: neither the elements DOM walk nor the
 * accessibility-tree walk runs (handleExtractState serves the stashed tree,
 * which is valid because the gate proves the DOM unchanged since it was
 * generated in the same synchronous flow that populated the snapshot). The
 * stash is cleared on every fresh extract and on `invalidateStateCache()`,
 * so it can never outlive its snapshot: an extract that produced no tree
 * (includeAxTree=false) or any DOM/tab/url/title/scroll change drops it, and
 * the next includeAxTree=true extract regenerates.
 *
 * STALE-OBSERVATION IS DELIBERATE for changes that mutate neither the DOM
 * structure the observer tracks nor the fingerprint's hashed surface: text
 * selection, hover, focus, CSS-animation-driven style changes (no mutation
 * records fire), and password/transient-text input values (property-only
 * writes; `domFingerprint()` deliberately excludes style attributes and
 * password values — see dom-fingerprint.ts). The agent then sees exactly
 * what a human would describe as "nothing changed". JS-driven `style`
 * attribute writes DO fire `attributes` mutations, so those re-extract; only
 * changes invisible to BOTH the observer and the fingerprint serve stale.
 * Scroll changes are NOT in this class — see gate leg 4.
 *
 * Invalidation points: `resetDomBaseline()` (page-state.ts, runs after
 * `pageChanged`), and the RAW `extractBrowserState([])` path — a caller
 * invoking the raw extractor with empty tab evidence (the executor's
 * action-time fallback) is a context that proves nothing, so the snapshot is
 * dropped and the next cached call falls back to fresh.
 */
import { getDomEpoch, isMutationSignalArmed } from "../mutation-signal";
import { domFingerprint } from "../../tools/helpers/dom-fingerprint";
import { extractBrowserState, setStateCacheInvalidator } from "./page-state";
import type { BrowserState, ExtractedElement, TabInfo } from "../../types";

/** The JSON-safe subset of {@link BrowserState} the cache holds. */
interface StateSnapshot {
  url: string;
  title: string;
  tabs: TabInfo[];
  elements: ExtractedElement[];
  elementsText: string;
  pageInfo: string;
  newElementCount: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}

/** Cache-served states carry no live DOM references — an empty map stands in
 * for `selectorMap` (the EXTRACT_STATE consumer strips it; the executors
 * rebuild live maps via `getSelectorMap()` and never see this object). */
const EMPTY_SELECTOR_MAP: Record<number, unknown> = Object.freeze({});

let snapshot: StateSnapshot | null = null;
let cachedState: BrowserState | null = null;
let stashedAxTree: string | null = null;
let lastFingerprint: string | null = null;
let lastEpoch = -1;
let lastTabs: TabInfo[] | null = null;
let lastUrl: string | null = null;
let lastTitle: string | null = null;
let lastScrollTop = -1;
let lastScrollHeight = -1;
let lastViewportHeight = -1;

/** Value-equality over the JSON-safe {@link TabInfo} shape. */
function tabsEqual(a: TabInfo[], b: TabInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.label !== y.label || x.url !== y.url || x.title !== y.title || x.active !== y.active) {
      return false;
    }
  }
  return true;
}

/** Freeze a JSON-safe value and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Project a fresh extraction's live state into the JSON-safe snapshot shape
 * (DOMRect instances become plain x/y/width/height objects). Every array and
 * record is defensively copied so an in-place mutation by a caller (e.g. of
 * its own `tabs` array) can never silently alter a stored snapshot. */
function toSnapshot(state: BrowserState): StateSnapshot {
  return {
    url: state.url,
    title: state.title,
    tabs: state.tabs.map((t) => ({ ...t })),
    elements: state.elements.map((el) => ({
      index: el.index,
      tag: el.tag,
      text: el.text,
      attributes: { ...el.attributes },
      hash: el.hash,
      rect: { x: el.rect.x, y: el.rect.y, width: el.rect.width, height: el.rect.height },
    })),
    elementsText: state.elementsText,
    pageInfo: state.pageInfo,
    newElementCount: state.newElementCount,
    scrollTop: state.scrollTop,
    scrollHeight: state.scrollHeight,
    viewportHeight: state.viewportHeight,
  };
}

/**
 * Extract browser state, serving the deep-frozen cached snapshot when the
 * page is provably unchanged (see module comment for the gate and the
 * deliberate stale-observation semantics). On any doubt — mutation observed,
 * fingerprint moved, tabs/url/title changed, scroll moved, or the signal
 * unarmed — a fresh extraction runs, its snapshot replaces the cache (and
 * the stashed AX tree is cleared, since it can never outlive its snapshot),
 * and the live state is returned.
 */
export function cachedExtractBrowserState(tabs: TabInfo[]): BrowserState {
  const unchanged =
    snapshot !== null &&
    lastTabs !== null &&
    lastFingerprint !== null &&
    lastUrl !== null &&
    lastTitle !== null &&
    isMutationSignalArmed() &&
    lastEpoch === getDomEpoch() &&
    lastFingerprint === domFingerprint() &&
    tabsEqual(lastTabs, tabs) &&
    lastUrl === location.href &&
    lastTitle === document.title &&
    lastScrollTop === (window.scrollY || 0) &&
    lastScrollHeight === document.documentElement.scrollHeight &&
    lastViewportHeight === window.innerHeight;

  if (unchanged && snapshot !== null) {
    if (cachedState === null) {
      const served: BrowserState = {
        ...snapshot,
        selectorMap: EMPTY_SELECTOR_MAP,
      };
      if (stashedAxTree !== null) served.axTree = stashedAxTree;
      cachedState = deepFreeze(served);
    }
    return cachedState;
  }

  const fresh = extractBrowserState(tabs);
  lastEpoch = getDomEpoch();
  lastFingerprint = domFingerprint();
  lastTabs = tabs.map((t) => ({ ...t }));
  lastUrl = location.href;
  lastTitle = document.title;
  lastScrollTop = fresh.scrollTop;
  lastScrollHeight = fresh.scrollHeight;
  lastViewportHeight = fresh.viewportHeight;
  snapshot = toSnapshot(fresh);
  cachedState = null;
  stashedAxTree = null;
  return fresh;
}

/** Stash the serialized accessibility tree produced for the CURRENT
 * snapshot's DOM so a later cache hit can serve it instead of re-walking the
 * page (the gate proves the DOM unchanged since the tree was built in the
 * same synchronous flow that populated the snapshot). The next fresh extract
 * or `invalidateStateCache()` clears it. */
export function setCachedAxTree(axTree: string): void {
  stashedAxTree = axTree;
  cachedState = null;
}

/** Drop the cached snapshot so the next `cachedExtractBrowserState` call
 * falls back to a fresh extraction. Called from `resetDomBaseline()` (a page
 * changed — e.g. after `pageChanged` — even before the observer delivers) and
 * from the raw `extractBrowserState([])` path (a caller with empty tab
 * evidence proves nothing about the snapshot's tab/url/title legs). */
export function invalidateStateCache(): void {
  snapshot = null;
  cachedState = null;
  stashedAxTree = null;
  lastFingerprint = null;
  lastEpoch = -1;
  lastTabs = null;
  lastUrl = null;
  lastTitle = null;
  lastScrollTop = -1;
  lastScrollHeight = -1;
  lastViewportHeight = -1;
}

// The cache layer depends on the raw extractor (`./page-state`), so the
// invalidation direction is inverted to keep the graph acyclic: register this
// module's invalidator into page-state's hook at module init. Module
// evaluation order guarantees the registration runs before any call into the
// extractor (imports evaluate before this module's body; both modules share
// one instance per graph). In raw-only graphs page-state's hook stays null
// and invalidation is a no-op — there is no snapshot to drop there anyway.
setStateCacheInvalidator(invalidateStateCache);
