/**
 * S11 scroll verbs — scroll_to_bottom, get_computed_style, get_page_info.
 *
 * Pinned contracts:
 * - scroll_to_bottom: loop `scrollBy({top: innerHeight})` until scrollY stops
 *   changing (bottom reached), waiting `delay_seconds` (default 0.4) after
 *   each viewport scroll for lazy content, then `scrollTo(0, 0)` to restore
 *   the viewport to the top. Abort mid-loop rejects with AbortError (sleep
 *   propagates, like `wait`).
 * - get_computed_style: reads the requested CSS properties of `[index]` via
 *   getComputedStyle; kebab-case names go through getPropertyValue, camelCase
 *   through direct property access. Missing/detached element throws
 *   NoSuchElementException (element-disappeared contract, like hover).
 * - get_page_info: payload `{ url, title, readyState, viewport, document,
 *   scroll }` serialized as the extractedContent.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { ActionContext } from "../src/lib/agent/tools/handlers/types";
import type { ActionResult } from "../src/lib/agent/types";
import { makeState } from "./helpers";
import { handleScrollToBottom } from "../src/lib/agent/tools/handlers/scroll";
import { handleGetComputedStyle } from "../src/lib/agent/tools/handlers/get-computed-style";
import { handleGetPageInfo } from "../src/lib/agent/tools/handlers/get-page-info";
import { NoSuchElementException } from "../src/lib/agent/errors";
import { ActionSchema } from "../src/lib/agent/tools/schema";

function ctx(signal?: AbortSignal): ActionContext {
  return {
    state: makeState(),
    beforeUrl: "http://localhost:3000/",
    beforeFingerprint: "fp",
    signal,
  };
}

// ─── scroll_to_bottom ──────────────────────────────────────────────────────

describe("handleScrollToBottom", () => {
  // jsdom never moves scrollY, so stub the window scroll surface: scrollBy
  // advances the fake position up to MAX_Y (simulating a finite page), and
  // scrollTo(0, 0) resets it.
  const MAX_Y = 1500;
  let fakeY = 0;
  let scrollBySpy: ReturnType<typeof vi.spyOn>;
  let scrollToSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeY = 0;
    scrollBySpy = vi.spyOn(window, "scrollBy").mockImplementation(() => {
      fakeY = Math.min(fakeY + window.innerHeight, MAX_Y);
    });
    scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation((x?: number, y?: number) => {
      if (typeof y === "number") fakeY = y;
      else fakeY = 0;
      return undefined;
    });
    // keep the scrollY accessor mock in sync with the fake position
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => fakeY);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("scrolls in viewport steps until the bottom, then restores the viewport to the top", async () => {
    vi.useFakeTimers();
    const p = handleScrollToBottom(ctx(), { type: "scroll_to_bottom", delay_seconds: 0.4 });
    // MAX_Y 1500, innerHeight 768 → scrolls 768, 1500, then no movement.
    await vi.advanceTimersByTimeAsync(400 * 10);
    const result = await p;

    expect(scrollBySpy).toHaveBeenCalledWith({ top: 768 });
    expect(scrollBySpy).toHaveBeenCalledTimes(3);
    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
    expect(result.success).toBe(true);
    expect(result.message).toBe(
      "Scrolled to bottom (2 steps) and restored the viewport to the top",
    );
  });

  test("uses the default 0.4s delay between viewport scrolls", async () => {
    vi.useFakeTimers();
    const p = handleScrollToBottom(ctx(), { type: "scroll_to_bottom", delay_seconds: 0.4 });
    await vi.advanceTimersByTimeAsync(399);
    // 399ms < 400ms → the first wait is still pending, only the initial
    // scrollBy has run.
    expect(scrollBySpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scrollBySpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400 * 10);
    await p;
  });

  test("honors a custom delay_seconds", async () => {
    vi.useFakeTimers();
    const p = handleScrollToBottom(ctx(), {
      type: "scroll_to_bottom",
      delay_seconds: 0.25,
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(scrollBySpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scrollBySpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400 * 10);
    await p;
  });

  test("already at the bottom → single scroll, immediate restore", async () => {
    vi.useFakeTimers();
    // scrollBy becomes a no-op (page cannot move).
    scrollBySpy.mockImplementation(() => undefined);
    const p = handleScrollToBottom(ctx(), { type: "scroll_to_bottom", delay_seconds: 0.4 });
    await vi.advanceTimersByTimeAsync(400);
    const result = await p;
    expect(scrollBySpy).toHaveBeenCalledTimes(1);
    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
    expect(result.message).toBe(
      "Scrolled to bottom (0 steps) and restored the viewport to the top",
    );
  });

  test("abort mid-loop rejects with AbortError", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const p = handleScrollToBottom(ctx(controller.signal), { type: "scroll_to_bottom", delay_seconds: 0.4 });
    await vi.advanceTimersByTimeAsync(400);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

// ─── get_computed_style ────────────────────────────────────────────────────

describe("handleGetComputedStyle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  test("reads kebab-case properties via getPropertyValue", () => {
    const el = document.createElement("div");
    el.style.color = "rgb(1, 2, 3)";
    document.body.appendChild(el);
    const result = handleGetComputedStyle(
      { ...ctx(), state: makeState({ selectorMap: { 1: el } }) },
      { type: "get_computed_style", index: 1, properties: ["color", "background-color"] },
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("(2 properties)");
    const record = JSON.parse(result.extractedContent ?? "{}") as Record<string, string>;
    expect(record.color).toBe("rgb(1, 2, 3)");
    // unset properties resolve to the computed default ("transparent"), not ""
    expect(record["background-color"]).toBe("rgba(0, 0, 0, 0)");
  });

  test("unknown property name yields an empty string", () => {
    const el = document.createElement("div");
    el.style.color = "rgb(1, 2, 3)";
    document.body.appendChild(el);
    const result = handleGetComputedStyle(
      { ...ctx(), state: makeState({ selectorMap: { 1: el } }) },
      { type: "get_computed_style", index: 1, properties: ["zzz"] },
    );
    const record = JSON.parse(result.extractedContent ?? "{}") as Record<string, string>;
    expect(record.zzz).toBe("");
  });

  test("reads camelCase properties via direct access", () => {
    const el = document.createElement("div");
    el.style.backgroundColor = "rgb(4, 5, 6)";
    document.body.appendChild(el);
    const result = handleGetComputedStyle(
      { ...ctx(), state: makeState({ selectorMap: { 1: el } }) },
      { type: "get_computed_style", index: 1, properties: ["backgroundColor"] },
    );
    const record = JSON.parse(result.extractedContent ?? "{}") as Record<string, string>;
    expect(record.backgroundColor).toBe("rgb(4, 5, 6)");
  });

  test("missing index throws NoSuchElementException (element-disappeared contract)", () => {
    expect(() =>
      handleGetComputedStyle(ctx(), { type: "get_computed_style", index: 1, properties: ["color"] }),
    ).toThrow(NoSuchElementException);
  });

  test("detached element throws NoSuchElementException", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.remove();
    const state = makeState({ selectorMap: { 1: el } });
    expect(() =>
      handleGetComputedStyle({ ...ctx(), state }, { type: "get_computed_style", index: 1, properties: ["color"] }),
    ).toThrow(NoSuchElementException);
  });

  test("schema rejects property names outside [a-zA-Z-]{1,64}", () => {
    expect(
      ActionSchema.safeParse({
        type: "get_computed_style",
        index: 1,
        properties: ["color!"],
      }).success,
    ).toBe(false);
    expect(
      ActionSchema.safeParse({
        type: "get_computed_style",
        index: 1,
        properties: ["background color"],
      }).success,
    ).toBe(false);
  });

  test("schema caps properties at 50", () => {
    expect(
      ActionSchema.safeParse({
        type: "get_computed_style",
        index: 1,
        properties: Array.from({ length: 51 }, (_, i) => `p${i}`),
      }).success,
    ).toBe(false);
    expect(
      ActionSchema.safeParse({
        type: "get_computed_style",
        index: 1,
        properties: ["color"],
      }).success,
    ).toBe(true);
  });
});

// ─── get_page_info ─────────────────────────────────────────────────────────

describe("handleGetPageInfo", () => {
  beforeEach(() => {
    document.title = "S11 Test Page";
    document.body.innerHTML = "";
  });

  test("returns the page payload as extractedContent", () => {
    const result: ActionResult = handleGetPageInfo(ctx(), { type: "get_page_info" });
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.extractedContent ?? "{}") as Record<string, unknown>;
    expect(payload.url).toBe(window.location.href);
    expect(payload.title).toBe("S11 Test Page");
    expect(payload.readyState).toBe(document.readyState);
    const viewport = payload.viewport as Record<string, number>;
    expect(viewport.width).toBe(window.innerWidth);
    expect(viewport.height).toBe(window.innerHeight);
    const doc = payload.document as Record<string, number>;
    expect(typeof doc.width).toBe("number");
    expect(typeof doc.height).toBe("number");
    const scroll = payload.scroll as Record<string, number>;
    expect(typeof scroll.x).toBe("number");
    expect(typeof scroll.y).toBe("number");
  });
});
