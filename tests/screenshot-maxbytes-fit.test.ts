/**
 * Screenshot maxBytes fit loop (S11 regression) — the canvas JPEG quality API
 * takes 0-1 and clamps out-of-range values to 1.0, while CDP screenshot
 * quality is 0-100. The old code passed the 0-100 value straight through, so
 * every re-encode ran at MAXIMUM quality, the byte size never shrank, and the
 * `q -= 0.1` loop spun ~798 full decode/draw/encode iterations (minutes of
 * background-thread stall per screenshot on the default derived-budget path).
 *
 * Pinned contracts:
 * - CDP-style quality (0-100) is normalized to the canvas 0-1 scale.
 * - The fit loop is bounded (never more than MAX_MAXBYTES_FIT_ITERATIONS
 *   re-encodes), even when the input can never shrink.
 * - The quality floor (0.3) is respected.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  fitScreenshotToMaxBytes,
  jpegQuality01,
  MAX_MAXBYTES_FIT_ITERATIONS,
  normalizeScreenshotToViewport,
} from "../src/extension/background/screenshots";

const fake = vi.hoisted(() => ({
  canvasAvailable: true,
  /** Quality values the (mocked) canvas re-encode received, in order. */
  qualities: [] as number[],
  /** Base64 payload length (chars) for the next re-encode. */
  payloadLen: 4,
  image: {
    width: 1000,
    height: 500,
    drawTo: vi.fn(),
    cleanup: vi.fn(),
  },
  canvas: {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "",
      drawImage: vi.fn(),
    })),
    convertToBlob: vi.fn(),
  },
}));

vi.mock("../src/lib/agent/dom/annotation/canvas-utils", () => ({
  createCompatibleCanvas: () => (fake.canvasAvailable ? fake.canvas : null),
  loadCompatibleImage: async () => fake.image,
}));

vi.mock("../src/lib/agent/dom/annotation/screenshot-annotator-utils", () => ({
  canvasToDataUrl: async (_canvas: unknown, _fallback: string, quality?: number) => {
    fake.qualities.push(quality ?? 0.85);
    // A base64 payload of `payloadLen` chars (≈ 3·len/4 decoded bytes).
    return `data:image/jpeg;base64,${"A".repeat(fake.payloadLen)}`;
  },
}));

function b64Len(chars: number): number {
  return Math.floor((chars * 3) / 4);
}

beforeEach(() => {
  fake.qualities.length = 0;
  fake.payloadLen = 4;
});

describe("jpegQuality01 — CDP 0-100 → canvas 0-1 normalization", () => {
  test("values above 1 are treated as the CDP 0-100 scale", () => {
    expect(jpegQuality01(80)).toBe(0.8);
    expect(jpegQuality01(100)).toBe(1);
    expect(jpegQuality01(50)).toBe(0.5);
  });

  test("values already in 0-1 pass through unchanged", () => {
    expect(jpegQuality01(0.85)).toBe(0.85);
    expect(jpegQuality01(1)).toBe(1);
    expect(jpegQuality01(0.3)).toBe(0.3);
  });
});

describe("fitScreenshotToMaxBytes — bounded fit loop", () => {
  test("stops as soon as the payload fits (quality stepped down 0.1 per pass)", async () => {
    const seen: number[] = [];
    await fitScreenshotToMaxBytes(
      "data:image/jpeg;base64," + "A".repeat(10),
      0.8,
      b64Len(2), // maxBytes: only a ≤2-byte payload fits
      async (dataUrl, q) => {
        seen.push(q);
        // Simulate the re-encode shrinking below the cap once q < 0.8.
        const shrunk = q < 0.8 ? "A".repeat(2) : "A".repeat(10);
        return `data:image/jpeg;base64,${shrunk}`;
      },
    );
    // q=0.8 (10B, still over) → q=0.7 (2B, fits) → stop after 2 encodes.
    expect(seen).toEqual([0.8, 0.7]);
  });

  test("an unshrinkable payload terminates at the iteration bound, never spinning", async () => {
    const seen: number[] = [];
    await fitScreenshotToMaxBytes(
      "data:image/jpeg;base64," + "A".repeat(4),
      0.8,
      1,
      async (dataUrl, q) => {
        seen.push(q);
        return dataUrl; // never shrinks
      },
    );
    // The quality floor is 0.3; the loop may run at most
    // MAX_MAXBYTES_FIT_ITERATIONS times regardless of input.
    expect(seen.length).toBeLessThanOrEqual(MAX_MAXBYTES_FIT_ITERATIONS);
    expect(seen.length).toBeGreaterThan(0);
    for (const q of seen) {
      expect(q).toBeGreaterThanOrEqual(0.3);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});

describe("normalizeScreenshotToViewport — full path with a 0-100 quality", () => {
  test("normalizes the CDP quality before the fit loop (no 80→1.0 clamping)", async () => {
    fake.payloadLen = 10; // never shrinks
    const out = await normalizeScreenshotToViewport(
      "data:image/jpeg;base64," + "A".repeat(10),
      80, // CDP scale — the old code passed this to a 0-1 API
      { maxBytes: 1 },
    );
    expect(out).toContain("data:image/jpeg;base64,");
    expect(fake.qualities.length).toBeGreaterThan(0);
    // The FIRST re-encode already runs at the normalized 0-1 quality —
    // the old code sent 80 (clamped to 1.0 by the canvas API).
    expect(fake.qualities[0]).toBeLessThanOrEqual(1);
  });
});