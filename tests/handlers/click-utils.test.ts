/**
 * `tryCdpClick` viewport pre-check — an element whose center lands exactly on
 * the right/bottom viewport edge is OUTSIDE the visible pixel range (coords are
 * 0-based, so the last visible pixel column is `innerWidth - 1`). The pre-check
 * must treat the edge pixel as outside instead of sending a coordinate click
 * that lands off-screen.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { tryCdpClick } from "../../src/lib/agent/tools/handlers/click-utils";

function installExtensionMock(): void {
  (globalThis as Record<string, unknown>).chrome = { runtime: { id: "ext-id" } };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
  vi.restoreAllMocks();
});

function stubRect(el: HTMLElement, x: number, y: number, width: number, height: number): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("tryCdpClick viewport edge pre-check", () => {
  test("rejects a center exactly at the right/bottom edge (0-based coords)", () => {
    installExtensionMock();
    const el = document.createElement("button");
    const w = window.innerWidth;
    const h = window.innerHeight;
    stubRect(el, w - 10, h - 10, 20, 20);
    const res = tryCdpClick(el);
    expect(res.error ?? "").toContain("outside the viewport");
  });

  test("allows a center one pixel inside the right/bottom edge", () => {
    installExtensionMock();
    const el = document.createElement("button");
    const w = window.innerWidth;
    const h = window.innerHeight;
    stubRect(el, w - 10, h - 10, 18, 18);
    const res = tryCdpClick(el);
    expect(res.error).toBeUndefined();
    expect(res.strategyUsed).toBe("CDP");
  });
});
