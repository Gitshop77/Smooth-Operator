/**
 * Vision Assistant — image preprocessing utilities.
 *
 * Canvas abstraction and image loading helpers extracted from preprocessor.ts
 * for better modularity and testability.
 */

import { IMAGE_MEAN } from "./constants";

/**
 * Matches a well-formed raster `data:image/*;base64,…` URL (compiled once, not
 * per screenshot). Explicit raster-mime allowlist — `image/svg+xml` and other
 * non-raster subtypes are rejected even though the decode paths rasterize
 * scriptlessly, so the guard's "image/*" intent cannot drift toward accepting
 * markup payloads.
 */
export const DATA_URL_RE = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/;

/** Mean normalization value as a 0–255 grey (image mean is a constant import). */
export const MEAN_GREY = Math.round(IMAGE_MEAN * 255);

/** Minimal common surface we use from either canvas flavor. */
interface PreprocessCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D | null;
}

/** A loaded image that knows its natural size and how to draw onto a 2D ctx. */
export interface LoadedImage {
  width: number;
  height: number;
  drawTo(ctx: CanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number): void;
  /**
   * Release any underlying image resource (e.g. an ImageBitmap). Callers
   * must invoke this after the last draw; absent when the image owns no
   * releasable resource (the HTMLImageElement path).
   */
  close?(): void;
}

/**
 * Create a canvas that works in the current context. Returns `null` if
 * neither `OffscreenCanvas` nor `document.createElement("canvas")` is
 * available (e.g. Node.js without a DOM shim).
 */
export function createCanvas(): PreprocessCanvas | null {
  // OffscreenCanvas is the only option in an MV3 service worker.
  const oc = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (typeof oc !== "undefined") {
    try {
      return new oc(1, 1) as unknown as PreprocessCanvas;
    } catch {
      /* fall through to HTMLCanvasElement */
    }
  }
  // Content-script / DOM context (also jsdom in unit tests).
  const doc = (globalThis as { document?: Document }).document;
  if (doc && typeof doc.createElement === "function") {
    try {
      return doc.createElement("canvas") as unknown as PreprocessCanvas;
    } catch {
      /* fall through to null */
    }
  }
  return null;
}

/** Convert a `data:image/*;base64,…` URL to a `Blob`. */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // `fetch(dataUrl)` works in SW + DOM and decodes any data-URL mime type
  // without manual base64 work.
  const res = await fetch(dataUrl);
  return await res.blob();
}

/**
 * Load an image from a data URL using whichever API is available:
 * - `createImageBitmap(blob)` (works in SWs and DOM) — preferred.
 * - `new Image()` (DOM fallback when `createImageBitmap` is missing).
 */
export async function loadImage(dataUrl: string): Promise<LoadedImage> {
  // Path 1: createImageBitmap — works in MV3 service worker.
  const cib = (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
  if (typeof cib !== "undefined") {
    const blob = await dataUrlToBlob(dataUrl);
    const bitmap = await cib(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      drawTo: (ctx, dx, dy, dw, dh) =>
        ctx.drawImage(bitmap as unknown as CanvasImageSource, dx, dy, dw, dh),
      // ImageBitmaps hold GPU/CPU memory until explicitly released; in long
      // agent runs (one detect per step) leaving them to GC accumulates
      // memory. The bitmap's only consumer is drawTo — close it on demand.
      close: () => bitmap.close(),
    };
  }
  // Path 2: HTMLImageElement — DOM-context fallback.
  return await loadImageViaImg(dataUrl);
}

/** Load a data URL into an `HTMLImageElement` (DOM-context fallback). */
function loadImageViaImg(dataUrl: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const ImageCtor = (globalThis as { Image?: typeof Image }).Image;
    if (!ImageCtor) {
      reject(new Error("Image constructor unavailable"));
      return;
    }
    const img = new ImageCtor();
    img.onload = () => {
      resolve({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        drawTo: (ctx, dx, dy, dw, dh) => ctx.drawImage(img, dx, dy, dw, dh),
      });
    };
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = dataUrl;
  });
}
