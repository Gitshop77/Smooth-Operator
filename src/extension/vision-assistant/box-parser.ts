/**
 * Vision Assistant — box parser.
 *
 * Parses LocateAnything's text output (<ref>label</ref><box>x1,y1,x2,y2</box>)
 * into structured Detection objects with pixel coordinates.
 */

import type { Detection, PixelDetection } from "./types";

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
      const nums = (b[1].match(/-?\d+\.?\d*/g) || []).map(Number);
      if (nums.length === 4) {
        out.push({ label, box: [nums[0], nums[1], nums[2], nums[3]] });
      }
    }
  }

  // Bare boxes without a preceding ref
  if (out.length === 0) {
    const boxRe = /<box>([\s\S]*?)<\/box>/gi;
    let b: RegExpExecArray | null;
    while ((b = boxRe.exec(text)) !== null) {
      const nums = (b[1].match(/-?\d+\.?\d*/g) || []).map(Number);
      if (nums.length === 4) {
        out.push({ label: "", box: [nums[0], nums[1], nums[2], nums[3]] });
      }
    }
  }

  return out;
}

/** Convert normalized 0-1000 coordinates to pixel coordinates.
 *  Clamps to image bounds to prevent out-of-bounds boxes from the model
 *  placing detections in the padded region of the preprocessor canvas.
 *
 *  `clampWidth`/`clampHeight` (defaulting to `imageWidth`/`imageHeight`)
 *  let the caller clamp to the ORIGINAL screenshot bounds rather than the
 *  PADDED canvas bounds. The model normalizes over the padded canvas, so
 *  `imageWidth` = `effectiveWidth` ≥ `originalWidth`. Clamping to
 *  `effectiveWidth - 1` would allow coords 3-6 CSS px beyond the viewport. */
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
    const [x1, y1, x2, y2] = d.box;
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
