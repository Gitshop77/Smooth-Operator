/**
 * background/screenshot-policy.ts — single source of truth for the capture →
 * annotation screenshot settings.
 *
 * Previously the capture path used `getScreenshotQuality()` (CDP JPEG quality,
 * 0-100) while the annotator re-encoded at a fixed 0.85 with a hard-coded
 * 1800px cap, so a configured quality/dimension silently drifted away from the
 * capture. `resolveScreenshotPolicy()` hands both values to every consumer:
 * - `quality` — the CDP JPEG quality (0-100) used for `Page.captureScreenshot`.
 *   The annotator divides by 100 at the call site because `canvasToDataUrl`
 *   takes 0-1.
 * - `annotateMaxDimension` — the cap applied when the annotator re-encodes.
 *   `getScreenshotMaxDimension()` returns 0 for "keep full viewport", which
 *   would DISABLE the annotator's historical 1800px cap; `|| 1800` keeps the
 *   cap on by default so annotation output stays bounded (and the downstream
 *   normalize step becomes a true no-op for the annotation path).
 */

import { getScreenshotQuality, getScreenshotMaxDimension } from "./tab-manager-utils";

export interface ScreenshotPolicy {
  /** CDP JPEG quality 0-100 (`Page.captureScreenshot`). */
  quality: number;
  /** Long-edge cap (CSS px) applied when the annotator re-encodes. */
  annotateMaxDimension: number;
}

export async function resolveScreenshotPolicy(): Promise<ScreenshotPolicy> {
  const quality = await getScreenshotQuality();
  const maxDimension = await getScreenshotMaxDimension();
  return { quality, annotateMaxDimension: maxDimension || 1800 };
}