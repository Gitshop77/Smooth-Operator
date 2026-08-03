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
import { sendDebuggerCommandWithTimeout } from "./tab-manager-utils";
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
 * Resize a screenshot data URL to the requested dimensions via canvas
 * re-encode. `imageSmoothingQuality: "high"` is the MV3 substitute for the
 * upstream LANCZOS filter. Graceful-degradation contract (mirrors
 * `annotateScreenshot`): on ANY failure — canvas unavailable, decode error,
 * missing 2D context — the ORIGINAL data URL is returned unchanged, so the
 * caller always has a usable image.
 */
export async function resizeScreenshotDataUrl(
  dataUrl: string,
  opts: ResizeOptions,
): Promise<string> {
  const canvas = createCompatibleCanvas();
  if (!canvas) return dataUrl;
  let img: CompatibleLoadedImage | undefined;
  try {
    img = await loadCompatibleImage(dataUrl);
    if (!img.width || !img.height) return dataUrl;
    const dims = computeResizeDims(img.width, img.height, opts);
    if (dims.width === img.width && dims.height === img.height) return dataUrl;
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.imageSmoothingEnabled = true;
    (ctx as { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
    img.drawTo(ctx, dims.width, dims.height);
    return await canvasToDataUrl(canvas, dataUrl);
  } catch {
    return dataUrl;
  } finally {
    img?.cleanup?.();
  }
}

/**
 * Capture a JPEG screenshot of the given tab via `chrome.debugger`. Attaches
 * the debugger, issues `Page.captureScreenshot`, and ALWAYS detaches (even on
 * error) — mirroring the CDP_CLICK / SCREENSHOT handler patterns. Returns a
 * `data:image/jpeg;base64,...` data URL. When `opts.resize` is provided, the
 * captured screenshot is resized (see {@link resizeScreenshotDataUrl})
 * before being returned; the default applies no resize.
 *
 * The agent's tab (`tabId`) is passed explicitly so we never capture the
 * user's *visible* tab. Using `captureVisibleTab(WINDOW_ID_CURRENT)` would
 * capture whichever tab the user was viewing — if they'd switched tabs
 * mid-run, vision detections + cached pixelRects would be for the WRONG page,
 * causing silent misclicks on `[vN]` (could be a delete/payment button).
 */
export async function captureTabScreenshot(
  tabId: number,
  opts?: { resize?: ResizeOptions },
): Promise<string> {
 // Route through the same per-tab refcounted debugger session that
 // `extractStateFromTab` uses, so a concurrent per-step screenshot cannot
 // tear down this session mid-capture (and vice-versa). The session is only
 // detached when the last user releases it (guaranteed by `withPageDebugger`'s
 // `finally` even on error).
  const quality = await getScreenshotQuality();
  return withPageDebugger(tabId, async () => {
    const result = await sendDebuggerCommandWithTimeout<{ data?: string }>(
      tabId,
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality,
        // Capture only the VISIBLE viewport. CDP defaults `captureBeyondViewport`
        // to true (full scrollable page) when not specified; the vision flow
        // matches screenshots against `pixelRects` expressed in VIEWPORT coords,
        // so a full-page image would misalign clicks (see header warning). Mirror
        // the sibling capture in tab-manager.ts which passes the same flag.
        captureBeyondViewport: false,
      },
    );
    if (!result?.data) throw new Error("Page.captureScreenshot returned no data");
    const dataUrl = `data:image/jpeg;base64,${result.data}`;
    return opts?.resize ? await resizeScreenshotDataUrl(dataUrl, opts.resize) : dataUrl;
  });
}
