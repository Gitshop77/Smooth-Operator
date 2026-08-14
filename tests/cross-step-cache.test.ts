import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBrowserState } from "../src/lib/agent/dom/extraction/page-state";
import {
  __test_disarmMutationSignalForTests,
  installMutationSignal,
} from "../src/lib/agent/dom/mutation-signal";
import {
  installJsdomLayoutMock,
  restoreJsdomLayoutMock,
  installViewportMock,
  restoreViewportMock,
} from "./helpers";

describe("cross-step caches", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    installJsdomLayoutMock();
    installViewportMock({ innerHeight: 800, scrollHeight: 1600, scrollY: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    installMutationSignal();
    restoreJsdomLayoutMock();
    restoreViewportMock();
  });

  it("second extraction on an unchanged page reuses cached visibility (0 forced reflows)", () => {
    const btn = document.createElement("button");
    btn.textContent = "Click me";
    document.body.appendChild(btn);

    const first = extractBrowserState([]);
    expect(first.elements.length).toBeGreaterThan(0);

    const spyRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const spyStyle = vi.spyOn(window, "getComputedStyle");
    const second = extractBrowserState([]);
    expect(spyRect).not.toHaveBeenCalled();
    expect(spyStyle).not.toHaveBeenCalled();
    expect(second.elements.length).toBe(first.elements.length);
  });

  it("a DOM mutation invalidates the caches (extraction sees the new DOM)", async () => {
    const btn = document.createElement("button");
    btn.textContent = "Click me";
    document.body.appendChild(btn);
    extractBrowserState([]);

    const added = document.createElement("button");
    added.textContent = "Added later";
    document.body.appendChild(added);
    await new Promise((r) => setTimeout(r, 10));

    const state = extractBrowserState([]);
    expect(state.elementsText).toContain("Added later");
  });

  it("fail-closed: an unarmed mutation signal never serves cross-walk caches (second extraction re-reads)", () => {
    const btn = document.createElement("button");
    btn.textContent = "Click me";
    document.body.appendChild(btn);
    installMutationSignal();
    extractBrowserState([]);

    __test_disarmMutationSignalForTests();
    // Simulate an environment without MutationObserver so the re-extract's
    // installMutationSignal() cannot re-arm the signal.
    vi.stubGlobal("MutationObserver", undefined);
    try {
      const spyRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
      const spyStyle = vi.spyOn(window, "getComputedStyle");
      const second = extractBrowserState([]);
      expect(spyRect).toHaveBeenCalled();
      expect(spyStyle).toHaveBeenCalled();
      expect(second.elements.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});