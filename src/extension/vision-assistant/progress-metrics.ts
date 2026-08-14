/**
 * Vision Assistant — pure download-progress metrics.
 *
 * Small, dependency-free helpers for the model-download UX (the ~649 MB,
 * multi-file Local Vision download): a rolling-window transfer-rate/ETA tracker, a
 * monotonic global-percent helper, and a percentage/time emission throttle.
 *
 * Everything here is deliberately pure (the tracker/throttle keep their state
 * in closure) so the math is unit-testable WITHOUT chrome/fetch/Cache Storage
 * — see tests/vision-download-progress.test.ts. The non-pure download
 * machinery (model-loader.ts / model-loader-utils.ts) calls in with wall-clock
 * timestamps from `nowMs()`.
 */

/** Monotonic millisecond clock (performance.now where available, else Date.now). */
export function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export interface ProgressSample {
  tMs: number;
  bytesDone: number;
}

export interface ProgressMetrics {
  /** Rolling transfer rate across the retained window, in bytes/second. */
  speedBytesPerSec?: number;
  /** Estimated seconds remaining for the whole set; only when speed > 0. */
  etaSeconds?: number;
}

export interface ProgressTracker {
  /** Record a cumulative byte count at a wall-clock time (monotonic per set). */
  record(bytesDone: number, nowMs: number): void;
  /** Current rolling speed + ETA over the retained window. */
  get(): ProgressMetrics;
  /**
   * Update the total the ETA is computed against. The bytesTotal for the whole
   * pending set is a best-effort estimate that refines as each file's probe
   * (Content-Range) reveals its exact size, so the tracker's total must be
   * adjustable rather than frozen at construction.
   */
  setTotalBytes(bytes: number): void;
}

/**
 * Rolling-window transfer-rate tracker.
 *
 * Keeps the last `maxSamples` (default 8) `{tMs, bytesDone}` samples; speed is
 * the derivative across the retained window (first sample ↔ last sample), ETA
 * is `(total - bytesDone) / speed`. No speed until ≥2 samples exist with a
 * positive time delta AND positive byte movement; no ETA when speed ≤ 0 or
 * nothing remains. Samples age out (oldest dropped) once the window fills, so
 * the rate reflects roughly the last ~1 s of activity instead of the whole
 * download.
 */
export function createProgressTracker(totalBytes: number, maxSamples = 8): ProgressTracker {
  let total = totalBytes > 0 ? totalBytes : 0;
  const samples: ProgressSample[] = [];
  const push = (s: ProgressSample): void => {
    samples.push(s);
    if (samples.length > maxSamples) samples.shift();
  };
  return {
    record(bytesDone: number, tMs: number): void {
      push({ tMs, bytesDone });
    },
    setTotalBytes(bytes: number): void {
      if (bytes > 0) total = bytes;
    },
    get(): ProgressMetrics {
      if (samples.length < 2) return {};
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dtSec = (last.tMs - first.tMs) / 1000;
      const dBytes = last.bytesDone - first.bytesDone;
      if (!(dtSec > 0) || !(dBytes > 0)) return {};
      const speedBytesPerSec = dBytes / dtSec;
      // Clamp remaining at 0 so a fully-downloaded set reports ETA 0, never a
      // negative (impossible) duration.
      const remaining = Math.max(0, total - last.bytesDone);
      const etaSeconds = remaining / speedBytesPerSec;
      return { speedBytesPerSec, etaSeconds };
    },
  };
}

/**
 * Monotonic global percent across the whole pending file set.
 *
 * The download bar must never move backwards. The bytesTotal estimate can GROW
 * mid-flight (a newly-probed file's real size may exceed the 300 MB fallback),
 * which would otherwise make `floor(bytesDone / bytesTotal * 100)` dip. We
 * clamp to the previous emitted value and only allow forward movement. The
 * final event still reaches 100 because bytesTotal is exact (every file
 * probed) by the time all downloads complete.
 */
export function nextGlobalPercent(bytesDone: number, bytesTotal: number, prevPercent: number): number {
  if (!(bytesTotal > 0)) return prevPercent;
  const pct = Math.floor((bytesDone / bytesTotal) * 100);
  return Math.min(100, Math.max(prevPercent, pct));
}

export interface ProgressThrottle {
  /**
   * True when an emission is due: `minPointStep` percentage points of progress
   * since the last emit, OR `minIntervalMs` elapsed — whichever comes first.
   * State advances on every true return.
   */
  shouldEmit(percent: number, tMs: number): boolean;
}

/**
 * Percentage/time emission throttle — "at most every ~1 percentage point OR
 * every ~400 ms, whichever comes first".
 *
 * Replaces the old fixed 10-percentage-point granularity: a slow full-file GET
 * (raw stream reads that advance the percent by fractions of a point) now
 * still ticks the bar every ~400 ms, while a fast chunked download emits at
 * most once per percentage point. Identical percent values are never re-emitted
 * faster than the interval (a pure time tick repeats the CURRENT percent, so a
 * stalled-but-alive stream still heartbeats).
 */
export function createProgressThrottle(minPointStep = 1, minIntervalMs = 400): ProgressThrottle {
  let lastPercent = -Infinity; // never emitted yet
  let lastEmitMs = -Infinity;
  return {
    shouldEmit(percent: number, tMs: number): boolean {
      const pointDue = percent >= lastPercent + minPointStep;
      const timeDue = tMs - lastEmitMs >= minIntervalMs;
      if (!pointDue && !timeDue) return false;
      if (percent === lastPercent && tMs - lastEmitMs < minIntervalMs) return false;
      lastPercent = percent;
      lastEmitMs = tMs;
      return true;
    },
  };
}
