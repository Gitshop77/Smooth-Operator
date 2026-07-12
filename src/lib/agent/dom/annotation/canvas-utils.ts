/**
 * Canvas + image-load helpers shared by the screenshot annotator and the
 * vision-assistant preprocessor.
 *
 * Both modules previously contained a byte-for-byte near-identical
 * `createCanvas()` that probes `globalThis.OffscreenCanvas` then falls back to
 * `document.createElement("canvas")`, plus a duplicated image-load path. That
 * duplication drifts (a fix applied to one copy but not the other) and the
 * canvas-selection behaviour must stay consistent wherever screenshot/vision
 * preprocessing runs (service worker vs content script). This module is the
 * single source of truth for both.
 */

/** Minimal common surface we use from either canvas flavor. */
export interface CompatibleCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D | null;
}

/** A decoded image that knows how to copy itself onto a 2D context. */
export interface CompatibleLoadedImage {
  width: number;
  height: number;
  drawTo(ctx: CanvasRenderingContext2D): void;
  cleanup?(): void;
}

/**
 * Create a canvas that works in the current context. Returns `null` if
 * neither `OffscreenCanvas` nor `document.createElement("canvas")` is
 * available (e.g. Node.js without a DOM shim) — the caller can then fall back
 * to returning the raw input unchanged.
 *
 * The path is selected by `createImageBitmap` availability, NOT by canvas
 * type: `createImageBitmap` is defined in both the Chrome service-worker
 * (OffscreenCanvas) and DOM (HTMLCanvasElement) contexts, so the
 * `HTMLImageElement` fallback is effectively only reached in jsdom/test
 * environments where `createImageBitmap` is absent. The `canvas` argument is
 * intentionally NOT used to drive the path (it is accepted for API symmetry
 * with callers that previously threaded a canvas through).
 */
export function createCompatibleCanvas(): CompatibleCanvas | null {
  // OffscreenCanvas is the only option in an MV3 service worker.
  const oc = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (typeof oc !== "undefined") {
    try {
      return new oc(1, 1) as unknown as CompatibleCanvas;
    } catch {
      /* fall through to HTMLCanvasElement */
    }
  }
  // Content-script / DOM context.
  const doc = (globalThis as { document?: Document }).document;
  if (doc && typeof doc.createElement === "function") {
    try {
      return doc.createElement("canvas") as unknown as CompatibleCanvas;
    } catch {
      /* fall through to null */
    }
  }
  return null;
}

/** Convert a `data:image/*;base64,…` URL to a `Blob`. */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // Prefer `fetch(dataUrl)` — works in SW + DOM and decodes any data-URL
  // mime type without manual base64 work.
  const res = await fetch(dataUrl);
  // A malformed / unsupported data URL can resolve with a non-OK status while
  // `res.blob()` still returns an empty/error blob. Fail loudly here (the
  // caller's fallback already handles the throw) instead of silently passing a
  // corrupt screenshot through as if annotation succeeded.
  if (!res.ok) {
    throw new Error(`dataUrlToBlob: fetch returned ${res.status} for data URL`);
  }
  return await res.blob();
}

/**
 * Load an image from a data URL.
 *
 * Path 1 (`createImageBitmap` available — Chrome SW + DOM): decode via Blob.
 * Path 2 (`HTMLImageElement` fallback — jsdom / non-createImageBitmap envs).
 * Returns a {@link CompatibleLoadedImage} that knows how to draw itself onto a
 * 2D context.
 */
export async function loadCompatibleImage(dataUrl: string): Promise<CompatibleLoadedImage> {
  if (typeof createImageBitmap !== "undefined") {
    const blob = await dataUrlToBlob(dataUrl);
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      drawTo: (ctx) => ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0),
      // ImageBitmap holds GPU/decoded-image resources — close after drawing
      // to prevent accumulation across long agent runs.
      cleanup: () => {
        try {
          bitmap.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
  return await loadImageViaImg(dataUrl);
}

/** Load a data URL into an `HTMLImageElement` (DOM-context fallback). */
function loadImageViaImg(dataUrl: string): Promise<CompatibleLoadedImage> {
  return new Promise((resolve, reject) => {
    const ImageCtor = (globalThis as { Image?: typeof Image }).Image;
    if (!ImageCtor) {
      reject(new Error("Image constructor unavailable"));
      return;
    }
    const img = new ImageCtor();
    img.onload = () => {
      resolve({
        width: img.width,
        height: img.height,
        drawTo: (ctx) => ctx.drawImage(img, 0, 0),
      });
    };
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = dataUrl;
  });
}
