import type { LogEvent } from "./types";
import { getSecretSetVersion, redactSecrets } from "./secrets";

/** Persistent record of one completed (or aborted) agent run. */
export interface RunRecord {
  id: string;
  task: string;
  startedAt: number;
  endedAt: number;
  steps: LogEvent[];
  result: { success: boolean; text: string } | null;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  stepCount: number;
  overflowCount: number;
}

export const STORAGE_KEY = "open_cowork_run_history";
export const MAX_RUNS = 50;
export const RUN_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STEPS = 2000;

export function isValidRunRecord(v: unknown): v is RunRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.task === "string" &&
    typeof r.startedAt === "number" &&
    Array.isArray(r.steps)
  );
}

export function writeLocalStorage(runs: RunRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

export function writeToLocalStorageWithRetry(runs: RunRecord[]): void {
  try {
    writeLocalStorage(runs);
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
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
}

export function normalizeRunRecord(r: RunRecord): RunRecord {
  return {
    ...r,
    totalTokensIn: r.totalTokensIn ?? 0,
    totalTokensOut: r.totalTokensOut ?? 0,
    totalCostUsd: r.totalCostUsd ?? 0,
    stepCount: r.stepCount ?? 0,
    overflowCount: r.overflowCount ?? 0,
    endedAt: r.endedAt ?? 0,
    result:
      r.result &&
      typeof r.result === "object" &&
      "success" in r.result &&
      "text" in r.result
        ? r.result
        : null,
  };
}

function isPlainObject(val: object): val is Record<string, unknown> {
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

const MAX_REDACT_DEPTH = 6;
const redactCache = new Map<string, string>();
let lastRedactCacheVersion = -1;

export const redactValue = async (val: unknown, depth = 0): Promise<unknown> => {
  if (typeof val === "string") {
    const version = getSecretSetVersion();
    if (lastRedactCacheVersion !== version) {
      redactCache.clear();
      lastRedactCacheVersion = version;
    }
    const cached = redactCache.get(val);
    if (cached !== undefined) return cached;
    const result = await redactSecrets(val);
    redactCache.set(val, result);
    return result;
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

export async function redactRunSecrets(run: RunRecord): Promise<RunRecord> {
  const steps = await Promise.all(
    run.steps.map(async (event) => {
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
