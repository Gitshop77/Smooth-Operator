import type { AgentAction } from "../types";
import { PageFingerprint } from "./page-fingerprint";
import { normalizeAction } from "./normalize-action";

export { normalizeAction } from "./normalize-action";

const LOOP_WINDOW_SIZE = 20;
const WARN_THRESHOLDS: readonly number[] = [5, 8, 12];
export const LOOP_TOP_THRESHOLD = WARN_THRESHOLDS[WARN_THRESHOLDS.length - 1];
const PAGE_FP_WINDOW_SIZE = 5;

/** Minimum full cycles before an alternating sequence counts as oscillation. */
const OSCILLATION_MIN_CYCLES = 2;
/** Detected oscillation periods (period-2 ping-pong and period-3 cycle). */
const OSCILLATION_PERIODS = [2, 3] as const;

export const GOAL_WARN_THRESHOLD = 3;
export const GOAL_TOP_THRESHOLD = 5;

interface ActionRecord {
  hash: string;
}

function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * True when the trailing `2*period` hashes form a strict alternating cycle of
 * `period` distinct states (A,B,A,B for period 2; A,B,C,A,B,C for period 3):
 * the hash at position `i` equals the one at `i + period` (same phase), and
 * adjacent positions differ (otherwise the sequence is a plain repeat, which
 * the exact-hash counter already handles).
 */
function isAlternatingCycle(seq: string[], period: number): boolean {
  const span = period * 2;
  if (seq.length < span) return false;
  const window = seq.slice(-span);
  for (let i = 0; i < period; i++) {
    if (window[i] !== window[i + period]) return false;
    if (window[i] === window[i + 1]) return false;
  }
  return true;
}

export class LoopDetector {
  private window: ActionRecord[] = [];
  private goalWindow: string[] = [];
  private pageFingerprints: PageFingerprint[] = [];
  private consecutiveStagnantPages = 0;
  private static readonly GOAL_WINDOW_SIZE = 6;
  private lastCount = 0;

  record(action: AgentAction, resultHead?: string): number {
    const base = normalizeAction(action);
    // Outcome-aware hashing: when the caller supplies a result-head (the
    // leading slice of the action's result message), identical outcomes from
    // slightly-rephrased calls still share a bucket — blocked or erroring
    // repeats are counted even when the call signature alternates.
    const hash = fnv1a(resultHead ? `${base}|result=${resultHead}` : base);
    this.window.push({ hash });
    if (this.window.length > LOOP_WINDOW_SIZE) {
      this.window.shift();
    }
    const count = this.window.filter((r) => r.hash === hash).length;
    this.lastCount = count;
    return count;
  }

  shouldWarn(): number {
    if (this.window.length === 0) return 0;
  // Warn on the live count once it crosses the first threshold, and keep
  // warning while it stays above — NOT only at exact milestones. Gating on
  // exact counts (5/8/12) made the warning vanish at 6-7 and 9-11 while the
  // counter climbed, then reappear (flicker).
    return this.lastCount >= WARN_THRESHOLDS[0] ? this.lastCount : 0;
  }

  /**
   * Oscillation detection — the stuck shapes an exact-repeat counter misses:
   * period-2 ping-pong (A,B,A,B) and period-3 cycles (A,B,C,A,B,C) between
   * equal-but-distinct actions. Returns the number of full cycles observed in
   * the trailing alternating run (0 when no oscillation is present).
   */
  shouldWarnOscillation(): number {
    const hashes = this.window.map((r) => r.hash);
    for (const period of OSCILLATION_PERIODS) {
      if (hashes.length < period * 2) continue;
      if (!isAlternatingCycle(hashes, period)) continue;
      // Walk back through consecutive alternating phases: position i must
      // equal i + period (same phase) and differ from i + 1 (adjacent).
      let i = hashes.length - period - 1;
      while (i >= 0) {
        if (hashes[i] !== hashes[i + period]) break;
        if (hashes[i] === hashes[i + 1]) break;
        i -= 1;
      }
      const runLength = hashes.length - (i + 1);
      const cycles = Math.floor(runLength / period);
      if (cycles >= OSCILLATION_MIN_CYCLES) return cycles;
    }
    return 0;
  }

  static oscillationWarningText(period: number, cycles: number): string {
    return `<sys>OSCILLATION DETECTED: your actions are alternating between ${period} distinct states (${cycles} full cycles) without making progress. STOP alternating and try a fundamentally different approach — a new strategy, scroll/search to discover new elements, or done(success=false) if the task is impossible.</sys>`;
  }

  static warningText(count: number): string {
    return `<sys>LOOP DETECTED: you have taken an equivalent action ${count} times in the recent window without making progress. Try a DIFFERENT approach: scroll to find new elements, switch strategy, or if truly stuck, call done(success=false) with an explanation.</sys>`;
  }

  async recordPageState(url: string, domText: string, elementCount: number): Promise<void> {
    const fp = await PageFingerprint.fromBrowserState(url, domText, elementCount);
    const last = this.pageFingerprints[this.pageFingerprints.length - 1];
    if (last && last.equals(fp)) {
      this.consecutiveStagnantPages += 1;
    } else {
      this.consecutiveStagnantPages = 0;
    }
    this.pageFingerprints.push(fp);
    if (this.pageFingerprints.length > PAGE_FP_WINDOW_SIZE) {
      this.pageFingerprints.shift();
    }
  }

  shouldWarnStagnant(): number {
  // Same non-flicker rule as `shouldWarn`: warn on the live count once it
  // crosses the first threshold, not only at exact milestones.
    return this.consecutiveStagnantPages >= WARN_THRESHOLDS[0]
      ? this.consecutiveStagnantPages
      : 0;
  }

  static stagnantWarningText(count: number): string {
    return `<sys>STAGNANT PAGE: the page content has not changed across the last ${count} consecutive snapshots. Your actions might not be having the intended effect. Try a different element, scroll to find new content, or reconsider your approach.</sys>`;
  }

  recordGoal(goal: string): number {
    const normalized = goal.toLowerCase().trim().slice(0, 200);
    this.goalWindow.push(normalized);
    if (this.goalWindow.length > LoopDetector.GOAL_WINDOW_SIZE) {
      this.goalWindow.shift();
    }
    return this.goalWindow.filter((g) => g === normalized).length;
  }

  reset(): void {
    this.window = [];
    this.goalWindow = [];
    this.pageFingerprints = [];
    this.consecutiveStagnantPages = 0;
    this.lastCount = 0;
  }
}
