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

  test("DEFAULT_ANNOTATE_PALETTE entries are all valid hex colors", () => {
    expect(DEFAULT_ANNOTATE_PALETTE).toHaveLength(12);
    for (const c of DEFAULT_ANNOTATE_PALETTE) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
