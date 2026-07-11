/**
 * Loop detector — detects when the agent repeats the same action (with the
 * same params) too many times in a rolling window, so the orchestrator can
 * inject a "try a different approach" nudge.
 *
 * Uses a fast FNV-1a hash of action name + normalized params. We don't need
 * cryptographic strength here — just stable, collision-resistant bucketing
 * for the short rolling window.
 *
 * The rolling window keeps the last {@link LOOP_WINDOW_SIZE} actions. When
 * the count of equivalent actions hits one of {@link WARN_THRESHOLDS}, the
 * orchestrator emits a `loop-warning` event so the UI can surface it.
 *
 * In addition to action repetition, the detector also tracks page
 * fingerprints (SHA-256 of DOM text + URL + element count). When the page
 * state hasn't changed across 5+ consecutive
 * actions, the detector emits a "stagnant page" nudge — the agent's actions
 * aren't having any visible effect, so a different element or strategy is
 * needed. This catches a class of loops that action-hash detection misses
 * (e.g. the agent alternates between two different scroll directions but
 * the page is at the bottom and doesn't move either way).
 */

import type { AgentAction } from "../types";

/** Max actions kept in the rolling window. */
const LOOP_WINDOW_SIZE = 20;
/** Repetition counts that trigger a warning (escalating severity). */
const WARN_THRESHOLDS = [5, 8, 12] as const;
/** Max page fingerprints kept in the rolling window. */
const PAGE_FP_WINDOW_SIZE = 5;
/** Threshold milestones for stagnant-page warnings (matches WARN_THRESHOLDS). */
const STAGNANT_THRESHOLDS: readonly number[] = [5, 8, 12];

/**
 * Goal-level loop detection: warn when the same goal appears this many times
 * in the recent window (the planner is stuck re-assigning the same goal).
 *
 * Exported so callers (e.g. planner-phases.ts) can reuse the SAME
 * constant instead of hard-coding a divergent literal.
 */
export const GOAL_WARN_THRESHOLD = 3;

/** A single recorded action with its normalized hash. */
interface ActionRecord {
  /** FNV-1a hash of the normalized action signature. */
  hash: string;
  /** Step number the action was recorded at. */
  step: number;
}

/**
 * Compute the SHA-256 hash of a string and return it as a hex string.
 *
 * Uses the Web Crypto API (`crypto.subtle.digest`) — available in MV3
 * service workers, content scripts, and modern browsers. The async nature
 * is why {@link PageFingerprint.fromBrowserState} and
 * {@link LoopDetector.recordPageState} are async.
 */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A page fingerprint — identifies a unique page state for stagnation
 * detection. Two states with the same URL, element count, and DOM-text hash
 * are considered identical (the agent's actions had no visible effect).
 *
 * The DOM-text hash is the first 16 hex chars of `SHA-256(domText)` — short
 * enough to store cheaply in a small rolling window, long enough that
 * collisions on realistic DOM sizes are vanishingly unlikely
 * (16 hex chars = 64 bits ≈ 1.8e19 buckets).
 */
export class PageFingerprint {
  constructor(
    public readonly url: string,
    public readonly elementCount: number,
    public readonly textHash: string,
  ) {}

  /**
   * Build a fingerprint from a raw browser-state snapshot. The DOM text is
   * hashed with SHA-256 (truncated to 16 hex chars) so the fingerprint is
   * cheap to store and compare.
   */
  static async fromBrowserState(
    url: string,
    domText: string,
    elementCount: number,
  ): Promise<PageFingerprint> {
    const fullHash = await sha256Hex(domText);
    return new PageFingerprint(url, elementCount, fullHash.slice(0, 16));
  }

  /** Two fingerprints are equal iff all three components match. */
  equals(other: PageFingerprint): boolean {
    return (
      this.url === other.url &&
      this.elementCount === other.elementCount &&
      this.textHash === other.textHash
    );
  }
}

/**
 * Normalize an action's params so semantically-equivalent actions hash the
 * same. E.g. `{type:"scroll", down:true, pages:1}` === `{type:"scroll"}`.
 * Only the params that distinguish the action's effect on the page are
 * included — pure cosmetic defaults are dropped.
 */
function normalizeAction(action: AgentAction): string {
  const a = action as Record<string, unknown>;
  const parts: string[] = [a.type as string];
  switch (a.type) {
    case "click":
    case "hover":
    case "dropdown_options":
    case "upload_file":
      parts.push(`idx=${a.index}`);
      break;
    case "input":
      parts.push(`idx=${a.index}`, `text=${a.text}`);
      break;
    case "select_dropdown":
      parts.push(`idx=${a.index}`, `text=${a.text}`, `optidx=${a.option_index ?? -1}`);
      break;
    case "press_and_hold":
      parts.push(`idx=${a.index}`, `hold=${a.hold_ms ?? 1500}`);
      break;
    case "scroll":
      parts.push(`dir=${a.down === false ? "up" : "down"}`, `pages=${a.pages ?? 1}`);
      break;
    case "send_keys":
      parts.push(`keys=${a.keys}`);
      break;
    case "navigate":
      parts.push(`url=${a.url}`);
      break;
    case "switch_tab":
    case "close_tab":
      parts.push(`tab=${a.tab_id}`);
      break;
    case "find_text":
      parts.push(`text=${a.text}`);
      break;
    case "extract":
    case "search":
      parts.push(`query=${a.query}`);
      break;
    case "search_page":
      parts.push(`pattern=${a.pattern}`);
      break;
    case "find_elements":
      parts.push(`selector=${a.selector}`);
      break;
    case "evaluate":
      parts.push(`code=${a.code}`);
      break;
    case "ask_human":
      parts.push(`question=${a.question}`);
      break;
    case "takeover":
      parts.push(`reason=${a.reason}`);
      break;
    case "verify":
      parts.push(`expectation=${a.expectation}`);
      break;
    case "load_skill":
      parts.push(`name=${a.name}`);
      break;
    case "alert_send_keys":
      parts.push(`text=${a.text}`);
      break;
    // Normalize the remaining parametrized actions so semantically-different
    // invocations hash differently. Without these, `detect_visual` with
    // different queries, `screenshot`/`save_as_pdf` with different filenames,
    // and `alert_accept`/`alert_dismiss` all hash the same → false-positive
    // loop warnings.
    case "detect_visual":
      parts.push(`query=${a.query}`);
      break;
    case "screenshot":
      parts.push(`file=${a.fileName ?? ""}`);
      break;
    case "save_as_pdf":
      parts.push(`file=${a.fileName ?? ""}`);
      break;
    // No-params actions (verified against schema.ts): wait, go_back, done,
    // alert_accept, alert_dismiss, alert_get_text. `load_url` is intentionally
    // absent — the schema has no such action (navigate covers URL loading).
  }
  return parts.join("|");
}

/** FNV-1a 32-bit offset basis + prime. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Fast FNV-1a 32-bit hash (returns an 8-char hex string). */
function fnv1a(s: string): string {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(16);
}

/**
 * Loop detector — keeps a rolling window of recent actions and surfaces
 * warnings when an equivalent action repeats too often. Also tracks page
 * fingerprints to detect when the agent's actions aren't changing the page.
 */
export class LoopDetector {
  private window: ActionRecord[] = [];
  /** Track recent goals for goal-level loop detection. */
  private goalWindow: string[] = [];
  /** Recent page fingerprints (last {@link PAGE_FP_WINDOW_SIZE}). */
  private pageFingerprints: PageFingerprint[] = [];
  /** How many consecutive page snapshots have been identical to the previous one. */
  private consecutiveStagnantPages = 0;
  private static readonly GOAL_WINDOW_SIZE = 6;

  /**
   * Record an action and return how many times it (or an equivalent) has
   * occurred in the rolling window (including this one).
   */
  record(action: AgentAction, step: number): number {
    const hash = fnv1a(normalizeAction(action));
    this.window.push({ hash, step });
    if (this.window.length > LOOP_WINDOW_SIZE) {
      this.window.shift();
    }
    return this.window.filter((r) => r.hash === hash).length;
  }

  /**
   * Decide whether to inject a loop-warning nudge. Returns the repetition
   * count if it matches one of {@link WARN_THRESHOLDS}, else `0`.
   */
  shouldWarn(): number {
    if (this.window.length === 0) return 0;
    const last = this.window[this.window.length - 1];
    const count = this.window.filter((r) => r.hash === last.hash).length;
    if ((WARN_THRESHOLDS as readonly number[]).includes(count)) return count;
    return 0;
  }

  /** Build the warning nudge text shown to the LLM. */
  static warningText(count: number): string {
    return `<sys>LOOP DETECTED: you have taken an equivalent action ${count} times in the recent window without making progress. Try a DIFFERENT approach: scroll to find new elements, switch strategy, or if truly stuck, call done(success=false) with an explanation.</sys>`;
  }

  /**
   * Record a page-state snapshot for stagnation detection. The DOM text is
   * hashed with SHA-256; if the resulting fingerprint matches the previous
   * one, the stagnant counter increments.
   *
   * Async because SHA-256 uses the Web Crypto API (`crypto.subtle.digest`).
   * Callers in the agent loop should `await` this after each
   * `extractBrowserState` call.
   */
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

  /**
   * Decide whether to inject a stagnant-page nudge. Returns the consecutive
   * stagnant count if it has reached a threshold milestone, else `0`.
   */
  shouldWarnStagnant(): number {
    // Use threshold matching (like shouldWarn) so the warning fires only at
    // specific count milestones, not on every step after the threshold.
    if (!STAGNANT_THRESHOLDS.includes(this.consecutiveStagnantPages)) return 0;
    return this.consecutiveStagnantPages;
  }

  /** Build the stagnant-page nudge text shown to the LLM. */
  static stagnantWarningText(count: number): string {
    return `<sys>STAGNANT PAGE: the page content has not changed across ${count} consecutive actions. Your actions might not be having the intended effect. Try a different element, scroll to find new content, or reconsider your approach.</sys>`;
  }

  /**
   * Record a goal for goal-level loop detection. If the same goal
   * appears GOAL_WARN_THRESHOLD times in the recent window, the planner
   * is stuck re-assigning the same goal.
   */
  recordGoal(goal: string): number {
    // Normalize: lowercase + trim for comparison
    const normalized = goal.toLowerCase().trim().slice(0, 200);
    this.goalWindow.push(normalized);
    if (this.goalWindow.length > LoopDetector.GOAL_WINDOW_SIZE) {
      this.goalWindow.shift();
    }
    return this.goalWindow.filter((g) => g === normalized).length;
  }

  /** Reset the rolling window (e.g. after a successful navigation). */
  reset(): void {
    this.window = [];
    this.goalWindow = [];
    this.pageFingerprints = [];
    this.consecutiveStagnantPages = 0;
  }
}
