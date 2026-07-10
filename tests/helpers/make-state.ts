/**
 * `makeState` — build a minimal BrowserState for executor / action-queue tests.
 *
 * Was duplicated byte-for-byte in `executor-actions.test.ts` and
 * `wiring-fixes.test.ts`. Override any field via `overrides` — defaults match
 * the shape those two files used.
 */
import type { BrowserState } from "../../src/lib/agent/types";

export function makeState(overrides: Partial<BrowserState> = {}): BrowserState {
  return {
    url: "https://example.com",
    title: "Test Page",
    tabs: [],
    elements: [],
    elementsText: "[empty]",
    pageInfo: "0 pages above, 0 pages below",
    newElementCount: 0,
    scrollTop: 0,
    scrollHeight: 1000,
    viewportHeight: 800,
    selectorMap: {},
    ...overrides,
  };
}
