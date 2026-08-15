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
import { ViewportTracker } from "../src/lib/agent/dom/viewport-tracker";

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
});
