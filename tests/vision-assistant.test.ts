/**
 * Vision Assistant — regression tests for security/correctness-critical paths
 * that feed CDP click coordinates and the model-weight integrity guard.
 */

import { describe, test, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import { webcrypto } from "node:crypto";

import { parseBoxes, toPixelCoords } from "../src/extension/vision-assistant/box-parser";
import { mergeDetections, renderMergedElementsText } from "../src/extension/vision-assistant/merger";
import { f16to32, gatherEmbed } from "../src/extension/vision-assistant/embedding-gather";
import { preprocessScreenshot } from "../src/extension/vision-assistant/preprocessor";
import { loadImage } from "../src/extension/vision-assistant/preprocessor-utils";
import { ModelLoader, ALL_MODEL_FILE_URLS } from "../src/extension/vision-assistant/model-loader";
import { MODEL_FILE_HASHES, N_LAYERS } from "../src/extension/vision-assistant/constants";
import {
  assertVisionOutput,
  assertLanguageInputs,
  pastKeyNames,
} from "../src/extension/vision-assistant/inference-utils";

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

afterEach(() => {
  for (const k of Object.keys(MODEL_FILE_HASHES)) delete MODEL_FILE_HASHES[k];
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
});

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
