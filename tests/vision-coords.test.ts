// @vitest-environment-options {"url":"http://vision-coords.test/"}

/**
 * Screenshot/vision coordinate correctness.
 *
 * Pins the full bounding-box → viewport-coordinate contract:
 * - `getBoundingClientRect()` returns CSS pixels, VIEWPORT-relative (the
 *   browser already subtracts the scroll offset) — the extraction pipeline
 *   passes those rects through unchanged, and the click pipeline consumes
 *   them unchanged (NO scrollY re-added, NO DPR applied).
 * - vision detections are produced in DEVICE pixels (= CSS × DPR); the
 *   merger divides them by the tab's DPR into CSS pixels so the cached
 *   pixelRect used for CDP clicks lands on the right element.
 * - `rectCenter` (the shared CDP_CLICK formula for both the DOM-rect and
 *   vision-rect paths) derives the mouse-press point from the CSS-pixel box.
 * - the screenshot annotator scales the SAME CSS rects by DPR to draw boxes
 *   at device resolution.
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { mergeDetections, renderMergedElementsText } from "../src/extension/vision-assistant/merger";
import { rescaleDetectionsToCapture } from "../src/extension/vision-assistant/box-parser";
import { rectCenter } from "../src/extension/background/cdp-rect-utils";
import { executeAction } from "../src/lib/agent/tools/executor";
import { makeState } from "./helpers";
import type { PixelDetection } from "../src/extension/vision-assistant/types";

function detection(x: number, y: number, width: number, height: number, label = "button"): PixelDetection {
  return { label, box: [x, y, x + width, y + height], pixelBox: { x, y, width, height } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../src/lib/agent/dom/annotation/canvas-utils");
  delete (globalThis as Record<string, unknown>).chrome;
  document.body.replaceChildren();
});

// ─── Vision detections: device pixels → CSS pixels via DPR ─────────────────

describe("vision detection → CSS-pixel mapping (DPR division)", () => {
  test("a DPR-2 detection at device (200,300,100,50) lands at CSS (100,150,50,25)", () => {
    const merged = mergeDetections([], [detection(200, 300, 100, 50)], 2);
    expect(merged).toHaveLength(1);
    const vision = merged[0];
    expect(vision.source).toBe("vision");
    expect(vision.visionId).toBe("v1");
    expect(vision.pixelRect).toEqual({ x: 100, y: 150, width: 50, height: 25 });
    expect(vision.rect).toEqual({ x: 100, y: 150, width: 50, height: 25 });
    expect(vision.attributes["data-vision-x"]).toBe("100");
    expect(vision.attributes["data-vision-y"]).toBe("150");
  });

  test("fractional DPR 1.5 scales correctly", () => {
    const merged = mergeDetections([], [detection(300, 450, 60, 30)], 1.5);
    expect(merged[0].pixelRect).toEqual({ x: 200, y: 300, width: 40, height: 20 });
  });

  test("DPR 1 passes device coordinates through unchanged (1:1 environment)", () => {
    const merged = mergeDetections([], [detection(10, 20, 30, 40)], 1);
    expect(merged[0].pixelRect).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  test("a detection overlapping a DOM element in CSS space is deduped BEFORE the center is computed (no double click target)", () => {
    const domEl = {
      index: 1,
      tag: "button",
      text: "Submit",
      attributes: {},
      hash: "h",
      rect: { x: 100, y: 100, width: 200, height: 50 },
    };
    // Same object in device pixels at DPR 2 — overlaps the DOM rect in CSS space.
    const merged = mergeDetections([domEl as never], [detection(200, 200, 400, 100)], 2);
    expect(merged.filter((m) => m.source === "vision")).toHaveLength(0);
  });

  test("rendered vision elements carry CSS-pixel coordinates (the values CDP consumes)", () => {
    const merged = mergeDetections([], [detection(400, 200, 80, 40)], 2);
    const text = renderMergedElementsText(merged);
    expect(text).toContain("[v1]<vision_element label=\"button\" x=\"200\" y=\"100\" w=\"40\" h=\"20\" />");
  });
});

// ─── Pre-resized VLM captures: boxes re-scaled to full capture space ────────

describe("pre-resized VLM captures: re-scale boxes to full capture space before merge", () => {
  test("boxes in the resized image's pixel space land on full-viewport CSS coords after re-scale + DPR division", () => {
    // 1280×800 CSS viewport at DPR 2 → 2560×1600 device-pixel capture,
    // pre-resized to the VLM decode edge (whLargest=512) → 512×320 input.
    const resized = [detection(51.2, 32, 51.2, 32)];
    const capture = { sourceWidth: 2560, sourceHeight: 1600, width: 512, height: 320 };
    const rescaled = rescaleDetectionsToCapture(resized, capture);
    // scale = sourceWidth/width = 2560/512 = 5 (same ratio for height).
    expect(rescaled[0].pixelBox).toEqual({ x: 256, y: 160, width: 256, height: 160 });
    // mergeDetections then divides by DPR as before (full-viewport device px).
    const merged = mergeDetections([], rescaled, 2);
    expect(merged[0].pixelRect).toEqual({ x: 128, y: 80, width: 128, height: 80 });
  });

  test("the re-scale is a no-op when the capture was already at/below the decode edge", () => {
    const dets = [detection(10, 20, 30, 40)];
    const capture = { sourceWidth: 800, sourceHeight: 600, width: 800, height: 600 };
    expect(rescaleDetectionsToCapture(dets, capture)).toBe(dets);
  });

  test("the re-scale is a no-op when the resize dims are unknown (no resize applied)", () => {
    const dets = [detection(10, 20, 30, 40)];
    expect(rescaleDetectionsToCapture(dets, {})).toBe(dets);
  });
});

// ─── rectCenter: the CDP_CLICK formula ──────────────────────────────────────

describe("rectCenter — CSS-pixel box → viewport mouse-press point", () => {
  test("computes the box center in the same space it received (no DPR, no scroll)", () => {
    expect(rectCenter({ x: 100, y: 200, width: 200, height: 100 })).toEqual({ x: 200, y: 250 });
    expect(rectCenter({ x: 0, y: 0, width: 1, height: 1 })).toEqual({ x: 0.5, y: 0.5 });
    // A sub-pixel box still lands inside the viewport space.
    expect(rectCenter({ x: -50, y: 10, width: 100, height: 20 })).toEqual({ x: 0, y: 20 });
  });

  test("the viewport-relative rect is used AS-IS: a scrolled element's document Y is NOT re-added", () => {
    // Element at document Y=500; the viewport is scrolled 300px down, so
    // getBoundingClientRect().y = 200. The click point must be 200+h/2 — NOT
    // 500+h/2 (which would click a full viewport-height too low).
    const viewportRect = { x: 120, y: 200, width: 160, height: 40 };
    expect(rectCenter(viewportRect)).toEqual({ x: 200, y: 220 });
    expect(rectCenter(viewportRect).y).not.toBe(500 + 20);
  });
});

// ─── End-to-end: the click pipeline sends the CSS rect, the SW centers it ──

describe("click pipeline sends viewport-relative CSS rects (scroll-safe)", () => {
  test("executeCdpClick forwards the exact getBoundingClientRect box to the SW", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as Record<string, unknown>).chrome = { runtime: { id: "coords-test", sendMessage } };
    const button = document.createElement("button");
    document.body.append(button);
    // Simulate the page scrolled 300px: the live rect is viewport-relative.
    Object.defineProperty(button, "getBoundingClientRect", {
      value: () => ({ x: 120, y: 200, width: 160, height: 40, top: 200, right: 280, bottom: 240, left: 120 }),
    });
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });

    const state = makeState({ selectorMap: { 1: button } });
    const result = await executeAction({ type: "click", index: 1 } as never, state);
    expect(result.success).toBe(true);

    const cdpMessage = sendMessage.mock.calls.map((c) => c[0] as { type?: string }).find((m) => m.type === "CDP_CLICK");
    expect(cdpMessage).toBeDefined();
    const rect = (cdpMessage as { rect?: { x: number; y: number; width: number; height: number } }).rect;
    expect(rect).toEqual({ x: 120, y: 200, width: 160, height: 40 });
    // The SW-side contract: press point = center of that box (viewport CSS px).
    expect(rectCenter(rect as never)).toEqual({ x: 200, y: 220 });
  });

  test("an element outside the viewport is rejected before any CDP click (no off-screen coordinate dispatch)", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as Record<string, unknown>).chrome = { runtime: { id: "coords-test", sendMessage } };
    const button = document.createElement("button");
    document.body.append(button);
    Object.defineProperty(button, "getBoundingClientRect", {
      value: () => ({ x: -500, y: 10, width: 20, height: 20, top: 10, right: -480, bottom: 30, left: -500 }),
    });
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });

    const state = makeState({ selectorMap: { 1: button } });
    const result = await executeAction({ type: "click", index: 1 } as never, state);
    // The COORDINATE guard rejects the off-screen CDP click...
    expect(sendMessage).not.toHaveBeenCalled();
    // ...and the handler falls back to a non-coordinate strategy (programmatic
    // el.click() does not need viewport coordinates). The invariant under test:
    // an off-screen box is NEVER dispatched as a CDP coordinate click.
    expect(result.message).not.toMatch(/CDP/);
  });
});

// ─── Screenshot annotator: same CSS rects scaled by DPR to device pixels ────

describe("screenshot annotation scales CSS rects by DPR (device-pixel drawing)", () => {
  test("a DPR-2 annotate draws the box at 2x CSS coordinates (device pixels)", async () => {
    const strokeRect = vi.fn();
    const fillRect = vi.fn();
    const measureText = vi.fn(() => ({ width: 20 }));
    const ctx = {
      font: "",
      textBaseline: "",
      strokeStyle: null,
      fillStyle: null,
      lineWidth: 0,
      scale: vi.fn(),
      strokeRect,
      fillRect,
      fillText: vi.fn(),
      measureText,
      drawImage: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      convertToBlob: vi.fn(async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" })),
    };
    const image = { width: 400, height: 300, drawTo: vi.fn(), cleanup: vi.fn() };

    vi.doMock("../src/lib/agent/dom/annotation/canvas-utils", () => ({
      createCompatibleCanvas: vi.fn(() => canvas),
      loadCompatibleImage: vi.fn(async () => image),
      canvasToDataUrl: async () => "data:image/jpeg;base64,OUT",
    }));
    const { annotateScreenshot } = await import("../src/lib/agent/dom/annotation/screenshot-annotator");
    const out = await annotateScreenshot("data:image/jpeg;base64,RAW", [
      { index: 7, rect: { x: 100, y: 200, width: 50, height: 30 } },
    ], { scaleFactor: 2 });
    vi.doUnmock("../src/lib/agent/dom/annotation/canvas-utils");

    // The mocked canvas path encoded successfully (the real canvasToDataUrl
    // converted the fake blob); the DRAW is what this test pins.
    expect(out).toMatch(/^data:image\/jpeg;base64,/);
    // CSS rect (100,200,50,30) scaled by DPR 2 → device rect (200,400,100,60).
    expect(strokeRect).toHaveBeenCalledWith(200, 400, 100, 60);
  });

  test("maxDimension caps the output canvas and scales the drawn box down with it", async () => {
    vi.resetModules();
    const strokeRect = vi.fn();
    const fillRect = vi.fn();
    const measureText = vi.fn(() => ({ width: 20 }));
    const scale = vi.fn();
    const ctx = {
      font: "",
      textBaseline: "",
      strokeStyle: null,
      fillStyle: null,
      lineWidth: 0,
      scale,
      strokeRect,
      fillRect,
      fillText: vi.fn(),
      measureText,
      drawImage: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      convertToBlob: vi.fn(async () => new Blob(["jpeg-bytes"], { type: "image/jpeg" })),
    };
    // A 2560×1600 source (DPR-2 viewport) capped to 1800px output.
    const image = { width: 2560, height: 1600, drawTo: vi.fn(), cleanup: vi.fn() };

    vi.doMock("../src/lib/agent/dom/annotation/canvas-utils", () => ({
      createCompatibleCanvas: vi.fn(() => canvas),
      loadCompatibleImage: vi.fn(async () => image),
      canvasToDataUrl: async () => "data:image/jpeg;base64,OUT",
    }));
    const { annotateScreenshot } = await import("../src/lib/agent/dom/annotation/screenshot-annotator");
    const out = await annotateScreenshot("data:image/jpeg;base64,RAW", [
      { index: 1, rect: { x: 100, y: 100, width: 100, height: 100 } },
    ], { scaleFactor: 2 });
    vi.doUnmock("../src/lib/agent/dom/annotation/canvas-utils");

    expect(out).toMatch(/^data:image\/jpeg;base64,/);
    // outScale = 1800/2560 = 0.703125 → canvas 1800x1125.
    expect(canvas.width).toBe(1800);
    expect(canvas.height).toBe(1125);
    // No 2D transform is applied — boxes are authored in pre-multiplied
    // capped-device px (regression pin for the removed ctx.scale double-scale
    // bug: a transform on top of pre-multiplied coords squished boxes toward
    // the origin whenever outScale < 1). The base layer is drawn at the
    // explicit dest size instead.
    expect(scale).not.toHaveBeenCalled();
    expect(image.drawTo).toHaveBeenCalledWith(ctx, 1800, 1125);
    // CSS (100,100,100,100) × DPR2 × outScale, rounded.
    expect(strokeRect).toHaveBeenCalledWith(141, 141, 141, 141);
  });
});
