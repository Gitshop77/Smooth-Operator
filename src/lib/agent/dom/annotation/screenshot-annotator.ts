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

export interface AnnotateOptions {
  /** Font size for the index label (in scaled / device pixels). Default 14. */
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

  const fontSize = options?.fontSize ?? 14;
  const textColor = options?.textColor ?? "#ffffff"; // white
  const scaleFactor = options?.scaleFactor ?? 1;
  const minSize = options?.minSize ?? 5;
  const refPrefix = options?.refPrefix ?? "";
  // Multi-color mode: cycle through `boxColors` by index. Single-color mode:
  // use `boxColor` for every box. Multi-color makes neighbouring elements
  // distinguishable on dense pages.
  const palette = options?.boxColors ?? null;
  const singleBoxColor = options?.boxColor ?? "#ef4444"; // red-500
  const singleBgColor = options?.bgColor ?? "#ef4444"; // red-500

  // Bail out early if no Canvas implementation is available. This is the
  // graceful-degradation path used by the Node.js demo mode.
  const canvas = createCanvas();
  if (!canvas) return screenshotDataUrl;

  let img: LoadedImage;
  try {
    img = await loadImage(screenshotDataUrl, canvas);
  } catch {
    // Image load failed (malformed data URL, decode error, …). Return raw.
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
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = "top";

    for (const el of elements) {
      const { x, y, width, height } = el.rect;
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
      const color = palette ? palette[el.index % palette.length] : singleBoxColor;
      const labelBg = palette ? color : singleBgColor;

      // Bounding-box outline.
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, scaleFactor);
      ctx.strokeRect(dx, dy, dw, dh);

      // Number label in the top-left corner — the label IS the element's
      // ref (the `[index]` the LLM uses to reference it), optionally
      // prefixed (e.g. `"e3"`) when the caller uses a ref-string convention.
      const label = refPrefix + String(el.index);
      const labelWidth = ctx.measureText(label).width + 6;
      const labelHeight = fontSize + 4;

      ctx.fillStyle = labelBg;
      ctx.fillRect(dx, dy, labelWidth, labelHeight);

      ctx.fillStyle = textColor;
      ctx.fillText(label, dx + 3, dy + 2);
    }

    return await canvasToDataUrl(canvas);
  } catch {
    // Any drawing / encoding error → return the raw screenshot.
    return screenshotDataUrl;
  } finally {
    // Release the ImageBitmap's GPU resources (no-op for HTMLImageElement).
    img.cleanup?.();
  }
}

// ─── Canvas abstraction (OffscreenCanvas ↔ HTMLCanvasElement) ───────────────

/** Minimal common surface we use from either canvas flavor. */
interface AnnotatorCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): CanvasRenderingContext2D | null;
}

/** A LoadedImage just knows how to copy itself onto a 2D context. */
interface LoadedImage {
  width: number;
  height: number;
  drawTo(ctx: CanvasRenderingContext2D): void;
  cleanup?(): void;
}

/**
 * Create a canvas that works in the current context. Returns `null` if
 * neither `OffscreenCanvas` nor `document.createElement("canvas")` is
 * available (e.g. Node.js without a DOM shim).
 */
function createCanvas(): AnnotatorCanvas | null {
  // OffscreenCanvas is the only option in an MV3 service worker.
  const oc = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (typeof oc !== "undefined") {
    try {
      return new oc(1, 1) as unknown as AnnotatorCanvas;
    } catch {
      /* fall through to HTMLCanvasElement */
    }
  }
  // Content-script / DOM context.
  const doc = (globalThis as { document?: Document }).document;
  if (doc && typeof doc.createElement === "function") {
    try {
      return doc.createElement("canvas") as unknown as AnnotatorCanvas;
    } catch {
      /* fall through to null */
    }
  }
  return null;
}

/**
 * Load an image from a data URL. Uses the right API for the canvas type:
 *   - `OffscreenCanvas` → `createImageBitmap(blob)` (works in SWs)
 *   - `HTMLCanvasElement` → `new Image()` (works in DOM contexts)
 *
 * Both paths return a {@link LoadedImage} that knows how to draw itself
 * onto a 2D context.
 */
async function loadImage(dataUrl: string, _canvas: AnnotatorCanvas): Promise<LoadedImage> {
  // Path 1: OffscreenCanvas → ImageBitmap (no DOM needed).
  if (typeof createImageBitmap !== "undefined") {
    const blob = await dataUrlToBlob(dataUrl);
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      drawTo: (ctx) => ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0),
      // ImageBitmap holds GPU/decoded-image resources — close after drawing
      // to prevent accumulation across long agent runs.
      cleanup: () => { try { bitmap.close(); } catch { /* already closed */ } },
    };
  }
  // Path 2: HTMLCanvasElement → HTMLImageElement (DOM required).
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
        width: img.width,
        height: img.height,
        drawTo: (ctx) => ctx.drawImage(img, 0, 0),
      });
    };
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = dataUrl;
  });
}

/** Convert a `data:image/*;base64,…` URL to a `Blob`. */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  // Prefer `fetch(dataUrl)` — works in SW + DOM and decodes any data-URL
  // mime type without manual base64 work.
  const res = await fetch(dataUrl);
  return await res.blob();
}

/** Convert a canvas back to a JPEG data URL.
 *
 * Output JPEG (quality 0.85) instead of PNG. `chrome.tabs.captureVisibleTab`
 * already produces JPEG at quality 80, so the input is already lossy — re-encoding
 * as PNG (3-5× larger for photographic content) was inflating both the bundle
 * sent to the LLM and the prompt token count with no quality benefit. JPEG q=85
 * preserves the numbered-box outlines cleanly while cutting size ~3-5×. */
async function canvasToDataUrl(canvas: AnnotatorCanvas): Promise<string> {
  // OffscreenCanvas path.
  const oc = canvas as unknown as {
    convertToBlob?: (opts: { type: string; quality?: number }) => Promise<Blob>;
  };
  if (typeof oc.convertToBlob === "function") {
    const blob = await oc.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    return await blobToDataUrl(blob);
  }
  // HTMLCanvasElement path.
  const html = canvas as unknown as { toDataURL?: (type: string, quality?: number) => string };
  if (typeof html.toDataURL === "function") {
    return html.toDataURL("image/jpeg", 0.85);
  }
  // Should never happen — both canvas flavors implement one of the two.
  throw new Error("No canvas-to-data-URL method available");
}

/** Convert a `Blob` to a `data:` URL via `FileReader`. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    // FileReader is available in both SW and DOM contexts.
    const FR = (globalThis as { FileReader?: typeof FileReader }).FileReader;
    if (!FR) {
      reject(new Error("FileReader unavailable"));
      return;
    }
    const reader = new FR();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}
