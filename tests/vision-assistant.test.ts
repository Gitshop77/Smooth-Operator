/**
 * Vision Assistant — regression tests for security/correctness-critical paths
 * that feed CDP click coordinates and the model-weight integrity guard.
 */

import { describe, test, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import { webcrypto } from "node:crypto";

import { parseBoxes, toPixelCoords } from "../src/extension/vision-assistant/box-parser";
import { mergeDetections, renderMergedElementsText } from "../src/extension/vision-assistant/merger";
import { f16to32, gatherEmbed } from "../src/extension/vision-assistant/embedding-gather";
import { preprocessScreenshot, fitPatchDims } from "../src/extension/vision-assistant/preprocessor";
import { loadImage, createCanvas } from "../src/extension/vision-assistant/preprocessor-utils";
import { ModelLoader, ALL_MODEL_FILE_URLS } from "../src/extension/vision-assistant/model-loader";
import { fetchBufProgress } from "../src/extension/vision-assistant/model-loader-utils";
import { MODEL_FILE_HASHES, N_LAYERS } from "../src/extension/vision-assistant/constants";
import { VisionAssistant } from "../src/extension/vision-assistant/inference";
import {
  assertVisionOutput,
  assertLanguageInputs,
  pastKeyNames,
  validateVisionOutput,
  validateLogitsShape,
} from "../src/extension/vision-assistant/inference-utils";

// The preprocessor imports these two from preprocessor-utils; mock them so
// the pixel pipeline can be driven with a fake canvas/image in jsdom (which
// has no canvas 2D context). The real implementations remain the default so
// every other test exercises the actual code paths.
vi.mock("../src/extension/vision-assistant/preprocessor-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/extension/vision-assistant/preprocessor-utils")>();
  return {
    ...actual,
    loadImage: vi.fn(actual.loadImage),
    createCanvas: vi.fn(actual.createCanvas),
  };
});

// transformers.js is lazily imported by the tokenizer loader; mock it so the
// loader can be tested without the real (multi-MB) library.
vi.mock("@huggingface/transformers", () => ({
  AutoTokenizer: { from_pretrained: vi.fn() },
}));

// jsdom does not implement Crypto.subtle; provide node's Web Crypto for the
// sha256-based integrity checks. Stubbed (and restored in afterAll) so it does
// not leak into other test files.
beforeAll(() => {
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    vi.stubGlobal("crypto", webcrypto);
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const sha256Hex = async (buf: Uint8Array): Promise<string> => {
  const d = await webcrypto.subtle.digest("SHA-256", buf.slice().buffer);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

// Snapshot the real pins so tests can add/remove keys without permanently
// wiping entries a later test (or a future one) relies on.
const REAL_MODEL_FILE_HASHES: Record<string, string | undefined> = { ...MODEL_FILE_HASHES };

afterEach(() => {
  for (const k of Object.keys(MODEL_FILE_HASHES)) delete MODEL_FILE_HASHES[k];
  for (const [k, v] of Object.entries(REAL_MODEL_FILE_HASHES)) {
    if (v !== undefined) MODEL_FILE_HASHES[k] = v;
  }
});

describe("box-parser", () => {
  test("parseBoxes extracts a well-formed detection", () => {
    const dets = parseBoxes('<ref>a</ref><box>1,2,3,4</box>');
    expect(dets).toHaveLength(1);
    expect(dets[0].label).toBe("a");
    expect(dets[0].box).toEqual([1, 2, 3, 4]);
  });

  test("parseBoxes rejects malformed box bodies", () => {
    expect(parseBoxes('<ref>a</ref><box>1.2.3</box>')).toHaveLength(0);
    expect(parseBoxes('<ref>a</ref><box>1,2,3</box>')).toHaveLength(0);
    expect(parseBoxes('<ref>a</ref><box>x,y,z,w</box>')).toHaveLength(0);
  });

  test("toPixelCoords normalizes an inverted box", () => {
    const dets = parseBoxes('<ref>a</ref><box>4,3,1,2</box>');
    const [px] = toPixelCoords(dets, 1000, 1000);
    // min(4,1)=1, min(3,2)=2, max-min => width 3, height 1
    expect(px.pixelBox).toEqual({ x: 1, y: 2, width: 3, height: 1 });
  });

  test("parseBoxes recovers a bare box without duplicating ref'd ones", () => {
    // The trailing box is separated by prose, so it is NOT part of the ref
    // group and must be recovered as a bare (label-less) detection exactly once.
    const dets = parseBoxes('<ref>a</ref><box>1,2,3,4</box> then <box>5,6,7,8</box>');
    expect(dets).toHaveLength(2);
    expect(dets[0]).toEqual({ label: "a", box: [1, 2, 3, 4] });
    expect(dets[1]).toEqual({ label: "", box: [5, 6, 7, 8] });
  });

  test("toPixelCoords clamps out-of-range coords to the original bounds", () => {
    const dets = parseBoxes('<ref>a</ref><box>1200,1200,1400,1400</box>');
    const [px] = toPixelCoords(dets, 1000, 1000);
    // Coords beyond 1000 map past the image; clamp x/y to bound-1, w/h to >=1.
    expect(px.pixelBox.x).toBe(999);
    expect(px.pixelBox.y).toBe(999);
    expect(px.pixelBox.width).toBe(1);
    expect(px.pixelBox.height).toBe(1);
  });
});

describe("embedding-gather", () => {
  test("f16to32 converts known half-precision values", () => {
    expect(f16to32(0x0000)).toBe(0);
    expect(f16to32(0x3c00)).toBe(1);
    expect(f16to32(0x4000)).toBe(2);
    expect(f16to32(0xbc00)).toBe(-1);
  });

  test("f16to32 maps the exponent-all-ones encodings to Infinity / NaN", () => {
    expect(f16to32(0x7c00)).toBe(Infinity);
    expect(f16to32(0xfc00)).toBe(-Infinity);
    expect(Number.isNaN(f16to32(0x7e00))).toBe(true);
  });

  test("gatherEmbed throws on out-of-range tokenId", () => {
    const meta = {
      vocab: 20,
      hidden: 2,
      block_size: 1,
      n_groups: 2,
      zero_point: 0,
    };
    const dst = new Float32Array(2);
    const packed = new Uint8Array(20);
    const scales = new Float32Array(40);
    expect(() => gatherEmbed(20, dst, 0, packed, scales, meta)).toThrow(
      /out of vocab range/,
    );
    expect(() => gatherEmbed(-1, dst, 0, packed, scales, meta)).toThrow(
      /out of vocab range/,
    );
  });

  test("gatherEmbed dequantizes known packed bytes (golden values)", () => {
    // token 0: bytes 0x12, 0x34 → (lo,hi) = (2,1) | (4,3); scales row 0 = [0.5, 2]
    // token 1: bytes 0x56, 0x78 → (lo,hi) = (6,5) | (8,7); scales row 1 = [0.25, 1]
    const meta = { vocab: 2, hidden: 4, block_size: 2, n_groups: 2, zero_point: 0 };
    const packed = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const scales = new Float32Array([0.5, 2.0, 0.25, 1.0]);
    const dst = new Float32Array(4);
    gatherEmbed(0, dst, 0, packed, scales, meta);
    expect(Array.from(dst)).toEqual([2 * 0.5, 1 * 0.5, 4 * 2.0, 3 * 2.0]);
    const dst1 = new Float32Array(4);
    gatherEmbed(1, dst1, 0, packed, scales, meta);
    expect(Array.from(dst1)).toEqual([6 * 0.25, 5 * 0.25, 8 * 1.0, 7 * 1.0]);
  });

  test("gatherEmbed applies a non-zero zero-point across group boundaries", () => {
    // block_size=3 splits the byte at packed index 1: j=2 lands in group 0,
    // j=3 in group 1 — the lo/hi nibbles of one byte must use different scales.
    const meta = { vocab: 1, hidden: 6, block_size: 3, n_groups: 2, zero_point: 1 };
    const packed = new Uint8Array([0x12, 0x45, 0x67]);
    const scales = new Float32Array([0.5, 2.0]);
    const dst = new Float32Array(6);
    gatherEmbed(0, dst, 0, packed, scales, meta);
    expect(Array.from(dst)).toEqual([
      (2 - 1) * 0.5, // j=0 lo, group 0
      (1 - 1) * 0.5, // j=1 hi, group 0
      (5 - 1) * 0.5, // j=2 lo, group 0
      (4 - 1) * 2.0, // j=3 hi, group 1
      (7 - 1) * 2.0, // j=4 lo of 0x67, group 1
      (6 - 1) * 2.0, // j=5 hi of 0x67, group 1
    ]);
  });

  test("gatherEmbed round-trips every row against a reference dequant", () => {
    // Pins the row-stride math (packedRow = token * H/2, scaleRow = token * NG)
    // across the whole table, not just row 0.
    const meta = { vocab: 4, hidden: 8, block_size: 4, n_groups: 2, zero_point: 3 };
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const packed = new Uint8Array(meta.vocab * (meta.hidden / 2));
    for (let i = 0; i < packed.length; i++) packed[i] = rnd() & 0xff;
    const scales = new Float32Array(meta.vocab * meta.n_groups);
    for (let i = 0; i < scales.length; i++) scales[i] = (rnd() % 4000) / 1000 + 0.01;

    const dst = new Float32Array(meta.vocab * meta.hidden);
    for (let t = 0; t < meta.vocab; t++) {
      gatherEmbed(t, dst, t * meta.hidden, packed, scales, meta);
    }
    for (let t = 0; t < meta.vocab; t++) {
      for (let j = 0; j < meta.hidden; j += 2) {
        const byte = packed[t * (meta.hidden / 2) + (j >> 1)];
        const lo = byte & 0x0f;
        const hi = (byte >> 4) & 0x0f;
        expect(dst[t * meta.hidden + j]).toBe(
          Math.fround((lo - meta.zero_point) * scales[t * meta.n_groups + ((j / meta.block_size) | 0)]),
        );
        expect(dst[t * meta.hidden + j + 1]).toBe(
          Math.fround(
            (hi - meta.zero_point) *
              scales[t * meta.n_groups + (((j + 1) / meta.block_size) | 0)],
          ),
        );
      }
    }
  });
});

describe("merger", () => {
  const domEl = {
    index: 1,
    tag: "button",
    text: "Go",
    attributes: {},
    hash: "h1",
    rect: { x: 0, y: 0, width: 100, height: 100 },
  };

  test("dedupes a vision box that overlaps a DOM element (IoU ~1)", () => {
    const vision = [
      { label: "btn", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    const merged = mergeDetections([domEl], vision, 1);
    // Identical rect → IoU 1 > 0.5 → vision is a duplicate, only the DOM element survives.
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("dom");
  });

  test("keeps a disjoint vision box (IoU 0) as a vision element", () => {
    const vision = [
      { label: "btn", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 500, y: 500, width: 50, height: 50 } },
    ];
    const merged = mergeDetections([domEl], vision, 1);
    expect(merged).toHaveLength(2);
    expect(merged[1].source).toBe("vision");
  });

  test("clamps and warns on an out-of-range devicePixelRatio", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const vision = [
      { label: "btn", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 800, y: 800, width: 80, height: 80 } },
    ];
    // dpr=8 is clamped to 4 (with a warning); coords are scaled by the clamped value.
    const merged = mergeDetections([], vision, 8);
    expect(warn).toHaveBeenCalledOnce();
    expect(merged[0].rect).toEqual({ x: 200, y: 200, width: 20, height: 20 });
    warn.mockRestore();
  });

  test("treats a zero devicePixelRatio as 1 without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const vision = [
      { label: "btn", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 10, y: 10, width: 10, height: 10 } },
    ];
    const merged = mergeDetections([], vision, 0);
    expect(warn).not.toHaveBeenCalled();
    expect(merged[0].rect).toEqual({ x: 10, y: 10, width: 10, height: 10 });
    warn.mockRestore();
  });

  test("dedupes overlapping vision boxes against each other", () => {
    // IoU of (0,0,100,100) vs (10,10,100,100) = 8100/11900 ≈ 0.68 > 0.5 → the
    // second box duplicates the first and must not become a separate [vN].
    const vision = [
      { label: "a", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 0, y: 0, width: 100, height: 100 } },
      { label: "b", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 10, y: 10, width: 100, height: 100 } },
    ];
    const merged = mergeDetections([], vision, 1);
    expect(merged).toHaveLength(1);
    expect(merged[0].visionId).toBe("v1");
    expect(merged[0].text).toBe("a");
  });

  test("keeps v indices sequential after skipping a duplicate vision box", () => {
    const vision = [
      { label: "a", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 0, y: 0, width: 100, height: 100 } },
      { label: "b", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 10, y: 10, width: 100, height: 100 } },
      { label: "c", box: [0, 0, 0, 0] as [number, number, number, number], pixelBox: { x: 500, y: 500, width: 50, height: 50 } },
    ];
    const merged = mergeDetections([], vision, 1);
    expect(merged).toHaveLength(2);
    expect(merged[0].visionId).toBe("v1");
    expect(merged[1].visionId).toBe("v2");
    expect(merged[1].text).toBe("c");
  });
});

describe("preprocessor", () => {
  test("preprocessScreenshot rejects non-image / malformed data URLs", async () => {
    await expect(preprocessScreenshot("not a data url")).rejects.toThrow();
    await expect(
      preprocessScreenshot("data:text/plain;base64,abc"),
    ).rejects.toThrow(/data:image|malformed|non-image/);
    await expect(preprocessScreenshot("data:image/png;base64,!!")).rejects.toThrow();
    await expect(preprocessScreenshot("data:image/png;base64,")).rejects.toThrow();
  });

  test("preprocessScreenshot rejects svg data URLs (raster allowlist)", async () => {
    await expect(
      preprocessScreenshot("data:image/svg+xml;base64,AAAA"),
    ).rejects.toThrow(/data:image|malformed|non-image/);
  });

  test("preprocessScreenshot rejects a zero-dimension source image", async () => {
    vi.mocked(loadImage).mockResolvedValueOnce(makeFakeImage(0, 100));
    await expect(
      preprocessScreenshot("data:image/png;base64,AAAA"),
    ).rejects.toThrow(/zero width or height/);
  });

  test("preprocessScreenshot builds a normalized, padded pixel_values tensor", async () => {
    // 100×50 → pad 28 → 112×56 → 8×4 = 32 patches, no rescale needed.
    vi.mocked(loadImage).mockResolvedValueOnce(makeFakeImage(100, 50));
    vi.mocked(createCanvas).mockReturnValueOnce(makeFakeCanvas(128) as never);
    const res = await preprocessScreenshot("data:image/png;base64,AAAA");

    expect(res.gridWidth).toBe(8);
    expect(res.gridHeight).toBe(4);
    expect(res.nPatches).toBe(32);
    expect(res.targetWidth).toBe(112);
    expect(res.targetHeight).toBe(56);
    expect(res.rescaledWidth).toBe(100);
    expect(res.rescaledHeight).toBe(50);
    expect(res.originalWidth).toBe(100);
    expect(res.originalHeight).toBe(50);
    expect(res.pixelValues.length).toBe(32 * 3 * 14 * 14);
    // Mean-grey fill normalizes to ((128/255) - 0.5) / 0.5 on every channel.
    const expected = (128 / 255 - 0.5) / 0.5;
    for (let i = 0; i < res.pixelValues.length; i += 997) {
      expect(res.pixelValues[i]).toBeCloseTo(expected, 6);
    }
  });

  test("preprocessScreenshot rescales an extreme aspect ratio within the patch cap", async () => {
    // 20000×10 floors h to 0 mid-rescale; the clamp + cap re-check must keep
    // the padded tensor within MAX_IMAGE_PATCHES (was 348 before the fix).
    vi.mocked(loadImage).mockResolvedValueOnce(makeFakeImage(20000, 10));
    vi.mocked(createCanvas).mockReturnValueOnce(makeFakeCanvas(128) as never);
    const res = await preprocessScreenshot("data:image/png;base64,AAAA");

    expect(res.nPatches).toBeLessThanOrEqual(256);
    expect(res.rescaledWidth).toBeGreaterThanOrEqual(1);
    expect(res.rescaledHeight).toBeGreaterThanOrEqual(1);
    expect(res.gridWidth * res.gridHeight).toBe(res.nPatches);
    expect(res.pixelValues.length).toBe(res.nPatches * 3 * 14 * 14);
  });

  test("fitPatchDims keeps the padded patch count within the cap for extreme ratios", () => {
    for (const [w, h] of [
      [20000, 10],
      [10000, 20],
      [1920, 1080],
      [50000, 2],
      [2, 50000],
      [1920, 10800],
    ] as Array<[number, number]>) {
      const r = fitPatchDims(w, h);
      expect(r.patches).toBeLessThanOrEqual(256);
      expect(r.w).toBeGreaterThanOrEqual(1);
      expect(r.h).toBeGreaterThanOrEqual(1);
      expect(r.tw % (2 * 14)).toBe(0);
      expect(r.th % (2 * 14)).toBe(0);
      expect(r.patches).toBe((r.tw / 14) * (r.th / 14));
    }
  });

  test("fitPatchDims leaves small images untouched", () => {
    expect(fitPatchDims(100, 50)).toEqual({
      w: 100,
      h: 50,
      tw: 112,
      th: 56,
      patches: 32,
    });
  });
});

/** Fake LoadedImage with the surface the preprocessor consumes. */
function makeFakeImage(width: number, height: number) {
  return {
    width,
    height,
    drawTo: vi.fn(),
    close: vi.fn(),
  };
}

/** Fake canvas whose 2D context returns a solid-color getImageData. */
function makeFakeCanvas(fill: number) {
  const ctx = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((x: number, y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4).fill(fill),
    })),
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

describe("inference session asserts", () => {
  test("vision session with exactly the expected output passes init", () => {
    expect(() => assertVisionOutput({ outputNames: ["visual_features"] } as never)).not.toThrow();
  });

  test("vision session with a renamed output fails init", () => {
    expect(() => assertVisionOutput({ outputNames: ["output"] } as never)).toThrow(/visual_features/);
  });

  test("vision session with extra outputs fails init", () => {
    expect(() =>
      assertVisionOutput({ outputNames: ["visual_features", "present_key_0"] } as never),
    ).toThrow(/visual_features/);
  });

  test("vision session with no outputs fails init", () => {
    expect(() => assertVisionOutput({ outputNames: [] } as never)).toThrow(/visual_features/);
  });

  test("language session declaring all expected inputs passes init", () => {
    const inputs = ["input_ids", "inputs_embeds", "attention_mask", "position_ids"];
    for (let i = 0; i < N_LAYERS; i++) {
      inputs.push(`past_key_${i}`, `past_value_${i}`);
    }
    expect(() => assertLanguageInputs({ inputNames: inputs } as never)).not.toThrow();
  });

  test("language session missing an expected input fails init", () => {
    const inputs = ["input_ids", "inputs_embeds", "position_ids"];
    expect(() => assertLanguageInputs({ inputNames: inputs } as never)).toThrow(/attention_mask/);
  });

  test("language session missing a KV-cache input fails init", () => {
    const inputs = ["input_ids", "inputs_embeds", "attention_mask", "position_ids", ...pastKeyNames];
    expect(() => assertLanguageInputs({ inputNames: inputs } as never)).toThrow(/past_value_/);
  });

  test("validateVisionOutput accepts a float32 vision output", () => {
    expect(() =>
      validateVisionOutput({ dims: [10, 1024], type: "float32" } as never, 1024, 10),
    ).not.toThrow();
  });

  test("validateVisionOutput rejects a non-float32 vision output", () => {
    expect(() =>
      validateVisionOutput({ dims: [10, 1024], type: "float16" } as never, 1024, 10),
    ).toThrow(/float32/);
  });

  test("validateLogitsShape rejects a non-float32 logits tensor", () => {
    expect(() =>
      validateLogitsShape({ dims: [1, 5, 10], type: "float16" } as never, "Vision detect()"),
    ).toThrow(/float32/);
  });

  test("validateLogitsShape accepts a float32 logits tensor", () => {
    expect(
      validateLogitsShape({ dims: [1, 5, 10], type: "float32" } as never, "Vision detect()"),
    ).toBe(10);
  });
});

describe("merger render", () => {
  test("renders a vision element with pixel coordinates", () => {
    const out = renderMergedElementsText([
      {
        index: -1,
        tag: "vision_element",
        text: "btn",
        attributes: {},
        hash: "v1_btn",
        rect: { x: 10, y: 20, width: 30, height: 40 },
        source: "vision",
        pixelRect: { x: 10, y: 20, width: 30, height: 40 },
        indexStr: "[v1]",
        visionId: "v1",
      },
    ]);
    expect(out).toContain('x="10" y="20" w="30" h="40"');
  });

  test("skips a vision element without pixelRect instead of crashing", () => {
    const out = renderMergedElementsText([
      {
        index: -1,
        tag: "vision_element",
        text: "btn",
        attributes: {},
        hash: "v1_btn",
        rect: { x: 10, y: 20, width: 30, height: 40 },
        source: "vision",
        indexStr: "[v1]",
        visionId: "v1",
      },
    ]);
    expect(out).toBe("");
  });

  test("renders DOM elements unchanged", () => {
    const out = renderMergedElementsText([
      {
        index: 1,
        tag: "button",
        text: "Go",
        attributes: {},
        hash: "h1",
        rect: { x: 0, y: 0, width: 100, height: 100 },
        source: "dom",
        indexStr: "[1]",
      },
    ]);
    expect(out).toBe("[1]<button /> Go");
  });
});

describe("preprocessor-utils loadImage", () => {
  test("exposes a close that releases the ImageBitmap after the last draw", async () => {
    const close = vi.fn();
    const realFetch = globalThis.fetch;
    const realCib = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    try {
      globalThis.fetch = (async () =>
        new Response(new Blob(["x"], { type: "image/png" }))) as typeof fetch;
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
        width: 4,
        height: 4,
        close,
      });
      const img = await loadImage("data:image/png;base64,AAAA");
      expect(close).not.toHaveBeenCalled();
      const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
      img.drawTo(ctx, 0, 0, 4, 4);
      expect(close).not.toHaveBeenCalled();
      img.close?.();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = realCib;
    }
  });
});

describe("model-loader integrity", () => {
  test("verifyIntegrity refuses an unpinned file when unpinned use is disallowed", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const loader = new ModelLoader();
    const verify = (loader as unknown as {
      verifyIntegrity: (u: string, n: string, b: Uint8Array) => Promise<string>;
    }).verifyIntegrity;
    await expect(
      verify.call(loader, "https://example.com/unpinned.onnx", "unpinned", new Uint8Array([1, 2, 3])),
    ).rejects.toThrow(/REFUSED|no pinned SHA-256/);
  });

  test("verifyIntegrity throws when the computed digest mismatches the pinned hash", async () => {
    const url = "https://example.com/m.bin";
    MODEL_FILE_HASHES[url] = "0000000000000000000000000000000000000000000000000000000000000000";
    const loader = new ModelLoader();
    const verify = (loader as unknown as {
      verifyIntegrity: (u: string, n: string, b: Uint8Array) => Promise<string>;
    }).verifyIntegrity;
    await expect(
      verify.call(loader, url, "m", new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow(/FAILED/);
  });

  test("verifyIntegrity returns the digest when it matches the pinned hash", async () => {
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([1, 2, 3, 4]);
    MODEL_FILE_HASHES[url] = await sha256Hex(buf);
    const loader = new ModelLoader();
    const verify = (loader as unknown as {
      verifyIntegrity: (u: string, n: string, b: Uint8Array) => Promise<string>;
    }).verifyIntegrity;
    await expect(verify.call(loader, url, "m", buf)).resolves.toBe(
      MODEL_FILE_HASHES[url],
    );
  });

  test("reverifyIntegrity rejects a tampered cache entry", async () => {
    const url = "https://example.com/m.bin";
    const stored = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const response = new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
      headers: { "x-model-sha256": stored },
    });
    const loader = new ModelLoader();
    await expect(
      (loader as unknown as {
        reverifyIntegrity: (u: string, b: Uint8Array, r: Response) => Promise<void>;
      }).reverifyIntegrity(url, new Uint8Array([9, 9, 9, 9]), response),
    ).rejects.toThrow(/failed re-verification/);
  });

  test("reverifyIntegrity accepts a cache entry whose digest matches", async () => {
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([5, 6, 7, 8]);
    const digest = await sha256Hex(buf);
    const response = new Response(buf.slice().buffer, {
      headers: { "x-model-sha256": digest },
    });
    const loader = new ModelLoader();
    await expect(
      (loader as unknown as {
        reverifyIntegrity: (u: string, b: Uint8Array, r: Response) => Promise<void>;
      }).reverifyIntegrity(url, buf, response),
    ).resolves.toBeUndefined();
  });

  test("reverifyIntegrity rejects a cache entry that mismatches its pinned hash", async () => {
    // No stored digest header → the guard must fall back to the pinned hash
    // and reject weights whose recomputed digest does not match it.
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([7, 7, 7, 7]);
    MODEL_FILE_HASHES[url] = "1111111111111111111111111111111111111111111111111111111111111111";
    const response = new Response(buf.slice().buffer);
    const loader = new ModelLoader();
    await expect(
      (loader as unknown as {
        reverifyIntegrity: (u: string, b: Uint8Array, r: Response) => Promise<void>;
      }).reverifyIntegrity(url, buf, response),
    ).rejects.toThrow(/does not match its pinned/);
  });

  test("verifyIntegrity refuses every unpinned file when unpinned weights are disallowed", async () => {
    // In the production service worker `typeof process === "undefined"`, so
    // allowUnpinnedWeights() is always false. In this Node harness the same
    // fail-closed state is reached by leaving COWORK_ALLOW_UNPINNED_VISION
    // unset, which is the browser-equivalent condition we must lock in.
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const loader = new ModelLoader();
    const verify = (loader as unknown as {
      verifyIntegrity: (u: string, n: string, b: Uint8Array) => Promise<string>;
    }).verifyIntegrity;
    for (const url of ALL_MODEL_FILE_URLS) {
      delete MODEL_FILE_HASHES[url];
      await expect(
        verify.call(loader, url, "model", new Uint8Array([1, 2, 3, 4])),
      ).rejects.toThrow(/REFUSED|no pinned SHA-256/);
    }
  });

  test("downloadAll refuses to cache unpinned weights (fail-closed)", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    for (const url of ALL_MODEL_FILE_URLS) delete MODEL_FILE_HASHES[url];
    const realFetch = globalThis.fetch;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({
          match: async () => undefined,
          put: async () => undefined,
        }),
      };
      globalThis.fetch = (async () =>
        new Response(new Uint8Array([1, 2, 3, 4]).buffer)) as typeof fetch;
      const loader = new ModelLoader();
      await expect(loader.downloadAll()).rejects.toThrow(/REFUSED|no pinned SHA-256/);
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });

  test("verifyIntegrity resolves and returns the computed digest for an unpinned file when unpinned weights are allowed", async () => {
    process.env.COWORK_ALLOW_UNPINNED_VISION = "1";
    try {
      const url = "https://example.com/unpinned.onnx";
      delete MODEL_FILE_HASHES[url];
      const buf = new Uint8Array([1, 2, 3, 4]);
      const loader = new ModelLoader();
      const verify = (loader as unknown as {
        verifyIntegrity: (u: string, n: string, b: Uint8Array) => Promise<string>;
      }).verifyIntegrity;
      const digest = await verify.call(loader, url, "unpinned", buf);
      expect(digest).toBe(await sha256Hex(buf));
    } finally {
      delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    }
  });

  test("downloadAll stores the computed digest header when unpinned weights are allowed", async () => {
    process.env.COWORK_ALLOW_UNPINNED_VISION = "1";
    for (const url of ALL_MODEL_FILE_URLS) delete MODEL_FILE_HASHES[url];
    const realFetch = globalThis.fetch;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    let storedHeader: string | null = null;
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({
          match: async () => undefined,
          put: async (_u: string, res: Response) => {
            storedHeader = res.headers.get("x-model-sha256");
          },
        }),
      };
      globalThis.fetch = (async () =>
        new Response(new Uint8Array([1, 2, 3, 4]).buffer)) as typeof fetch;
      const loader = new ModelLoader();
      await loader.downloadAll();
      expect(storedHeader).toBe(await sha256Hex(new Uint8Array([1, 2, 3, 4])));
    } finally {
      globalThis.fetch = realFetch;
      (globalThis as { caches?: unknown }).caches = realCaches;
      delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    }
  });

  test("getBuffer deletes the cache entry when re-verification of a stored digest fails", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    let deleted = false;
    const buf = new Uint8Array([1, 2, 3, 4]);
    const wrongDigest =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const response = new Response(buf.slice().buffer, {
      headers: { "x-model-sha256": wrongDigest },
    });
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({
          match: async () => response,
          delete: async () => {
            deleted = true;
            return true;
          },
        }),
      };
      const loader = new ModelLoader();
      await expect(
        loader.getBuffer("https://example.com/m.bin"),
      ).rejects.toThrow(/failed re-verification/);
      expect(deleted).toBe(true);
    } finally {
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });

  test("verifyIntegrity skips the check for an unpinned file when the chrome.storage opt-in is set", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const realChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: async () => ({ coworkAllowUnpinnedVision: true }) } },
    };
    try {
      const url = "https://example.com/unpinned.onnx";
      delete MODEL_FILE_HASHES[url];
      const buf = new Uint8Array([1, 2, 3, 4]);
      const loader = new ModelLoader();
      const verify = (loader as unknown as {
        verifyIntegrity: (u: string, n: string, b: Uint8Array) => Promise<string>;
      }).verifyIntegrity;
      const digest = await verify.call(loader, url, "unpinned", buf);
      expect(digest).toBe(await sha256Hex(buf));
    } finally {
      (globalThis as { chrome?: unknown }).chrome = realChrome;
    }
  });

  test("verifyIntegrity refuses an unpinned file even when the chrome.storage opt-in is absent", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const realChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: async () => ({ coworkAllowUnpinnedVision: false }) } },
    };
    try {
      const url = "https://example.com/unpinned.onnx";
      delete MODEL_FILE_HASHES[url];
      const loader = new ModelLoader();
      const verify = (loader as unknown as {
        verifyIntegrity: (u: string, n: string, b: Uint8Array) => Promise<string>;
      }).verifyIntegrity;
      await expect(
        verify.call(loader, url, "unpinned", new Uint8Array([1, 2, 3, 4])),
      ).rejects.toThrow(/REFUSED|no pinned SHA-256/);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = realChrome;
    }
  });

  test("getBuffer deletes the cache entry when the recomputed digest mismatches the pinned hash", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    let deleted = false;
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([1, 2, 3, 4]);
    const wrongPin =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    MODEL_FILE_HASHES[url] = wrongPin;
    // Cache entry carries no stored digest header, so the guard falls back to
    // the pinned hash and must reject the tampered weights, then auto-delete.
    const response = new Response(buf.slice().buffer);
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({
          match: async () => response,
          delete: async () => {
            deleted = true;
            return true;
          },
        }),
      };
      const loader = new ModelLoader();
      await expect(
        loader.getBuffer(url),
      ).rejects.toThrow(/does not match its pinned/);
      expect(deleted).toBe(true);
    } finally {
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });

  test("getBuffer rejects a cached buffer whose digest does not match its pinned hash (poisoned/unexpected payload)", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([0x3c, 0x68, 0x74, 0x6d]); // "<htm" — a non-weights payload
    const response = new Response(buf.slice().buffer); // no x-model-sha256 header
    // Pin a hash the '<'-prefixed buffer can never satisfy. The first-byte
    // markup heuristic was intentionally removed (it false-positived on valid
    // ONNX weights); integrity is enforced solely by the SHA-256 digest check,
    // which also catches error pages / partial payloads. A mismatched digest
    // makes `getBuffer` reject and auto-delete the poisoned cache entry.
    MODEL_FILE_HASHES[url] = "0000000000000000000000000000000000000000000000000000000000000000";
    let deleted = false;
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({
          match: async () => response,
          delete: async () => {
            deleted = true;
            return true;
          },
        }),
      };
      const loader = new ModelLoader();
      await expect(
        loader.getBuffer(url),
      ).rejects.toThrow(/does not match its pinned/i);
      expect(deleted).toBe(true);
    } finally {
      delete MODEL_FILE_HASHES[url];
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });
});

describe("model-loader getJSON integrity order", () => {
  test("getJSON re-verifies integrity BEFORE parsing and auto-deletes a poisoned entry", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    const url = "https://example.com/meta.json";
    const buf = new TextEncoder().encode('{"vocab":10}');
    const wrongDigest =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const response = new Response(buf.slice().buffer, {
      headers: { "x-model-sha256": wrongDigest },
    });
    let deleted = false;
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({
          match: async () => response,
          delete: async () => {
            deleted = true;
            return true;
          },
        }),
      };
      const loader = new ModelLoader();
      // A poisoned entry must surface as the integrity error (with auto-delete),
      // NOT as the confusing "not valid JSON" parse error.
      await expect(loader.getJSON(url)).rejects.toThrow(/failed re-verification/);
      expect(deleted).toBe(true);
    } finally {
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });

  test("getJSON parses a verified cached JSON entry", async () => {
    const realCaches = (globalThis as { caches?: unknown }).caches;
    const url = "https://example.com/meta.json";
    const buf = new TextEncoder().encode('{"vocab":10,"hidden":2048}');
    const digest = await sha256Hex(buf);
    const response = new Response(buf.slice().buffer, {
      headers: { "x-model-sha256": digest },
    });
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({ match: async () => response }),
      };
      const loader = new ModelLoader();
      await expect(loader.getJSON(url)).resolves.toEqual({ vocab: 10, hidden: 2048 });
    } finally {
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });

  test("getJSON still rejects unparseable JSON after a verified digest", async () => {
    const realCaches = (globalThis as { caches?: unknown }).caches;
    const url = "https://example.com/meta.json";
    const buf = new TextEncoder().encode("not json {{{");
    const digest = await sha256Hex(buf);
    const response = new Response(buf.slice().buffer, {
      headers: { "x-model-sha256": digest },
    });
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({ match: async () => response }),
      };
      const loader = new ModelLoader();
      await expect(loader.getJSON(url)).rejects.toThrow(/not valid JSON/);
    } finally {
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });

  test("getJSON rejects a verified non-object payload", async () => {
    const realCaches = (globalThis as { caches?: unknown }).caches;
    const url = "https://example.com/meta.json";
    const buf = new TextEncoder().encode("42");
    const digest = await sha256Hex(buf);
    const response = new Response(buf.slice().buffer, {
      headers: { "x-model-sha256": digest },
    });
    try {
      (globalThis as { caches?: unknown }).caches = {
        open: async () => ({ match: async () => response }),
      };
      const loader = new ModelLoader();
      await expect(loader.getJSON(url)).rejects.toThrow(/did not parse to a JSON object/);
    } finally {
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });
});

describe("model-loader Range download", () => {
  // Server that honours Range requests against a backing byte array.
  const makeRangeServer = (
    file: Uint8Array,
    opts: { starTotal?: boolean; ignoreRange?: boolean; shortChunks?: boolean } = {},
  ) => {
    return async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const range = headers["Range"] ?? headers["range"];
      if (range && !opts.ignoreRange) {
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        const start = Number(m?.[1]);
        const end = Number(m?.[2]);
        const part = file.subarray(start, end + 1);
        const send = opts.shortChunks && start > 0 ? part.subarray(0, Math.max(1, part.length - 2)) : part;
        return new Response(send.slice().buffer, {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${start + send.length - 1}/${opts.starTotal ? "*" : file.length}`,
            "content-length": String(send.length),
          },
        });
      }
      return new Response(file.slice().buffer, {
        status: 200,
        headers: { "content-length": String(file.length) },
      });
    };
  };

  test("assembles a full file from 206 Range chunks with progress", async () => {
    const file = new Uint8Array(100).map((_, i) => i);
    const realFetch = globalThis.fetch;
    const progress: Array<{ downloaded: number; total: number; percent: number }> = [];
    try {
      globalThis.fetch = makeRangeServer(file) as typeof fetch;
      // chunkSize 10 → progress fires exactly at 10%, 20%, …, 100%.
      const buf = await fetchBufProgress("https://example.com/model.bin", "model", (p) =>
        progress.push(p), 10,
      );
      expect(Array.from(buf)).toEqual(Array.from(file));
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[progress.length - 1]).toEqual({
        file: "model",
        downloaded: 100,
        total: 100,
        percent: 100,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("falls back to a full-file GET when Content-Range total is *", async () => {
    const file = new Uint8Array(100).map((_, i) => i);
    const realFetch = globalThis.fetch;
    let fullGets = 0;
    try {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const range = headers["Range"] ?? headers["range"];
        if (range) {
          const part = file.subarray(0, 4);
          return new Response(part.slice().buffer, {
            status: 206,
            headers: { "content-range": "bytes 0-3/*", "content-length": "4" },
          });
        }
        fullGets++;
        return new Response(file.slice().buffer, {
          status: 200,
          headers: { "content-length": String(file.length) },
        });
      }) as typeof fetch;
      const buf = await fetchBufProgress("https://example.com/model.bin", "model", undefined, 4);
      // Must NOT trust the single probe chunk as the whole file.
      expect(fullGets).toBe(1);
      expect(Array.from(buf)).toEqual(Array.from(file));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("re-fetches the whole file when the server ignores Range (200 + Content-Length)", async () => {
    const file = new Uint8Array(100).map((_, i) => i);
    const realFetch = globalThis.fetch;
    let rangedRequests = 0;
    let fullGets = 0;
    try {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const range = headers["Range"] ?? headers["range"];
        if (range) {
          rangedRequests++;
          return new Response(file.subarray(0, 4).slice().buffer, {
            status: 200,
            headers: { "content-length": String(file.length) },
          });
        }
        fullGets++;
        return new Response(file.slice().buffer, {
          status: 200,
          headers: { "content-length": String(file.length) },
        });
      }) as typeof fetch;
      const buf = await fetchBufProgress("https://example.com/model.bin", "model", undefined, 4);
      expect(rangedRequests).toBe(1);
      expect(fullGets).toBe(1);
      expect(Array.from(buf)).toEqual(Array.from(file));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("returns the probe buffer directly when the whole file fits the probe cap", async () => {
    const file = new Uint8Array([1, 2, 3, 4]);
    const realFetch = globalThis.fetch;
    let fullGets = 0;
    try {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const range = headers["Range"] ?? headers["range"];
        if (range) {
          return new Response(file.subarray(0, 4).slice().buffer, {
            status: 200,
            headers: { "content-length": "4" },
          });
        }
        fullGets++;
        return new Response(file.slice().buffer, {
          status: 200,
          headers: { "content-length": "4" },
        });
      }) as typeof fetch;
      const buf = await fetchBufProgress("https://example.com/small.bin", "small", undefined, 4);
      expect(fullGets).toBe(0);
      expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("throws on a chunk whose size does not match the requested range", async () => {
    const file = new Uint8Array(100).map((_, i) => i);
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = makeRangeServer(file, { shortChunks: true }) as typeof fetch;
      await expect(
        fetchBufProgress("https://example.com/model.bin", "model", undefined, 4),
      ).rejects.toThrow(/Chunk size mismatch/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("returns the whole file when a chunk request is answered with 200", async () => {
    const file = new Uint8Array(100).map((_, i) => i);
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const range = headers["Range"] ?? headers["range"];
        if (range && range.startsWith("bytes=0-")) {
          const part = file.subarray(0, 4);
          return new Response(part.slice().buffer, {
            status: 206,
            headers: { "content-range": "bytes 0-3/100", "content-length": "4" },
          });
        }
        // Any later chunk request is answered with the WHOLE file (200).
        return new Response(file.slice().buffer, {
          status: 200,
          headers: { "content-length": String(file.length) },
        });
      }) as typeof fetch;
      const buf = await fetchBufProgress("https://example.com/model.bin", "model", undefined, 4);
      expect(Array.from(buf)).toEqual(Array.from(file));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("detect re-entrancy — second-caller signal", () => {
  const stubWebGpu = (): void => {
    vi.stubGlobal("navigator", { gpu: {} });
  };

  test("identical-input share throws AbortError when the second caller is already aborted", async () => {
    const realNav = globalThis.navigator;
    stubWebGpu();
    try {
      const va = new VisionAssistant();
      (va as unknown as { detectPromise: Promise<unknown> }).detectPromise = Promise.resolve([]);
      (va as unknown as { detectDataUrl: string }).detectDataUrl = "data:image/png;base64,AAAA";
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        va.detect("data:image/png;base64,AAAA", ctrl.signal),
      ).rejects.toThrow(/aborted/i);
    } finally {
      vi.stubGlobal("navigator", realNav);
    }
  });

  test("identical-input share returns the in-flight promise for a non-aborted caller", async () => {
    const realNav = globalThis.navigator;
    stubWebGpu();
    try {
      const va = new VisionAssistant();
      (va as unknown as { detectPromise: Promise<unknown> }).detectPromise = Promise.resolve([]);
      (va as unknown as { detectDataUrl: string }).detectDataUrl = "data:image/png;base64,AAAA";
      await expect(va.detect("data:image/png;base64,AAAA")).resolves.toEqual([]);
    } finally {
      vi.stubGlobal("navigator", realNav);
    }
  });
});

describe("tokenizer loading", () => {
  test("logs loudly that the tokenizer is unpinned, and retries after a transient failure", async () => {
    vi.resetModules();
    const { getTokenizer } = await import("../src/extension/vision-assistant/tokenizer");
    const { AutoTokenizer } = await import("@huggingface/transformers");
    const fromPretrained = AutoTokenizer.from_pretrained as ReturnType<typeof vi.fn>;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Transient failure: no loud log, and the next call retries from scratch.
      fromPretrained.mockRejectedValueOnce(new Error("network"));
      await expect(getTokenizer()).rejects.toThrow(/network/);
      expect(err).not.toHaveBeenCalled();

      fromPretrained.mockResolvedValueOnce({ ok: true });
      await expect(getTokenizer()).resolves.toEqual({ ok: true });
      expect(err).toHaveBeenCalledTimes(1);
      expect(err.mock.calls[0][0]).toMatch(/tokenizer/i);
      expect(err.mock.calls[0][0]).toMatch(/integrity check/i);
    } finally {
      err.mockRestore();
    }
  });
});
