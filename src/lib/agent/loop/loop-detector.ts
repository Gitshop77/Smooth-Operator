import type { AgentAction } from "../types";
import { PageFingerprint } from "./page-fingerprint";
import { normalizeAction } from "./normalize-action";

export { normalizeAction } from "./normalize-action";

const LOOP_WINDOW_SIZE = 20;
const WARN_THRESHOLDS: readonly number[] = [5, 8, 12];
export const LOOP_TOP_THRESHOLD = WARN_THRESHOLDS[WARN_THRESHOLDS.length - 1];
const PAGE_FP_WINDOW_SIZE = 5;

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

export class LoopDetector {
  private window: ActionRecord[] = [];
  private goalWindow: string[] = [];
  private pageFingerprints: PageFingerprint[] = [];
  private consecutiveStagnantPages = 0;
  private static readonly GOAL_WINDOW_SIZE = 6;
  private lastCount = 0;

  record(action: AgentAction, _step: number): number {
    const hash = fnv1a(normalizeAction(action));
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
    return WARN_THRESHOLDS.includes(this.lastCount) ? this.lastCount : 0;
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
    if (!WARN_THRESHOLDS.includes(this.consecutiveStagnantPages)) return 0;
    return this.consecutiveStagnantPages;
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
