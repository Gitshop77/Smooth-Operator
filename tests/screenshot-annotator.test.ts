/**
 * Screenshot-annotator drawing-path tests — mock the canvas + image-decoder
 * primitives from `./canvas-utils` and assert each draw branch: validation
 * skips (NaN / infinite / negative / sub-minSize), scaleFactor handling,
 * palette cycling, label rendering, and the fallback branches (image load
 * failure, no canvas, no 2D context, encode failure).
 *
 * Run with: `npx vitest run tests/screenshot-annotator.test.ts`
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  annotateScreenshot,
  DEFAULT_ANNOTATE_PALETTE,
  type AnnotatableElement,
} from "../src/lib/agent/dom/annotation/screenshot-annotator";
import {
  createCompatibleCanvas,
  loadCompatibleImage,
} from "../src/lib/agent/dom/annotation/canvas-utils";

vi.mock("../src/lib/agent/dom/annotation/canvas-utils", () => ({
  createCompatibleCanvas: vi.fn(),
  loadCompatibleImage: vi.fn(),
}));

const mockCreateCanvas = vi.mocked(createCompatibleCanvas);
const mockLoadImage = vi.mocked(loadCompatibleImage);

const RAW = "data:image/jpeg;base64,SENTINEL";

type MockContext = {
  font: string;
  textBaseline: string;
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  strokeRect: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  measureText: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
};

function makeContext(): MockContext {
  return {
    font: "",
    textBaseline: "",
    strokeStyle: null,
    fillStyle: null,
    lineWidth: 0,
    strokeRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 20 })),
    drawImage: vi.fn(),
    scale: vi.fn(),
  };
}

function makeCanvas(ctx: MockContext, encodeFails = false) {
  return {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    convertToBlob: vi.fn(async () => {
      if (encodeFails) throw new Error("encode failed");
      return new Blob(["jpeg-bytes"], { type: "image/jpeg" });
    }),
  };
}

function makeImage(width: number, height: number) {
  return {
    width,
    height,
    drawTo: vi.fn(),
    cleanup: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("validation skips (no draw work)", () => {
  test("NaN rect coordinates → raw screenshot, canvas never created", async () => {
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: NaN, y: 0, width: 50, height: 50 } },
    ];
    await expect(annotateScreenshot(RAW, elements)).resolves.toBe(RAW);
    expect(mockCreateCanvas).not.toHaveBeenCalled();
    expect(mockLoadImage).not.toHaveBeenCalled();
  });

  test("infinite dimensions → raw screenshot", async () => {
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: Infinity, height: 50 } },
    ];
    await expect(annotateScreenshot(RAW, elements)).resolves.toBe(RAW);
    expect(mockCreateCanvas).not.toHaveBeenCalled();
  });

  test("sub-minSize element → raw screenshot (box would be unreadable)", async () => {
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 2, height: 2 } },
    ];
    await expect(annotateScreenshot(RAW, elements)).resolves.toBe(RAW);
    expect(mockCreateCanvas).not.toHaveBeenCalled();
  });
});

describe("fallback branches", () => {
  test("no canvas implementation → raw screenshot", async () => {
    mockCreateCanvas.mockReturnValue(null);
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    await expect(annotateScreenshot(RAW, elements)).resolves.toBe(RAW);
  });

  test("image load failure → raw screenshot", async () => {
    mockCreateCanvas.mockReturnValue(makeCanvas(makeContext()) as never);
    mockLoadImage.mockRejectedValue(new Error("decode failed"));
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    await expect(annotateScreenshot(RAW, elements)).resolves.toBe(RAW);
  });

  test("zero-size decoded image → raw screenshot, image resources released", async () => {
    const img = makeImage(0, 0);
    mockCreateCanvas.mockReturnValue(makeCanvas(makeContext()) as never);
    mockLoadImage.mockResolvedValue(img);
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    await expect(annotateScreenshot(RAW, elements)).resolves.toBe(RAW);
    expect(img.cleanup).toHaveBeenCalled();
  });

  test("no 2D context → raw screenshot", async () => {
    mockCreateCanvas.mockReturnValue({
      width: 0,
      height: 0,
      getContext: vi.fn(() => null),
    } as never);
    mockLoadImage.mockResolvedValue(makeImage(100, 100));
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    await expect(annotateScreenshot(RAW, elements)).resolves.toBe(RAW);
  });

  test("encode failure → raw screenshot fallback", async () => {
    mockCreateCanvas.mockReturnValue(makeCanvas(makeContext(), true) as never);
    mockLoadImage.mockResolvedValue(makeImage(100, 100));
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    await expect(annotateScreenshot(RAW, elements)).resolves.toBe(RAW);
  });
});

describe("drawing path", () => {
  test("scaleFactor scales rects, font, and line width to device pixels", async () => {
    const ctx = makeContext();
    mockCreateCanvas.mockReturnValue(makeCanvas(ctx) as never);
    mockLoadImage.mockResolvedValue(makeImage(200, 100));
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 10, y: 20, width: 100, height: 50 } },
    ];

    const out = await annotateScreenshot(RAW, elements, { scaleFactor: 2 });

    expect(ctx.strokeRect).toHaveBeenCalledWith(20, 40, 200, 100);
    expect(ctx.lineWidth).toBe(2);
    expect(ctx.font).toBe("bold 28px sans-serif");
    expect(out).toMatch(/^data:image\/jpeg;base64,/);
    expect(out).not.toBe(RAW);
  });

  test("palette cycles by index in multi-color mode", async () => {
    const ctx = makeContext();
    mockCreateCanvas.mockReturnValue(makeCanvas(ctx) as never);
    mockLoadImage.mockResolvedValue(makeImage(200, 100));
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 50, height: 50 } },
      { index: 2, rect: { x: 60, y: 0, width: 50, height: 50 } },
      { index: 3, rect: { x: 120, y: 0, width: 50, height: 50 } },
    ];

    await annotateScreenshot(RAW, elements, { boxColors: ["#ff0000", "#00ff00"] });

    const strokes = vi.mocked(ctx.strokeRect).mock.calls;
    expect(strokes).toHaveLength(3);
    const fillStyles = vi.mocked(ctx.fillRect).mock.calls;
    expect(fillStyles).toHaveLength(3);
    // indices 1,2,3 → palette[1], palette[0], palette[1]
    expect(ctx.strokeStyle).toBe("#00ff00");
  });

  test("labels use refPrefix + index and honor an explicit textColor", async () => {
    const ctx = makeContext();
    mockCreateCanvas.mockReturnValue(makeCanvas(ctx) as never);
    mockLoadImage.mockResolvedValue(makeImage(200, 100));
    const elements: AnnotatableElement[] = [
      { index: 3, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];

    await annotateScreenshot(RAW, elements, {
      refPrefix: "e",
      textColor: "#000000",
      scaleFactor: 1,
    });

    expect(ctx.measureText).toHaveBeenCalledWith("e3");
    expect(ctx.fillText).toHaveBeenCalledWith("e3", 3, 2);
    expect(ctx.fillStyle).toBe("#000000");
  });

  test("a negative index still maps to a valid palette slot (no NaN lookup)", async () => {
    const ctx = makeContext();
    mockCreateCanvas.mockReturnValue(makeCanvas(ctx) as never);
    mockLoadImage.mockResolvedValue(makeImage(200, 100));
    const elements: AnnotatableElement[] = [
      { index: -1, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];

    await expect(
      annotateScreenshot(RAW, elements, { boxColors: ["#ff0000", "#00ff00"] }),
    ).resolves.toMatch(/^data:image\/jpeg;base64,/);
    expect(ctx.strokeStyle).toBe("#00ff00");
  });

  test("re-encodes at the caller-provided JPEG quality (policy quality / 100)", async () => {
    const ctx = makeContext();
    const canvas = makeCanvas(ctx);
    mockCreateCanvas.mockReturnValue(canvas as never);
    mockLoadImage.mockResolvedValue(makeImage(200, 100));
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];

    await annotateScreenshot(RAW, elements, { quality: 0.8 });

    expect(canvas.convertToBlob).toHaveBeenCalledWith({ type: "image/jpeg", quality: 0.8 });
  });

  test("maxDimension option caps the canvas long edge at annotation time", async () => {
    const ctx = makeContext();
    const canvas = makeCanvas(ctx);
    mockCreateCanvas.mockReturnValue(canvas as never);
    mockLoadImage.mockResolvedValue(makeImage(400, 200));
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ];

    await annotateScreenshot(RAW, elements, { maxDimension: 100 });

    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(50);
  });

  test("outScale < 1 draws boxes at pre-multiplied device px with no extra transform (no double-scale)", async () => {
    const ctx = makeContext();
    const canvas = makeCanvas(ctx);
    mockCreateCanvas.mockReturnValue(canvas as never);
    // A 2400x1600 source (full-res capture) capped to maxDimension 1800 →
    // outScale 0.75. Coordinates are pre-multiplied by scaleFactor * outScale
    // into device px; a lingering ctx.scale(outScale, outScale) transform
    // would apply the downscale a SECOND time at render (squishing every box
    // toward the origin), so the transform must NOT be set and the base image
    // must be drawn at the canvas' explicit dest size instead.
    const img = makeImage(2400, 1600);
    mockLoadImage.mockResolvedValue(img);
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 100, y: 100, width: 200, height: 100 } },
    ];

    await annotateScreenshot(RAW, elements, { maxDimension: 1800, scaleFactor: 2 });

    expect(canvas.width).toBe(1800);
    expect(canvas.height).toBe(1200);
    expect(ctx.scale).not.toHaveBeenCalled();
    // Base layer drawn at the canvas' dest size (scaled down in the draw call,
    // not by a context transform).
    expect(img.drawTo).toHaveBeenCalledWith(ctx, 1800, 1200);
    // Device px: CSS (100,100,200,100) x DPR 2 x outScale 0.75, rounded.
    expect(ctx.strokeRect).toHaveBeenCalledWith(150, 150, 300, 150);
  });

  test("outScale < 1 scales the label font by outScale so the label stays inside its box", async () => {
    // Regression: the removed ctx.scale transform used to scale EVERYTHING
    // (including the label font) by outScale at render time. With the
    // transform gone, a font at fontSize x scaleFactor alone renders
    // 1/outScale too big — taller than its own pill and overflowing the box.
    // The label font must be fontSize x scaleFactor x outScale; the pill
    // (sFont * outScale + padding) then fits it exactly.
    const ctx = makeContext();
    const canvas = makeCanvas(ctx);
    mockCreateCanvas.mockReturnValue(canvas as never);
    // Same downscaled path as the double-scale regression test.
    mockLoadImage.mockResolvedValue(makeImage(2400, 1600));
    const elements: AnnotatableElement[] = [
      { index: 1, rect: { x: 100, y: 100, width: 200, height: 100 } },
    ];

    await annotateScreenshot(RAW, elements, { maxDimension: 1800, scaleFactor: 2 });

    // Default fontSize(14) x scaleFactor(2) x outScale(0.75) = 21 device px —
    // NOT the 28 px the pre-fix code would emit (1/outScale too big).
    expect(ctx.font).toBe("bold 21px sans-serif");
    // The label pill: text at sFont x outScale + 4 x scaleFactor x outScale
    // tall and 6 x scaleFactor x outScale wider than the measured text —
    // single-factor math, so the text fits inside its own pill.
    expect(ctx.fillRect).toHaveBeenCalledWith(150, 150, 20 + 9, 21 * 0.75 + 6);
    // measureText reflects the scaled font; text baseline is top of pill.
    expect(ctx.textBaseline).toBe("top");
  });

  test("DEFAULT_ANNOTATE_PALETTE entries are all valid hex colors", () => {
    expect(DEFAULT_ANNOTATE_PALETTE).toHaveLength(12);
    for (const c of DEFAULT_ANNOTATE_PALETTE) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
