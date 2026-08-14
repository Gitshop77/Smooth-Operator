/**
 * Vision Assistant — type definitions.
 */

/** A raw detection from LFM2.5-VL (normalized 0-1000 coordinates). */
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

/**
 * Download progress callback.
 *
 * `file`/`downloaded`/`total`/`percent` are the per-file primitives and stay
 * REQUIRED (backward compatible — existing consumers only read those). The
 * aggregate fields below are OPTIONAL at the type level because the low-level
 * per-file emitter (`fetchBufProgress`) only knows about the single file it is
 * downloading and must keep its event shape stable. `ModelLoader.downloadAll`
 * is the ONLY place that constructs fully-enriched events: it wraps the
 * callback and populates every aggregate field on each event it emits, so UI
 * consumers of the downloadAll path always receive them.
 */
export interface DownloadProgress {
  file: string;
  downloaded: number;
  total: number;
  percent: number;
  /** 1-based position of `file` within the pending download set; 0 on set-level events. */
  fileIndex?: number;
  /** Size of the pending download set. */
  totalFiles?: number;
  /** 0-100 across ALL pending files. Monotonic — the bar never moves backwards (see progress-metrics.ts). */
  globalPercent?: number;
  /** Aggregate bytes received across all files so far. */
  bytesDone?: number;
  /** Aggregate total of the whole pending set (best-effort estimate; exact once every file is probed). */
  bytesTotal?: number;
  /** Rolling transfer rate across all files, bytes/second. */
  speedBytesPerSec?: number;
  /** Estimated seconds remaining for the whole set; present only when speed > 0. */
  etaSeconds?: number;
  /** Human-readable log line for this event (start / per-file completion / ~5s aggregate / all-done). */
  message?: string;
}

/** Status change callback. */
export type StatusCallback = (status: VisionStatus, message?: string) => void;

// Note: `MergedElement` is intentionally NOT defined here — it lives in
// `merger.ts` (where it `extends ExtractedElement` and carries the extra
// `source` / `pixelRect` / `indexStr` / `visionId` fields the merger needs).
// A duplicate definition here would diverge from the real interface if either
// file changed.
