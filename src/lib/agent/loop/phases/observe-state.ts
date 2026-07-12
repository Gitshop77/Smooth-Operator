/**
 * Phase: observe-state — extracted from orchestrator.ts (Phase 1).
 *
 * Wraps the getTabs + extractState logic with error handling. Returns the
 * browser state on success, or an error result that the caller can use to
 * increment `consecutiveFailures` and decide whether to abort.
 */

import type { BrowserState, TabInfo } from "../../types";
import { extractBrowserState } from "../../dom/extractor";
import type { LoopState, ObserveStateResult } from "../types";

/**
 * Wrap the getTabs + extractState logic with error handling. Returns the
 * browser state on success, or an error result that the caller can use to
 * increment `consecutiveFailures` and decide whether to abort.
 */
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

  let browserState: BrowserState;
  try {
    if (state.deps.extractState) {
      browserState = await state.deps.extractState(tabs);
    } else {
      browserState = extractBrowserState(tabs);
    }
  } catch (e) {
    return {
      status: "error",
      phase: "extractState",
      message: `extractBrowserState failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { status: "ok", state: browserState, tabs };
}
