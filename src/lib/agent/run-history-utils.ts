import type { LogEvent } from "./types";
import type { LogEntry } from "./logging";
import { isRunTerminalReason, type RunTerminalReason } from "./run-lifecycle-contract";
import { getSecretSetVersion, redactSecrets } from "./secrets";
import { redactKeyShapes } from "./key-shape-redact";

/** Persistent record of one completed (or aborted) agent run. */
export interface RunRecord {
  id: string;
  task: string;
  startedAt: number;
  endedAt: number;
  steps: LogEvent[];
  /** Structured JSON-lines log entries (bounded ring, drained at finish). */
  logs: LogEntry[];
  result: { success: boolean; text: string } | null;
  /** Additive V1 terminal reason; absent on legacy history records. */
  terminalReason?: RunTerminalReason;
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
/** Max serialized size of a single imported run entry (keeps storage quota safe). */
export const MAX_RUN_ENTRY_BYTES = 2 * 1024 * 1024; // 2 MiB per entry
/** Cumulative import budget across existing + imported entries (quota-safe). */
export const CUMULATIVE_IMPORT_BUDGET_BYTES = 4 * 1024 * 1024; // 4 MiB total
/** chrome.storage.local key holding the monotonic background-owned history
 *  revision counter (guards concurrent whole-list mutations across contexts). */
export const HISTORY_REVISION_KEY = "open_cowork_run_history_revision";

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

function writeLocalStorage(runs: RunRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

const textEncoder = new TextEncoder();

/**
 * Real byte measurement of a value's JSON serialization (UTF-8 bytes), matching
 * chrome.storage quota accounting. `string.length` counts UTF-16 code units and
 * under-estimates multi-byte text ~2× at budget boundaries.
 */
export function serializedByteSize(value: unknown): number {
  try {
    return textEncoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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
    logs: Array.isArray(r.logs) ? r.logs : [],
    totalTokensIn: r.totalTokensIn ?? 0,
    totalTokensOut: r.totalTokensOut ?? 0,
    totalCostUsd: r.totalCostUsd ?? 0,
    stepCount: r.stepCount ?? 0,
    overflowCount: r.overflowCount ?? 0,
    endedAt: r.endedAt ?? 0,
    terminalReason: isRunTerminalReason(r.terminalReason) ? r.terminalReason : undefined,
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
const MAX_REDACT_CACHE_ENTRIES = 1000;
/** Skip caching strings longer than this — page-derived strings can run to MBs,
 *  and 1000 large cached values would balloon the SW heap and make redaction
 *  slower than recompute. */
export const MAX_REDACT_CACHE_STRING_LENGTH = 1024;
const redactCache = new Map<string, string>();
let lastRedactCacheVersion = -1;

/**
 * Redact one string for persistence: stored-secret values first, then
 * well-known key shapes (API keys, tokens, DB URLs). The key-shape pass is
 * what every other persistence surface does (messages.ts, compaction) — run
 * history receives page-derived strings that never passed the LLM prompt, so
 * it needs the same parity.
 */
const redactString = async (val: string): Promise<string> => {
  return redactKeyShapes(await redactSecrets(val));
};

export const redactValue = async (val: unknown, depth = 0): Promise<unknown> => {
  if (typeof val === "string") {
    const version = getSecretSetVersion();
    if (lastRedactCacheVersion !== version) {
      redactCache.clear();
      lastRedactCacheVersion = version;
    }
    // Oversized values are never cached: they are the common no-recompute-hit
    // case, and caching them would defeat the entry-count bound on VALUE bytes.
    if (val.length > MAX_REDACT_CACHE_STRING_LENGTH) {
      return redactString(val);
    }
    const cached = redactCache.get(val);
    if (cached !== undefined) {
      // True LRU: a hit re-inserts the entry at the newest position so the
      // entry-count eviction below drops genuinely-oldest entries, not FIFO.
      redactCache.delete(val);
      redactCache.set(val, cached);
      return cached;
    }
    const result = await redactString(val);
    redactCache.set(val, result);
    if (redactCache.size > MAX_REDACT_CACHE_ENTRIES) {
      // Evict the oldest entries (Map preserves insertion order) so the
      // cache cannot grow without bound.
      let excess = redactCache.size - MAX_REDACT_CACHE_ENTRIES;
      for (const key of redactCache.keys()) {
        if (excess-- <= 0) break;
        redactCache.delete(key);
      }
    }
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
  const redactedResultText = typeof resultText === "string" ? await redactString(resultText) : resultText;
  const task = typeof run.task === "string" ? await redactString(run.task) : run.task;
  const logs = await Promise.all(
    (run.logs ?? []).map(async (entry) => {
      let patched: LogEntry = entry;
      for (const [key, val] of Object.entries(entry)) {
        const redacted = await redactValue(val);
        if (redacted !== val) {
          patched = { ...patched, [key]: redacted };
        }
      }
      return patched;
    }),
  );
  return { ...run, task, steps, logs, result: result ? { success: result.success, text: redactedResultText } : null };
}
