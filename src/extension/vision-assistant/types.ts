/**
 * Vision Assistant — type definitions.
 */

/** A raw detection from LocateAnything (normalized 0-1000 coordinates). */
export interface Detection {
  label: string;
  box: [x1: number, y1: number, x2: number, y2: number]; // normalized 0-1000
}

/** A detection with pixel coordinates resolved to the screenshot size. */
export interface PixelDetection extends Detection {
  pixelBox: { x: number; y: number; width: number; height: number };
}

/** Vision assistant status. */
export type VisionStatus = "uninitialized" | "checking" | "downloading" | "compiling" | "ready" | "warning" | "error";

/** Download progress callback. */
export interface DownloadProgress {
  file: string;
  downloaded: number;
  total: number;
  percent: number;
}

/** Status change callback. */
export type StatusCallback = (status: VisionStatus, message?: string) => void;

// Note: `MergedElement` is intentionally NOT defined here — it lives in
// `merger.ts` (where it `extends ExtractedElement` and carries the extra
// `source` / `pixelRect` / `indexStr` / `visionId` fields the merger needs).
// A duplicate definition here would diverge from the real interface if either
// file changed.
