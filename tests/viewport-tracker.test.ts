/**
 * ViewportTracker tests — `src/lib/agent/dom/viewport-tracker.ts`.
 *
 * jsdom has no IntersectionObserver (jsdom#2032), so tests/helpers/test-isolation.ts
 * installs a no-op stub globally: `observe`/`unobserve`/`disconnect` never fire
 * the callback and the last-constructed instance is exposed as
 * `globalThis.__ocLastIO`. These tests drive that stored callback with fake
 * `isIntersecting` entries to verify membership bookkeeping.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ViewportTracker, getViewportTracker } from "../src/lib/agent/dom/viewport-tracker";
import { bumpDomEpoch } from "../src/lib/agent/dom/mutation-signal";

interface IOStub {
  callback: IntersectionObserverCallback;
  observed: Element[];
}

const lastIO = (): IOStub | undefined =>
  (globalThis as { __ocLastIO?: IOStub }).__ocLastIO;

/** Drive the stored IO callback with a single fake intersection entry. */
function fireIO(target: Element, isIntersecting: boolean): void {
  const io = lastIO();
  if (!io) throw new Error("expected an IntersectionObserver stub to be installed");
  io.callback(
    [{ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 } as unknown as IntersectionObserverEntry],
    io as unknown as IntersectionObserver,
  );
}

describe("ViewportTracker", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("returns undefined (unknown) when IntersectionObserver is unavailable", () => {
    const tracker = new ViewportTracker(document.documentElement);
    expect(tracker.isInViewport(document.body)).toBeUndefined();
  });

  it("tracks observed elements and reports membership from the IO callback", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const tracker = new ViewportTracker(document.documentElement);
    tracker.observe(el);
    // fake IO: call the stored callback with isIntersecting: true
    fireIO(el, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(tracker.isInViewport(el)).toBe(true);
  });

  it("reports false membership from the IO callback", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const tracker = new ViewportTracker(document.documentElement);
    tracker.observe(el);
    fireIO(el, false);
    expect(tracker.isInViewport(el)).toBe(false);
  });

  it("membership stays undefined until the IO callback fires (callers fall back to rect math)", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const tracker = new ViewportTracker(document.documentElement);
    tracker.observe(el);
    expect(tracker.isInViewport(el)).toBeUndefined();
  });

  it("observe() is idempotent — the IO registers an element only once", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const tracker = new ViewportTracker(document.documentElement);
    tracker.observe(el);
    tracker.observe(el);
    expect(lastIO()?.observed).toHaveLength(1);
    expect(lastIO()?.observed).toContain(el);
  });

  it("returns undefined for every element while IntersectionObserver is genuinely unavailable", () => {
    const globalWithIO = globalThis as { IntersectionObserver?: unknown };
    const saved = globalWithIO.IntersectionObserver;
    delete globalWithIO.IntersectionObserver;
    try {
      const tracker = new ViewportTracker(document.documentElement);
      tracker.observe(document.body);
      expect(tracker.isInViewport(document.body)).toBeUndefined();
    } finally {
      globalWithIO.IntersectionObserver = saved;
    }
  });

  it("getViewportTracker rebuilds per DOM epoch — old IO disconnected (element refs released)", () => {
    const t1 = getViewportTracker();
    const io1 = lastIO();
    const el = document.createElement("div");
    document.body.appendChild(el);
    t1.observe(el);
    expect(io1?.observed).toContain(el);

    // The DOM epoch moves (any mutation bumps it) → membership for the old
    // epoch's DOM is meaningless, and the old IO holds STRONG references to
    // every element it observed — a long-lived tracker would leak them.
    bumpDomEpoch();
    const t2 = getViewportTracker();

    expect(t2).not.toBe(t1);
    const io2 = lastIO();
    expect(io2).not.toBe(io1);
    // The previous IO was disconnected: its observed set was cleared,
    // releasing the strong element references it held.
    expect(io1?.observed).toHaveLength(0);
    // The fresh tracker starts cold — unknown membership → rect-math fallback
    // (byte-identical to the pre-tracker gate) until the walk re-observes.
    expect(t2.isInViewport(el)).toBeUndefined();

    // Unchanged epoch → the same tracker persists (the steady-state
    // membership cache that makes cross-step reads free).
    expect(getViewportTracker()).toBe(t2);
  });
});
