/**
 * Skip-if-unchanged extraction cache (B1).
 *
 * `cachedExtractBrowserState` serves the LAST successful extraction's
 * serialized snapshot when the page is provably unchanged since then. The
 * gate (ALL THREE legs must hold):
 *
 *   1. the DOM-epoch mutation signal has not moved since the snapshot was
 *      taken (`lastEpoch === getDomEpoch()`) AND is armed — an unarmed epoch
 *      proves nothing, so the cache fails closed and re-extracts (same
 *      fail-closed rule as the visibility/read caches in page-state.ts);
 *   2. `domFingerprint()` still equals the fingerprint captured at extract
 *      time (defense-in-depth against observer delivery gaps, and the exact
 *      `GET_DOM_FINGERPRINT` value the vision path uses);
 *   3. `tabs`/`url`/`title` are unchanged (cheap reads, compared by value).
 *
 * The cache stores ONLY JSON-safe serialized state — elements with plain
 * rects, elementsText, pageInfo, tabs, url, title, scroll metrics. Live
 * runtime-only fields (`selectorMap`, `elementIdentities`) never enter the
 * cache: the executor recomputes them from the live DOM when it needs them
 * (`getSelectorMap()`/`getElementIdentities()`, the A5 incremental caches —
 * still epoch-valid because the gate proves the DOM unchanged), and
 * `handleExtractState` builds `elementRects` from the cached plain rects.
 * A cache-served state is DEEP-FROZEN (a single frozen object is reused
 * across hits) so no caller can mutate a snapshot shared between steps.
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
 *
 * Invalidation points: `resetDomBaseline()` (page-state.ts, runs after
 * `pageChanged`), and the RAW `extractBrowserState([])` path — a caller
 * invoking the raw extractor with empty tab evidence (the executor's
 * action-time fallback) is a context that proves nothing, so the snapshot is
 * dropped and the next cached call falls back to fresh.
 */
import { getDomEpoch, isMutationSignalArmed } from "../mutation-signal";
import { domFingerprint } from "../../tools/helpers/dom-fingerprint";
import { extractBrowserState } from "./page-state";
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
 * for `selectorMap` (the executor uses `getSelectorMap()` when it needs one). */
const EMPTY_SELECTOR_MAP: Record<number, unknown> = Object.freeze({});

let snapshot: StateSnapshot | null = null;
let cachedState: BrowserState | null = null;
let lastFingerprint: string | null = null;
let lastEpoch = -1;
let lastTabs: TabInfo[] | null = null;
let lastUrl: string | null = null;
let lastTitle: string | null = null;

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
 * (DOMRect instances become plain x/y/width/height objects). */
function toSnapshot(state: BrowserState): StateSnapshot {
  return {
    url: state.url,
    title: state.title,
    tabs: state.tabs,
    elements: state.elements.map((el) => ({
      index: el.index,
      tag: el.tag,
      text: el.text,
      attributes: el.attributes,
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
 * fingerprint moved, tabs/url/title changed, or the signal unarmed — a fresh
 * extraction runs, its snapshot replaces the cache, and the live state is
 * returned.
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
    lastTitle === document.title;

  if (unchanged && snapshot !== null) {
    if (cachedState === null) {
      cachedState = deepFreeze({
        ...snapshot,
        selectorMap: EMPTY_SELECTOR_MAP,
      });
    }
    return cachedState;
  }

  const fresh = extractBrowserState(tabs);
  lastEpoch = getDomEpoch();
  lastFingerprint = domFingerprint();
  lastTabs = tabs;
  lastUrl = location.href;
  lastTitle = document.title;
  snapshot = toSnapshot(fresh);
  cachedState = null;
  return fresh;
}

/** Drop the cached snapshot so the next `cachedExtractBrowserState` call
 * falls back to a fresh extraction. Called from `resetDomBaseline()` (a page
 * changed — e.g. after `pageChanged` — even before the observer delivers) and
 * from the raw `extractBrowserState([])` path (a caller with empty tab
 * evidence proves nothing about the snapshot's tab/url/title legs). */
export function invalidateStateCache(): void {
  snapshot = null;
  cachedState = null;
  lastFingerprint = null;
  lastEpoch = -1;
  lastTabs = null;
  lastUrl = null;
  lastTitle = null;
}