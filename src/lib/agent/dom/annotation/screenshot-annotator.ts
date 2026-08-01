/**
 * Screenshot annotator — draws numbered bounding boxes on screenshots,
 * linking the visual view to the `[index]` numbers in the elements tree.
 *
 * Draws numbered bounding boxes on screenshots, linking the visual
 * view to the [index] numbers. For vision-capable models, seeing "5" drawn on the
 * submit button + `[5]<button>Submit</button>` in the elements tree
 * creates a direct visual-structural link that dramatically improves
 * click accuracy — the model no longer has to guess which pixel region
 * corresponds to which `[index]` in the DOM tree.
 *
 * ## Coordinate-system note
 *
 * `chrome.tabs.captureVisibleTab` returns a JPEG (when called with
 * `format: "jpeg"`) at *device* pixel
 * resolution (e.g. a 1280×800 CSS viewport at DPR 2 produces a
 * 2560×1600 image). `getBoundingClientRect()` returns *CSS* pixel
 * coordinates. The {@link AnnotatableElement.rect} is therefore in CSS
 * pixels and must be scaled by `scaleFactor` (= `window.devicePixelRatio`)
 * before being drawn on the canvas — otherwise the boxes will be drawn in
 * the top-left quadrant of the screenshot at half the correct size.
 *
 * ## Prompt note
 *
 * The navigator prompt (`src/lib/agent/prompts/navigator-prompt.ts`)
 * SHOULD mention to the LLM that "the screenshot has numbered labels
 * matching the `[index]` numbers in the elements tree — use the same
 * `[index]` to reference an element whether you read it in the tree or
 * see it drawn on the screenshot." That prompt file is owned by another
 * agent and is intentionally not edited here.
 *
 * ## Graceful degradation
 *
 * Falls back to the original screenshot if Canvas 2D is unavailable
 * (e.g. when running under Node.js test runner where neither
 * `OffscreenCanvas` nor `document.createElement("canvas")` exist). The
 * caller therefore never has to handle an annotation failure — it just
 * gets the raw screenshot back.
 *
 * Extracted from the historical `dom/screenshot-annotator.ts`. The legacy
 * `@/lib/agent/dom/screenshot-annotator` import path stays working via a
 * re-export shim in `dom/screenshot-annotator.ts`.
 */

import {
  createCompatibleCanvas,
  loadCompatibleImage,
  type CompatibleLoadedImage,
} from "./canvas-utils";
import {
  isHexColor,
  sanitizeColor,
  pickReadableTextColor,
  canvasToDataUrl,
} from "./screenshot-annotator-utils";

export interface AnnotatableElement {
  /** 1-based index the LLM uses to reference this element. */
  index: number;
  /** Bounding box in CSS pixels (viewport-relative, matching `getBoundingClientRect`). */
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Default 12-color palette cycled by element index. Each box outline + label
 * background uses `palette[index % palette.length]` so neighbouring elements
 * are visually distinguishable on dense pages (the single-color approach
 * makes overlapping boxes impossible to tell apart).
 */
export const DEFAULT_ANNOTATE_PALETTE: readonly string[] = [
  "#ef4444", // red-500
  "#f59e0b", // amber-500
  "#10b981", // emerald-500
  "#3b82f6", // blue-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#14b8a6", // teal-500
  "#f97316", // orange-500
  "#84cc16", // lime-500
  "#06b6d4", // cyan-500
  "#a855f7", // purple-500
  "#6366f1", // indigo-500
];

interface AnnotateOptions {
  /** Base font size for the index label, in CSS pixels. It is multiplied by
 * `scaleFactor` when drawn on the device-resolution canvas, so the label
 * renders at a consistent visual size regardless of DPR. Default 14. */
  fontSize?: number;
  /** Hex color of the bounding-box outline (single-color mode). Default `#ef4444` (red-500). Ignored when `boxColors` is set. */
  boxColor?: string;
  /**
 * Array of hex colors cycled by element index (multi-color mode). When set,
 * each element's box outline + label background uses
 * `boxColors[index % boxColors.length]`, making neighbouring elements
 * visually distinguishable. Default: `undefined` (single-color via `boxColor`).
 */
  boxColors?: string[];
  /** Hex color of the label text. Default `#ffffff` (white). */
  textColor?: string;
  /** Hex color of the label background (single-color mode). Default `#ef4444` (red-500). Ignored when `boxColors` is set. */
  bgColor?: string;
  /**
 * Minimum width AND height (in CSS pixels) for an element to be annotated.
 * Elements smaller than this are skipped — their boxes would be too tiny to
 * see and their labels would be unreadable. Default 5.
 */
  minSize?: number;
  /**
 * Multiplier applied to all rect coordinates to convert CSS pixels →
 * device pixels (matches the screenshot's intrinsic resolution).
 * Default `1` (no scaling — caller should pass `window.devicePixelRatio`
 * for the screenshot's tab).
 */
  scaleFactor?: number;
  /**
 * Optional prefix prepended to each label (e.g. `"e"` → label `"e3"`).
 * When omitted, the label is the bare index number (`"3"`). Default `""`.
 */
  refPrefix?: string;
}

/**
 * Draw numbered labels on a screenshot image.
 *
 * Takes a screenshot data URL + a list of elements with their bounding rects,
 * returns a new JPEG data URL with numbered boxes drawn on each element.
 * On any failure (Canvas unavailable, image load error, …) the original
 * screenshot data URL is returned unchanged so the agent always has a
 * usable image.
 *
 * Uses Canvas 2D via `OffscreenCanvas` (available in MV3 service workers
 * since Chrome 69) or via a regular `<canvas>` element in content/DOM
 * contexts.
 */
export async function annotateScreenshot(
  screenshotDataUrl: string,
  elements: AnnotatableElement[],
  options?: AnnotateOptions,
): Promise<string> {
 // Fast-path: nothing to draw. Avoids canvas creation entirely.
  if (!elements || elements.length === 0) return screenshotDataUrl;

  const fontSize =
    typeof options?.fontSize === "number" &&
    Number.isFinite(options.fontSize) &&
    options.fontSize > 0
      ? options.fontSize
      : 14;
 // `scaleFactor` must be a finite positive number (it multiplies every
 // coordinate + the font size). A `0` collapses boxes to the origin; a
 // negative one mirrors drawing. Fall back to `1` for any bad input so a
 // malformed caller can't produce silently-wrong output.
  const rawScale = options?.scaleFactor;
  const scaleFactor =
    typeof rawScale === "number" && Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const minSize =
    typeof options?.minSize === "number" &&
    Number.isFinite(options.minSize) &&
    options.minSize > 0
      ? options.minSize
      : 5;
  const refPrefix = options?.refPrefix ?? "";
 // Multi-color mode: cycle through `boxColors` by index. Single-color mode:
 // use `boxColor` for every box. An empty / all-invalid `boxColors` array is
 // "no palette" (not a palette of length 0, which would yield `NaN` indices →
 // black boxes). Drop any entry that isn't a valid hex color.
  const validBoxColors = options?.boxColors?.filter(
    (c): c is string => typeof c === "string" && isHexColor(c),
  );
  const palette = validBoxColors?.length ? validBoxColors : null;
  const singleBoxColor = sanitizeColor(options?.boxColor, "#ef4444"); // red-500
  const singleBgColor = sanitizeColor(options?.bgColor, "#ef4444"); // red-500
  const textColor = sanitizeColor(options?.textColor, "#ffffff"); // white

 // Fast-path: if no element survives the draw filter (finite, positive,
 // >= minSize, finite index) there is nothing to draw — skip the full image
 // decode + canvas allocation and return the raw screenshot unchanged.
  const hasDrawable = elements.some(
    (el) =>
      el != null &&
      el.rect != null &&
      Number.isFinite(el.index) &&
      Number.isFinite(el.rect.x) &&
      Number.isFinite(el.rect.y) &&
      Number.isFinite(el.rect.width) &&
      Number.isFinite(el.rect.height) &&
      el.rect.width > 0 &&
      el.rect.height > 0 &&
      el.rect.width >= minSize &&
      el.rect.height >= minSize,
  );
  if (!hasDrawable) return screenshotDataUrl;

 // Bail out early if no Canvas implementation is available. This is the
 // graceful-degradation path used by the Node.js demo mode.
  const canvas = createCompatibleCanvas();
  if (!canvas) return screenshotDataUrl;

  let img: LoadedImage;
  try {
 // `loadCompatibleImage` selects the decode path internally (no canvas arg
 // needed — see ./canvas-utils). The dead `_canvas` param was removed.
    img = await loadCompatibleImage(screenshotDataUrl);
  } catch {
 // Image load failed (malformed data URL, decode error, …). Return raw.
    return screenshotDataUrl;
  }

  if (!img.width || !img.height) {
    img.cleanup?.();
    return screenshotDataUrl;
  }

  try {
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return screenshotDataUrl;

 // Draw the original screenshot as the base layer.
    img.drawTo(ctx);

 // Draw numbered boxes on each element.
 // The canvas is at device resolution, so scale the label font by
 // `scaleFactor` to match the boxes; otherwise the label text renders at
 // ~1/scaleFactor of the intended visual size on high-DPR screenshots.
    const sFont = fontSize * scaleFactor;
    ctx.font = `bold ${sFont}px sans-serif`;
    ctx.textBaseline = "top";

    for (const el of elements) {
      if (el == null || el.rect == null) continue;
      const { x, y, width, height } = el.rect;
 // Skip malformed / non-finite rects — a NaN passes the `<= 0` checks but
 // would make `ctx.strokeRect(NaN, …)` draw nothing (silent drop), and a
 // negative index would break the palette lookup below.
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
 // `x`/`y` are also guarded: a `NaN` coordinate passes all the size checks
 // but `strokeRect(NaN, …)` / `fillRect(NaN, …)` draw nothing, silently
 // dropping that element's annotation.
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!Number.isFinite(el.index)) continue;
 // Skip zero-size AND sub-`minSize` elements — their boxes would be
 // invisible and their labels unreadable.
      if (width <= 0 || height <= 0) continue;
      if (width < minSize || height < minSize) continue;

 // Scale CSS-pixel rect → device-pixel canvas coordinates.
      const dx = x * scaleFactor;
      const dy = y * scaleFactor;
      const dw = width * scaleFactor;
      const dh = height * scaleFactor;

 // Pick this element's color: cycle the palette by index in multi-color
 // mode, or use the single color otherwise. The palette is also used for
 // the label background so the label contrasts with the box outline.
 // Use a non-negative modulo so a negative `el.index` still indexes a
 // valid palette slot instead of yielding `undefined`.
 // Floor the index so a fractional `el.index` (e.g. 2.5) maps to a
      // valid palette slot instead of `palette[2.5]` → `undefined`.
      const idx = Math.trunc(el.index);
      const color = palette
        ? palette[((idx % palette.length) + palette.length) % palette.length]
        : singleBoxColor;
      const labelBg = palette ? color : singleBgColor;

 // Bounding-box outline.
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, scaleFactor);
      ctx.strokeRect(dx, dy, dw, dh);

 // Number label in the top-left corner — the label IS the element's
 // ref (the `[index]` the LLM uses to reference it), optionally
 // prefixed (e.g. `"e3"`) when the caller uses a ref-string convention.
      const label = refPrefix + String(el.index);
 // `measureText` already reflects the scaled font; pad the box in
 // device pixels too so the label sits comfortably inside its box at
 // any DPR.
      const labelWidth = ctx.measureText(label).width + 6 * scaleFactor;
      const labelHeight = sFont + 4 * scaleFactor;

      ctx.fillStyle = labelBg;
      ctx.fillRect(dx, dy, labelWidth, labelHeight);

 // Use the caller-supplied textColor verbatim when provided; otherwise pick
 // black/white by the label background's luminance so light palette colors
 // (amber/lime/cyan) don't yield unreadable white-on-light text.
      ctx.fillStyle =
        typeof options?.textColor === "string" && isHexColor(options.textColor.trim())
          ? textColor
          : pickReadableTextColor(labelBg);
      ctx.fillText(label, dx + 3 * scaleFactor, dy + 2 * scaleFactor);
    }

    return await canvasToDataUrl(canvas, screenshotDataUrl);
  } catch {
 // Any drawing / encoding error → return the raw screenshot.
    return screenshotDataUrl;
  } finally {
 // Release the ImageBitmap's GPU resources (no-op for HTMLImageElement).
 // `img` may be `undefined` if image load failed (the inner try returned
 // early) — guard against it so the `finally` can't throw and override the
 // graceful-degradation return of the raw screenshot.
    img?.cleanup?.();
  }
}

// ─── Canvas abstraction (OffscreenCanvas ↔ HTMLCanvasElement) ───────────────
//
// Canvas creation + image decode now live in `./canvas-utils` so this module
// and the vision-assistant preprocessor share one implementation (previously
// duplicated `createCanvas()` across two modules). `createCompatibleCanvas`
// and `loadCompatibleImage` are imported at the top of this file.

/** A LoadedImage just knows how to copy itself onto a 2D context (alias of the shared type). */
type LoadedImage = CompatibleLoadedImage;


