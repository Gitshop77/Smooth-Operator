/**
 * Phase: observe-state — extracted from orchestrator.ts.
 *
 * Wraps the getTabs + extractState logic with error handling. Returns the
 * browser state on success, or an error result that the caller can use to
 * increment `consecutiveFailures` and decide whether to abort.
 */

import type { TabInfo } from "../../types";
import { extractBrowserState } from "../../dom/extractor";
import type { LoopState, ObserveStateResult } from "../types";

/**
 * IMPORTANT (serialization contract): the `BrowserState` returned on success
 * may contain NON-SERIALIZABLE runtime-only fields — `selectorMap` (a map of
 * live `HTMLElement`s) and `elements[].rect` (`DOMRect`s). `JSON.stringify`
 * turns these into `{}`, so this object MUST NOT cross a serialization
 * boundary (e.g. `runtime.sendMessage` / `postMessage`, or a persisted/debug
 * log). The extension caller (`content.ts`) already strips `selectorMap` before
 * messaging; the in-loop caller here returns the raw object relying on the
 * orchestrator/navigator reading only the `elementsText` string. If a future
 * caller needs to serialize it, project to a plain shape first (or expose
 * `getSelectorMap()` separately).
 *
 * NOTE: this path deliberately uses the RAW `extractBrowserState`, not the
 * skip-if-unchanged cache (`dom/extraction/state-cache.ts`). The returned
 * state flows into the BUILT-IN action executor, which resolves action
 * indices through the state's live `selectorMap`
 * (`tools/helpers/element-resolver.ts`) — a cache-served snapshot carries no
 * live map, so every indexed action would fail. The skip-if-unchanged cache
 * is consumed only by the extension's EXTRACT_STATE handler, where
 * `selectorMap` is stripped before the state crosses IPC.
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
      : extractBrowserState(tabs);
    return { status: "ok", state: browserState, tabs };
  } catch (e) {
    return {
      status: "error",
      phase: "extractState",
      message: `${usedOverride ? "extractState" : "extractBrowserState"} failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
