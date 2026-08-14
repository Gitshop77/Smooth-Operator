/**
 * Phase: observe-state — extracted from orchestrator.ts.
 *
 * Wraps the getTabs + extractState logic with error handling. Returns the
 * browser state on success, or an error result that the caller can use to
 * increment `consecutiveFailures` and decide whether to abort.
 */

import type { TabInfo } from "../../types";
import { cachedExtractBrowserState } from "../../dom/extraction/state-cache";
import type { LoopState, ObserveStateResult } from "../types";

/**
 * IMPORTANT (serialization contract): the `BrowserState` returned on success
 * is one of two shapes:
 *
 * - FRESH (first extraction, or after any change): may contain
 *   NON-SERIALIZABLE runtime-only fields — `selectorMap` (a map of live
 *   `HTMLElement`s) and `elements[].rect` (`DOMRect`s). `JSON.stringify`
 *   turns these into `{}`, so such an object MUST NOT cross a serialization
 *   boundary (e.g. `runtime.sendMessage` / `postMessage`, or a persisted/
 *   debug log). The extension caller (`content.ts`) already strips
 *   `selectorMap` before messaging; the in-loop caller here reads only the
 *   `elementsText`/`pageInfo`/`url`/`title`/`tabs` strings, so the live
 *   fields never leave the loop.
 * - CACHE-SERVED (page provably unchanged since the last extraction, per the
 *   gate in `dom/extraction/state-cache.ts` — mutation-epoch + fingerprint +
 *   tabs/url/title): DEEP-FROZEN, carries only JSON-safe data, and has no
 *   live `selectorMap` (empty map; the executor recomputes one from the live
 *   DOM via `getSelectorMap()` when it needs it). Read-only consumers are
 *   unaffected — but do NOT `Object.assign` into it (throws on a frozen
 *   target): rebind the variable instead.
 *
 * DELIBERATE STALE-OBSERVATION BEHAVIOR: the cache serves the last snapshot
 * for changes that neither the DOM-epoch MutationObserver nor
 * `domFingerprint()` can see — text selection, hover, focus changes, CSS
 * animation-driven style-only updates, and password/transient-text input
 * values (the fingerprint deliberately ignores style attributes and password
 * values). The agent then observes exactly "nothing changed". JS-driven
 * `style`-attribute writes DO fire `attributes` mutations and re-extract.
 * The cache is invalidated by `resetDomBaseline()` (runs after
 * `pageChanged`), any raw `extractBrowserState([])` call, and any of the
 * gate's three legs failing.
 */
export async function observeState(state: LoopState): Promise<ObserveStateResult> {
  let tabs: TabInfo[];
  try {
    tabs = await state.deps.getTabs();
  } catch (e) {
    return {
      status: "error",
      phase: "getTabs",
      message: `getTabs failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const usedOverride = !!state.deps.extractState;
  try {
    const browserState = usedOverride
      ? await state.deps.extractState!(tabs, { includeScreenshotOnce: state.pendingVisualInspection })
      : cachedExtractBrowserState(tabs);
    return { status: "ok", state: browserState, tabs };
  } catch (e) {
    return {
      status: "error",
      phase: "extractState",
      message: `${usedOverride ? "extractState" : "extractBrowserState"} failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
