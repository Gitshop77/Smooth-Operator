/**
 * Screenshot resize (S10) — pure resize-dimension math with Python `int()`
 * (truncation) semantics + the canvas re-encode helper in
 * `background/screenshots.ts` (imageSmoothingQuality "high" as the MV3
 * LANCZOS substitute).
 *
 * Pinned contracts (upstream test pins S04:376-386):
 * - width=800 on W×H → 800 × int(H·800/W) (aspect preserved, width exact).
 * - height=300 on W×H → int(W·300/H) × 300 (aspect preserved, height exact).
 * - width=400 & height=400 → exactly 400×400 (may stretch).
 * - whLargest=512 → the LONGEST side becomes 512, the other keeps ratio.
 * - whLargest takes precedence when width/height are also given.
 * - invalid / missing options → dimensions unchanged.
 * - resizeScreenshotDataUrl re-encodes at the computed dims with high-quality
 *   smoothing and returns the ORIGINAL data URL on any failure.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  computeResizeDims,
  resizeScreenshotDataUrl,
  type ResizeOptions,
} from "../src/extension/background/screenshots";

// ─── Fake canvas/image/ctx for the re-encode path ───────────────────────────

const fake = vi.hoisted(() => ({
  canvasAvailable: true,
  loadFails: false,
  canvas: {
    width: 0,
    height: 0,
    getContext: vi.fn(),
    convertToBlob: vi.fn(),
  },
  ctx: {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    drawImage: vi.fn(),
  },
  image: {
    width: 1000,
    height: 500,
    drawTo: vi.fn(),
    cleanup: vi.fn(),
  },
}));

vi.mock("../src/lib/agent/dom/annotation/canvas-utils", () => ({
  createCompatibleCanvas: () => (fake.canvasAvailable ? fake.canvas : null),
  loadCompatibleImage: async () => {
    if (fake.loadFails) throw new Error("decode failed");
    return fake.image;
  },
}));

vi.mock("../src/lib/agent/dom/annotation/screenshot-annotator-utils", () => ({
  canvasToDataUrl: async (_canvas: unknown, fallback: string) => `resized:${fallback}`,
}));

// ─── Pure dimension math ────────────────────────────────────────────────────

describe("computeResizeDims", () => {
  const dims = (w: number, h: number, opts?: ResizeOptions) => computeResizeDims(w, h, opts);

  test("width only → exact width, height keeps ratio (int truncation)", () => {
    expect(dims(1600, 900, { width: 800 })).toEqual({ width: 800, height: 450 });
    expect(dims(1000, 300, { width: 250 })).toEqual({ width: 250, height: 75 });
    // int() semantics: 1000·100/300 = 333.33… → 333, not 334.
    expect(dims(1000, 300, { height: 100 })).toEqual({ width: 333, height: 100 });
  });

  test("height only → exact height, width keeps ratio", () => {
    expect(dims(1600, 900, { height: 300 })).toEqual({ width: 533, height: 300 });
  });

  test("width + height → exactly those dims (may stretch)", () => {
    expect(dims(1600, 900, { width: 400, height: 400 })).toEqual({ width: 400, height: 400 });
  });

  test("whLargest → longest side becomes the target, ratio kept", () => {
    expect(dims(1000, 500, { whLargest: 512 })).toEqual({ width: 512, height: 256 });
    expect(dims(500, 1000, { whLargest: 512 })).toEqual({ width: 256, height: 512 });
    // int() semantics: 1000·0.512 = 512 exactly; a fractional scale truncates.
    expect(dims(1000, 300, { whLargest: 512 })).toEqual({ width: 512, height: 153 }); // 300·0.512 = 153.6 → 153
  });

  test("whLargest takes precedence over width/height", () => {
    expect(dims(1000, 500, { width: 100, height: 100, whLargest: 512 })).toEqual({
      width: 512,
      height: 256,
    });
  });

  test("no options → unchanged dimensions", () => {
    expect(dims(1000, 500)).toEqual({ width: 1000, height: 500 });
    expect(dims(1000, 500, {})).toEqual({ width: 1000, height: 500 });
  });

  test("invalid inputs (zero / negative / non-finite) → unchanged", () => {
    expect(dims(0, 0, { width: 800 })).toEqual({ width: 0, height: 0 });
    expect(dims(100, 50, { width: -5 })).toEqual({ width: 100, height: 50 });
    expect(dims(100, 50, { whLargest: 0 })).toEqual({ width: 100, height: 50 });
    expect(dims(Number.NaN, 50, { width: 800 })).toEqual({ width: Number.NaN, height: 50 });
    expect(dims(100, 50, { width: Number.POSITIVE_INFINITY })).toEqual({ width: 100, height: 50 });
  });
});

// ─── Canvas re-encode path ──────────────────────────────────────────────────

describe("resizeScreenshotDataUrl", () => {
  const DATA_URL = "data:image/jpeg;base64,AAAA";

  beforeEach(() => {
    fake.canvasAvailable = true;
    fake.loadFails = false;
    fake.canvas.width = 0;
    fake.canvas.height = 0;
    fake.canvas.getContext.mockReturnValue(fake.ctx);
    fake.ctx.imageSmoothingEnabled = false;
    fake.ctx.imageSmoothingQuality = "low";
    fake.image.width = 1000;
    fake.image.height = 500;
    fake.image.drawTo.mockClear();
    fake.image.cleanup.mockClear();
  });

  test("re-encodes at the computed dims with imageSmoothingQuality 'high'", async () => {
    const out = await resizeScreenshotDataUrl(DATA_URL, { whLargest: 512 });
    expect(out).toBe(`resized:${DATA_URL}`);
    expect(fake.canvas.width).toBe(512);
    expect(fake.canvas.height).toBe(256);
    expect(fake.ctx.imageSmoothingEnabled).toBe(true);
    expect(fake.ctx.imageSmoothingQuality).toBe("high");
    expect(fake.image.drawTo).toHaveBeenCalledWith(fake.ctx, 512, 256);
    expect(fake.image.cleanup).toHaveBeenCalled();
  });

  test("already-at-target dims → original returned without drawing", async () => {
    const out = await resizeScreenshotDataUrl(DATA_URL, {});
    expect(out).toBe(DATA_URL);
    expect(fake.image.drawTo).not.toHaveBeenCalled();
  });

  test("canvas unavailable → original returned", async () => {
    fake.canvasAvailable = false;
    expect(await resizeScreenshotDataUrl(DATA_URL, { whLargest: 512 })).toBe(DATA_URL);
  });

  test("2D context unavailable → original returned", async () => {
    fake.canvas.getContext.mockReturnValue(null);
    expect(await resizeScreenshotDataUrl(DATA_URL, { whLargest: 512 })).toBe(DATA_URL);
  });

  test("image decode failure → original returned", async () => {
    fake.loadFails = true;
    expect(await resizeScreenshotDataUrl(DATA_URL, { whLargest: 512 })).toBe(DATA_URL);
  });

  test("zero-dimension source → original returned", async () => {
    fake.image.width = 0;
    fake.image.height = 0;
    expect(await resizeScreenshotDataUrl(DATA_URL, { whLargest: 512 })).toBe(DATA_URL);
  });
});
