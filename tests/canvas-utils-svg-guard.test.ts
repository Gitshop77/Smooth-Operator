/**
 * Regression test for the data-URL guard in canvas-utils: only raster
 * `data:image/*` URLs must be accepted, and every case variation of
 * `svg+xml` must be rejected (SVG would otherwise be rasterized in the
 * HTMLImageElement fallback — a decode/exfil surface for a screenshot
 * annotator).
 *
 * Run with: `npx vitest run tests/canvas-utils-svg-guard.test.ts`
 */

import { describe, test, expect, vi, afterEach } from "vitest";
import { dataUrlToBlob } from "../src/lib/agent/dom/annotation/canvas-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

const stubFetchBlob = (blob: Blob): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, blob: async () => blob })),
  );
};

describe("assertDataUrl SVG rejection is case-insensitive", () => {
  test("rejects uppercase SVG data URL (svg+xml bypass)", async () => {
    const svg = "data:image/SVG+XML;base64,PHN2Zz48L3N2Zz4=";
    await expect(dataUrlToBlob(svg)).rejects.toThrow(/expected a raster data:image URL/);
  });

  test("rejects mixed-case svg+xml data URL", async () => {
    const svg = "data:image/SvG+XmL;base64,PHN2Zz48L3N2Zz4=";
    await expect(dataUrlToBlob(svg)).rejects.toThrow(/expected a raster data:image URL/);
  });

  test("rejects lowercase svg+xml data URL with charset param", async () => {
    const svg = "data:image/svg+xml;charset=utf-8,PHN2Zz48L3N2Zz4=";
    await expect(dataUrlToBlob(svg)).rejects.toThrow(/expected a raster data:image URL/);
  });

  test("accepts a valid raster PNG data URL", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const fakeBlob = new Blob(["x"]);
    stubFetchBlob(fakeBlob);
    await expect(dataUrlToBlob(png)).resolves.toBe(fakeBlob);
  });

  test("accepts a valid raster JPEG data URL", async () => {
    const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const fakeBlob = new Blob(["y"]);
    stubFetchBlob(fakeBlob);
    await expect(dataUrlToBlob(jpeg)).resolves.toBe(fakeBlob);
  });

  test("accepts a valid raster JPG data URL (jpg variant)", async () => {
    const jpg = "data:image/jpg;base64,/9j/4AAQSkZJRg==";
    const fakeBlob = new Blob(["z"]);
    stubFetchBlob(fakeBlob);
    await expect(dataUrlToBlob(jpg)).resolves.toBe(fakeBlob);
  });
});

describe("assertDataUrl rejects percent-encoded media types", () => {
  test("rejects a percent-encoded svg+xml media type (single-encoded bypass)", async () => {
    const svg = "data:image/svg%2Bxml;base64,PHN2Zz48L3N2Zz4=";
    await expect(dataUrlToBlob(svg)).rejects.toThrow(/expected a raster data:image URL/);
  });

  test("rejects a double-encoded svg media type (percent-decode bypass)", async () => {
    const svg = "data:image/%2573v%2567%252Bxml;base64,PHN2Zz48L3N2Zz4=";
    await expect(dataUrlToBlob(svg)).rejects.toThrow(/expected a raster data:image URL/);
  });

  test("rejects a percent-encoded raster media type (browser never percent-decodes data-URL MIME types)", async () => {
    const jpeg = "data:image/jpeg%3Bbase64,/9j/4AAQ==";
    await expect(dataUrlToBlob(jpeg)).rejects.toThrow(/expected a raster data:image URL/);
  });
});
