/**
 * Vision memory watchdog — JS-heap growth sampling around inference.
 *
 * Samples Chrome's JS heap (`performance.memory`) across detection runs and
 * warns when the heap sustains growth past a threshold. `navigator.deviceMemory`
 * is NOT used: it is a per-device constant and cannot detect growth.
 * `performance.memory` is Chrome-specific and may be absent (Firefox, some
 * headless modes) — `readMemoryInfo()` returns null then and the watchdog
 * no-ops.
 *
 * The warning path mirrors the existing vision-assistant architecture: the
 * assistant surfaces it via the status callback, and the module-level notice
 * registry carries it to the background service-worker watchdog, which owns
 * the side-panel message bus (AGENT_EVENT). See background/watchdog.ts.
 */

export interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface MemoryWarning {
  kind: "memory-growth";
  message: string;
  growthMb: number;
  baselineMb: number;
  currentMb: number;
}

export interface MemoryWatchdogOptions {
  /** Heap growth in MB above baseline that counts toward a warning. */
  growthThresholdMb?: number;
  /** Consecutive above-threshold samples required before warning. */
  consecutiveRequired?: number;
}

const DEFAULT_GROWTH_THRESHOLD_MB = 200;
const DEFAULT_CONSECUTIVE_REQUIRED = 3;

/** Read Chrome's JS-heap metric; null when absent or malformed. */
export function readMemoryInfo(): MemoryInfo | null {
  const m = (performance as unknown as { memory?: MemoryInfo }).memory;
  if (
    !m ||
    !Number.isFinite(m.usedJSHeapSize) ||
    !Number.isFinite(m.totalJSHeapSize) ||
    !Number.isFinite(m.jsHeapSizeLimit)
  ) {
    return null;
  }
  return m;
}

export class MemoryWatchdog {
  private readonly thresholdMb: number;
  private readonly consecutiveRequired: number;
  private baselineMb: number | null = null;
  private currentMb = 0;
  private consecutiveAbove = 0;
  private warned = false;

  constructor(opts: MemoryWatchdogOptions = {}) {
    this.thresholdMb = opts.growthThresholdMb ?? DEFAULT_GROWTH_THRESHOLD_MB;
    this.consecutiveRequired = opts.consecutiveRequired ?? DEFAULT_CONSECUTIVE_REQUIRED;
  }

  /**
   * Feed one heap sample. Returns a warning when the heap has sustained growth
   * past the threshold for `consecutiveRequired` samples. Warnings fire once
   * per episode; `reset()` ends the episode and rebaselines.
   */
  record(sample: MemoryInfo): MemoryWarning | null {
    this.currentMb = Math.round(sample.usedJSHeapSize / 1048576);
    if (this.baselineMb === null) this.baselineMb = this.currentMb;
    const growthMb = this.currentMb - this.baselineMb;
    if (growthMb > this.thresholdMb) {
      this.consecutiveAbove++;
      if (!this.warned && this.consecutiveAbove >= this.consecutiveRequired) {
        this.warned = true;
        return {
          kind: "memory-growth",
          message:
            `Vision model memory grew ${growthMb}MB above baseline ` +
            `(${this.baselineMb}MB → ${this.currentMb}MB). Consider disabling Local Vision or restarting the extension.`,
          growthMb,
          baselineMb: this.baselineMb,
          currentMb: this.currentMb,
        };
      }
    } else {
      this.consecutiveAbove = 0;
    }
    return null;
  }

  /** End the current warning episode; the next sample rebaselines. */
  reset(): void {
    this.baselineMb = null;
    this.consecutiveAbove = 0;
    this.warned = false;
  }

  state(): { growthMb: number; baselineMb: number | null; currentMb: number; warned: boolean } {
    return {
      growthMb: this.baselineMb === null ? 0 : this.currentMb - this.baselineMb,
      baselineMb: this.baselineMb,
      currentMb: this.currentMb,
      warned: this.warned,
    };
  }
}

// ─── Notice registry ────────────────────────────────────────────────────────
// Bridges the vision assistant (which runs the watchdog inside inference) and
// the background SW watchdog (which owns the side-panel message bus). The
// assistant pushes; the SW watchdog consumes on its interval.
const pendingWarnings: MemoryWarning[] = [];

export function pushMemoryWarning(warning: MemoryWarning): void {
  pendingWarnings.push(warning);
}

export function consumeMemoryWarning(): MemoryWarning | null {
  return pendingWarnings.shift() ?? null;
}
