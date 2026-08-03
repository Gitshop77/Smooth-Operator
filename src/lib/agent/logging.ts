/**
 * Structured JSON-lines logging with run IDs.
 *
 * Emits one JSON line per event (`{ts, level, msg, runId, ...fields}`) and
 * keeps a bounded in-memory ring that the run builder drains into the
 * persisted run record at finish (see `run-history.ts`).
 *
 * Console routing: `error`/`warn` go through `console.error`/`console.warn`
 * (untouched by the production console-debug-strip plugin), while `info`/
 * `debug` go through `console.debug` (stripped from the production bundle).
 * The ring and run-history persistence capture every level regardless of the
 * production strip, so realtime console visibility in prod is limited to
 * warn/error but no log line is ever lost.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One structured log entry; `fields` spread over the fixed envelope. */
export interface LogEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  level: LogLevel;
  msg: string;
  /** Run id captured at emit time; empty string when no run is active. */
  runId: string;
  [key: string]: unknown;
}

/** Maximum ring size — the last N lines are persisted with the run. */
export const LOG_RING_CAPACITY = 200;

let activeRunId: string | null = null;
const ring: LogEntry[] = [];

/** Bind the logger to a run; pass `null` to detach after the run ends. */
export function setActiveRunId(runId: string | null): void {
  activeRunId = runId;
}

export function getActiveRunId(): string | null {
  return activeRunId;
}

/** Emit one structured log line into the console and the ring. */
export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    runId: activeRunId ?? "",
    ...fields,
  };
  ring.push(entry);
  if (ring.length > LOG_RING_CAPACITY) {
    ring.splice(0, ring.length - LOG_RING_CAPACITY);
  }
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // A non-serializable field must never make the logger throw — fall back
    // to the primitive-only envelope.
    line = JSON.stringify({ ts: entry.ts, level, msg, runId: entry.runId });
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.debug(line);
}

/** Drain and clear the ring (called by the run builder at finish). */
export function drainLogRing(): LogEntry[] {
  return ring.splice(0, ring.length);
}
