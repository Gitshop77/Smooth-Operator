/**
 * background/screenshots.ts — screenshot-capture helper.
 *
 * Captures a single JPEG screenshot of a SPECIFIC agent tab via the CDP
 * debugger (attaching + detaching around the call). Used by the
 * `detect_visual` flow so vision detections are for the agent's tab, not the
 * user's visible tab.
 *
 * Also hosts the screenshot-resize utility (dimension math + canvas
 * re-encode). The capture entry point accepts an optional `resize` so callers
 * can bound the screenshot size before handing it to a consumer (the
 * upstream equivalent of `use_screenshot(resize=...)`); by default no resize
 * is applied.
 */

import { withPageDebugger, getScreenshotQuality } from "./tab-manager";
import { sendDebuggerCommandWithTimeout, throwIfAborted } from "./tab-manager-utils";
import {
  createCompatibleCanvas,
  loadCompatibleImage,
  type CompatibleLoadedImage,
} from "@/lib/agent/dom/annotation/canvas-utils";
import { canvasToDataUrl } from "@/lib/agent/dom/annotation/screenshot-annotator-utils";

/**
 * Resize request for a captured screenshot. Mirrors the upstream
 * `screenshot.resize(width=…, height=…, whLargest=…)` contract:
 * - `whLargest` — scale so the LONGEST side equals this (ratio kept). Wins
 *   over `width`/`height` when both are given.
 * - `width` + `height` — exactly these dimensions (may stretch).
 * - only `width` or only `height` — that dimension exact, the other keeps
 *   the aspect ratio.
 */
export interface ResizeOptions {
  width?: number;
  height?: number;
  whLargest?: number;
  /** Re-encode even when the target dimensions equal the source (JPEG
   * quality reduction without a size change). Used by the maxBytes fit loop —
   * without it the "already at target" fast path makes the loop a no-op. */
  forceReencode?: boolean;
}

/**
 * Compute the target dimensions for a `W × H` image under a resize request.
 * Pure — no canvas, no I/O. All derived dimensions use `Math.trunc` (the
 * Python `int()` semantics of the upstream implementation: truncation toward
 * zero, never rounding). Invalid inputs (non-positive / non-finite source
 * dims or resize values) leave the dimensions unchanged.
 */
export function computeResizeDims(
  width: number,
  height: number,
  opts: ResizeOptions = {},
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width, height };
  }
  const whLargest = opts.whLargest;
  if (typeof whLargest === "number" && Number.isFinite(whLargest) && whLargest > 0) {
    const scale = whLargest / Math.max(width, height);
    return {
      width: Math.max(1, Math.trunc(width * scale)),
      height: Math.max(1, Math.trunc(height * scale)),
    };
  }
  const rw = opts.width;
  const rh = opts.height;
  if (
    typeof rw === "number" && Number.isFinite(rw) && rw > 0 &&
    typeof rh === "number" && Number.isFinite(rh) && rh > 0
  ) {
    return { width: Math.trunc(rw), height: Math.trunc(rh) };
  }
  if (typeof rw === "number" && Number.isFinite(rw) && rw > 0) {
    return { width: Math.trunc(rw), height: Math.max(1, Math.trunc((height * rw) / width)) };
  }
  if (typeof rh === "number" && Number.isFinite(rh) && rh > 0) {
    return { width: Math.max(1, Math.trunc((width * rh) / height)), height: Math.trunc(rh) };
  }
  return { width, height };
}

/**
 * Result of a resize: the (possibly unchanged) data URL plus the dimensions of
 * the RETURNED image and the pre-resize SOURCE dimensions. `0` for a dimension
 * means "unknown" (the decode/resize never ran, e.g. canvas unavailable).
 * Callers that re-scale coordinates from the resized image back to the source
 * (capture) space use `sourceWidth/width` (same ratio for height).
 */
export interface ResizedScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Resize a screenshot data URL to the requested dimensions via canvas
 * re-encode. `imageSmoothingQuality: "high"` is the MV3 substitute for the
 * upstream LANCZOS filter. Graceful-degradation contract (mirrors
 * `annotateScreenshot`): on ANY failure — canvas unavailable, decode error,
 * missing 2D context — the ORIGINAL data URL is returned unchanged (with
 * unknown/`0` dims), so the caller always has a usable image. Same behavior
 * and semantics as {@link resizeScreenshotDataUrl}, but also reports the
 * returned + source dimensions so downstream coordinate mapping can invert
 * the resize.
 */
export async function resizeScreenshotDataUrlWithDims(
  dataUrl: string,
  opts: ResizeOptions,
  quality?: number,
): Promise<ResizedScreenshot> {
  const canvas = createCompatibleCanvas();
  if (!canvas) return { dataUrl, width: 0, height: 0, sourceWidth: 0, sourceHeight: 0 };
  let img: CompatibleLoadedImage | undefined;
  try {
    img = await loadCompatibleImage(dataUrl);
    if (!img.width || !img.height) return { dataUrl, width: 0, height: 0, sourceWidth: 0, sourceHeight: 0 };
    const dims = computeResizeDims(img.width, img.height, opts);
    if (!opts.forceReencode && dims.width === img.width && dims.height === img.height) {
      // Already at/under the target — the data URL is returned unchanged, so
      // its dimensions ARE the source dimensions (ratio 1 for any re-scale).
      return { dataUrl, width: img.width, height: img.height, sourceWidth: img.width, sourceHeight: img.height };
    }
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl, width: img.width, height: img.height, sourceWidth: img.width, sourceHeight: img.height };
    ctx.imageSmoothingEnabled = true;
    (ctx as { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
    img.drawTo(ctx, dims.width, dims.height);
    return {
      dataUrl: await canvasToDataUrl(canvas, dataUrl, quality),
      width: dims.width,
      height: dims.height,
      sourceWidth: img.width,
      sourceHeight: img.height,
    };
  } catch {
    return { dataUrl, width: 0, height: 0, sourceWidth: 0, sourceHeight: 0 };
  } finally {
    img?.cleanup?.();
  }
}

/**
 * Resize a screenshot data URL to the requested dimensions via canvas
 * re-encode. See {@link resizeScreenshotDataUrlWithDims} for the full
 * graceful-degradation contract; this wrapper returns just the data URL.
 */
export async function resizeScreenshotDataUrl(
  dataUrl: string,
  opts: ResizeOptions,
  quality?: number,
): Promise<string> {
  return (await resizeScreenshotDataUrlWithDims(dataUrl, opts, quality)).dataUrl;
}

/** Number of decoded bytes in a `data:...;base64,...` URL (strips the header
 * and accounts for padding). Returns 0 for malformed input. */
export function base64ByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = (b64.match(/=+$/) ?? [""])[0].length;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** Max re-encode iterations in the maxBytes fit loop — a quality-scale bug or
 * unshrinkable input must never become an unbounded decode/draw/encode storm
 * (the canvas JPEG quality API takes 0-1 and clamps out-of-range to 1.0; CDP
 * screenshot quality is 0-100, so an unscaled value silently re-encodes at
 * MAXIMUM quality and the loop can spin ~800 times). */
export const MAX_MAXBYTES_FIT_ITERATIONS = 8;

/** Normalize a CDP-style 0-100 JPEG quality to the canvas 0-1 scale (values
 * already in 0-1 pass through). */
export function jpegQuality01(quality: number): number {
  return quality > 1 ? quality / 100 : quality;
}

/** Iteratively re-encode `working` at decreasing quality until its decoded
 * byte size fits `maxBytes` (bounded by {@link MAX_MAXBYTES_FIT_ITERATIONS}
 * and a 0.3 quality floor). The current quality is tried FIRST, then stepped
 * down in exact tenths (no float drift: 0.8 - 0.1 must be 0.7). Exported so
 * the loop is testable without a canvas; production passes a forced re-encode
 * (`forceReencode: true`) so a same-dimension JPEG re-encode actually runs. */
export async function fitScreenshotToMaxBytes(
  working: string,
  quality01: number,
  maxBytes: number,
  reencode: (dataUrl: string, quality: number) => Promise<string>,
): Promise<string> {
  let q = quality01;
  for (let i = 0; i < MAX_MAXBYTES_FIT_ITERATIONS && base64ByteLength(working) > maxBytes && q > 0.3; i++) {
    working = await reencode(working, q);
    if (base64ByteLength(working) <= maxBytes) break;
    q = Math.max(0.3, Math.round((q - 0.1) * 10) / 10);
  }
  return working;
}

/**
 * Normalize a captured screenshot to a size that a vision backend can actually
 * ingest — WITHOUT silently destroying information the way the old
 * context-derived char cap did (it used to downscale a full 2560×1600 viewport
 * to ~512px "because the token math said so", cropping away most of the page).
 *
 * The contract: by default we keep the FULL CSS-pixel viewport (the size the
 * model will reason about), applying the user's JPEG `quality`. Only optional,
 * explicit ceilings shrink it:
 * - `maxDimension` (CSS px, 0 = off): scale so the longest side ≤ this.
 * - `maxBytes` (0 = off): repeatedly re-encode at lower quality until the
 *   decoded byte size fits. This is the knob for hosted APIs that cap payload
 *   size while preserving the full field of view.
 */
export async function normalizeScreenshotToViewport(
  dataUrl: string,
  quality: number,
  opts: { maxDimension?: number; maxBytes?: number } = {},
): Promise<string> {
  const maxDimension = opts.maxDimension ?? 0;
  const maxBytes = opts.maxBytes ?? 0;
  // CDP screenshot quality is 0-100; the canvas re-encode APIs take 0-1 and
  // clamp out-of-range to 1.0. Normalize ONCE so the fit loop below actually
  // steps quality down (an unscaled 80 would re-encode at maximum quality
  // forever and spin the loop to its floor).
  const quality01 = jpegQuality01(quality);
  let working = dataUrl;

  if (maxDimension > 0) {
    working = await resizeScreenshotDataUrl(working, { whLargest: maxDimension }, quality01);
  }
  if (maxBytes > 0) {
    // forceReencode: the fit loop must actually re-encode at the same
    // dimensions (lower JPEG quality shrinks the bytes); without it the
    // "already at target" fast path returns the input unchanged.
    working = await fitScreenshotToMaxBytes(
      working,
      quality01,
      maxBytes,
      (dataUrl, q) => resizeScreenshotDataUrl(
        dataUrl,
        { ...(maxDimension > 0 ? { whLargest: maxDimension } : {}), forceReencode: true },
        q,
      ),
    );
  }
  return working;
}

/**
 * A captured screenshot: the data URL plus — when a resize was requested and
 * its dims are known — the FINAL (post-resize) image dimensions and the
 * PRE-RESIZE capture dimensions (device pixels). Callers that hand the resized
 * image to a model whose boxes land in the resized space use the dims to
 * re-scale those boxes back to the full capture space.
 */
export interface CapturedScreenshot {
  dataUrl: string;
  /** Final (post-resize) image dimensions. Present only when known. */
  width?: number;
  height?: number;
  /** Pre-resize capture dimensions in device pixels. Present only when known. */
  sourceWidth?: number;
  sourceHeight?: number;
}

/**
 * Capture a JPEG screenshot of the given tab via `chrome.debugger`. Attaches
 * the debugger, issues `Page.captureScreenshot`, and ALWAYS detaches (even on
 * error) — mirroring the CDP_CLICK / SCREENSHOT handler patterns. Returns a
 * `data:image/jpeg;base64,...` data URL. When `opts.resize` is provided, the
 * captured screenshot is resized (see {@link resizeScreenshotDataUrlWithDims})
 * before being returned and the final + source dimensions are reported (see
 * {@link CapturedScreenshot}); the default applies no resize and reports no
 * dimensions.
 *
 * The agent's tab (`tabId`) is passed explicitly so we never capture the
 * user's *visible* tab. Using `captureVisibleTab(WINDOW_ID_CURRENT)` would
 * capture whichever tab the user was viewing — if they'd switched tabs
 * mid-run, vision detections + cached pixelRects would be for the WRONG page,
 * causing silent misclicks on `[vN]` (could be a delete/payment button).
 */
export async function captureTabScreenshot(
  tabId: number,
  opts?: { resize?: ResizeOptions; signal?: AbortSignal },
): Promise<CapturedScreenshot> {
 // Route through the same per-tab refcounted debugger session that
 // `extractStateFromTab` uses, so a concurrent per-step screenshot cannot
 // tear down this session mid-capture (and vice-versa). The session is only
 // detached when the last user releases it (guaranteed by `withPageDebugger`'s
 // `finally` even on error).
  throwIfAborted(opts?.signal);
  const quality = await getScreenshotQuality();
  throwIfAborted(opts?.signal);
  return withPageDebugger(tabId, async () => {
    throwIfAborted(opts?.signal);
    const result = await sendDebuggerCommandWithTimeout<{ data?: string }>(
      tabId,
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality,
        // Capture only the VISIBLE viewport. CDP's protocol default for
        // `captureBeyondViewport` is false (viewport-only); we pass it
        // explicitly so the behavior is pinned. The vision flow matches
        // screenshots against `pixelRects` expressed in VIEWPORT coords,
        // so a full-page image would misalign clicks (see header warning).
        // Mirror the sibling capture in tab-manager.ts which passes the same
        // flag.
        captureBeyondViewport: false,
      },
    );
    throwIfAborted(opts?.signal);
    if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
    const dataUrl = `data:image/jpeg;base64,${result.data}`;
    if (!opts?.resize) return { dataUrl };
    const resized = await resizeScreenshotDataUrlWithDims(dataUrl, opts.resize, quality);
    throwIfAborted(opts?.signal);
    return {
      dataUrl: resized.dataUrl,
      width: resized.width > 0 ? resized.width : undefined,
      height: resized.height > 0 ? resized.height : undefined,
      sourceWidth: resized.sourceWidth > 0 ? resized.sourceWidth : undefined,
      sourceHeight: resized.sourceHeight > 0 ? resized.sourceHeight : undefined,
    };
  });
}
