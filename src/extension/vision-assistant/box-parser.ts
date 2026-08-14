/**
 * Vision Assistant — detection coordinate mapping.
 *
 * LFM2.5-VL emits grounding coordinates normalized to [0, 1000] over the full
 * input image (matching the LFM Space's `left: xmin/10%` overlay math). This
 * module converts those normalized boxes into pixel coordinates in the
 * original screenshot.
 */

import type { Detection, PixelDetection } from "./types";

/**
 * Convert normalized 0-1000 coordinates to pixel coordinates.
 * Clamps to image bounds to prevent out-of-bounds boxes from the model
 * placing detections in a padded/resized region.
 *
 * `clampWidth`/`clampHeight` (defaulting to `imageWidth`/`imageHeight`)
 * let the caller clamp to the ORIGINAL screenshot bounds rather than any
 * PADDED canvas bounds. Inverted boxes (where the model emits x2 < x1 or
 * y2 < y1) are normalized to (left, top, right, bottom) before conversion so
 * the box is anchored at the correct corner instead of the smaller coordinate.
 */
export function toPixelCoords(
  detections: Detection[],
  imageWidth: number,
  imageHeight: number,
  clampWidth?: number,
  clampHeight?: number,
): PixelDetection[] {
  const cw = clampWidth ?? imageWidth;
  const ch = clampHeight ?? imageHeight;
  return detections.map((d) => {
    const [ax1, ay1, ax2, ay2] = d.box;
 // Normalize so x1 <= x2 and y1 <= y2 even if the model emitted an
 // inverted box. Otherwise px/py would be taken from the smaller
 // coordinate while pw/ph are clamped to >=1, mis-localizing the target.
    const x1 = Math.min(ax1, ax2);
    const y1 = Math.min(ay1, ay2);
    const x2 = Math.max(ax1, ax2);
    const y2 = Math.max(ay1, ay2);
    let px = (x1 * imageWidth) / 1000;
    let py = (y1 * imageHeight) / 1000;
    let pw = ((x2 - x1) * imageWidth) / 1000;
    let ph = ((y2 - y1) * imageHeight) / 1000;
 // Clamp to the ORIGINAL screenshot bounds (cw × ch).
    px = Math.max(0, Math.min(px, cw - 1));
    py = Math.max(0, Math.min(py, ch - 1));
    pw = Math.max(1, Math.min(pw, cw - px));
    ph = Math.max(1, Math.min(ph, ch - py));
    return {
      ...d,
      pixelBox: { x: px, y: py, width: pw, height: ph },
    };
  });
}

/**
 * Capture dimensions needed to invert a pre-resize. `width`/`height` are the
 * FINAL (post-resize) image dimensions, `sourceWidth`/`sourceHeight` the
 * PRE-RESIZE capture dimensions (device pixels). Optional because a capture
 * without a resize reports no dims — see `CapturedScreenshot`.
 */
export interface CaptureDims {
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

/**
 * Re-scale detections from a PRE-RESIZED input image back to the FULL capture
 * (device-pixel) space.
 *
 * The always-on vision path pre-resizes the capture to the VLM decode edge
 * (`VLM_DECODE_MAX_EDGE`) before `RawImage.read`; the model's 0-1000 boxes
 * then map (via {@link toPixelCoords}) to the RESIZED image's pixel space,
 * not the full viewport's device pixels. `mergeDetections` divides by the tab
 * DPR assuming full-viewport device pixels — feeding it resized-space boxes
 * would mislocalize every vision-guided click. This inverts the resize before
 * the merge: multiply by `sourceWidth/width` (same ratio for height; an
 * aspect-preserving resize keeps both axes' factors equal).
 *
 * No-op (returns the input array unchanged) when the dims are missing — a
 * capture with no resize — or when the resize was a no-op (ratio 1).
 */
export function rescaleDetectionsToCapture(
  detections: PixelDetection[],
  capture: CaptureDims,
): PixelDetection[] {
  const { width, height, sourceWidth, sourceHeight } = capture;
  if (
    !width || !height || !sourceWidth || !sourceHeight ||
    (width === sourceWidth && height === sourceHeight)
  ) {
    return detections;
  }
  const sx = sourceWidth / width;
  const sy = sourceHeight / height;
  return detections.map((d) => ({
    ...d,
    pixelBox: {
      x: d.pixelBox.x * sx,
      y: d.pixelBox.y * sy,
      width: d.pixelBox.width * sx,
      height: d.pixelBox.height * sy,
    },
  }));
}

