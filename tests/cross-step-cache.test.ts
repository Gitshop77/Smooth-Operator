import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBrowserState } from "../src/lib/agent/dom/extraction/page-state";
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
});