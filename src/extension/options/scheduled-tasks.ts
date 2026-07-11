/**
 * options/scheduled-tasks.ts — schedule form + chrome.alarms arming.
 *
 * Reads/writes the persisted scheduled-task list, renders the existing-task
 * rows, computes the next-fire delay for daily/weekly schedules, and arms
 * chrome.alarms so the background service worker can fire them.
 *
 * P3: validation errors use the styled modal; visibility toggles use the
 * `is-hidden` class instead of inline `style.display`.
 */

import type { ScheduledTask, ScheduledTaskSchedule } from "@/lib/agent/scheduled-tasks";
import { computeNextFire as computeNextFireCanonical } from "@/lib/agent/scheduled-tasks";
import { $, escapeHtml } from "@/extension/shared";
import { STORAGE_KEYS } from "./settings-sync";
import { alertModal } from "./modal";
import { requestKeepAwake, maybeReleaseKeepAwake } from "@/extension/background/state-store";

const ALARM_PREFIX = "open_cowork_scheduled_";
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;
const DEFAULT_DAY_OF_WEEK = 1;

const show = (id: string) => $(id).classList.remove("is-hidden");
const hide = (id: string) => $(id).classList.add("is-hidden");

// ─── Schedule type toggle ──────────────────────────────────────────────────

$("scheduleType").addEventListener("change", () => {
  const type = ($("scheduleType") as HTMLSelectElement).value;
  if (type === "interval") {
    show("scheduleInterval");
    hide("scheduleTime");
    hide("scheduleDay");
  } else if (type === "daily") {
    hide("scheduleInterval");
    show("scheduleTime");
    hide("scheduleDay");
  } else {
    hide("scheduleInterval");
    show("scheduleTime");
    show("scheduleDay");
  }
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
      `<span class="schedule-summary">${escapeHtml(t.task.slice(0, 50))} — ${escapeHtml(formatSchedule(t.schedule))}</span>` +
      `<span class="schedule-controls">` +
        `<button type="button" class="toggle-enable" data-enabled="${t.enabled}">${t.enabled ? "Disable" : "Enable"}</button>` +
        `<button type="button" class="schedule-delete">Delete</button>` +
      `</span>`;
    const [enableBtn, delBtn] = Array.from(item.querySelectorAll("button"));
    delBtn.addEventListener("click", async () => {
      const filtered = tasks.filter((x) => x.id !== t.id);
      await writeScheduledTasks(filtered);
      try {
        await chrome.alarms.clear(`${ALARM_PREFIX}${t.id}`);
      } catch (e) {
        console.warn("[options] alarms.clear failed:", e);
      }
      void maybeReleaseKeepAwake();
      await renderSchedule();
    });
    enableBtn.addEventListener("click", async () => {
      t.enabled = !t.enabled;
      await writeScheduledTasks(tasks);
      // Mirror the background's arming semantics: re-arm the alarm+keep-awake
      // lock when enabling, and disarm + release the lock when disabling so a
      // disabled task neither keeps waking the service worker nor holds the OS
      // awake (previously the alarm stayed armed and the keep-awake lock leaked).
      if (t.enabled) {
        await armAlarm(t);
      } else {
        await disarmAlarm(t.id);
      }
      await renderSchedule();
    });
    list.appendChild(item);
  }
}

/** Minimum delay (ms) for the next fire — guards against scheduling in the
 *  immediate past when `now` ticks forward between compute + alarm create.
 *  Mirrors the canonical constant in src/lib/agent/scheduled-tasks.ts. */
const MIN_FIRE_DELAY_MS = 60_000;

/**
 * Clear the chrome.alarm for a task and release the system keep-awake lock if
 * no other enabled scheduled tasks remain. Mirrors the canonical `scheduleAlarm`
 * disable path (src/lib/agent/scheduled-tasks.ts).
 */
async function disarmAlarm(taskId: string): Promise<void> {
  const name = `${ALARM_PREFIX}${taskId}`;
  try {
    await chrome.alarms.clear(name);
  } catch (e) {
    console.warn("[options] alarms.clear failed:", e);
  }
  // `maybeReleaseKeepAwake` internally checks whether any enabled task remains
  // armed before releasing the OS power lock — so re-arming another task keeps
  // the lock and the laptop stays awake through the next fire.
  void maybeReleaseKeepAwake();
}

/**
 * (Re)arm the chrome.alarm for a scheduled task. Mirrors the canonical
 * `scheduleAlarm` (src/lib/agent/scheduled-tasks.ts) so the Options page and the
 * background service worker share identical arming semantics:
 *  - clears any existing alarm first (chrome.alarms.create replaces, but an
 *    explicit clear keeps behavior symmetric and avoids stale-period leaks);
 *  - is a no-op (after clearing) when `task.enabled` is false;
 *  - clamps `delayInMinutes` to the 1-minute minimum;
 *  - requests the OS keep-awake lock when arming, and releases it (if no other
 *    enabled tasks remain) when disarming.
 */
async function armAlarm(task: ScheduledTask): Promise<void> {
  if (!task.enabled) {
    await disarmAlarm(task.id);
    return;
  }
  const name = `${ALARM_PREFIX}${task.id}`;
  try {
    await chrome.alarms.clear(name);
    if (task.schedule.type === "interval") {
      await chrome.alarms.create(name, { periodInMinutes: task.schedule.intervalMinutes });
    } else {
      const now = new Date();
      const target = computeNextFireCanonical(task.schedule, now);
      const delayInMinutes = Math.max(
        (target.getTime() - now.getTime()) / 60_000,
        MIN_FIRE_DELAY_MS / 60_000
      );
      const periodInMinutes = task.schedule.type === "weekly" ? MINUTES_PER_WEEK : MINUTES_PER_DAY;
      await chrome.alarms.create(name, { delayInMinutes, periodInMinutes });
    }
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
      await alertModal({ title: "Invalid interval", message: "Interval must be between 1 and 10080 minutes." });
      return;
    }
    schedule.intervalMinutes = intervalMinutes;
  } else {
    const timeStr = ($("scheduleTime") as HTMLInputElement).value;
    const [h, m] = timeStr.split(":").map(Number);
    if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
      await alertModal({ title: "Invalid time", message: "Time must be HH:MM (00:00 to 23:59)." });
      return;
    }
    schedule.hour = h;
    schedule.minute = m;
    if (type === "weekly") {
      const dayOfWeek = parseInt(($("scheduleDay") as HTMLSelectElement).value, 10);
      if (Number.isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        await alertModal({ title: "Invalid day", message: "Day of week must be 0 (Sun) to 6 (Sat)." });
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
  await armAlarm(scheduledTask);
  ($("scheduleTask") as HTMLInputElement).value = "";
  await renderSchedule();
});
