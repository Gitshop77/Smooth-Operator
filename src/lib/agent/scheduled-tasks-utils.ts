/**
 * Pure utility functions for scheduled tasks — no chrome API dependencies.
 */

/** Schedule spec for a recurring task. */
export interface ScheduledTaskSchedule {
  type: "interval" | "daily" | "weekly";
  intervalMinutes?: number;
  hour?: number;
  minute?: number;
  dayOfWeek?: number;
}

/** A user-configured scheduled task. */
export interface ScheduledTask {
  id: string;
  task: string;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  mode?: "restricted" | "standard";
}

/** Prefix for chrome.alarms names created by this module. */
export const ALARM_PREFIX = "open_cowork_scheduled_";

/** Default hour (9 AM) when none is specified. */
export const DEFAULT_HOUR = 9;
/** Default minute (0) when none is specified. */
export const DEFAULT_MINUTE = 0;
/** Default day-of-week (Monday) when none is specified. */
export const DEFAULT_DAY_OF_WEEK = 1;
/** Minutes per day — used to compute the period for daily/weekly alarms. */
export const MINUTES_PER_DAY = 24 * 60;
/** Minutes per week — used to compute the period for weekly alarms. */
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
/** Minimum delay (ms) for the next fire. */
export const MIN_FIRE_DELAY_MS = 60_000;

/** Build the chrome.alarms name for a given task id. */
export function alarmName(taskId: string): string {
  return `${ALARM_PREFIX}${taskId}`;
}

/**
 * Validate a schedule spec.
 *
 * Returns `null` if valid, or a human-readable error message describing the
 * first violation.
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

/** Type guard: a persisted entry is a usable ScheduledTask iff its identity and schedule validate. */
export function isValidTaskEntry(t: unknown): t is ScheduledTask {
  if (t == null || typeof t !== "object") return false;
  const task = t as Partial<ScheduledTask>;
  // A corrupt/legacy entry with garbage identity would be re-armed under a
  // nonsense alarm name (`open_cowork_scheduled_undefined`) with a blank
  // prompt. Require a non-empty id and task before trusting the entry.
  if (typeof task.id !== "string" || task.id.trim() === "") return false;
  if (typeof task.task !== "string" || task.task.trim() === "") return false;
  const schedule = task.schedule;
  // A torn/partial write or an older schema version can leave `schedule`
  // missing — validateSchedule would crash on `s.type` and take down the
  // whole load path (listScheduledTasks/initScheduledTasks). Filter it out.
  if (schedule === null || typeof schedule !== "object") return false;
  return validateSchedule(schedule as ScheduledTaskSchedule) === null;
}

/**
 * Compute the next fire time for a daily/weekly schedule.
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
    const desiredDay = schedule.dayOfWeek ?? DEFAULT_DAY_OF_WEEK;
    const daysUntil = (desiredDay - target.getDay() + 7) % 7;
    target.setDate(target.getDate() + daysUntil);
  }

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
