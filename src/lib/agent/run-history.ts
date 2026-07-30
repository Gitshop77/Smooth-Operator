/**
 * Run history — persists completed runs to chrome.storage.local (extension)
 * or localStorage (in-page demo). Enables transcript replay + debugging.
 *
 * Each run stores: task, start/end time, steps (LogEvents), final result,
 * token/cost totals. Runs are listed in a "History" view in the side panel.
 */

import type { LogEvent } from "./types";
import { isExtensionWithLocal } from "./runtime";
import { redactSecrets } from "./secrets";

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
  /** Number of LogEvents dropped from `steps` once it exceeded the cap. */
  overflowCount: number;
}

/** localStorage / chrome.storage key under which runs are persisted. */
const STORAGE_KEY = "open_cowork_run_history";

/** Cap on the number of runs retained (newest first). */
const MAX_RUNS = 50;

/** Run entries older than this are silently dropped on load. */
const RUN_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Length of the random suffix appended to run IDs. */
const ID_SUFFIX_LENGTH = 6;

/** Maximum number of LogEvents retained per run (oldest are dropped past this). */
const MAX_STEPS = 2000;

/**
 * Validate a single loaded history entry. A corrupt/partial record (written by
 * another extension under the same key, or truncated by a crashed write) must
 * not be returned to callers that assume `steps` is an array — they would throw
 * on `.unshift` / `.map`. Returns `true` only for shape-complete records.
 */
function isValidRunRecord(v: unknown): v is RunRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.task === "string" &&
    typeof r.startedAt === "number" &&
    Array.isArray(r.steps)
  );
}

/** Persist the run list to localStorage as a single JSON string. */
function writeLocalStorage(runs: RunRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

/**
 * Coerce optional numeric history fields to `0` so a partial/corrupt record
 * that passed {@link isValidRunRecord} can't surface `undefined`/`NaN` in the
 * History UI. Does NOT reject records — history is preserved.
 */
function normalizeRunRecord(r: RunRecord): RunRecord {
  return {
    ...r,
    totalTokensIn: r.totalTokensIn ?? 0,
    totalTokensOut: r.totalTokensOut ?? 0,
    totalCostUsd: r.totalCostUsd ?? 0,
    stepCount: r.stepCount ?? 0,
    overflowCount: r.overflowCount ?? 0,
    endedAt: r.endedAt ?? 0,
 // Coerce a corrupt/non-conforming `result` to null so a truthy but
 // partial value can't propagate `success: undefined` to the History UI.
    result:
      r.result &&
      typeof r.result === "object" &&
      "success" in r.result &&
      "text" in r.result
        ? r.result
        : null,
  };
}

/**
 * Serialize all `saveRun` calls through a single promise chain so concurrent
 * saves (e.g. a side-panel re-save racing the normal finish) cannot clobber
 * each other's `loadRuns → unshift → set` sequence. Without this, two
 * near-simultaneous saves each read the pre-write list and the loser's write
 * drops a run from history. The chain preserves RMW ordering: each queued save
 * awaits the previous one before it reads the now-updated list.
 */
let saveChain: Promise<void> = Promise.resolve();

/**
 * Persist a run record. Prepends it to the stored list and trims to
 * {@link MAX_RUNS} entries.
 *
 * Wraps the entire load→redact→write sequence so a storage read OR write
 * failure (invalidated extension context, corruption, quota) is logged and
 * swallowed rather than surfacing as an unhandled rejection that could crash
 * the run loop. The read path (`loadRuns`) is otherwise OUTSIDE every try/catch
 * and could reject on exactly the kind of storage error the doc says is
 * handled.
 */
export async function saveRun(run: RunRecord): Promise<void> {
  const runSave = async (): Promise<void> => {
    let runs: RunRecord[] = [];
    try {
      runs = await loadRuns();
    } catch (e) {
 // Read failure — can't safely merge, but don't crash the run. Log and
 // fall back to a single-entry list so at least this run is persisted.
      console.warn("[run-history] loadRuns failed; persisting this run only:", e);
      runs = [];
    }
 // defense-in-depth — redact any secret values that may have
 // leaked into persisted log events before writing to disk. redactRunSecrets
 // scans EVERY string-valued field of every LogEvent (including page-derived
 // `url`/`pageInfo`/`description` and planner text), not just `message`, so a
 // secret that reaches storage via any path is caught here rather than left in
 // chrome.storage.local / localStorage.
 // Redaction is defense-in-depth, not essential to persistence. If the
 // secrets module fails to load (e.g. dynamic import rejects) or throws
 // while scanning a field, don't let that abort the whole save — fall back
 // to persisting the original run so the history entry survives and stays
 // replayable. The failure is logged so the gap in secret-hygiene is at
 // least visible, rather than silently dropping the run record.
    let safeRun: RunRecord;
    try {
      safeRun = await redactRunSecrets(run);
    } catch (e) {
      console.warn("[run-history] redactRunSecrets failed; persisting unredacted run:", e);
      safeRun = run;
    }
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
      writeLocalStorage(runs);
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
 // Trim oldest (last) entry and retry once. If it still fails, log + give up.
        runs.pop();
        try {
          writeLocalStorage(runs);
        } catch (e2) {
          console.warn("[run-history] localStorage quota exhausted even after trim:", e2);
        }
      } else {
        console.warn("[run-history] localStorage.setItem failed:", e);
      }
    }
  };

 // Chain onto the in-flight save sequence so writes are serialized. `thisSave`
 // resolves only after BOTH the prior save and this one complete, so callers
 // awaiting `saveRun` observe this run's persistence. A rejection is swallowed
 // (logged inside `runSave`) so it can't poison the chain for later saves.
  const thisSave = saveChain.then(runSave, runSave);
  saveChain = thisSave.then(
    () => undefined,
    () => undefined,
  );
  return thisSave;
}

/**
 * Walk a RunRecord's steps and redact any secret values from EVERY text-bearing
 * field across every LogEvent variant — not just a fixed allow-list. This is the
 * defense-in-depth catch for secrets that reach storage: page-derived fields
 * such as `state.url`, `state.pageInfo`, and `action.description`, plus planner
 * text (`decision`/`goal`/`plan`) and challenge/takeover `kind`/`message`/`reason`,
 * can all contain entered form values, visible PII, or access tokens in the URL
 * query string. Iterating over every string-valued key (and string elements of
 * any array-valued key, e.g. planner `plan`) guarantees we never miss a new field
 * added to the LogEvent union. Also redacts the run's result text.
 * Returns a shallow-cloned run with sanitized steps. Called by saveRun before
 * persistence.
 */
/**
 * True only for plain data objects (`{}` / `Object.create(null)`), so recursion
 * skips class instances, Maps, Dates, etc., whose enumerable-key rebuild could
 * lose behavior.
 */
function isPlainObject(val: object): val is Record<string, unknown> {
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

async function redactRunSecrets(run: RunRecord): Promise<RunRecord> {
 // `redactSecrets` is a static import (sibling module), so it is bundled into
 // the service worker with `splitting:false` and is always available on the SW
 // save path — no dynamic chunk load that could silently degrade redaction.
 // Redact a single value: strings are scanned for secrets; arrays and plain
 // objects are recursed into so a nested string field (e.g. `{data:{url}}`)
 // is never persisted unredacted. Recursion is depth-bounded so a pathological
 // deeply-nested structure cannot stall redaction. Non-string/non-container
 // values (and anything beyond the depth bound) are returned untouched.
  const MAX_REDACT_DEPTH = 6;
  const redactValue = async (val: unknown, depth = 0): Promise<unknown> => {
    if (typeof val === "string") {
      return await redactSecrets(val);
    }
    if (depth >= MAX_REDACT_DEPTH) return val;
    if (Array.isArray(val)) {
      let changed = false;
      const out = await Promise.all(
        val.map(async (v) => {
          const r = await redactValue(v, depth + 1);
          if (r !== v) changed = true;
          return r;
        }),
      );
      return changed ? out : val;
    }
    if (val !== null && typeof val === "object" && isPlainObject(val)) {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        const r = await redactValue(v, depth + 1);
        if (r !== v) changed = true;
        out[k] = r;
      }
      return changed ? out : val;
    }
    return val;
  };
  const steps = await Promise.all(
    run.steps.map(async (event) => {
 // A corrupt / non-object step would make `Object.entries(event)` throw
 // and defeat redaction for the WHOLE run (the secret would then be
 // persisted unredacted). Skip such entries rather than letting one bad
 // step take down redaction for every other step.
      if (typeof event !== "object" || event === null) return event;
      let patched = event;
      for (const [key, val] of Object.entries(event)) {
        const redacted = await redactValue(val);
        if (redacted !== val) {
          patched = { ...patched, [key]: redacted } as LogEvent;
        }
      }
      return patched;
    }),
  );
  const result = run.result;
  const resultText = result?.text ?? "";
  const redactedResultText = typeof resultText === "string" ? await redactSecrets(resultText) : resultText;
  const task = typeof run.task === "string" ? await redactSecrets(run.task) : run.task;
  return { ...run, task, steps, result: result ? { success: result.success, text: redactedResultText } : null };
}

/**
 * Replace the entire stored run list with `runs`, serialized through the same
 * {@link saveChain} that {@link saveRun} uses so an options-page bulk write
 * (import/clear) cannot race a concurrent `saveRun` read-modify-write against
 * the shared `open_cowork_run_history` key and silently drop a run. Trims to
 * {@link MAX_RUNS}. Writes through the same storage path so the in-page
 * (localStorage) and extension (chrome.storage.local) behaviours stay aligned.
 *
 * Redaction parity with {@link saveRun}: every run is passed through
 * {@link redactRunSecrets} before it is written, so a bulk import/clear/write
 * cannot persist a secret that reached storage via an imported run (the
 * options-import path historically persisted WITHOUT redaction — see L7). The
 * redaction is defense-in-depth: if it throws we fall back to persisting the
 * original runs (mirroring `saveRun`) so the bulk write still completes rather
 * than dropping the user's history.
 */
export async function replaceAllRuns(runs: RunRecord[]): Promise<void> {
  const writer = async (): Promise<void> => {
    let list = runs;
    if (list.length > MAX_RUNS) list = list.slice(0, MAX_RUNS);
    let safeList: RunRecord[];
    try {
      safeList = await Promise.all(list.map((r) => redactRunSecrets(r)));
    } catch (e) {
      console.warn("[run-history] redactRunSecrets failed for replaceAllRuns; persisting unredacted runs:", e);
      safeList = list;
    }
    if (isExtensionWithLocal()) {
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: safeList });
      } catch (e) {
        console.warn("[run-history] chrome.storage.local.set failed:", e);
      }
      return;
    }
    try {
      writeLocalStorage(safeList);
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        safeList.pop();
        try {
          writeLocalStorage(safeList);
        } catch (e2) {
          console.warn("[run-history] localStorage quota exhausted even after trim:", e2);
        }
      } else {
        console.warn("[run-history] localStorage.setItem failed:", e);
      }
    }
  };
  const thisSave = saveChain.then(writer, writer);
  saveChain = thisSave.then(
    () => undefined,
    () => undefined,
  );
  return thisSave;
}

/**
 * Remove all stored runs, serialized through {@link saveChain} so the clear
 * cannot race a concurrent {@link saveRun}. Uses the same storage path as
 * {@link saveRun}/{@link replaceAllRuns}.
 */
export async function clearAllRuns(): Promise<void> {
  const writer = async (): Promise<void> => {
    if (isExtensionWithLocal()) {
      try {
        await chrome.storage.local.remove(STORAGE_KEY);
      } catch (e) {
        console.warn("[run-history] chrome.storage.local.remove failed:", e);
      }
      return;
    }
    try {
      writeLocalStorage([]);
    } catch (e) {
      console.warn("[run-history] localStorage.setItem failed:", e);
    }
  };
  const thisSave = saveChain.then(writer, writer);
  saveChain = thisSave.then(
    () => undefined,
    () => undefined,
  );
  return thisSave;
}

/**
 * Load all stored run records (newest first).
 * Returns an empty array if storage is empty or unreadable.
 */
export async function loadRuns(): Promise<RunRecord[]> {
  const cutoff = Date.now() - RUN_HISTORY_MAX_AGE_MS;
  if (isExtensionWithLocal()) {
    const res = await chrome.storage.local.get(STORAGE_KEY);
    const arr = res[STORAGE_KEY];
 // Guard against type-mismatched / corrupt storage (e.g. a non-array value
 // written under the same key by another extension) so callers don't throw
 // on `.unshift` / `.map` downstream. Also validate each entry's shape and
 // drop any partial/corrupt record rather than letting a bad `steps` value
 // propagate into the UI / replay.
    if (!Array.isArray(arr)) return [];
    return (arr as unknown[])
      .filter(isValidRunRecord)
      .map(normalizeRunRecord)
      .filter((r) => !r.startedAt || r.startedAt >= cutoff);
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? (parsed as unknown[])
          .filter(isValidRunRecord)
          .map(normalizeRunRecord)
          .filter((r) => !r.startedAt || r.startedAt >= cutoff)
      : [];
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
      overflowCount: 0,
    };
  }

  /**
 * Append a LogEvent and update cumulative totals.
 * - `cost` events add to token + USD totals.
 * - `navigator-step-start` events bump the step counter to
 * `Math.max(stepCount, event.step + 1)` — the +1 accounts for the
 * 0-indexed step number (a `navigator-step-start` at step 0 means 1 step
 * has executed, not 0).
 */
  addEvent(event: LogEvent): void {
    this.run.steps.push(event);
    // Amortize the O(N) `shift()` reindex once past MAX_STEPS (MED finding):
    // let the buffer grow to MAX_STEPS + OVERFLOW_BATCH, then drop a whole batch
    // at once instead of reindexing on every event.
    const OVERFLOW_BATCH = 256;
    // Let the buffer grow to MAX_STEPS + OVERFLOW_BATCH, then splice a whole
    // batch at once instead of reindexing (shift) on every event — this
    // amortizes the O(N) reindex so long runs stay near O(1) per event.
    if (this.run.steps.length > MAX_STEPS + OVERFLOW_BATCH) {
      this.run.steps.splice(0, OVERFLOW_BATCH);
      this.run.overflowCount += OVERFLOW_BATCH;
    }
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

