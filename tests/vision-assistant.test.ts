/**
 * Vision Assistant — regression tests for the LFM2.5-VL-3B (ONNX Q4 WebGPU)
 * engine: grounding parsing, coordinate mapping, the model-weight integrity
 * guard (hash + size pins), download primitives, and the serialization guards
 * that feed CDP click coordinates.
 */

import { describe, test, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import { webcrypto } from "node:crypto";

import { toPixelCoords } from "../src/extension/vision-assistant/box-parser";
import { mergeDetections, renderMergedElementsText } from "../src/extension/vision-assistant/merger";
import { ModelLoader } from "../src/extension/vision-assistant/model-loader";
import { fetchBufProgress } from "../src/extension/vision-assistant/model-loader-utils";
import {
  MODEL_FILE_HASHES,
  MODEL_FILE_SIZES,
  allModelFileUrls,
  modelFileEntries,
  pickEmbeddingPrecision,
} from "../src/extension/vision-assistant/constants";
import { VisionAssistant } from "../src/extension/vision-assistant/inference";
import type { VisionStatus } from "../src/extension/vision-assistant/types";
import {
  parseGroundingResponse,
  groundingToDetections,
} from "../src/extension/vision-assistant/grounding-parser";

// transformers.js is heavy + WebGPU-bound; mock it so the init/detect wiring
// can be driven without a real model or GPU.
vi.mock("@huggingface/transformers", () => {
  const fakeTokenizer = {
    apply_chat_template: vi.fn(() => "prompt"),
    decode: vi.fn((_ids: number[]) => "[]"),
  };
  const fakeProcessor = Object.assign(
    vi.fn(async () => ({ input_ids: { dims: [1, 10] }, attention_mask: { dims: [1, 10] }, pixel_values: { dims: [1, 3, 512, 512] } })),
    { tokenizer: fakeTokenizer },
  );
  const fakeModel = {
    generate: vi.fn(async () => ({ sequences: { tolist: () => [[10, 11, 12, 13]] } })),
    dispose: vi.fn(async () => undefined),
  };
  return {
    env: {
      allowLocalModels: false,
      allowRemoteModels: false,
      useBrowserCache: false,
      useCustomCache: false,
      customCache: null,
      backends: { onnx: {} },
    },
    AutoConfig: {
      from_pretrained: vi.fn(async () => ({ transformers_version: "5.0.0.dev0" })),
    },
    AutoProcessor: {
      from_pretrained: vi.fn(async () => fakeProcessor),
    },
    AutoModelForImageTextToText: {
      from_pretrained: vi.fn(async () => fakeModel),
    },
    InterruptableStoppingCriteria: vi.fn(function () {
      return { interrupt: vi.fn() };
    }),
    RawImage: {
      read: vi.fn(async () => ({ width: 200, height: 100 })),
    },
  };
});

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
const REAL_MODEL_FILE_SIZES: Record<string, number | undefined> = { ...MODEL_FILE_SIZES };

afterEach(() => {
  for (const k of Object.keys(MODEL_FILE_HASHES)) delete MODEL_FILE_HASHES[k];
  for (const [k, v] of Object.entries(REAL_MODEL_FILE_HASHES)) {
    if (v !== undefined) MODEL_FILE_HASHES[k] = v;
  }
  for (const k of Object.keys(MODEL_FILE_SIZES)) delete MODEL_FILE_SIZES[k];
  for (const [k, v] of Object.entries(REAL_MODEL_FILE_SIZES)) {
    if (v !== undefined) MODEL_FILE_SIZES[k] = v;
  }
  vi.restoreAllMocks();
});

// ─── constants ────────────────────────────────────────────────────────────────

describe("constants", () => {
  test("every model file URL is size-pinned (exact byte counts)", () => {
    for (const file of modelFileEntries("fp16")) {
      expect(MODEL_FILE_SIZES[file.url], file.name).toBeGreaterThan(0);
    }
  });

  test("all 10 cheap-to-pin files have a valid 64-char lowercase SHA-256", () => {
    const hex64 = /^[0-9a-f]{64}$/;
    const withHash = modelFileEntries("fp16").filter((f) => MODEL_FILE_HASHES[f.url]);
    // config/tokenizer JSONs + chat template + the three small graph files.
    expect(withHash.length).toBeGreaterThanOrEqual(10);
    for (const file of withHash) {
      expect(MODEL_FILE_HASHES[file.url]).toMatch(hex64);
      expect(MODEL_FILE_HASHES[file.url]).not.toBe("0".repeat(64));
    }
  });

  test("sizes are exact integers", () => {
    for (const size of Object.values(MODEL_FILE_SIZES)) {
      expect(Number.isInteger(size)).toBe(true);
    }
  });

  test("fp16 and fp32 file lists differ only in the embedding variant", () => {
    const fp16 = allModelFileUrls("fp16");
    const fp32 = allModelFileUrls("fp32");
    // fp16 adds graph + data shard; fp32 is a single self-contained file.
    expect(fp16.length).toBe(fp32.length + 1);
    // The shared prefix (config + decoder + vision) must be identical.
    const sharedFp16 = fp16.filter((u) => !u.includes("embed_tokens"));
    const sharedFp32 = fp32.filter((u) => !u.includes("embed_tokens"));
    expect(sharedFp16).toEqual(sharedFp32);
    expect(fp16.some((u) => u.includes("embed_tokens_fp16"))).toBe(true);
    expect(fp32.some((u) => u.includes("embed_tokens"))).toBe(true);
  });

  test("pickEmbeddingPrecision fails toward fp32 when WebGPU is absent", async () => {
    const realNav = globalThis.navigator;
    vi.stubGlobal("navigator", { ...realNav, gpu: undefined });
    try {
      await expect(pickEmbeddingPrecision()).resolves.toBe("fp32");
    } finally {
      vi.stubGlobal("navigator", realNav);
    }
  });

  test("pickEmbeddingPrecision picks fp16 when the adapter advertises shader-f16", async () => {
    const realNav = globalThis.navigator;
    vi.stubGlobal("navigator", {
      ...realNav,
      gpu: {
        requestAdapter: async () => ({ features: { has: (f: string) => f === "shader-f16" } }),
      },
    });
    try {
      await expect(pickEmbeddingPrecision()).resolves.toBe("fp16");
    } finally {
      vi.stubGlobal("navigator", realNav);
    }
  });
});


// ─── grounding-parser (ported from the LFM2.5-VL-3B-WebGPU Space tests) ───────

describe("grounding-parser", () => {
  test("parses normalized boxes and points", () => {
    expect(
      parseGroundingResponse(
        JSON.stringify([
          { image_id: 0, bbox_2d: [10, 20, 500, 600], label: "cat" },
          { image_id: 1, point_2d: [750, 125], label: "nose" },
        ]),
        2,
      ),
    ).toEqual([
      { imageId: 0, label: "cat", type: "box", coordinates: [10, 20, 500, 600] },
      { imageId: 1, label: "nose", type: "point", coordinates: [750, 125] },
    ]);
  });

  test("accepts a valid empty grounding response", () => {
    expect(parseGroundingResponse("[]", 1)).toEqual([]);
  });

  test("renders bare four-number lists as boxes on the first image", () => {
    expect(
      parseGroundingResponse("Detected regions: [10, 20, 500, 600] and [600, 100, 900, 800].", 2),
    ).toEqual([
      { imageId: 0, label: "Bounding box", type: "box", coordinates: [10, 20, 500, 600] },
      { imageId: 0, label: "Bounding box 2", type: "box", coordinates: [600, 100, 900, 800] },
    ]);
  });

  test("normalizes zero-to-one boxes in structured and bare output", () => {
    expect(parseGroundingResponse('[{"image_id":0,"label":"cat","bbox_2d":[0.1,0.2,0.8,0.9]}]', 1)).toEqual([
      { imageId: 0, label: "cat", type: "box", coordinates: [100, 200, 800, 900] },
    ]);
    expect(parseGroundingResponse("box: [0.125, 0.25, 0.75, 1]", 1)).toEqual([
      { imageId: 0, label: "Bounding box", type: "box", coordinates: [125, 250, 750, 1000] },
    ]);
  });

  test("does not treat fenced or unrelated JSON as grounding", () => {
    expect(parseGroundingResponse("```json\n[]\n```", 1)).toBeNull();
    expect(parseGroundingResponse('{"answer": 4}', 1)).toBeNull();
    expect(parseGroundingResponse('[{"image_id":0,"label":"cat","bbox_2d":[0,0,1,1],"score":1}]', 1)).toBeNull();
  });

  test("rejects invalid image references and coordinates", () => {
    expect(parseGroundingResponse('[{"image_id":1,"label":"cat","bbox_2d":[0,0,10,10]}]', 1)).toBeNull();
    expect(parseGroundingResponse('[{"image_id":0,"label":"cat","point_2d":[1.5,2]}]', 1)).toBeNull();
    expect(parseGroundingResponse('[{"image_id":0,"label":"cat","point_2d":[1001,2]}]', 1)).toBeNull();
    expect(parseGroundingResponse('[{"image_id":0,"label":"cat","bbox_2d":[20,20,10,30]}]', 1)).toBeNull();
  });

  test("requires one and only one supported geometry", () => {
    expect(parseGroundingResponse('[{"image_id":0,"label":"cat"}]', 1)).toBeNull();
    expect(parseGroundingResponse('[{"image_id":0,"label":"cat","point_2d":[1,2],"bbox_2d":[0,0,2,3]}]', 1)).toBeNull();
    expect(parseGroundingResponse('[{"image_id":0,"label":"","point_2d":[1,2]}]', 1)).toBeNull();
  });

  test("groundingToDetections keeps boxes only and normalizes labels", () => {
    const items = parseGroundingResponse(
      JSON.stringify([
        { image_id: 0, bbox_2d: [10, 20, 500, 600], label: "  Submit  " },
        { image_id: 0, point_2d: [750, 125], label: "nose" },
      ]),
      1,
    )!;
    expect(groundingToDetections(items)).toEqual([
      { label: "Submit", box: [10, 20, 500, 600] },
    ]);
  });
});

// ─── toPixelCoords ────────────────────────────────────────────────────────────

describe("toPixelCoords", () => {
  test("maps normalized 0-1000 coords to a 1000x2000 pixel screenshot", () => {
    const out = toPixelCoords([{ label: "b", box: [100, 200, 300, 400] }], 1000, 2000);
    expect(out[0].pixelBox).toEqual({ x: 100, y: 400, width: 200, height: 400 });
  });

  test("clamps to the clamp bounds (original screenshot) not the padded canvas", () => {
    const out = toPixelCoords(
      [{ label: "b", box: [1000, 1000, 1000, 1000] }],
      1000, // padded canvas width
      1000, // padded canvas height
      800,  // original width
      600,  // original height
    );
    expect(out[0].pixelBox.x).toBeLessThan(800);
    expect(out[0].pixelBox.y).toBeLessThan(600);
    expect(out[0].pixelBox.x).toBeGreaterThanOrEqual(0);
    expect(out[0].pixelBox.y).toBeGreaterThanOrEqual(0);
  });

  test("normalizes an inverted box so it is anchored at the correct corner", () => {
    const out = toPixelCoords([{ label: "b", box: [300, 400, 100, 200] }], 1000, 1000);
    expect(out[0].pixelBox).toEqual({ x: 100, y: 200, width: 200, height: 200 });
  });

  test("degenerate 1x1 screenshot cannot produce NaN/Infinity coords", () => {
    const out = toPixelCoords([{ label: "b", box: [10, 20, 30, 40] }], 1, 1);
    expect(out[0].pixelBox).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(Number.isFinite(out[0].pixelBox.x)).toBe(true);
    expect(Number.isFinite(out[0].pixelBox.y)).toBe(true);
  });
});


// ─── merger (unchanged behavior: vision detections merge with DOM elements) ───

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


// ─── model-loader integrity ───────────────────────────────────────────────────

describe("model-loader integrity", () => {
  const verify = async (loader: ModelLoader, url: string, name: string, buf: Uint8Array) => {
    return (loader as unknown as {
      verifyIntegrity: (u: string, n: string, b: Uint8Array) => Promise<string>;
    }).verifyIntegrity.call(loader, url, name, buf);
  };

  test("refuses an UNPINNED, UNSIZED file when unpinned use is disallowed", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const url = "https://example.com/unpinned.onnx";
    delete MODEL_FILE_HASHES[url];
    delete MODEL_FILE_SIZES[url];
    const loader = new ModelLoader();
    await expect(
      verify(loader, url, "unpinned", new Uint8Array([1, 2, 3])),
    ).rejects.toThrow(/REFUSED/);
  });

  test("throws when the computed digest mismatches the pinned hash", async () => {
    const url = "https://example.com/m.bin";
    MODEL_FILE_HASHES[url] = "0000000000000000000000000000000000000000000000000000000000000000";
    const loader = new ModelLoader();
    await expect(verify(loader, url, "m", new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/FAILED/);
  });

  test("returns the digest when it matches the pinned hash", async () => {
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([1, 2, 3, 4]);
    MODEL_FILE_HASHES[url] = await sha256Hex(buf);
    const loader = new ModelLoader();
    await expect(verify(loader, url, "m", buf)).resolves.toBe(MODEL_FILE_HASHES[url]);
  });

  test("size-pinned files verify their byte count, record the digest, and warn loudly", async () => {
    const url = "https://example.com/shard.bin";
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    MODEL_FILE_SIZES[url] = buf.byteLength;
    delete MODEL_FILE_HASHES[url];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warningCb = vi.fn();
    const loader = new ModelLoader();
    loader.onWarning(warningCb);
    const digest = await verify(loader, url, "shard", buf);
    expect(digest).toBe(await sha256Hex(buf));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SIZE-PINNED"));
    expect(warningCb).toHaveBeenCalledWith(expect.stringContaining("SIZE-PINNED"));
    warn.mockRestore();
  });

  test("size-pinned files REJECT on a byte-count mismatch", async () => {
    const url = "https://example.com/shard.bin";
    MODEL_FILE_SIZES[url] = 1000;
    const loader = new ModelLoader();
    await expect(verify(loader, url, "shard", new Uint8Array(999))).rejects.toThrow(/expected 1000 bytes/);
  });
});


describe("model-loader reverify", () => {
  const reverify = (loader: ModelLoader, url: string, buf: Uint8Array, response: Response) => {
    return (loader as unknown as {
      reverifyIntegrity: (u: string, b: Uint8Array, r: Response) => Promise<void>;
    }).reverifyIntegrity.call(loader, url, buf, response);
  };

  test("rejects a tampered cache entry (digest mismatch)", async () => {
    const url = "https://example.com/m.bin";
    const stored = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const response = new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
      headers: { "x-model-sha256": stored },
    });
    const loader = new ModelLoader();
    await expect(reverify(loader, url, new Uint8Array([9, 9, 9, 9]), response)).rejects.toThrow(/failed re-verification/);
  });

  test("accepts a cache entry whose digest matches", async () => {
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([5, 6, 7, 8]);
    const digest = await sha256Hex(buf);
    const response = new Response(buf.slice().buffer, {
      headers: { "x-model-sha256": digest },
    });
    const loader = new ModelLoader();
    await expect(reverify(loader, url, buf, response)).resolves.toBeUndefined();
  });

  test("rejects a cache entry that mismatches its pinned hash", async () => {
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([7, 7, 7, 7]);
    MODEL_FILE_HASHES[url] = "1111111111111111111111111111111111111111111111111111111111111111";
    const response = new Response(buf.slice().buffer);
    const loader = new ModelLoader();
    await expect(reverify(loader, url, buf, response)).rejects.toThrow(/does not match its pinned/);
  });

  test("rejects a size-pinned cache entry whose size changed", async () => {
    const url = "https://example.com/m.bin";
    MODEL_FILE_SIZES[url] = 4;
    const response = new Response(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    const loader = new ModelLoader();
    await expect(reverify(loader, url, new Uint8Array([1, 2, 3, 4, 5]), response)).rejects.toThrow(/size re-verification/);
  });

  test("no-ops for a fully unpinned file (nothing to check)", async () => {
    const url = "https://example.com/free.bin";
    delete MODEL_FILE_HASHES[url];
    delete MODEL_FILE_SIZES[url];
    const response = new Response(new Uint8Array([1, 2, 3]).buffer);
    const loader = new ModelLoader();
    await expect(reverify(loader, url, new Uint8Array([1, 2, 3]), response)).resolves.toBeUndefined();
  });

  test("getBuffer deletes a cache entry whose recomputed digest mismatches the stored digest", async () => {
    delete process.env.COWORK_ALLOW_UNPINNED_VISION;
    const realCaches = (globalThis as { caches?: unknown }).caches;
    const url = "https://example.com/m.bin";
    const buf = new Uint8Array([1, 2, 3, 4]);
    const wrongDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
      await expect(loader.getBuffer(url)).rejects.toThrow(/failed re-verification/);
      expect(deleted).toBe(true);
    } finally {
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });
});


// ─── model-loader Range download (chunked fetchBufProgress) ───────────────────

describe("model-loader Range download", () => {
  /** A fake Range-capable HTTP server backed by an in-memory file. */
  function makeRangeServer(file: Uint8Array, opts: { shortChunks?: boolean } = {}) {
    return async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const range = headers["Range"] ?? headers["range"];
      if (!range) {
        return new Response(file.slice().buffer, {
          status: 200,
          headers: { "content-length": String(file.length) },
        });
      }
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      if (!m) return new Response(null, { status: 416 });
      const start = Number(m[1]);
      const end = Number(m[2]);
      const part = opts.shortChunks ? file.subarray(start, Math.min(start + 2, file.length)) : file.subarray(start, end + 1);
      return new Response(part.slice().buffer, {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${start + part.length - 1}/${file.length}`,
          "content-length": String(part.length),
        },
      });
    };
  }

  test("fetches a multi-chunk file with Range requests and assembles it exactly", async () => {
    const file = new Uint8Array(100).map((_, i) => i);
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = makeRangeServer(file) as typeof fetch;
      const buf = await fetchBufProgress("https://example.com/model.bin", "model");
      expect(Array.from(buf)).toEqual(Array.from(file));
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
});


// ─── VisionAssistant init/detect wiring (transformers.js mocked) ──────────────

const fakeCache = () => ({
  match: async () => undefined,
  put: async () => undefined,
  keys: async () => [],
});

/** Stub the globals init() needs: WebGPU probe + Cache Storage. */
function stubInitGlobals(): () => void {
  const realNav = globalThis.navigator;
  const realCaches = (globalThis as { caches?: unknown }).caches;
  vi.stubGlobal("navigator", { ...realNav, gpu: { requestAdapter: async () => null } });
  (globalThis as { caches?: unknown }).caches = { open: async () => fakeCache() };
  vi.spyOn(ModelLoader.prototype, "init").mockResolvedValue(undefined);
  vi.spyOn(ModelLoader.prototype, "isCached").mockResolvedValue(true);
  return () => {
    vi.stubGlobal("navigator", realNav);
    (globalThis as { caches?: unknown }).caches = realCaches;
  };
}

/** Build a ready assistant whose model/processor are the mocked ones. */
async function readyAssistant(): Promise<VisionAssistant> {
  const va = new VisionAssistant();
  await va.init();
  return va;
}

describe("VisionAssistant init", () => {
  test("downloads nothing when cached, wires transformers.js to the pinned cache, and reaches ready", async () => {
    const restore = stubInitGlobals();
    try {
      const downloadAll = vi.spyOn(ModelLoader.prototype, "downloadAll").mockResolvedValue(undefined);
      const va = new VisionAssistant();
      const statuses: VisionStatus[] = [];
      va.onStatus((s) => statuses.push(s));

      await va.init();

      expect(va.isReady).toBe(true);
      expect(statuses).toContain("checking");
      expect(statuses).toContain("compiling");
      expect(statuses).toContain("ready");
      expect(downloadAll).not.toHaveBeenCalled();

      const mod = await import("@huggingface/transformers");
      expect(mod.AutoConfig.from_pretrained).toHaveBeenCalledWith(
        expect.stringContaining("LFM2.5-VL-3B-ONNX"),
        expect.objectContaining({ revision: expect.any(String), device: "webgpu" }),
      );
      // Fail-closed: nothing may be fetched from the network.
      expect(mod.env.allowRemoteModels).toBe(false);
      expect(mod.env.useCustomCache).toBe(true);
    } finally {
      restore();
    }
  });

  test("downloads when nothing is cached", async () => {
    const restore = stubInitGlobals();
    try {
      const isCached = vi.spyOn(ModelLoader.prototype, "isCached").mockResolvedValue(false);
      const downloadAll = vi.spyOn(ModelLoader.prototype, "downloadAll").mockResolvedValue(undefined);
      const va = new VisionAssistant();
      await va.init();
      expect(isCached).toHaveBeenCalled();
      expect(downloadAll).toHaveBeenCalled();
      expect(va.isReady).toBe(true);
    } finally {
      restore();
    }
  });

  test("re-entrant init() calls share one in-flight init (no double download)", async () => {
    const restore = stubInitGlobals();
    try {
      vi.spyOn(ModelLoader.prototype, "isCached").mockResolvedValue(false);
      const downloadAll = vi.spyOn(ModelLoader.prototype, "downloadAll").mockResolvedValue(undefined);
      const va = new VisionAssistant();
      await Promise.all([va.init(), va.init(), va.init()]);
      expect(downloadAll).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test("a failed init sets status error and throws", async () => {
    const restore = stubInitGlobals();
    try {
      const mod = await import("@huggingface/transformers");
      (mod.AutoConfig.from_pretrained as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("missing model file"),
      );
      const va = new VisionAssistant();
      const statuses: VisionStatus[] = [];
      va.onStatus((s) => statuses.push(s));
      await expect(va.init()).rejects.toThrow(/missing model file/);
      expect(statuses).toContain("error");
      expect(va.isReady).toBe(false);
    } finally {
      restore();
    }
  });

  test("rejects when WebGPU is unavailable", async () => {
    const realNav = globalThis.navigator;
    vi.stubGlobal("navigator", { ...realNav, gpu: undefined });
    try {
      const va = new VisionAssistant();
      await expect(va.init()).rejects.toThrow(/WebGPU/);
    } finally {
      vi.stubGlobal("navigator", realNav);
    }
  });
});



describe("VisionAssistant detect", () => {
  async function setDecodedText(va: VisionAssistant, text: string): Promise<void> {
    const tokenizer = (va as unknown as { processor: { tokenizer: { decode: ReturnType<typeof vi.fn> } } })
      .processor.tokenizer;
    tokenizer.decode.mockImplementation(() => text);
  }

  test("decodes a screenshot, generates grounding JSON, and maps boxes to pixels", async () => {
    const realNav = globalThis.navigator;
    const restore = stubInitGlobals();
    try {
      const va = await readyAssistant();
      await setDecodedText(
        va,
        JSON.stringify([{ image_id: 0, label: "Go", bbox_2d: [100, 200, 500, 600] }]),
      );

      const dets = await va.detect("data:image/png;base64,AAAA");

      // RawImage mock reports 200x100; 0-1000 normalized coords map linearly.
      expect(dets).toHaveLength(1);
      expect(dets[0].label).toBe("Go");
      expect(dets[0].pixelBox).toEqual({ x: 20, y: 20, width: 80, height: 40 });
    } finally {
      vi.stubGlobal("navigator", realNav);
      restore();
    }
  });

  test("returns [] when the model emits no valid grounding", async () => {
    const restore = stubInitGlobals();
    try {
      const va = await readyAssistant();
      await setDecodedText(va, "I cannot see any interactive elements.");
      await expect(va.detect("data:image/png;base64,AAAA")).resolves.toEqual([]);
    } finally {
      restore();
    }
  });

  test("honors an already-aborted signal with AbortError", async () => {
    const restore = stubInitGlobals();
    try {
      const va = await readyAssistant();
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(va.detect("data:image/png;base64,AAAA", ctrl.signal)).rejects.toThrow(/aborted/i);
    } finally {
      restore();
    }
  });

  test("throws a clear error when detect is called before init", async () => {
    const realNav = globalThis.navigator;
    vi.stubGlobal("navigator", { ...realNav, gpu: {} });
    try {
      const va = new VisionAssistant();
      await expect(va.detect("data:image/png;base64,AAAA")).rejects.toThrow(/not ready|not available/);
    } finally {
      vi.stubGlobal("navigator", realNav);
    }
  });
});


// ─── detect re-entrancy — second-caller signal ────────────────────────────────

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

// ─── cleanup ──────────────────────────────────────────────────────────────────

describe("VisionAssistant cleanup", () => {
  test("releases the model session and returns to uninitialized", async () => {
    const restore = stubInitGlobals();
    try {
      const va = await readyAssistant();
      const dispose = (va as unknown as { model: { dispose: ReturnType<typeof vi.fn> } }).model.dispose;
      expect(va.isReady).toBe(true);
      await va.cleanup();
      expect(va.isReady).toBe(false);
      expect(dispose).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
