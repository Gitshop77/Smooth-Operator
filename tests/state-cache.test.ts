/**
 * Skip-if-unchanged extraction cache tests.
 *
 * `cachedExtractBrowserState` serves the last successful extraction's
 * serialized snapshot when the page is provably unchanged since then:
 * mutation-signal epoch unchanged (and armed), `domFingerprint()` unchanged,
 * and tabs/url/title unchanged. A cache-served state must be DEEP-FROZEN and
 * returned WITHOUT walking the DOM.
 *
 * The "no DOM walk" marker is `ReadCache.prototype.batchRead`: every walker
 * element visit calls it (the epoch-stamped read cache makes the
 * underlying rect/style reads zero-cost, but the METHOD is still invoked per
 * element), while the epoch/fingerprint/tabs gate never touches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedExtractBrowserState,
  invalidateStateCache,
  setCachedAxTree,
} from "../src/lib/agent/dom/extraction/state-cache";
import { ReadCache } from "../src/lib/agent/dom/utils/read-cache";
import {
  installMutationSignal,
  __test_disarmMutationSignalForTests,
} from "../src/lib/agent/dom/mutation-signal";
import {
  installJsdomLayoutMock,
  restoreJsdomLayoutMock,
  installViewportMock,
  restoreViewportMock,
} from "./helpers";
import type { TabInfo } from "../src/lib/agent/types";

function makeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: 1,
    label: "1",
    url: "https://example.com/",
    title: "Example",
    active: true,
    ...overrides,
  };
}

describe("state-cache", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installJsdomLayoutMock();
    installViewportMock({ innerHeight: 800, scrollHeight: 1600, scrollY: 0 });
    installMutationSignal();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    installMutationSignal();
    restoreJsdomLayoutMock();
    restoreViewportMock();
  });

  it("serves the cached state on an unchanged page (no DOM walk)", () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    const first = cachedExtractBrowserState([]);
    expect(first.elements.length).toBeGreaterThan(0);

    const walkSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const second = cachedExtractBrowserState([]);

    expect(walkSpy).not.toHaveBeenCalled();
    expect(second.elementsText).toBe(first.elementsText);
    expect(second.elements.length).toBe(first.elements.length);
    expect(second).toBe(cachedExtractBrowserState([]));
  });

  it("serves a DEEP-FROZEN state from the cache", () => {
    document.body.innerHTML = "<button id='b'>Go</button><a href='/x'>Link</a>";
    cachedExtractBrowserState([]);
    const served = cachedExtractBrowserState([]);
    expect(Object.isFrozen(served)).toBe(true);
    expect(Object.isFrozen(served.elements)).toBe(true);
    expect(Object.isFrozen(served.elements[0])).toBe(true);
    expect(Object.isFrozen(served.elements[0].rect)).toBe(true);
    expect(Object.isFrozen(served.elements[0].attributes)).toBe(true);
    expect(Object.isFrozen(served.tabs)).toBe(true);
  });

  it("re-extracts after a DOM mutation", async () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    const first = cachedExtractBrowserState([]);
    document.body.appendChild(document.createElement("button"));
    await new Promise((r) => setTimeout(r, 10));
    const second = cachedExtractBrowserState([]);
    expect(second.elements.length).toBeGreaterThan(first.elements.length);
    invalidateStateCache();
  });

  it("re-extracts when the tabs argument changes (tabs-sensitivity)", () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    cachedExtractBrowserState([makeTab()]);
    const walkSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const second = cachedExtractBrowserState([]);
    expect(walkSpy).toHaveBeenCalled();
    expect(second.elements.length).toBeGreaterThan(0);
  });

  it("defends the tabs leg against in-place caller mutation", () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    const tabs = [makeTab()];
    cachedExtractBrowserState(tabs);
    tabs[0].url = "https://changed.example/";
    const walkSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const second = cachedExtractBrowserState(tabs);
    expect(walkSpy).toHaveBeenCalled();
    expect(second.elements.length).toBeGreaterThan(0);
  });

  it("re-extracts after a scroll (scroll legs are part of the gate)", () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    cachedExtractBrowserState([]);
    installViewportMock({ innerHeight: 800, scrollHeight: 1600, scrollY: 120 });
    const walkSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const second = cachedExtractBrowserState([]);
    expect(walkSpy).toHaveBeenCalled();
    expect(second.scrollTop).toBe(120);
    expect(second.elements.length).toBeGreaterThan(0);
  });

  it("serves the stashed axTree on a cache hit without re-extracting", () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    cachedExtractBrowserState([]);
    setCachedAxTree("AX-TREE-A");
    const walkSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const served = cachedExtractBrowserState([]);
    expect(walkSpy).not.toHaveBeenCalled();
    expect(served.axTree).toBe("AX-TREE-A");
    expect(Object.isFrozen(served)).toBe(true);
  });

  it("a fresh extract clears the stashed axTree (never outlives its snapshot)", async () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    cachedExtractBrowserState([]);
    setCachedAxTree("AX-TREE-A");
    document.body.appendChild(document.createElement("a"));
    await new Promise((r) => setTimeout(r, 10));
    cachedExtractBrowserState([]); // miss — stash cleared
    const served = cachedExtractBrowserState([]); // hit on the new snapshot
    expect(served.axTree).toBeUndefined();
  });

  it("invalidateStateCache drops the stashed axTree too", () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    cachedExtractBrowserState([]);
    setCachedAxTree("AX-TREE-A");
    invalidateStateCache();
    cachedExtractBrowserState([]); // miss
    const served = cachedExtractBrowserState([]); // hit
    expect(served.axTree).toBeUndefined();
  });

  it("invalidateStateCache forces a fresh extract", () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    const first = cachedExtractBrowserState([]);
    invalidateStateCache();
    const walkSpy = vi.spyOn(ReadCache.prototype, "batchRead");
    const fresh = cachedExtractBrowserState([]);
    expect(walkSpy).toHaveBeenCalled();
    expect(fresh).toBeDefined();
    expect(fresh.elementsText).toBe(first.elementsText);
  });

  it("fail-closed: an unarmed mutation signal never serves the cache", () => {
    document.body.innerHTML = "<button id='b'>Go</button>";
    cachedExtractBrowserState([]);

    __test_disarmMutationSignalForTests();
    vi.stubGlobal("MutationObserver", undefined);
    try {
      const walkSpy = vi.spyOn(ReadCache.prototype, "batchRead");
      const second = cachedExtractBrowserState([]);
      expect(walkSpy).toHaveBeenCalled();
      expect(second.elements.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
