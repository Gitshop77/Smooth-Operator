import { isExtensionWithLocal } from "./runtime";
import {
  type RunRecord, STORAGE_KEY, MAX_RUNS, RUN_HISTORY_MAX_AGE_MS, MAX_STEPS,
  isValidRunRecord, writeLocalStorage, writeToLocalStorageWithRetry,
  normalizeRunRecord, redactRunSecrets,
} from "./run-history-utils";
import type { LogEvent } from "./types";

let saveChain: Promise<void> = Promise.resolve();

export async function saveRun(run: RunRecord): Promise<void> {
  const runSave = async (): Promise<void> => {
    let runs: RunRecord[] = [];
    try { runs = await loadRuns(); }
    catch (e) { console.warn("[run-history] loadRuns failed; persisting this run only:", e); runs = []; }
    let safeRun: RunRecord;
    try { safeRun = await redactRunSecrets(run); }
    catch (e) { console.warn("[run-history] redactRunSecrets failed; persisting unredacted run:", e); safeRun = run; }
    runs.unshift(safeRun);
    if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
    if (isExtensionWithLocal()) {
      try { await chrome.storage.local.set({ [STORAGE_KEY]: runs }); }
      catch (e) { console.warn("[run-history] chrome.storage.local.set failed:", e); }
      return;
    }
    writeToLocalStorageWithRetry(runs);
  };
  const thisSave = saveChain.then(runSave, runSave);
  saveChain = thisSave.then(() => undefined, () => undefined);
  return thisSave;
}

export async function replaceAllRuns(runs: RunRecord[]): Promise<void> {
  const writer = async (): Promise<void> => {
    let list = runs;
    if (list.length > MAX_RUNS) list = list.slice(0, MAX_RUNS);
    let safeList: RunRecord[];
    try { safeList = await Promise.all(list.map((r) => redactRunSecrets(r))); }
    catch (e) { console.warn("[run-history] redactRunSecrets failed for replaceAllRuns; persisting unredacted runs:", e); safeList = list; }
    if (isExtensionWithLocal()) {
      try { await chrome.storage.local.set({ [STORAGE_KEY]: safeList }); }
      catch (e) { console.warn("[run-history] chrome.storage.local.set failed:", e); }
      return;
    }
    writeToLocalStorageWithRetry(safeList);
  };
  const thisSave = saveChain.then(writer, writer);
  saveChain = thisSave.then(() => undefined, () => undefined);
  return thisSave;
}

export async function clearAllRuns(): Promise<void> {
  const writer = async (): Promise<void> => {
    if (isExtensionWithLocal()) {
      try { await chrome.storage.local.remove(STORAGE_KEY); }
      catch (e) { console.warn("[run-history] chrome.storage.local.remove failed:", e); }
      return;
    }
    try { writeLocalStorage([]); }
    catch (e) { console.warn("[run-history] localStorage.setItem failed:", e); }
  };
  const thisSave = saveChain.then(writer, writer);
  saveChain = thisSave.then(() => undefined, () => undefined);
  return thisSave;
}

export async function loadRuns(): Promise<RunRecord[]> {
  const cutoff = Date.now() - RUN_HISTORY_MAX_AGE_MS;
  if (isExtensionWithLocal()) {
    const res = await chrome.storage.local.get(STORAGE_KEY);
    const arr = res[STORAGE_KEY];
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

export class RunBuilder {
  private run: RunRecord;
  private capturedResult: { success: boolean; text: string } | null = null;

  constructor(task: string) {
    this.run = {
      id: crypto.randomUUID(),
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

  finish(result: { success: boolean; text: string }): RunRecord {
    if (this.run.endedAt !== 0) {
      return this.run;
    }
    this.run.endedAt = Date.now();
    this.run.result = this.capturedResult ?? result;
    return this.run;
  }

  get id(): string {
    return this.run.id;
  }
}
