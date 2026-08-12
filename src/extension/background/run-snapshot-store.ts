import { redactSecrets } from "@/lib/agent/secrets";
import { redactKeyLeak } from "@/lib/agent/redact-shared";
import { saveRun } from "@/lib/agent/run-history";
import type { RunRecord } from "@/lib/agent/run-history-utils";
import { isRunSnapshotV1 } from "@/lib/agent/run-lifecycle-contract";
import type { RunSnapshotV1 } from "./run-controller";
import { redactLiveRunSnapshot } from "./run-event-projection";
import type { RunState } from "./state-store";

export const LAST_RUN_SNAPSHOT_KEY = "open_cowork_run_snapshot_v1";
const MAX_TASK_CHARS = 10_000;
const MAX_OPERATION_CHARS = 500;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_RESULT_CHARS = 50_000;

/** Latest-wins coalescing window for the streaming snapshot persistence. */
const SNAPSHOT_COALESCE_MS = 250;

let writeChain: Promise<unknown> = Promise.resolve();
/** True when the write chain has fully settled (no write in flight). */
let chainSettled = true;
/** Buffered latest snapshot awaiting the coalescing flush. */
let pendingSnapshot: RunSnapshotV1 | null = null;
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

function bounded(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : value.slice(0, max) + "\n[truncated]";
}

async function redactSnapshot(snapshot: RunSnapshotV1): Promise<RunSnapshotV1> {
  const [storedTask, storedOperation, storedTerminalMessage, storedResultText] = await Promise.all([
    redactSecrets(bounded(snapshot.task, MAX_TASK_CHARS) ?? ""),
    snapshot.activeOperation
      ? redactSecrets(bounded(snapshot.activeOperation, MAX_OPERATION_CHARS) ?? "")
      : undefined,
    snapshot.terminalMessage
      ? redactSecrets(bounded(snapshot.terminalMessage, MAX_MESSAGE_CHARS) ?? "")
      : undefined,
    snapshot.resultText
      ? redactSecrets(bounded(snapshot.resultText, MAX_RESULT_CHARS) ?? "")
      : undefined,
  ]);
  const task = redactKeyLeak(storedTask);
  const operation = storedOperation === undefined ? undefined : redactKeyLeak(storedOperation);
  const terminalMessage = storedTerminalMessage === undefined
    ? undefined
    : redactKeyLeak(storedTerminalMessage);
  const resultText = storedResultText === undefined ? undefined : redactKeyLeak(storedResultText);
  return {
    ...snapshot,
    task,
    activeOperation: operation,
    terminalMessage,
    resultText,
  };
}

/** Enqueue one redacted write behind the serial chain. */
function enqueueSnapshotWrite(snapshot: RunSnapshotV1): Promise<void> {
  chainSettled = false;
  const run = writeChain.then(async () => {
    const safe = await redactSnapshot(snapshot);
    await chrome.storage.session.set({ [LAST_RUN_SNAPSHOT_KEY]: safe });
  });
  writeChain = run.catch(() => {});
  void writeChain.then(() => { chainSettled = true; }, () => { chainSettled = true; });
  return run;
}

function flushCoalesced(): void {
  coalesceTimer = null;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  if (snapshot !== null) void enqueueSnapshotWrite(snapshot);
}

/**
 * Persist a run snapshot. Streaming events coalesce latest-wins on a ~250ms
 * debounce: a step emitting 5-10 events now causes ONE storage.session write
 * instead of N full redact+set round-trips through the serial chain. A
 * standalone call with an idle chain writes immediately, so awaiting the
 * returned promise (or {@link flushRunSnapshot}) guarantees durability.
 */
export function persistRunSnapshot(snapshot: RunSnapshotV1): Promise<void> {
  // Redact synchronously before this projection enters the async write queue.
  // A later `redactSecrets()` pass remains defense-in-depth, but cannot be the
  // first line of defense for a snapshot concurrently returned by STATUS/STOP.
  const immutable = redactLiveRunSnapshot({
    ...snapshot,
    ...(snapshot.usage ? { usage: { ...snapshot.usage } } : {}),
  });
  if (chainSettled && coalesceTimer === null && pendingSnapshot === null) {
    return enqueueSnapshotWrite(immutable);
  }
  pendingSnapshot = immutable;
  if (coalesceTimer === null) {
    coalesceTimer = setTimeout(flushCoalesced, SNAPSHOT_COALESCE_MS);
  }
  return writeChain.then(() => undefined, () => undefined);
}

/** Persist any buffered snapshot immediately and await the write chain. */
export function flushRunSnapshot(): Promise<void> {
  if (coalesceTimer !== null) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  if (snapshot !== null) return enqueueSnapshotWrite(snapshot);
  return writeChain.then(() => undefined, () => undefined);
}

export async function getPersistedRunSnapshot(): Promise<RunSnapshotV1 | null> {
  const value = (await chrome.storage.session.get(LAST_RUN_SNAPSHOT_KEY))[LAST_RUN_SNAPSHOT_KEY];
  return isRunSnapshotV1(value) ? redactLiveRunSnapshot(value) : null;
}

export async function persistInterruptedRunSnapshot(
  state: RunState | null,
  message: string,
  now = Date.now(),
): Promise<RunSnapshotV1> {
  const existing = await getPersistedRunSnapshot();
  const sameTask = state === null
    ? Boolean(existing)
    : Boolean(
        existing?.task === state.task &&
        (!state.runId || !existing.runId || state.runId === existing.runId),
      );
  const base: RunSnapshotV1 = sameTask
    ? existing!
    : {
        version: 1,
        runId: state?.runId || existing?.runId || crypto.randomUUID(),
        revision: 0,
        dispatchRevision: state?.dispatchRevision ?? 0,
        task: state?.task ?? existing?.task ?? "Interrupted run",
        maxSteps: state?.maxSteps ?? existing?.maxSteps ?? 1,
        mode: state?.mode ?? existing?.mode ?? "standard",
        status: "running",
        phase: "starting",
        // Persisted run-state uses the loop's zero-based index; snapshots are
        // user-facing and use the same one-based contract as run history.
        step: state ? state.step + 1 : (existing?.step ?? 0),
        startedAt: state ? now : (existing?.startedAt ?? now),
        updatedAt: now,
        ...(state?.usage ? { usage: state.usage } : existing?.usage ? { usage: existing.usage } : {}),
      };
  const interrupted: RunSnapshotV1 = {
    ...base,
    revision: base.revision + 1,
    dispatchRevision: base.dispatchRevision + 1,
    status: "interrupted",
    phase: "terminal",
    step: state ? state.step + 1 : base.step,
    activeOperation: undefined,
    terminalReason: "interrupted",
    terminalMessage: message,
    updatedAt: now,
    endedAt: now,
    ...(state?.usage ? { usage: state.usage } : base.usage ? { usage: base.usage } : {}),
  };
  await persistRunSnapshot(interrupted);
  // The interrupted snapshot is the fail-closed recovery record for the next
  // SW startup — it must be durable before this function returns, never left
  // in the coalescing buffer.
  await flushRunSnapshot();
  return redactLiveRunSnapshot(interrupted);
}

/** Persist a compact, terminal history record for a run killed with its SW. */
export async function persistInterruptedRunHistory(snapshot: RunSnapshotV1): Promise<void> {
  const safeSnapshot = redactLiveRunSnapshot(snapshot);
  const usage = safeSnapshot.usage;
  const record: RunRecord = {
    id: safeSnapshot.runId,
    task: bounded(safeSnapshot.task, MAX_TASK_CHARS) ?? "Interrupted run",
    startedAt: safeSnapshot.startedAt,
    endedAt: safeSnapshot.endedAt ?? safeSnapshot.updatedAt,
    steps: [{ type: "done", step: safeSnapshot.step, success: false, text: safeSnapshot.terminalMessage ?? "Run interrupted." }],
    logs: [],
    // Use the REDACTED terminal message (safeSnapshot) exactly like every other
    // egress field: the raw snapshot's terminalMessage can embed task text or
    // secret-shaped values and must never reach durable history unredacted.
    result: { success: false, text: safeSnapshot.terminalMessage ?? "Run interrupted." },
    terminalReason: "interrupted",
    totalTokensIn: usage?.tokensIn ?? 0,
    totalTokensOut: usage?.tokensOut ?? 0,
    totalCostUsd: usage?.costUsd ?? 0,
    stepCount: safeSnapshot.step,
    overflowCount: 0,
  };
  await saveRun(record);
}

export function resetRunSnapshotWriteChainForTests(): void {
  writeChain = Promise.resolve();
  chainSettled = true;
  pendingSnapshot = null;
  if (coalesceTimer !== null) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
}
