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

/** Schedule spec for a recurring task. */
export interface ScheduledTaskSchedule {
  /** Discriminator for the schedule shape. */
  type: "interval" | "daily" | "weekly";
  /** For `interval`: minutes between runs. */
  intervalMinutes?: number;
  /** For `daily` / `weekly`: hour of the day (0-23). */
  hour?: number;
  /** For `daily` / `weekly`: minute of the hour (0-59). */
  minute?: number;
  /** For `weekly`: 0=Sun..6=Sat. */
  dayOfWeek?: number;
}

/** A user-configured scheduled task. */
export interface ScheduledTask {
  /** Unique id (used as part of the chrome.alarms name). */
  id: string;
  /** Prompt to run when the alarm fires. */
  task: string;
  /** When the alarm should fire. */
  schedule: ScheduledTaskSchedule;
  /** Whether the task is currently armed. */
  enabled: boolean;
  /** Unix ms timestamp when the task was created. */
  createdAt: number;
  /** Unix ms timestamp of the last run (or undefined if never run). */
  lastRunAt?: number;
  /** Unix ms timestamp of the next scheduled run (or undefined if disabled). */
  nextRunAt?: number;
}

/** localStorage / chrome.storage key under which scheduled tasks are persisted. */
const STORAGE_KEY = "open_cowork_scheduled_tasks";

/** Prefix for chrome.alarms names created by this module. */
const ALARM_PREFIX = "open_cowork_scheduled_";

/** Default hour (9 AM) when none is specified. */
const DEFAULT_HOUR = 9;
/** Default minute (0) when none is specified. */
const DEFAULT_MINUTE = 0;
/** Default day-of-week (Monday) when none is specified. */
const DEFAULT_DAY_OF_WEEK = 1;
/** Minutes per day — used to compute the period for daily/weekly alarms. */
const MINUTES_PER_DAY = 24 * 60;
/** Minutes per week — used to compute the period for weekly alarms. */
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
/** Minimum delay (ms) for the next fire — guards against scheduling in the
 * immediate past when `now` ticks forward between compute + alarm create. */
export const MIN_FIRE_DELAY_MS = 60_000;

/** Build the chrome.alarms name for a given task id. */
function alarmName(taskId: string): string {
  return `${ALARM_PREFIX}${taskId}`;
}

/**
 * Serialize scheduled-task storage mutations within a single JS context.
 *
 * `chrome.storage.local` has no transactions, so a read-modify-write of the
 * scheduled-task list can interleave with another mutation in the *same*
 * context and clobber it (lost-update race — see ). This
 * mutex makes each mutation atomic *within* this context (e.g. two alarms
 * firing concurrently both call `saveScheduledTask`; each re-reads the list
 * under the lock so both `lastRunAt` updates survive).
 *
 * It cannot prevent a race with the Options page (a separate JS context) —
 * fixing that requires per-task storage keys, which also needs the Options
 * page (`src/extension/options/scheduled-tasks.ts`) to adopt the same scheme.
 */
let taskMutationLock: Promise<void> = Promise.resolve();
async function withTaskMutation<T>(fn: () => Promise<T>): Promise<T> {
  const prev = taskMutationLock;
  let release!: () => void;
  taskMutationLock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Validate a schedule spec.
 *
 * Returns `null` if valid, or a human-readable error message describing the
 * first violation. Used to reject malformed user input before persisting +
 * to keep `computeNextFire` from producing nonsense fire times.
 */
export function validateSchedule(s: ScheduledTaskSchedule): string | null {
  if (s.type === "interval") {
    if (typeof s.intervalMinutes !== "number" || !Number.isFinite(s.intervalMinutes) || s.intervalMinutes < 1) {
      return "intervalMinutes must be ≥ 1";
    }
    return null;
  }
  if (s.type === "daily" || s.type === "weekly") {
    if (typeof s.hour !== "number" || !Number.isFinite(s.hour) || s.hour < 0 || s.hour > 23) {
      return "hour must be 0-23";
    }
    if (typeof s.minute !== "number" || !Number.isFinite(s.minute) || s.minute < 0 || s.minute > 59) {
      return "minute must be 0-59";
    }
    if (s.type === "weekly") {
      if (typeof s.dayOfWeek !== "number" || !Number.isFinite(s.dayOfWeek) || s.dayOfWeek < 0 || s.dayOfWeek > 6) {
        return "dayOfWeek must be 0-6 (0=Sun..6=Sat)";
      }
    }
    return null;
  }
  return `unknown schedule type: ${s.type as string}`;
}

/** Type guard: a persisted entry is a usable {@link ScheduledTask} iff it's an
 * object whose `schedule` still validates . */
function isValidTaskEntry(t: unknown): t is ScheduledTask {
  return t != null && typeof t === "object" && validateSchedule((t as ScheduledTask).schedule) === null;
}

/** List all scheduled tasks (regardless of `enabled`). */
export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  if (!isExtensionWithAlarms()) return [];
  const res = await chrome.storage.local.get(STORAGE_KEY);
  const arr = res[STORAGE_KEY];
 // Guard against a corrupted/overwritten storage value (a non-array would
 // otherwise flow into `saveScheduledTask`/`initScheduledTasks`, where
 // `.findIndex`/`.map` throw a TypeError and break alarm init at SW startup).
 // Mirrors the `Array.isArray` guards used by `loadRuns`/`loadAllMemories`.
 // Also drop any persisted task whose schedule no longer validates .
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
 // Validate the schedule up-front — don't persist a malformed task.
  const validationError = validateSchedule(task.schedule);
  if (validationError) {
    throw new Error(`Invalid schedule: ${validationError}`);
  }
 // Read the stored task list once and reuse it as the rollback snapshot
 // (chrome.storage.local has no transaction support). Snapshot the raw value
 // so rollback is byte-for-byte identical to the prior state.
  const previousTasks = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  const tasks = Array.isArray(previousTasks) ? previousTasks.filter(isValidTaskEntry) : [];
  const idx = tasks.findIndex((t) => t.id === task.id);
 // Keep the original `lastRunAt` if the task already exists (don't clobber
 // run history on a config update).
  const merged: ScheduledTask =
    idx >= 0 ? { ...tasks[idx], ...task, lastRunAt: task.lastRunAt ?? tasks[idx].lastRunAt } : task;
 // Populate `nextRunAt` (declared + documented on the interface) so the UI /
 // run-history can show when the task will next fire. Previously left
 // `undefined` . For interval schedules the next fire
 // is simply now + the interval; for daily/weekly we reuse `computeNextFire`.
  if (merged.enabled) {
    merged.nextRunAt =
      merged.schedule.type === "interval"
        ? Date.now() + (merged.schedule.intervalMinutes ?? 0) * 60_000
        : computeNextFire(merged.schedule, new Date()).getTime();
  } else {
    merged.nextRunAt = undefined;
  }
 // Capture the pre-update entry (before mutation) so that, if (re)arming fails,
 // we can re-arm the previous alarm instead of leaving an enabled task without a
 // live alarm.
  const prior = idx >= 0 ? { ...tasks[idx] } : null;
  if (idx >= 0) tasks[idx] = merged;
  else tasks.push(merged);

  await chrome.storage.local.set({ [STORAGE_KEY]: tasks });
  try {
    await scheduleAlarm(merged);
  } catch (e) {
 // Roll back storage to the previous state. If `previousTasks` was
 // undefined we remove the key entirely.
    try {
      if (previousTasks) {
        await chrome.storage.local.set({ [STORAGE_KEY]: previousTasks });
      } else {
        await chrome.storage.local.remove(STORAGE_KEY);
      }
    } catch (rbErr) {
 // Rollback failure is best-effort, but a silent swallow would hide a
 // real inconsistency (storage says "enabled" but no alarm armed, or
 // vice-versa). Surface it so the breakage is diagnosable , then re-throw the original arming error.
      console.error(
        `[scheduled-tasks] rollback of storage for task ${task.id} failed:`,
        rbErr instanceof Error ? rbErr.message : String(rbErr)
      );
    }
    // Re-arm the previous alarm (best-effort) so an enabled task isn't left
    // without a live alarm until the next SW restart. The prior entry exists
    // only when updating an already-stored task.
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
 * `@/extension/*` import (see / 1).
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
 * Compute the next fire time for a daily/weekly schedule.
 *
 * Algorithm (corrected — the original advanced the day first then checked
 * the time, which produced wrong next-fire previews when the target time
 * had already passed today):
 *
 * 1. Set the target time-of-day on `now`.
 * 2. For weekly: advance the date to the next occurrence of `dayOfWeek`
 * (starting from today — 0 days if today is the target day).
 * 3. If the resulting datetime is in the past (or within the 1-minute
 * minimum-delay window), advance by the recurrence interval
 * (1 day for daily, 7 days for weekly) until it's in the future.
 *
 * Returns a Date at least {@link MIN_FIRE_DELAY_MS} in the future.
 */
export function computeNextFire(schedule: ScheduledTaskSchedule, now: Date): Date {
  const target = new Date(now);
  target.setHours(
    schedule.hour ?? DEFAULT_HOUR,
    schedule.minute ?? DEFAULT_MINUTE,
    0,
    0
  );

  if (schedule.type === "weekly") {
 // Advance to the desired day-of-week (0 = today is the target day).
    const desiredDay = schedule.dayOfWeek ?? DEFAULT_DAY_OF_WEEK;
    const daysUntil = (desiredDay - target.getDay() + 7) % 7;
    target.setDate(target.getDate() + daysUntil);
  }

 // If the target time has already passed (or is within the min-delay
 // window), advance by whole recurrence intervals until it's in the
 // future. Computed arithmetically (not looped) so extreme clock skew
 // can't leave the target in the past — the previous 8-iteration loop
 // cap could return a past date if `now` was weeks ahead of `target`.
  const minFuture = now.getTime() + MIN_FIRE_DELAY_MS;
  const stepDays = schedule.type === "weekly" ? 7 : 1;
  if (target.getTime() <= minFuture) {
    const intervalMs = stepDays * 24 * 60 * 60 * 1000;
    const elapsed = minFuture - target.getTime();
    const intervalsNeeded = Math.floor(elapsed / intervalMs) + 1;
    target.setDate(target.getDate() + stepDays * intervalsNeeded);
  }
  return target;
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
 // task was disabled — release the system keep-awake lock IF no
 // other scheduled tasks are still armed. `maybeReleaseKeepAwakeLocal`
 // performs the inline check internally. No cross-layer import required.
    try {
      await maybeReleaseKeepAwakeLocal();
    } catch {
      /* chrome.power unavailable in non-extension context — non-fatal. */
    }
    return;
  }

  if (task.schedule.type === "interval") {
    await chrome.alarms.create(name, { periodInMinutes: task.schedule.intervalMinutes } as chrome.alarms.AlarmCreateInfo);
  } else {
    const now = new Date();
    const target = computeNextFire(task.schedule, now);
    const delayInMinutes = Math.max(
      (target.getTime() - now.getTime()) / 60_000,
      MIN_FIRE_DELAY_MS / 60_000
    );
    const periodInMinutes = task.schedule.type === "weekly" ? MINUTES_PER_WEEK : MINUTES_PER_DAY;
    await chrome.alarms.create(name, { delayInMinutes, periodInMinutes });
  }
 // alarm armed successfully — request the OS keep the system awake
 // so the laptop doesn't sleep through the alarm. `requestKeepAwakeLocal`
 // internally checks that at least one enabled task exists (this one),
 // so it's a no-op if all tasks were disabled between arming + firing.
 // Safe to call outside the extension context (silent no-op when
 // `chrome.power` is unavailable).
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
 // Call scheduleAlarm unconditionally — it clears stale alarms for
 // disabled tasks (chrome.alarms persist across SW restarts, so a task
 // disabled while the SW was down may still have an armed alarm).
 // The early-return on !task.enabled was a bug: it left stale alarms
 // firing indefinitely.
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
