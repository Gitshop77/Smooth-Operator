/**
 * click-utils occlusion gate — a coordinate click whose center is covered by a
 * DIFFERENT element (modal/toast/cookie banner) must never dispatch onto the
 * covering overlay: `tryCdpClick` reports `occluded` and the click handler
 * hard-stops instead of falling through to JS strategies.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { tryCdpClick, executeCdpClick, occlusionError } from "../src/lib/agent/tools/handlers/click-utils";

function resetDom(): void {
  document.body.innerHTML = "";
  delete (document as unknown as Record<string, unknown>).elementFromPoint;
}

/** jsdom does not implement `elementFromPoint` — define it for the test. */
function stubElementFromPoint(hit: Element | null | (() => Element | null)): void {
  const fn = typeof hit === "function" ? hit : () => hit;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    writable: true,
    value: fn,
  });
}

beforeEach(resetDom);

describe("occlusionError", () => {
  test("returns null when the target itself is hit", () => {
    const el = document.createElement("button");
    el.style.position = "absolute";
    el.style.left = "10px";
    el.style.top = "10px";
    el.style.width = "100px";
    el.style.height = "40px";
    document.body.appendChild(el);
    stubElementFromPoint(el);
    expect(occlusionError(el, 60, 30)).toBeNull();
  });

  test("returns null when a DESCENDANT of the target is hit (self-contained widgets)", () => {
    const el = document.createElement("div");
    const child = document.createElement("span");
    el.appendChild(child);
    document.body.appendChild(el);
    stubElementFromPoint(child);
    expect(occlusionError(el, 60, 30)).toBeNull();
  });

  test("returns an error when a DIFFERENT element intercepts the center", () => {
    const el = document.createElement("button");
    const overlay = document.createElement("div");
    overlay.className = "cookie-banner";
    document.body.appendChild(el);
    document.body.appendChild(overlay);
    stubElementFromPoint(overlay);
    const err = occlusionError(el, 60, 30);
    expect(err).toBeTruthy();
    expect(err).toContain("cookie-banner");
    expect(err).toContain("overlay");
  });

  test("treats elementFromPoint failures as pass-through (never throws)", () => {
    const el = document.createElement("button");
    document.body.appendChild(el);
    stubElementFromPoint(() => {
      throw new Error("not implemented");
    });
    expect(() => occlusionError(el, 60, 30)).not.toThrow();
    expect(occlusionError(el, 60, 30)).toBeNull();
  });
});

describe("tryCdpClick occlusion", () => {
  test("a covered target is reported occluded (no CDP dispatch, no JS fallback signal)", () => {
    const el = document.createElement("button");
    el.style.position = "absolute";
    el.style.left = "10px";
    el.style.top = "10px";
    el.style.width = "100px";
    el.style.height = "40px";
    document.body.appendChild(el);
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);
    stubElementFromPoint(overlay);
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      runtime: { id: "test-ext" },
    };
    try {
      const result = tryCdpClick(el);
      expect(result.occluded).toBe(true);
      expect(result.clicked).toBe(false);
      expect(result.error).toMatch(/intercepted by <div>/);
    } finally {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    }
  });

  test("an uncovered target passes the gate (strategy CDP)", () => {
    const el = document.createElement("button");
    el.style.position = "absolute";
    el.style.left = "10px";
    el.style.top = "10px";
    el.style.width = "100px";
    el.style.height = "40px";
    document.body.appendChild(el);
    stubElementFromPoint(el);
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      runtime: { id: "test-ext" },
    };
    try {
      const result = tryCdpClick(el);
      expect(result.occluded).toBeUndefined();
      expect(result.strategyUsed).toBe("CDP");
    } finally {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    }
  });
});

describe("executeCdpClick occlusion", () => {
  test("a covered target fails fast with occluded=true (no SW round-trip)", async () => {
    const el = document.createElement("button");
    el.style.position = "absolute";
    el.style.left = "10px";
    el.style.top = "10px";
    el.style.width = "100px";
    el.style.height = "40px";
    document.body.appendChild(el);
    const overlay = document.createElement("div");
    document.body.appendChild(overlay);
    stubElementFromPoint(overlay);
    const sendMessage = vi.fn();
    (globalThis as unknown as { chrome?: unknown }).chrome = {
      runtime: { id: "test-ext", sendMessage },
    };
    try {
      const result = await executeCdpClick(el);
      expect(result.occluded).toBe(true);
      expect(result.clicked).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    }
  });
});
