/**
 * options/scheduled-tasks.ts — schedule form + chrome.alarms arming.
 *
 * Reads/writes the persisted scheduled-task list, renders the existing-task
 * rows, computes the next-fire delay for daily/weekly schedules (delegating
 * to `scheduled-tasks.ts:computeNextFire`), and arms chrome.alarms so the
 * background service worker can fire them.
 */

import type { ScheduledTask, ScheduledTaskSchedule } from "@/lib/agent/scheduled-tasks";
import {
  computeNextFire as computeNextFireCanonical,
} from "@/lib/agent/scheduled-tasks";
import { $, escapeHtml } from "@/extension/shared";
import { STORAGE_KEYS } from "./settings-sync";
import {
  requestKeepAwake,
  maybeReleaseKeepAwake,
} from "@/extension/background/state-store";

const ALARM_PREFIX = "open_cowork_scheduled_";
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;
const DEFAULT_DAY_OF_WEEK = 1;

// ─── Schedule type toggle ──────────────────────────────────────────────────

$("scheduleType").addEventListener("change", () => {
  const type = ($("scheduleType") as HTMLSelectElement).value;
  $("scheduleInterval").style.display = type === "interval" ? "" : "none";
  $("scheduleTime").style.display = type === "interval" ? "none" : "";
  $("scheduleDay").style.display = type === "weekly" ? "" : "none";
});

// ─── Scheduled tasks ───────────────────────────────────────────────────────

async function readScheduledTasks(): Promise<ScheduledTask[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.scheduledTasks);
  return (res[STORAGE_KEYS.scheduledTasks] as ScheduledTask[]) || [];
}

async function writeScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.scheduledTasks]: tasks });
}

/** Format a schedule spec into a human-readable string. */
function formatSchedule(s: ScheduledTaskSchedule): string {
  const hh = String(s.hour ?? DEFAULT_HOUR).padStart(2, "0");
  const mm = String(s.minute ?? DEFAULT_MINUTE).padStart(2, "0");
  if (s.type === "interval") return `every ${s.intervalMinutes ?? 60} min`;
  if (s.type === "daily") return `daily at ${hh}:${mm}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `weekly ${days[s.dayOfWeek ?? DEFAULT_DAY_OF_WEEK]} ${hh}:${mm}`;
}

/** Render the scheduled tasks list. Call after every mutation. */
export async function renderSchedule(): Promise<void> {
  const tasks = await readScheduledTasks();
  const list = $("scheduleList") as HTMLDivElement;
  list.innerHTML = "";
  if (tasks.length === 0) {
    list.innerHTML = '<p class="empty-hint">No scheduled tasks.</p>';
    return;
  }
  for (const t of tasks) {
    const item = document.createElement("div");
    item.className = "schedule-item";
    item.innerHTML =
      `<span>${escapeHtml(t.task.slice(0, 50))} — ${escapeHtml(formatSchedule(t.schedule))}</span>` +
      `<button type="button">Delete</button>`;
    item.querySelector("button")!.addEventListener("click", async () => {
      const filtered = tasks.filter((x) => x.id !== t.id);
      await writeScheduledTasks(filtered);
      try {
        await chrome.alarms.clear(`${ALARM_PREFIX}${t.id}`);
      } catch (e) {
        console.warn("[options] alarms.clear failed:", e);
      }
      // task deleted — release the system keep-awake lock IF no other
      // enabled scheduled tasks remain armed. `maybeReleaseKeepAwake`
      // performs the inline check internally. Safe to call outside the
      // extension context.
      void maybeReleaseKeepAwake();
      await renderSchedule();
    });
    list.appendChild(item);
  }
}

/** Compute the delay (in minutes) to the next fire of a daily/weekly schedule.
 * delegates to scheduled-tasks.ts:computeNextFire (the canonical
 * implementation) instead of reimplementing the algorithm here. */
function computeDelayMinutes(schedule: ScheduledTaskSchedule, now: Date): number {
  const target = computeNextFireCanonical(schedule, now);
  return (target.getTime() - now.getTime()) / 60_000;
}

/** Arm the chrome.alarm for a schedule spec. */
async function armAlarm(taskId: string, schedule: ScheduledTaskSchedule): Promise<void> {
  const name = `${ALARM_PREFIX}${taskId}`;
  try {
    if (schedule.type === "interval") {
      await chrome.alarms.create(name, { periodInMinutes: schedule.intervalMinutes });
    } else {
      const delayInMinutes = computeDelayMinutes(schedule, new Date());
      const periodInMinutes = schedule.type === "weekly" ? MINUTES_PER_WEEK : MINUTES_PER_DAY;
      await chrome.alarms.create(name, { delayInMinutes, periodInMinutes });
    }
    // alarm armed — request the OS keep the system awake so the
    // laptop doesn't sleep through the alarm. `requestKeepAwake` internally
    // checks that at least one enabled task exists (this one). Safe to call
    // outside the extension context (silent no-op when `chrome.power` is
    // unavailable).
    void requestKeepAwake();
  } catch (e) {
    console.warn("[options] alarms.create failed:", e);
  }
}

$("addSchedule").addEventListener("click", async () => {
  const task = ($("scheduleTask") as HTMLInputElement).value.trim();
  const type = ($("scheduleType") as HTMLSelectElement).value as ScheduledTaskSchedule["type"];
  if (!task) return;
  const schedule: ScheduledTaskSchedule = { type };
  if (type === "interval") {
    const intervalMinutes = parseInt(($("scheduleInterval") as HTMLInputElement).value, 10);
    if (Number.isNaN(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > MINUTES_PER_WEEK) {
      alert("Interval must be between 1 and 10080 minutes");
      return;
    }
    schedule.intervalMinutes = intervalMinutes;
  } else {
    const timeStr = ($("scheduleTime") as HTMLInputElement).value;
    const [h, m] = timeStr.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
      alert("Time must be HH:MM (00:00 to 23:59)");
      return;
    }
    schedule.hour = h;
    schedule.minute = m;
    if (type === "weekly") {
      const dayOfWeek = parseInt(($("scheduleDay") as HTMLSelectElement).value, 10);
      if (Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        alert("Day of week must be 0 (Sun) to 6 (Sat)");
        return;
      }
      schedule.dayOfWeek = dayOfWeek;
    }
  }
  const scheduledTask: ScheduledTask = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task,
    schedule,
    enabled: true,
    createdAt: Date.now(),
  };
  const tasks = await readScheduledTasks();
  tasks.push(scheduledTask);
  await writeScheduledTasks(tasks);
  await armAlarm(scheduledTask.id, schedule);
  ($("scheduleTask") as HTMLInputElement).value = "";
  await renderSchedule();
});
