/**
 * Run history — persists completed runs to chrome.storage.local (extension)
 * or localStorage (in-page demo). Enables transcript replay + debugging.
 *
 * Each run stores: task, start/end time, steps (LogEvents), final result,
 * token/cost totals. Runs are listed in a "History" view in the side panel.
 */

import type { LogEvent } from "./types";
import { isExtensionWithLocal } from "./runtime";

/** Persistent record of one completed (or aborted) agent run. */
export interface RunRecord {
  /** Unique id (timestamp + short random suffix). */
  id: string;
  /** Original user task. */
  task: string;
  /** Unix ms timestamp when the run started. */
  startedAt: number;
  /** Unix ms timestamp when the run ended (0 if still running). */
  endedAt: number;
  /** All LogEvents emitted during the run, in order. */
  steps: LogEvent[];
  /** Final result, or null if the run was aborted without finishing. */
  result: { success: boolean; text: string } | null;
  /** Cumulative input tokens consumed. */
  totalTokensIn: number;
  /** Cumulative output tokens consumed. */
  totalTokensOut: number;
  /** Cumulative USD cost. */
  totalCostUsd: number;
  /** Number of navigator steps executed. */
  stepCount: number;
}

/** localStorage / chrome.storage key under which runs are persisted. */
const STORAGE_KEY = "open_cowork_run_history";

/** Cap on the number of runs retained (newest first). */
const MAX_RUNS = 50;

/** Length of the random suffix appended to run IDs. */
const ID_SUFFIX_LENGTH = 6;

/**
 * Persist a run record. Prepends it to the stored list and trims to
 * {@link MAX_RUNS} entries.
 *
 * Wraps localStorage.setItem in try/catch — a QuotaExceededError (older
 * browsers / private mode) is retried after trimming the oldest entry, and
 * any remaining failure is logged + swallowed so a persistence error can't
 * crash the run.
 */
export async function saveRun(run: RunRecord): Promise<void> {
  const runs = await loadRuns();
  // defense-in-depth — redact any secret values that may have
  // leaked into action-result messages before persisting to disk. The
  // executor's `input` action redacts at the source, but this catches any
  // other path that might surface a secret value in a `message` field.
  // Also wraps the chrome.storage.local write in try/catch so a
  // quota/corruption error surfaces as a user-visible warning instead of an
  // unhandled rejection.
  const safeRun = await redactRunSecrets(run);
  runs.unshift(safeRun);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  if (isExtensionWithLocal()) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: runs });
    } catch (e) {
      // surface storage-write failures so the user knows their run
      // wasn't saved, rather than silently dropping it.
      console.warn("[run-history] chrome.storage.local.set failed:", e);
    }
    return;
  }
  // localStorage path — may throw QuotaExceededError.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      // Trim oldest (last) entry and retry once. If it still fails, log + give up.
      runs.pop();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
      } catch (e2) {
        console.warn("[run-history] localStorage quota exhausted even after trim:", e2);
      }
    } else {
      console.warn("[run-history] localStorage.setItem failed:", e);
    }
  }
}

/**
 * Walk a RunRecord's steps and redact any secret values from ALL text-bearing
 * fields across every LogEvent variant. Also redacts the run's result text.
 * Returns a shallow-cloned run with sanitized steps. Called by saveRun before
 * persistence.
 */
async function redactRunSecrets(run: RunRecord): Promise<RunRecord> {
  const { redactSecrets } = await import("./secrets");
  const textFields = ["message", "text", "reason", "question", "expectation", "evaluation", "memory", "nextGoal"] as const;
  const steps = await Promise.all(
    run.steps.map(async (event) => {
      let patched = event;
      for (const key of textFields) {
        const val = (event as Record<string, unknown>)[key];
        if (typeof val === "string") {
          const redacted = await redactSecrets(val);
          if (redacted !== val) {
            patched = { ...patched, [key]: redacted } as LogEvent;
          }
        }
      }
      return patched;
    }),
  );
  const result = run.result;
  const resultText = result?.text ?? "";
  const redactedResultText = typeof resultText === "string" ? await redactSecrets(resultText) : resultText;
  return { ...run, steps, result: result ? { success: result.success, text: redactedResultText } : null };
}

/**
 * Load all stored run records (newest first).
 * Returns an empty array if storage is empty or unreadable.
 */
export async function loadRuns(): Promise<RunRecord[]> {
  if (isExtensionWithLocal()) {
    const res = await chrome.storage.local.get(STORAGE_KEY);
    return (res[STORAGE_KEY] as RunRecord[]) || [];
  }
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as RunRecord[];
  } catch {
    return [];
  }
}

/**
 * Incremental builder for a RunRecord.
 *
 * Accumulates events as the run progresses and tallies cost/token totals
 * so the orchestrator doesn't have to track them separately. Call
 * {@link RunBuilder.finish} to seal the record.
 */
export class RunBuilder {
  private run: RunRecord;
  /** Captured from the last `done` LogEvent — used by finish() as the real result. */
  private capturedResult: { success: boolean; text: string } | null = null;

  /**
   * @param task Original user task (used as the run's title).
   */
  constructor(task: string) {
    // Pad the random suffix to ID_SUFFIX_LENGTH chars — `Math.random().toString(36)`
    // can produce a leading `0.` segment shorter than ID_SUFFIX_LENGTH when the
    // mantissa happens to end in zeros, which would yield a run id like
    // `1719…-0` (1-char suffix) and risk collisions.
    const rand = Math.random().toString(36).slice(2, 2 + ID_SUFFIX_LENGTH).padEnd(ID_SUFFIX_LENGTH, "0");
    this.run = {
      id: `${Date.now()}-${rand}`,
      task,
      startedAt: Date.now(),
      endedAt: 0,
      steps: [],
      result: null,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
      stepCount: 0,
    };
  }

  /**
   * Append a LogEvent and update cumulative totals.
   * - `cost` events add to token + USD totals.
   * - `navigator-step-start` events bump the step counter to
   *   `Math.max(stepCount, event.step + 1)` — the +1 accounts for the
   *   0-indexed step number (a `navigator-step-start` at step 0 means 1 step
   *   has executed, not 0).
   */
  addEvent(event: LogEvent): void {
    this.run.steps.push(event);
    if (event.type === "cost") {
      this.run.totalTokensIn += event.tokensIn;
      this.run.totalTokensOut += event.tokensOut;
      this.run.totalCostUsd += event.costUsd;
    }
    if (event.type === "navigator-step-start") {
      this.run.stepCount = Math.max(this.run.stepCount, event.step + 1);
    }
    // Capture the last `done` event so finish() can use the real result
    // instead of a hardcoded default. Without this, every run shows as
    // "failed" in the History tab because agent-bridge.ts passes a
    // conservative default to finish().
    if (event.type === "done") {
      this.capturedResult = { success: event.success, text: event.text };
    }
  }

  /** Seal the record with the final result + end timestamp.
   *
   * Idempotent — a second `finish()` call is a no-op (the original result +
   * timestamp are preserved). Guards against double-finish when the
   * orchestrator's terminal-event path fires twice (e.g. an uncaught throw
   * followed by the run-loop's own finally block). */
  finish(result: { success: boolean; text: string }): RunRecord {
    if (this.run.endedAt !== 0) {
      // Already finished — return the sealed record as-is.
      return this.run;
    }
    this.run.endedAt = Date.now();
    // Use the captured `done` event's result if available (the real outcome);
    // fall back to the caller's default (which may be a conservative "false").
    this.run.result = this.capturedResult ?? result;
    return this.run;
  }

  /** The run's unique id. */
  get id(): string {
    return this.run.id;
  }
}

