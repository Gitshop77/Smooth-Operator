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

const withTaskMutation = createMutex();

/**
 * Roll back the storage write to the previous state. If `previousTasks` was
 * undefined we remove the key entirely.
 */
async function rollbackStorage(
  previousTasks: unknown,
  taskId: string,
): Promise<void> {
  try {
    if (previousTasks) {
      await chrome.storage.local.set({ [STORAGE_KEY]: previousTasks });
    } else {
      await chrome.storage.local.remove(STORAGE_KEY);
    }
  } catch (rbErr2) {
    console.error(
      `[scheduled-tasks] rollback of storage for task ${taskId} failed:`,
      rbErr2 instanceof Error ? rbErr2.message : String(rbErr2)
    );
  }
}

/**
 * Re-arm the previous alarm (best-effort) so an enabled task isn't left
 * without a live alarm until the next SW restart.
 */
async function reArmPriorAlarm(prior: ScheduledTask | null): Promise<void> {
  if (prior && prior.enabled) {
    try {
      await scheduleAlarm(prior);
    } catch (armErr) {
      console.error(
        `[scheduled-tasks] re-arming previous alarm for task ${prior.id} failed:`,
        armErr instanceof Error ? armErr.message : String(armErr)
      );
    }
  }
}

/** List all scheduled tasks (regardless of `enabled`). */
export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  if (!isExtensionWithAlarms()) return [];
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const arr = res[STORAGE_KEY];
  if (!Array.isArray(arr)) return [];
  return arr.filter(isValidTaskEntry);
}

/**
 * Create or update a scheduled task. Also (re)arms the chrome.alarm if
 * `task.enabled` is true.
 *
 * Rolls back the storage write if `scheduleAlarm` throws — otherwise a
 * half-committed state would persist (storage says "task exists + enabled"
 * but no alarm is armed, so the task silently never fires).
 */
export async function saveScheduledTask(task: ScheduledTask): Promise<void> {
  if (!isExtensionWithAlarms()) return;
  return withTaskMutation(async () => {
  const validationError = validateSchedule(task.schedule);
  if (validationError) {
    throw new Error(`Invalid schedule: ${validationError}`);
  }
  const previousTasks = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  const tasks = Array.isArray(previousTasks) ? previousTasks.filter(isValidTaskEntry) : [];
  const idx = tasks.findIndex((t) => t.id === task.id);
  const merged: ScheduledTask =
    idx >= 0 ? { ...tasks[idx], ...task, lastRunAt: task.lastRunAt ?? tasks[idx].lastRunAt } : task;
  if (merged.enabled) {
    merged.nextRunAt =
      merged.schedule.type === "interval"
        ? Date.now() + (merged.schedule.intervalMinutes ?? 0) * 60_000
        : computeNextFire(merged.schedule, new Date()).getTime();
  } else {
    merged.nextRunAt = undefined;
  }
  const prior = idx >= 0 ? { ...tasks[idx] } : null;
  if (idx >= 0) tasks[idx] = merged;
  else tasks.push(merged);

  await chrome.storage.local.set({ [STORAGE_KEY]: tasks });
  try {
    await scheduleAlarm(merged);
  } catch (e) {
    await rollbackStorage(previousTasks, task.id);
    await reArmPriorAlarm(prior);
    throw new Error(
      `Failed to arm alarm for task ${task.id}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
  });
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

  if (task.schedule.type === "interval") {
    // Preserve the persisted first-fire phase: `nextRunAt` is an absolute
    // time computed when the task was saved/fired. Arming with only
    // `periodInMinutes` anchors the first fire at (re-)arm time, so every
    // SW startup that re-arms would slide the phase by the restart duration.
    // `when` keeps the phase exact (a past value means "missed fire — catch
    // up", the same semantics as the fixed-time branch below).
    const when = task.nextRunAt ?? Date.now() + (task.schedule.intervalMinutes ?? 0) * 60_000;
    await chrome.alarms.create(name, { when, periodInMinutes: task.schedule.intervalMinutes } as chrome.alarms.AlarmCreateInfo);
  } else {
    // Preserve the persisted first-fire phase: `nextRunAt` is an absolute
    // time computed when the task was saved. Deriving a `delayInMinutes`
    // from `now` on every (re)arm would shift the wall-clock fire time by
    // however late the previous fire / SW restart was delivered. `when`
    // keeps the phase exact (a past value means "missed fire — catch up").
    const when = task.nextRunAt ?? computeNextFire(task.schedule, new Date()).getTime();
    const periodInMinutes = task.schedule.type === "weekly" ? MINUTES_PER_WEEK : MINUTES_PER_DAY;
    await chrome.alarms.create(name, { when, periodInMinutes } as chrome.alarms.AlarmCreateInfo);
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
        await scheduleAlarm(task);
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
