/**
 * Vision Assistant — box parser.
 *
 * Parses LocateAnything's text output (<ref>label</ref><box>x1,y1,x2,y2</box>)
 * into structured Detection objects with pixel coordinates.
 */

import type { Detection, PixelDetection } from "./types";

/**
 * Strictly parse a single <box> body into four numbers.
 *
 * Requires the body to consist of exactly four numeric tokens (no stray
 * characters, no extra/fewer tokens). Tokens may be separated by commas
 * and/or whitespace. This rejects noisy or malformed model output — a loose
 * number scan would happily accept `1.2.3` or `a1b2c3d4` as a spurious
 * detection.
 *
 * Returns null when the body does not match the expected format.
 */
function parseBoxBody(body: string): [number, number, number, number] | null {
  const trimmed = body.trim();
  const tokens = trimmed.split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length !== 4) return null;
  const nums = tokens.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

/** Parse <ref>label</ref><box>...</box> from model output text. */
export function parseBoxes(text: string): Detection[] {
  const out: Detection[] = [];
  const re = /<ref>([\s\S]*?)<\/ref>((?:\s*<box>[\s\S]*?<\/box>)+)/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const label = m[1].trim();
    const boxRe = /<box>([\s\S]*?)<\/box>/gi;
    let b: RegExpExecArray | null;
    while ((b = boxRe.exec(m[2])) !== null) {
      const box = parseBoxBody(b[1]);
      if (box) {
        out.push({ label, box });
      }
    }
  }

 // Bare boxes without a preceding ref
  if (out.length === 0) {
    const boxRe = /<box>([\s\S]*?)<\/box>/gi;
    let b: RegExpExecArray | null;
    while ((b = boxRe.exec(text)) !== null) {
      const box = parseBoxBody(b[1]);
      if (box) {
        out.push({ label: "", box });
      }
    }
  }

  return out;
}

/** Convert normalized 0-1000 coordinates to pixel coordinates.
 * Clamps to image bounds to prevent out-of-bounds boxes from the model
 * placing detections in the padded region of the preprocessor canvas.
 *
 * `clampWidth`/`clampHeight` (defaulting to `imageWidth`/`imageHeight`)
 * let the caller clamp to the ORIGINAL screenshot bounds rather than the
 * PADDED canvas bounds. The model normalizes over the padded canvas, so
 * `imageWidth` = `effectiveWidth` ≥ `originalWidth`. Clamping to
 * `effectiveWidth - 1` would allow coords 3-6 CSS px beyond the viewport.
 *
 * Inverted boxes (where the model emits x2 < x1 or y2 < y1) are normalized
 * to (left, top, right, bottom) before conversion so the box is anchored at
 * the correct corner instead of the smaller coordinate. */
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
 // Clamp to the ORIGINAL screenshot bounds (cw × ch), not the padded
 // canvas bounds (imageWidth × imageHeight).
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
