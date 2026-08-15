import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadCache } from "../src/lib/agent/dom/utils/read-cache";
import { extractBrowserState } from "../src/lib/agent/dom/extraction/page-state";
import {
  installJsdomLayoutMock,
  restoreJsdomLayoutMock,
  installViewportMock,
  restoreViewportMock,
} from "./helpers";

describe("ReadCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("batches rect+style+visibility reads and serves them without touching the DOM", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const cache = new ReadCache();
    cache.batchRead(div);
    const spyRect = vi.spyOn(div, "getBoundingClientRect");
    const spyStyle = vi.spyOn(window, "getComputedStyle");
    expect(cache.getRect(div)).toBeDefined();
    expect(cache.getVisible(div)).toBe(false); // detached-ish/unstyled default
    expect(spyRect).not.toHaveBeenCalled();
    expect(spyStyle).not.toHaveBeenCalled();
    cache.clear();
    expect(cache.getRect(div)).toBeUndefined();
  });

  it("returns undefined for elements never read (fallback path preserved)", () => {
    const cache = new ReadCache();
    expect(cache.getRect(document.body)).toBeUndefined();
  });

  it("serves the cached computed style and memoizes the visibility boolean", () => {
    const div = document.createElement("div");
    div.style.display = "none";
    document.body.appendChild(div);
    const cache = new ReadCache();
    cache.batchRead(div);
    const spyStyle = vi.spyOn(window, "getComputedStyle");
    expect(cache.getStyle(div)?.display).toBe("none");
    expect(cache.getVisible(div)).toBe(false);
    expect(cache.getVisible(div)).toBe(false);
    expect(spyStyle).not.toHaveBeenCalled();
  });
});

describe("extractBrowserState walk read batching", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    installJsdomLayoutMock();
    installViewportMock({ innerHeight: 800, scrollHeight: 1600, scrollY: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreJsdomLayoutMock();
    restoreViewportMock();
  });

  it("second extraction on an unchanged page performs the same bounded reads (batch, not thrash)", () => {
    for (let i = 0; i < 200; i++) {
      const div = document.createElement("div");
      div.textContent = `item ${i}`;
      if (i % 10 === 0) {
        const button = document.createElement("button");
        button.textContent = `action ${i}`;
        div.appendChild(button);
      }
      document.body.appendChild(div);
    }
    const elementCount = document.body.querySelectorAll("*").length;

    // Walk 1 — count the layout reads (rect + computed style).
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const styleSpy = vi.spyOn(window, "getComputedStyle");
    const first = extractBrowserState([]);
    const firstRectReads = rectSpy.mock.calls.length;
    const firstStyleReads = styleSpy.mock.calls.length;
    rectSpy.mockRestore();
    styleSpy.mockRestore();

    // NOTE: do NOT reinstall the layout mock between walks. Its display cache
    // (per install) would otherwise force a `getComputedStyle` per `offsetParent`
    // read in walk 2, inflating the style count past the walk's own reads.
    const rectSpy2 = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const styleSpy2 = vi.spyOn(window, "getComputedStyle");
    const second = extractBrowserState([]);
    const secondRectReads = rectSpy2.mock.calls.length;
    const secondStyleReads = styleSpy2.mock.calls.length;

    // Both walks classify the same elements identically (JSON comparison:
    // rect `toJSON` closures differ per mock install, values don't).
    expect(first.elements.length).toBeGreaterThan(0);
    expect(JSON.stringify(second.elements)).toBe(JSON.stringify(first.elements));

    // Bounded: each walk reads each element's rect exactly once (batch, not
    // thrash). Without the cache the walk re-reads rects (text-parent viewport
    // checks + visibility fallbacks), pushing the count past the element count.
    expect(firstRectReads).toBe(elementCount);
    // Walk 1 does perform style reads (batchRead + the layout mock's
    // offsetParent display lookups) — only walk 2 is asserted to be free.
    expect(firstStyleReads).toBeGreaterThan(0);

    // Cross-walk reuse: the epoch-stamped shared cache serves every
    // element from walk 1, so walk 2 performs ZERO forced layout reads.
    expect(secondRectReads).toBe(0);
    expect(secondStyleReads).toBe(0);
  });
});