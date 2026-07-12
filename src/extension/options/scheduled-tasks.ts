/**
 * options/scheduled-tasks.ts — schedule form + chrome.alarms arming.
 *
 * Reads/writes the persisted scheduled-task list and renders the existing-task
 * rows. All alarm arming is delegated to the canonical `saveScheduledTask` /
 * `listScheduledTasks` in src/lib/agent/scheduled-tasks.ts so the Options page
 * and the background service worker share ONE source of truth for arming
 * semantics (enabled check, clear-before-arm, keep-awake bookkeeping).
 *
 * This file deliberately keeps NO local copy of the arming logic: that was the
 * root cause of a prior disable-leak (a disabled task left its chrome.alarm
 * armed and a keep-awake lock held). Keeping arming canonical makes that class
 * of bug impossible.
 *
 * P3: validation errors use the styled modal; visibility toggles use the
 * `is-hidden` class instead of inline `style.display`.
 */

import type { ScheduledTask, ScheduledTaskSchedule } from "@/lib/agent/scheduled-tasks";
import { listScheduledTasks, saveScheduledTask } from "@/lib/agent/scheduled-tasks";
import { $, escapeHtml } from "@/extension/shared";
import { STORAGE_KEYS } from "./settings-sync";
import { alertModal } from "./modal";
import { maybeReleaseKeepAwake } from "@/extension/background/state-store";

const ALARM_PREFIX = "open_cowork_scheduled_";
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

/** Persist the full task list. Used by the delete path only — add/toggle go
 *  through the canonical `saveScheduledTask`, which also arms/disarms the
 *  alarm and manages the keep-awake lock. */
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
  const tasks = await listScheduledTasks();
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
      // `maybeReleaseKeepAwake` internally checks whether any enabled task
      // remains armed before releasing the OS power lock.
      void maybeReleaseKeepAwake();
      await renderSchedule();
    });
    enableBtn.addEventListener("click", async () => {
      // Flip enabled and persist through the canonical `saveScheduledTask`,
      // which delegates arming to `scheduleAlarm`:
      //   - enabling → arms the alarm + requests the keep-awake lock;
      //   - disabling → clears the alarm + releases the keep-awake lock IF no
      //     other enabled task remains.
      // This is the single source of truth for arming, so a disabled task can
      // never leave an armed alarm or a leaked keep-awake lock.
      t.enabled = !t.enabled;
      try {
        await saveScheduledTask(t);
      } catch (e) {
        console.warn("[options] saveScheduledTask failed:", e);
        // Revert the in-memory flip so the re-render reflects persisted state.
        t.enabled = !t.enabled;
      }
      await renderSchedule();
    });
    list.appendChild(item);
  }
}

$("addSchedule").addEventListener("click", async () => {
  const task = ($("scheduleTask") as HTMLInputElement).value.trim();
  const type = ($("scheduleType") as HTMLSelectElement).value as ScheduledTaskSchedule["type"];
  if (!task) return;
  const schedule: ScheduledTaskSchedule = { type };
  if (type === "interval") {
    const intervalMinutes = parseInt(($("scheduleInterval") as HTMLInputElement).value, 10);
    if (Number.isNaN(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 7 * 24 * 60) {
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
  // Persist + arm via the canonical `saveScheduledTask` (single source of truth
  // for arming). It validates the schedule, writes storage, and arms the alarm
  // — rolling storage back if arming fails, so a half-committed state (task
  // stored + enabled but no alarm) can never persist.
  try {
    await saveScheduledTask(scheduledTask);
  } catch (e) {
    console.warn("[options] saveScheduledTask failed:", e);
    await renderSchedule();
    return;
  }
  ($("scheduleTask") as HTMLInputElement).value = "";
  await renderSchedule();
});
