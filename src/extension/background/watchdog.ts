/**
 * Service-worker watchdog — event-loop stall detection + vision memory
 * correlation, surfaced into the side panel via the existing AGENT_EVENT bus.
 *
 * MV3: the interval dies with the SW and restarts on wake (it is armed at
 * module load in index.ts). OS sleep/suspend is distinguished from a real
 * stall by drift magnitude: a gap beyond `maxReportableDriftMs` is suppressed
 * and primes a short quiet window, mirroring the camofox watchdog semantics
 * (lib/reporter.js startWatchdog).
 */

import { consumeMemoryWarning } from "../vision-assistant/memory-watchdog";

export interface StallNotice {
  kind: "stall";
  message: string;
  driftMs: number;
  thresholdMs: number;
}

export interface SwWatchdogOptions {
  /** How often the watchdog checks (also the expected gap between ticks). */
  checkIntervalMs?: number;
  /** Drift beyond this (after subtracting the expected gap) is a stall. */
  stallThresholdMs?: number;
  /** A drift beyond this is OS sleep/suspend, not a bug — suppress it. */
  maxReportableDriftMs?: number;
  /** Ticks to stay quiet after a sleep/suspend gap (post-wake jitter). */
  suppressTicks?: number;
}

export class SwWatchdog {
  readonly checkIntervalMs: number;
  private readonly stallThresholdMs: number;
  private readonly maxReportableDriftMs: number;
  private readonly suppressTicks: number;
  private suppressTicksRemaining = 0;
  private lastTick: number | null = null;

  constructor(opts: SwWatchdogOptions = {}) {
    this.checkIntervalMs = opts.checkIntervalMs ?? 5000;
    this.stallThresholdMs = opts.stallThresholdMs ?? 5000;
    this.maxReportableDriftMs = opts.maxReportableDriftMs ?? 60_000;
    this.suppressTicks = opts.suppressTicks ?? 5;
  }

  /**
   * Feed one wall-clock tick. Returns a stall notice when the event loop
   * blocked past the stall threshold (and the gap is not OS sleep).
   */
  tick(now: number): StallNotice | null {
    if (this.lastTick === null) {
      this.lastTick = now;
      return null;
    }
    const drift = now - this.lastTick - this.checkIntervalMs;
    this.lastTick = now;
    if (drift > this.maxReportableDriftMs) {
      this.suppressTicksRemaining = this.suppressTicks;
      return null;
    }
    if (this.suppressTicksRemaining > 0) {
      this.suppressTicksRemaining--;
      return null;
    }
    if (drift <= this.stallThresholdMs) return null;
    return {
      kind: "stall",
      message:
        `Service worker event loop stalled for ${Math.round(drift / 1000)}s ` +
        `(threshold ${Math.round(this.stallThresholdMs / 1000)}s).`,
      driftMs: drift,
      thresholdMs: this.stallThresholdMs,
    };
  }
}

/**
 * Decide what to surface this cycle: a stall first, then any pending
 * vision-model memory warning (P4 correlation — a one-line read of the
 * vision assistant's exported registry).
 */
export function runWatchdogCycle(wd: SwWatchdog, now: number): string | null {
  const stall = wd.tick(now);
  if (stall) return stall.message;
  const memoryWarning = consumeMemoryWarning();
  return memoryWarning ? memoryWarning.message : null;
}

// ─── SW lifecycle wiring ────────────────────────────────────────────────────

let watchdog: SwWatchdog | null = null;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;

/** Arm the interval watchdog. Idempotent — re-entry is a no-op. */
export function startSwWatchdog(opts: SwWatchdogOptions = {}): void {
  if (watchdogInterval) return;
  watchdog = new SwWatchdog(opts);
  const wd = watchdog;
  watchdogInterval = setInterval(() => {
    const message = runWatchdogCycle(wd, Date.now());
    if (message) emitNotice(message);
  }, wd.checkIntervalMs);
  // Never keep the process alive just for the watchdog (matters for tooling
  // and tests; the real SW is kept alive by Chrome, not by this timer).
  if (typeof watchdogInterval.unref === "function") watchdogInterval.unref();
}

/** Tear the interval down (used by tests and on explicit shutdown paths). */
export function stopSwWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  watchdog = null;
}

function emitNotice(message: string): void {
  try {
    chrome.runtime
      .sendMessage({
        type: "AGENT_EVENT",
        event: { type: "warn", message },
        time: new Date().toTimeString().slice(0, 8),
      })
      .catch(() => {
        /* side panel may be closed — non-fatal */
      });
  } catch {
    /* chrome.runtime unavailable during teardown */
  }
}
