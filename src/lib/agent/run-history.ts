import { isExtensionWithLocal } from "./runtime";
import {
  type RunRecord, STORAGE_KEY, MAX_RUNS, RUN_HISTORY_MAX_AGE_MS, MAX_STEPS,
  isValidRunRecord, writeToLocalStorageWithRetry,
  normalizeRunRecord, redactRunSecrets, HISTORY_REVISION_KEY,
  MAX_RUN_ENTRY_BYTES, CUMULATIVE_IMPORT_BUDGET_BYTES, serializedByteSize,
} from "./run-history-utils";
import type { LogEvent } from "./types";
import type { RunTerminalReason } from "./run-lifecycle-contract";
import { createMutex } from "./mutex";
import { drainLogRing, log, setActiveRunId } from "./logging";

const withRunChain = createMutex<unknown>();

const REDACTION_FAILED_MARKER = "[REDACTED: redaction failed]";

/** Pre-write quota guard: whole-list history stays under 8 MiB (10 MiB quota
 *  minus headroom), popping oldest entries before the commit so a `set` that
 *  would trip QUOTA_BYTES is prevented rather than swallowed. */
export const MAX_HISTORY_BUDGET_BYTES = 8 * 1024 * 1024;

/** Raised when a whole-list history mutation raced a newer commit. */
export class HistoryRevisionError extends Error {
  readonly code = "HISTORY_REVISION_CONFLICT";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Run history changed before the mutation could commit ` +
      `(expected revision ${expectedRevision}, actual ${actualRevision})`,
    );
    this.name = "HistoryRevisionError";
  }
}

/** Read the monotonic history revision counter (0 when absent/legacy). */
async function readHistoryRevision(): Promise<number> {
  if (isExtensionWithLocal()) {
    try {
      const res = await chrome.storage.local.get(HISTORY_REVISION_KEY);
      const v = res[HISTORY_REVISION_KEY];
      return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0;
    } catch {
      return 0;
    }
  }
  try {
    const raw = localStorage.getItem(HISTORY_REVISION_KEY);
    if (raw === null) return 0;
    const v: unknown = JSON.parse(raw);
    return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0;
  } catch {
    return 0;
  }
}

/** Read the current history revision for a caller's optimistic-concurrency use. */
export async function getHistoryRevision(): Promise<number> {
  return readHistoryRevision();
}

/** Roll the history record back to `previousRaw` after a failed commit. */
async function rollbackHistoryStorage(previousRaw: unknown): Promise<void> {
  if (isExtensionWithLocal()) {
    if (previousRaw !== undefined) {
      await chrome.storage.local.set({ [STORAGE_KEY]: previousRaw });
    } else {
      await chrome.storage.local.remove(STORAGE_KEY);
    }
    return;
  }
  if (previousRaw !== undefined) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(previousRaw));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Quota-guard a whole-list commit: while the serialized list exceeds
 * {@link MAX_HISTORY_BUDGET_BYTES}, drop the OLDEST entries (the list is
 * newest-first). A single oversized run can still push the total over budget
 * after the trim — the guard stops at one entry so the commit is never empty.
 */
function trimListToBudget(runs: RunRecord[]): RunRecord[] {
  let list = runs;
  let total = serializedByteSize(list);
  while (list.length > 1 && total > MAX_HISTORY_BUDGET_BYTES) {
    list = list.slice(0, -1);
    total = serializedByteSize(list);
  }
  return list;
}

/**
 * Atomic background commit: data + revision land in ONE storage call so the
 * list can never commit while the counter lags (or vice versa), halving
 * storage writes per run near the ~120/min local cap. The optimistic
 * `HistoryRevisionError` guard stays authoritative because the counter now
 * travels with the data it versions.
 */
async function commitHistoryList(
  runs: RunRecord[],
  nextRevision: number,
): Promise<void> {
  if (isExtensionWithLocal()) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: trimListToBudget(runs),
      [HISTORY_REVISION_KEY]: nextRevision,
    });
    return;
  }
  writeToLocalStorageWithRetry(trimListToBudget(runs));
  localStorage.setItem(HISTORY_REVISION_KEY, JSON.stringify(nextRevision));
}

/** Read the current revision, then fold the bump into the same commit. */
async function nextHistoryRevision(): Promise<number> {
  return (await readHistoryRevision()) + 1;
}

/**
 * Redact a run for persistence, failing CLOSED: if redaction throws, persist
 * a marker run (id/timestamps preserved, content dropped) rather than the
 * unredacted run. Redaction is the only line of defense for stored data.
 */
async function redactRunOrMarker(run: RunRecord): Promise<RunRecord> {
  try {
    return await redactRunSecrets(run);
  } catch (e) {
    console.error("[run-history] redactRunSecrets failed; persisting marker instead of unredacted run:", e);
    return {
      ...run,
      task: REDACTION_FAILED_MARKER,
      steps: [],
      logs: [],
      result: null,
    };
  }
}

export async function saveRun(run: RunRecord): Promise<void> {
  return withRunChain(async () => {
    let runs: RunRecord[] = [];
    try { runs = await loadRuns(false); }
    catch (e) { console.warn("[run-history] loadRuns failed; persisting this run only:", e); runs = []; }
    const safeRun = await redactRunOrMarker(run);
    // Idempotency: persisting the SAME logical run twice (e.g. the same
    // interrupted snapshot recovered again after another worker restart) must
    // REPLACE the existing record by id, never duplicate it. Run ids are
    // UUIDs generated per run, so a duplicate id can only mean a re-persist of
    // the same logical run — the freshest copy wins and keeps its position at
    // the head of the list.
    runs = [safeRun, ...runs.filter((r) => r.id !== safeRun.id)];
    if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
    await commitHistoryList(runs, await nextHistoryRevision());
  }) as Promise<void>;
}

export async function replaceAllRuns(runs: RunRecord[]): Promise<void> {
  return withRunChain(async () => {
    let list = runs;
    if (list.length > MAX_RUNS) list = list.slice(0, MAX_RUNS);
    const safeList = await Promise.all(list.map(redactRunOrMarker));
    await commitHistoryList(safeList, await nextHistoryRevision());
  }) as Promise<void>;
}

export async function clearAllRuns(): Promise<void> {
  return withRunChain(async () => {
    // An empty array (rather than removing the key) lets the revision bump
    // travel in the same atomic commit as the data.
    await commitHistoryList([], await nextHistoryRevision());
  }) as Promise<void>;
}

export async function loadRuns(persistPrune = true): Promise<RunRecord[]> {
  const cutoff = Date.now() - RUN_HISTORY_MAX_AGE_MS;
  if (isExtensionWithLocal()) {
    try {
      const res = await chrome.storage.local.get(STORAGE_KEY);
      const arr = res[STORAGE_KEY];
      if (!Array.isArray(arr)) return [];
      const all = (arr as unknown[])
        .filter(isValidRunRecord)
        .map(normalizeRunRecord);
      const fresh = all.filter((r) => !r.startedAt || r.startedAt >= cutoff);
      if (persistPrune && fresh.length < all.length) {
        // Expired 30-day runs stay on disk forever unless pruned back —
        // retention is an active cleanup job, not a passive read filter.
        // Best-effort: never fail the read on a write-back error. Callers
        // inside the mutation chain pass `false` (the chain's own commit
        // writes the authoritative list).
        void chrome.storage.local
          .set({ [STORAGE_KEY]: fresh })
          .catch(() => {});
      }
      return fresh;
    } catch {
      return [];
    }
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

export interface MergeRunsResult {
  /** Full merged list (sorted newest-first, capped at MAX_RUNS). */
  merged: RunRecord[];
  /** New history revision after this commit. */
  revision: number;
  /** Imported entries that were kept (either added or merged over an existing id). */
  imported: number;
  /** Imported entries dropped for size/budget/validation reasons. */
  skippedInvalid: number;
  /** Valid imported entries dropped by the MAX_RUNS cap. */
  droppedForCap: number;
  /** Pre-existing entries evicted by the MAX_RUNS cap. */
  existingDropped: number;
}

function serializedSize(value: unknown): number {
  return serializedByteSize(value);
}

/**
 * Background-owned, revision-guarded whole-list import.
 *
 * Runs entirely inside the shared history mutation chain, so it cannot
 * interleave with a concurrent run-completion save or another import. The
 * `expectedRevision` optimistic guard makes a stale import (one based on an
 * older list) fail closed with {@link HistoryRevisionError} instead of
 * overwriting newer runs.
 *
 * Imported entries are untrusted: each is validated, byte-budget-bounded, and
 * redacted (fail-closed marker on redaction failure) before commit. The commit
 * is transactional — data and the revision counter land in ONE storage call,
 * so they can never diverge; a failed commit rolls the data back to the
 * pre-import state.
 */
export async function mergeRuns(
  entries: unknown[],
  expectedRevision: number,
  now = Date.now(),
): Promise<MergeRunsResult> {
  return withRunChain(async () => {
    const actualRevision = await readHistoryRevision();
    if (actualRevision !== expectedRevision) {
      throw new HistoryRevisionError(expectedRevision, actualRevision);
    }

    const cutoff = now - RUN_HISTORY_MAX_AGE_MS;
    const validated = (Array.isArray(entries) ? entries : []).filter((e): e is RunRecord => {
      if (!isValidRunRecord(e)) return false;
      if (e.startedAt !== undefined && e.startedAt < cutoff) return false; // stale
      if (serializedSize(e) > MAX_RUN_ENTRY_BYTES) return false;
      return true;
    });

    const existing = (await loadRuns(false)) ?? [];
    let budget =
      existing.reduce((sum, r) => sum + serializedSize(r), 0);
    const budgeted: RunRecord[] = [];
    for (const entry of validated) {
      const size = serializedSize(entry);
      if (budget + size > CUMULATIVE_IMPORT_BUDGET_BYTES) break;
      budget += size;
      budgeted.push(entry);
    }
    // Everything that failed validation, the age/size filters, or the
    // cumulative budget is a skipped invalid entry.
    const skippedInvalid = (Array.isArray(entries) ? entries : []).length - budgeted.length;

    // Dedupe by startedAt|task (first occurrence wins, existing first) —
    // mirrors the legacy Options merge so imported files round-trip identically.
    const keyOf = (r: RunRecord) => `${r.startedAt}|${r.task}`;
    const seen = new Set<string>();
    const merged: RunRecord[] = [];
    for (const r of [...existing, ...budgeted]) {
      const k = keyOf(r);
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(r);
      }
    }
    merged.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    const capped = merged.slice(0, MAX_RUNS);
    const cappedSet = new Set(capped.map((r) => r.id));

    const safeList = await Promise.all(capped.map(redactRunOrMarker));

    const previousRaw = isExtensionWithLocal()
      ? (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
      : (() => {
          try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"); } catch { return undefined; }
        })();
    const nextRevision = actualRevision + 1;
    try {
      await commitHistoryList(safeList, nextRevision);
    } catch (e) {
      // The atomic commit failed before landing (or only partially applied in
      // the localStorage fallback) — roll the data back so a later import can
      // never be applied against a stale revision.
      try {
        await rollbackHistoryStorage(previousRaw);
      } catch (rbErr) {
        console.warn("[run-history] rollback after commit failure failed:", rbErr);
      }
      throw e;
    }

    let existingDropped = 0;
    for (const r of existing) if (!cappedSet.has(r.id)) existingDropped++;
    let droppedForCap = 0;
    let importedKept = 0;
    for (const r of budgeted) {
      if (!cappedSet.has(r.id)) droppedForCap++;
      else importedKept++;
    }

    return {
      merged: safeList,
      revision: nextRevision,
      imported: importedKept,
      skippedInvalid,
      droppedForCap,
      existingDropped,
    } as MergeRunsResult;
  }) as Promise<MergeRunsResult>;
}

export class RunBuilder {
  private run: RunRecord;
  private capturedResult: { success: boolean; text: string } | null = null;

  constructor(task: string) {
    // Any ring lines left over from a previous (never-finished) run are
    // orphans — drop them so this run's record never inherits them.
    drainLogRing();
    this.run = {
      id: crypto.randomUUID(),
      task,
      startedAt: Date.now(),
      endedAt: 0,
      steps: [],
      logs: [],
      result: null,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCostUsd: 0,
      stepCount: 0,
      overflowCount: 0,
    };
    setActiveRunId(this.run.id);
    log("info", "run started", { task });
  }

  addEvent(event: LogEvent): void {
    this.run.steps.push(event);
    this.trimSteps();
    if (event.type === "cost") {
      this.run.totalTokensIn += event.tokensIn;
      this.run.totalTokensOut += event.tokensOut;
      this.run.totalCostUsd += event.costUsd;
    }
    if (event.type === "navigator-step-start") {
      this.run.stepCount = Math.max(this.run.stepCount, event.step + 1);
    }
    if (event.type === "done") {
      this.capturedResult = { success: event.success, text: event.text };
    }
  }

  private trimSteps(): void {
    const OVERFLOW_BATCH = 256;
    if (this.run.steps.length > MAX_STEPS + OVERFLOW_BATCH) {
      this.run.steps.splice(0, OVERFLOW_BATCH);
      this.run.overflowCount += OVERFLOW_BATCH;
    }
  }

  finish(result: { success: boolean; text: string; terminalReason?: RunTerminalReason }): RunRecord {
    if (this.run.endedAt !== 0) {
      return this.run;
    }
    this.run.endedAt = Date.now();
    // `terminalReason` is a top-level additive history field, not part of the
    // legacy result contract. Keep the nested result shape stable.
    this.run.result = this.capturedResult ?? { success: result.success, text: result.text };
    this.run.terminalReason = result.terminalReason;
    log("info", "run ended", { success: this.run.result.success, steps: this.run.steps.length });
    this.run.logs = drainLogRing();
    setActiveRunId(null);
    return this.run;
  }

  get id(): string {
    return this.run.id;
  }

  get startedAt(): number {
    return this.run.startedAt;
  }
}
