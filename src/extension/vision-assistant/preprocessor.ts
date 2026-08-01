/**
 * Vision Assistant — image preprocessor.
 *
 * Converts a screenshot data URL to the pixel_values tensor that the
 * MoonViT vision encoder expects.
 * Ported from Reza2kn's preprocess() function.
 *
 * ## Service-worker compatibility
 *
 * This module runs inside the MV3 service worker (bundled into
 * `background.js`). The SW context has NO `document`, NO `new Image()`, and
 * NO `HTMLCanvasElement`. The previous implementation used those DOM APIs
 * directly — `new Image()` threw `ReferenceError` on every call, which the
 * agent-bridge's `.catch(() => [])` swallowed silently, leaving Local Vision
 * completely broken in production. We now follow the same OffscreenCanvas +
 * `createImageBitmap` pattern used by `screenshot-annotator.ts`, with a
 * DOM-context fallback so the unit tests (which run under jsdom) still work.
 */

import {
  PATCH_SIZE,
  MERGE_FACTOR,
  MAX_IMAGE_PATCHES,
  IMAGE_MEAN,
  IMAGE_STD,
} from "./constants";

import {
  DATA_URL_RE,
  MEAN_GREY,
  createCanvas,
  loadImage,
} from "./preprocessor-utils";

interface PreprocessResult {
  pixelValues: Float32Array; // [nPatches, 3, PATCH_SIZE, PATCH_SIZE]
  gridHeight: number;
  gridWidth: number;
  nPatches: number;
  /** Padded canvas dimensions used for the pixel_values tensor. */
  targetWidth: number;
  /** Padded canvas dimensions used for the pixel_values tensor. */
  targetHeight: number;
  /**
   * Rescaled image dimensions (after fitting to MAX_IMAGE_PATCHES, before
   * padding to multiples of PATCH_SIZE). The model normalizes its 0-1000
   * coordinates over the PADDED canvas (targetWidth × targetHeight), so
   * mapping back to original pixels requires both the rescale factor and
   * the padding factor.
   */
  rescaledWidth: number;
  rescaledHeight: number;
  /**
   * Original screenshot dimensions (before any rescale or padding).
   * CDP `Input.dispatchMouseEvent` consumes CSS pixels, and the screenshot's
   * native pixel dimensions are what `chrome.tabs.captureVisibleTab` returns.
   */
  originalWidth: number;
  originalHeight: number;
}

function paddedDims(w: number, h: number): { tw: number; th: number; patches: number } {
  const pad = MERGE_FACTOR * PATCH_SIZE;
  const tw = Math.ceil(w / pad) * pad;
  const th = Math.ceil(h / pad) * pad;
  return { tw, th, patches: (tw / PATCH_SIZE) * (th / PATCH_SIZE) };
}

/**
 * Preprocess a screenshot for the MoonViT vision encoder.
 *
 * Pipeline:
 * 1. Load the data URL into an image (ImageBitmap in SW, HTMLImageElement
 * in DOM).
 * 2. If the patch count exceeds {@link MAX_IMAGE_PATCHES}, downscale
 * (preserving aspect ratio) so it fits.
 * 3. Pad the (possibly-scaled) image up to the next multiple of
 * `MERGE_FACTOR * PATCH_SIZE` (= 28 px) per side. Padding is done by
 * drawing the image at its scaled size on a canvas pre-filled with the
 * normalization mean color (0.5 grey → maps to 0 after `(v - mean)/std`).
 * This preserves the aspect ratio of the visible content — the previous
 * implementation stretched the image to fill the padded canvas,
 * distorting aspect ratio AND throwing off bounding-box coordinates.
 * 4. Slice the padded canvas into `nPatches` patches of `PATCH_SIZE` ×
 * `PATCH_SIZE`, normalize each pixel to `((v/255) - mean) / std`, and
 * lay them out as `[nPatches, 3, PATCH_SIZE, PATCH_SIZE]` (channel-first
 * per patch — matches the MoonViT encoder's expected layout).
 */
export async function preprocessScreenshot(screenshotDataUrl: string): Promise<PreprocessResult> {
  // Validate the input is a well-formed `image/*` data URL BEFORE decoding —
  // a malformed/non-image or huge data URL would otherwise throw deep inside
  // `loadImage`/`createImageBitmap` (an opaque decode error) or allocate an
  // oversized canvas. Fail fast with a clear message.
  if (typeof screenshotDataUrl !== "string" || screenshotDataUrl.length === 0) {
    throw new Error("preprocessScreenshot: screenshotDataUrl must be a non-empty string");
  }
  if (!DATA_URL_RE.test(screenshotDataUrl)) {
    throw new Error(
      "preprocessScreenshot: expected a data:image/*;base64,… URL (got a malformed or non-image value)",
    );
  }
  // Upper bound on input size (~50 MiB of base64) to avoid allocating a giant
  // bitmap/canvas from a hostile or corrupt screenshot.
  const MAX_SCREENSHOT_CHARS = 50 * 1024 * 1024;
  if (screenshotDataUrl.length > MAX_SCREENSHOT_CHARS) {
    throw new Error("preprocessScreenshot: screenshot data URL exceeds the maximum allowed size");
  }
  const img = await loadImage(screenshotDataUrl);
  // Reject zero-dimension source screenshots: a 0×N or N×0 image would make
  // `originalWidth`/`originalHeight` zero, collapsing every downstream
  // toPixelCoords computation (clamp bound `cw-1` becomes -1) into
  // {x:0,y:0,w:1,h:1} garbage coordinates.
  if (img.width <= 0 || img.height <= 0) {
    throw new Error("preprocessScreenshot: screenshot image has zero width or height");
  }
  // Original screenshot pixel dimensions (BEFORE any rescale/pad). Used
  // downstream by `toPixelCoords` to map the model's 0-1000 normalized box
  // coordinates back to actual screenshot pixels.
  const originalWidth = img.width;
  const originalHeight = img.height;
  let w = originalWidth;
  let h = originalHeight;

  // Rescale if the post-padding patch count exceeds the cap. Padding rounds
  // `w`/`h` up to the next multiple of `MERGE_FACTOR * PATCH_SIZE`, so the
  // effective patch count is `(tw / PATCH_SIZE) * (th / PATCH_SIZE)` after
  // padding — not the pre-padding `floor(w/PATCH) * floor(h/PATCH)`.
  // Iterate the rescale because a single pass may still exceed the cap
  // due to ceiling-rounding after the scale-down (e.g. a 1920×1080 screenshot
  // lands at 264 patches after one pass, still > 256).
  let { tw, th, patches } = paddedDims(w, h);
  while (patches > MAX_IMAGE_PATCHES) {
    const scale = Math.sqrt(MAX_IMAGE_PATCHES / patches);
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
    ({ tw, th, patches } = paddedDims(w, h));
  }

  // Guard against a degenerate (zero-sized) source image. A zero-width/height
  // source leaves `w`/`h` at 0 and the rescale loop's floor(… × scale) can also
  // floor a small dimension down to 0. That would make `tw`/`th` (and therefore
  // the canvas) zero-sized AND turn `rescaledWidth`/`rescaledHeight` into
  // divisors of zero downstream (non-finite 0-1000 → pixel coordinates). Clamp
  // to ≥1 and recompute the padded dimensions so the invariant holds.
  w = Math.max(1, w);
  h = Math.max(1, h);
  ({ tw, th } = paddedDims(w, h));

  const canvas = createCanvas();
  if (!canvas) {
    throw new Error("Canvas unavailable — cannot preprocess screenshot");
  }
  // Draw to canvas to get pixel data. Pre-fill with the mean color (0.5 grey)
  // so the padded border maps to 0 after normalization — this keeps the
  // aspect ratio of the visible content intact (stretching the image to fill
  // `tw × th` would distort it and break the 0-1000 → pixel mapping).
  canvas.width = tw;
  canvas.height = th;
  const cx = canvas.getContext("2d");
  if (!cx) {
    throw new Error("Canvas 2D context unavailable");
  }
  cx.imageSmoothingEnabled = true;
  (cx as CanvasRenderingContext2D & { imageSmoothingQuality: string }).imageSmoothingQuality =
    "high";
  // Fill with the mean grey (0.5 * 255 ≈ 127.5 → rounds to 128). After
  // normalization `(128/255 - 0.5) / 0.5 ≈ 0.004`, effectively zero — the
  // padded border contributes ~nothing to the vision encoder's output for
  // those patches.
  cx.fillStyle = `rgb(${MEAN_GREY}, ${MEAN_GREY}, ${MEAN_GREY})`;
  cx.fillRect(0, 0, tw, th);
  // Draw the (possibly-rescaled) image at its scaled size in the top-left
  // corner. The remaining `tw - w` × `th - h` strip stays mean-grey.
  img.drawTo(cx, 0, 0, w, h);
  // drawTo was the bitmap's last (and only) use — getImageData below reads
  // the canvas, not the image. Release the underlying ImageBitmap now so
  // per-step detects don't accumulate GPU/CPU memory until GC.
  img.close?.();
  const data = cx.getImageData(0, 0, tw, th).data;

  const gh = th / PATCH_SIZE;
  const gw = tw / PATCH_SIZE;
  const nPatches = gh * gw;

  // Build pixel_values [nPatches, 3, PATCH_SIZE, PATCH_SIZE]
  const pv = new Float32Array(nPatches * 3 * PATCH_SIZE * PATCH_SIZE);
  let p = 0;
  for (let py = 0; py < gh; py++) {
    for (let px = 0; px < gw; px++) {
      for (let ch = 0; ch < 3; ch++) {
        for (let yy = 0; yy < PATCH_SIZE; yy++) {
          for (let xx = 0; xx < PATCH_SIZE; xx++) {
            const sx = px * PATCH_SIZE + xx;
            const sy = py * PATCH_SIZE + yy;
            const v = data[(sy * tw + sx) * 4 + ch] / 255;
            pv[p++] = (v - IMAGE_MEAN) / IMAGE_STD;
          }
        }
      }
    }
  }

  return {
    pixelValues: pv,
    gridHeight: gh,
    gridWidth: gw,
    nPatches,
    targetWidth: tw,
    targetHeight: th,
    rescaledWidth: w,
    rescaledHeight: h,
    originalWidth,
    originalHeight,
  };
}
