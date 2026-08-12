/**
 * Scheduled tasks — lets users schedule recurring agent runs.
 *
 * Uses chrome.alarms (MV3-compliant). Each scheduled task stores:
 * - task prompt
 * - schedule (cronlike interval or fixed time)
 * - target tab (or "active")
 *
 * When the alarm fires, the background service worker opens the side panel
 * and starts the run.
 *
 * This module is a no-op outside the extension context (chrome.alarms is
 * only available in MV3 service workers). Every public function guards with
 * {@link isExtensionWithAlarms} so callers can invoke them unconditionally — a
 * missing chrome.alarms simply produces an empty list / no-op save.
 */

import { isExtensionWithAlarms } from "./runtime";
import { createMutex } from "./mutex";
import { redactSecrets } from "./secrets";
import { redactKeyShapes } from "./key-shape-redact";
import {
  ALARM_PREFIX,
  MINUTES_PER_DAY,
  MINUTES_PER_WEEK,
  alarmName,
  computeNextFire,
  isValidTaskEntry,
  validateSchedule,
  type ScheduledTask,
} from "./scheduled-tasks-utils";
export type { ScheduledTask, ScheduledTaskSchedule } from "./scheduled-tasks-utils";
export { MIN_FIRE_DELAY_MS, computeNextFire, validateSchedule } from "./scheduled-tasks-utils";

/** localStorage / chrome.storage key under which scheduled tasks are persisted. */
const STORAGE_KEY = "open_cowork_scheduled_tasks";

const withTaskMutation = createMutex<unknown>();

/** Raised when a UI mutation was based on an ambiguously stale task row. */
export class ScheduledTaskRevisionError extends Error {
  readonly code = "SCHEDULED_TASK_REVISION_CONFLICT";

  constructor(
    readonly taskId: string,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(
      `Scheduled task ${taskId} changed before the mutation ` +
      `(expected revision ${String(expectedRevision)}, actual ${String(actualRevision)})`,
    );
    this.name = "ScheduledTaskRevisionError";
  }
}

function revisionOf(task: ScheduledTask): number {
  return task.revision ?? 0;
}

function nextRunAtFrom(task: ScheduledTask, now: number): number | undefined {
  if (!task.enabled) return undefined;
  return task.schedule.type === "interval"
    ? now + (task.schedule.intervalMinutes ?? 0) * 60_000
    : computeNextFire(task.schedule, new Date(now)).getTime();
}

function nextRunAt(task: ScheduledTask): number | undefined {
  return nextRunAtFrom(task, Date.now());
}

async function readStoredTasks(): Promise<{ raw: unknown; tasks: ScheduledTask[] }> {
  const raw = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return {
    raw,
    tasks: Array.isArray(raw) ? raw.filter(isValidTaskEntry) : [],
  };
}

/**
 * Roll back the storage write to the previous state. If `previousTasks` was
 * undefined we remove the key entirely.
 */
async function rollbackStorage(
  previousTasks: unknown,
  taskId: string,
): Promise<boolean> {
  try {
    if (previousTasks !== undefined) {
      await chrome.storage.local.set({ [STORAGE_KEY]: previousTasks });
    } else {
      await chrome.storage.local.remove(STORAGE_KEY);
    }
    return true;
  } catch (rbErr2) {
    console.error(
      `[scheduled-tasks] rollback of storage for task ${taskId} failed:`,
      rbErr2 instanceof Error ? rbErr2.message : String(rbErr2)
    );
    return false;
  }
}

/**
 * Re-arm the previous alarm (best-effort) so an enabled task isn't left
 * without a live alarm until the next SW restart.
 */
async function reArmPriorAlarm(prior: ScheduledTask | null): Promise<boolean> {
  if (prior && prior.enabled) {
    try {
      await scheduleAlarm(prior);
      return true;
    } catch (armErr) {
      console.error(
        `[scheduled-tasks] re-arming previous alarm for task ${prior.id} failed:`,
        armErr instanceof Error ? armErr.message : String(armErr)
      );
      return false;
    }
  }
  return true;
}

/** List all scheduled tasks (regardless of `enabled`). */
export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  if (!isExtensionWithAlarms()) return [];
  return (await readStoredTasks()).tasks;
}

type RevisionExpectation = number | null | undefined;

function requireRevision(
  taskId: string,
  prior: ScheduledTask | null,
  expectedRevision: RevisionExpectation,
): void {
  if (expectedRevision === undefined) return;
  const actualRevision = prior ? revisionOf(prior) : null;
  if (actualRevision !== expectedRevision) {
    throw new ScheduledTaskRevisionError(taskId, expectedRevision, actualRevision);
  }
}

async function persistAndReconcile(
  previousRaw: unknown,
  tasks: ScheduledTask[],
  next: ScheduledTask,
  prior: ScheduledTask | null,
): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: tasks });
  try {
    await scheduleAlarm(next);
  } catch (error) {
    const storageRestored = await rollbackStorage(previousRaw, next.id);
    const alarmRestored = await reArmPriorAlarm(prior);
    const recovery = storageRestored && alarmRestored
      ? "previous state restored"
      : "rollback incomplete; mutation state is ambiguous and remains blocked";
    throw new Error(
      `Failed to reconcile alarm for task ${next.id}: ` +
      `${error instanceof Error ? error.message : String(error)} (${recovery})`,
      { cause: error },
    );
  }
}

async function saveScheduledTaskLocked(
  task: ScheduledTask,
  expectedRevision: RevisionExpectation,
): Promise<void> {
  const validationError = validateSchedule(task.schedule);
  if (validationError) throw new Error(`Invalid schedule: ${validationError}`);

  const { raw, tasks } = await readStoredTasks();
  const index = tasks.findIndex((candidate) => candidate.id === task.id);
  const prior = index >= 0 ? { ...tasks[index] } : null;
  requireRevision(task.id, prior, expectedRevision);
  const merged: ScheduledTask = {
    ...(prior ?? {}),
    ...task,
    lastRunAt: task.lastRunAt ?? prior?.lastRunAt,
    // Caller-supplied revisions are expectations, never authority. A new row
    // always starts at 1; only the background increments an existing row.
    revision: prior ? revisionOf(prior) + 1 : 1,
  };
  merged.nextRunAt = nextRunAt(merged);
  if (index >= 0) tasks[index] = merged;
  else tasks.push(merged);
  await persistAndReconcile(raw, tasks, merged, prior);
}

/**
 * Create or update a scheduled task. Also (re)arms the chrome.alarm if
 * `task.enabled` is true.
 *
 * Rolls back the storage write if `scheduleAlarm` throws — otherwise a
 * half-committed state would persist (storage says "task exists + enabled"
 * but no alarm is armed, so the task silently never fires).
 */
export async function saveScheduledTask(
  task: ScheduledTask,
  expectedRevision?: number | null,
): Promise<void> {
  if (!isExtensionWithAlarms()) return;
  return withTaskMutation(() => saveScheduledTaskLocked(task, expectedRevision)) as Promise<void>;
}

/** Atomically update only the enabled field from a rendered Options row. */
export async function setScheduledTaskEnabled(
  taskId: string,
  enabled: boolean,
  expectedRevision: number,
  expectedEnabled: boolean,
): Promise<void> {
  if (!isExtensionWithAlarms()) return;
  return withTaskMutation(async () => {
    const current = await getScheduledTask(taskId);
    if (!current) throw new ScheduledTaskRevisionError(taskId, expectedRevision, null);
    // A run-result write may advance the row revision while leaving the field
    // this command depends on unchanged. That merge is unambiguous. A changed
    // enabled value means another user mutation won and must fail closed.
    if (revisionOf(current) !== expectedRevision && current.enabled !== expectedEnabled) {
      throw new ScheduledTaskRevisionError(taskId, expectedRevision, revisionOf(current));
    }
    await saveScheduledTaskLocked({ ...current, enabled }, revisionOf(current));
  }) as Promise<void>;
}

/** Delete one stable task identity without writing a stale full-list snapshot. */
export async function deleteScheduledTask(
  taskId: string,
  expectedRevision: number,
  expectedCreatedAt: number,
): Promise<void> {
  if (!isExtensionWithAlarms()) return;
  return withTaskMutation(async () => {
    const { tasks } = await readStoredTasks();
    const index = tasks.findIndex((candidate) => candidate.id === taskId);
    const prior = index >= 0 ? tasks[index] : null;
    if (!prior) throw new ScheduledTaskRevisionError(taskId, expectedRevision, null);
    // Deletion remains unambiguous across run-result revisions, but an ID that
    // now identifies a different creation must never be deleted by a stale UI.
    if (prior.createdAt !== expectedCreatedAt) {
      throw new ScheduledTaskRevisionError(taskId, expectedRevision, revisionOf(prior));
    }
    await chrome.alarms.clear(alarmName(taskId));
    tasks.splice(index, 1);
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: tasks });
    } catch (error) {
      const alarmRestored = await reArmPriorAlarm(prior);
      throw new Error(
        `Failed to delete scheduled task ${taskId}: ` +
        `${error instanceof Error ? error.message : String(error)}` +
        (alarmRestored ? " (previous alarm restored)" : " (alarm rollback failed; state is ambiguous)"),
        { cause: error },
      );
    }
    await maybeReleaseKeepAwakeLocal();
  }) as Promise<void>;
}

/** Persist a completed alarm run without overwriting concurrent user fields. */
export async function recordScheduledTaskRun(taskId: string, lastRunAt: number): Promise<void> {
  if (!isExtensionWithAlarms()) return;
  return withTaskMutation(async () => {
    const current = await getScheduledTask(taskId);
    if (!current) return;
    await saveScheduledTaskLocked({ ...current, lastRunAt }, revisionOf(current));
  }) as Promise<void>;
}

/**
 * Request the OS keep-awake lock so the laptop doesn't sleep through an
 * armed alarm. This is a platform (`chrome.power`) concern that used to be
 * reached by dynamically importing the extension's `state-store` module —
 * that created a layering inversion (`lib/agent` → `extension/background`)
 * and a hidden circular dependency. We now call `chrome.power` directly
 * (guarded for non-extension contexts), keeping this module free of any
 * `@/extension/*` import.
 */
async function requestKeepAwakeLocal(): Promise<void> {
  try {
    if (typeof chrome !== "undefined" && chrome.power?.requestKeepAwake) {
      chrome.power.requestKeepAwake("system");
    }
  } catch {
    /* chrome.power unavailable — non-fatal */
  }
}

/**
 * Release the OS keep-awake lock, but only if no other enabled scheduled
 * task remains that would still need it. Mirrors the "maybe release" check
 * that previously lived in `state-store`; inlined here to avoid the
 * cross-layer dependency.
 */
async function maybeReleaseKeepAwakeLocal(): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.power?.releaseKeepAwake) return;
    const tasks = await listScheduledTasks();
    if (!tasks.some((t) => t.enabled)) {
      chrome.power.releaseKeepAwake();
    }
  } catch {
    /* chrome.power unavailable — non-fatal */
  }
}

/**
 * (Re)arm the chrome.alarm for a single task.
 * No-op if `task.enabled` is false. Clears any existing alarm first to avoid
 * duplicates. Also requests `chrome.power.requestKeepAwake("system")` when
 * arming (so the laptop doesn't sleep through the alarm), and releases it
 * when disarming IF no other enabled tasks remain.
 */
async function scheduleAlarm(task: ScheduledTask): Promise<void> {
  if (!isExtensionWithAlarms()) return;
  const name = alarmName(task.id);
  await chrome.alarms.clear(name);
  if (!task.enabled) {
    try {
      await maybeReleaseKeepAwakeLocal();
    } catch {
      /* chrome.power unavailable in non-extension context — non-fatal. */
    }
    return;
  }

  await createAlarm(task);
}

/** Create an alarm from an already-cleared, freshly-authorized task row. */
async function createAlarm(task: ScheduledTask): Promise<void> {
  const name = alarmName(task.id);
  if (task.schedule.type === "interval") {
    // Preserve the persisted first-fire phase: `nextRunAt` is an absolute
    // time computed when the task was saved/fired. Arming with only
    // `periodInMinutes` anchors the first fire at (re-)arm time, so every
    // SW startup that re-arms would slide the phase by the restart duration.
    // `when` keeps the phase exact (a past value means "missed fire — catch
    // up", the same semantics as the fixed-time branch below).
    const when = task.nextRunAt ?? Date.now() + (task.schedule.intervalMinutes ?? 0) * 60_000;
    // `persistAcrossSessions` (Chrome 150+) makes alarm durability explicit;
    // older Chrome ignores it and the SW-startup re-arm in `initScheduledTasks`
    // remains the compat backstop.
    await chrome.alarms.create(name, { when, periodInMinutes: task.schedule.intervalMinutes, persistAcrossSessions: true } as chrome.alarms.AlarmCreateInfo);
  } else {
    // Preserve the persisted first-fire phase: `nextRunAt` is an absolute
    // time computed when the task was saved. Deriving a `delayInMinutes`
    // from `now` on every (re)arm would shift the wall-clock fire time by
    // however late the previous fire / SW restart was delivered. `when`
    // keeps the phase exact (a past value means "missed fire — catch up").
    const when = task.nextRunAt ?? computeNextFire(task.schedule, new Date()).getTime();
    const periodInMinutes = task.schedule.type === "weekly" ? MINUTES_PER_WEEK : MINUTES_PER_DAY;
    await chrome.alarms.create(name, { when, periodInMinutes, persistAcrossSessions: true } as chrome.alarms.AlarmCreateInfo);
  }
  try {
    await requestKeepAwakeLocal();
  } catch {
    /* chrome.power unavailable in non-extension context — non-fatal. */
  }
}

/**
 * Re-arm alarms for every enabled task. Call on service-worker startup.
 *
 * Uses `Promise.all` rather than a sequential await loop — chrome.alarms
 * operations are independent so they can run concurrently (saves
 * ~N×RTT on a cold SW start where N is the number of scheduled tasks).
 * Failures are caught + logged so one bad task can't block the rest.
 */
export async function initScheduledTasks(): Promise<void> {
  if (!isExtensionWithAlarms()) return;
  const tasks = await listScheduledTasks();
  await Promise.all(
    tasks.map(async (task) => {
      try {
        // Clear outside the mutation mutex. If an Options command arrives
        // while this cold-start operation is suspended, that command can
        // commit and reconcile first instead of deadlocking behind startup.
        await chrome.alarms.clear(alarmName(task.id));
        await withTaskMutation(async () => {
          // The startup snapshot is advisory only. Re-read under the single
          // background mutation authority immediately before creating so a
          // task disabled/deleted while clear was in flight cannot be rearmed.
          const latest = await getScheduledTask(task.id);
          if (!latest?.enabled) {
            await maybeReleaseKeepAwakeLocal();
            return;
          }
          await createAlarm(latest);
        });
      } catch (e) {
        console.warn(`[scheduled-tasks] failed to arm/clear alarm for task ${task.id}:`, e);
      }
    })
  );
}

/**
 * Parse a chrome.alarms name back into a task id.
 * @returns The task id, or `null` if the name wasn't produced by this module.
 */
export function parseAlarmName(name: string): string | null {
  if (name.startsWith(ALARM_PREFIX)) {
    return name.slice(ALARM_PREFIX.length);
  }
  return null;
}

/** Find a scheduled task by id. */
export async function getScheduledTask(id: string): Promise<ScheduledTask | null> {
  const tasks = await listScheduledTasks();
  return tasks.find((t) => t.id === id) || null;
}

/** Redact a task's prompt for export (stored secrets first, then key shapes). */
async function redactTaskForExport(task: ScheduledTask): Promise<ScheduledTask> {
  const taskText = await redactSecrets(task.task);
  return { ...task, task: redactKeyShapes(taskText) };
}

/**
 * Export scheduled tasks with prompt text redacted. Read-only; never mutates
 * storage or alarms. The returned rows keep their structure so an export can
 * be re-imported (imports recompute revisions/alarms background-side).
 */
export async function exportScheduledTasks(): Promise<ScheduledTask[]> {
  if (!isExtensionWithAlarms()) return [];
  const tasks = await listScheduledTasks();
  return Promise.all(tasks.map(redactTaskForExport));
}

export interface ImportScheduledTasksResult {
  /** Tasks in storage after the import (revisions recomputed, alarms armed). */
  tasks: ScheduledTask[];
  /** New rows added by this import. */
  added: number;
  /** Existing rows updated by this import. */
  updated: number;
  /** Payload rows rejected as invalid. */
  skipped: number;
}

/**
 * Import scheduled tasks. Entirely background-owned: rows are re-validated,
 * prompts re-redacted, revisions recomputed (client revisions are expectations,
 * never authority), and the storage+alarm commit is transactional:
 * 1. storage is written first (under the single mutation mutex),
 * 2. alarms are armed only after the storage commit,
 * 3. if any alarm arm fails, storage is rolled back and prior alarms re-armed —
 *    a storage-write failure never leaves an armed alarm that would double-fire
 *    a run storage does not know about.
 */
export async function importScheduledTasks(entries: unknown[]): Promise<ImportScheduledTasksResult> {
  if (!isExtensionWithAlarms()) return { tasks: [], added: 0, updated: 0, skipped: 0 };
  const payload = Array.isArray(entries) ? entries : [];
  return withTaskMutation(async () => {
    const { raw, tasks } = await readStoredTasks();
    const merged: ScheduledTask[] = [...tasks];
    let added = 0;
    let updated = 0;
    for (const entry of payload) {
      if (!isValidTaskEntry(entry)) continue;
      const redacted = await redactTaskForExport(entry);
      const idx = merged.findIndex((candidate) => candidate.id === redacted.id);
      if (idx >= 0) {
        const prior = merged[idx];
        const next: ScheduledTask = {
          ...prior,
          ...redacted,
          id: prior.id,           // identity is background-owned
          createdAt: prior.createdAt, // createdAt is identity-ish; keep the original
          revision: revisionOf(prior) + 1,
        };
        next.nextRunAt = nextRunAtFrom(next, Date.now());
        merged[idx] = next;
        updated++;
      } else {
        const fresh: ScheduledTask = { ...redacted, revision: 1 };
        fresh.nextRunAt = nextRunAtFrom(fresh, Date.now());
        merged.push(fresh);
        added++;
      }
    }
    const skipped = payload.length - (added + updated);

    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
    try {
      // Arm only after the storage commit. Re-arming unchanged tasks is
      // idempotent (createAlarm preserves the persisted phase via `when`).
      // Deliberately SEQUENTIAL: the commit is transactional — a failed arm
      // must not leave any alarm armed for an imported task after the storage
      // rollback, and a concurrent `Promise.all` arm can succeed for another
      // task while this one fails, orphaning a phantom alarm that would fire a
      // run the rolled-back storage does not know about.
      for (const t of merged) {
        await scheduleAlarm(t);
      }
    } catch (error) {
      const storageRestored = await rollbackStorage(raw, "import");
      const priorAlarms = await Promise.all(tasks.map((t) => reArmPriorAlarm(t)));
      const allRestored = storageRestored && priorAlarms.every(Boolean);
      throw new Error(
        `Failed to reconcile alarms for imported tasks: ` +
        `${error instanceof Error ? error.message : String(error)} ` +
        `(${allRestored ? "previous state restored" : "rollback incomplete; state is ambiguous and remains blocked"})`,
        { cause: error },
      );
    }
    return { tasks: merged, added, updated, skipped } as ImportScheduledTasksResult;
  }) as Promise<ImportScheduledTasksResult>;
}

/**
 * Deterministic missed/overlap policy for alarm fires.
 *
 * Chrome delivers at most ONE catch-up fire when a service worker was asleep
 * past a scheduled time (missed runs are never replayed), and a fire that lands
 * while a run is already active is skipped (overlapping runs never start a
 * second run). Both cases leave the task's persisted `nextRunAt` pointing at a
 * time that has already passed. This function collapses the skipped slot: when
 * `nextRunAt` is in the past it is recomputed from the schedule and the alarm
 * is re-armed to the next future occurrence, so the phase stays exact and the
 * stale in-the-past value can never trigger an immediate catch-up fire loop on
 * the next SW restart.
 *
 * @returns true when the slot was advanced; false when there was nothing to do
 *          (task missing, disabled, or already in the future).
 */
export async function advanceScheduledTaskPastMissedFire(
  taskId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!isExtensionWithAlarms()) return false;
  return withTaskMutation(async () => {
    const current = await getScheduledTask(taskId);
    if (!current || !current.enabled) return false;
    if (current.nextRunAt !== undefined && current.nextRunAt > now) return false;
    const nextRun = nextRunAtFrom(current, now);
    if (nextRun === undefined || nextRun <= now) return false;
    const { raw, tasks } = await readStoredTasks();
    const index = tasks.findIndex((candidate) => candidate.id === taskId);
    if (index < 0) return false;
    // Durable missed-fire bookkeeping: a repeating task whose SW kept sleeping
    // produces silent phase slides — surface them as first-class state so the
    // user can tune intervals instead of discovering missed runs later.
    const merged: ScheduledTask = {
      ...current,
      revision: revisionOf(current),
      nextRunAt: nextRun,
      lastMissedFireAt: now,
      missedFires: (current.missedFires ?? 0) + 1,
    };
    tasks[index] = merged;
    await persistAndReconcile(raw, tasks, merged, current);
    return true;
  }) as Promise<boolean>;
}
