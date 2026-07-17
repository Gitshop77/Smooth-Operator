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
/** Max characters allowed in a scheduled-task prompt (storage / UI sanity). */
const MAX_SCHEDULED_TASK_PROMPT = 10_000;

/**
 * Serialize Options-side scheduled-task mutations so rapid delete clicks in the
 * SAME context can't interleave their read-modify-write of the whole list and
 * resurrect a just-deleted task (finding #10 — lost-update / task resurrection).
 * This mirrors the `withTaskMutation` mutex in `lib/agent/scheduled-tasks.ts`.
 * The canonical delete should ultimately live in the lib (sharing ONE lock with
 * the SW context), but until then this prevents the same-context race.
 */
let optionsTaskLock: Promise<void> = Promise.resolve();
async function withTaskMutation<T>(fn: () => Promise<T>): Promise<T> {
  const prev = optionsTaskLock;
  let release!: () => void;
  optionsTaskLock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

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
 * through the canonical `saveScheduledTask`, which also arms/disarms the
 * alarm and manages the keep-awake lock. */
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
 // Guard the stored `dayOfWeek` (a corrupt/absent value would index `days`
 // as `undefined` and render "weekly undefined HH:MM").
  const dow =
    typeof s.dayOfWeek === "number" && s.dayOfWeek >= 0 && s.dayOfWeek <= 6
      ? s.dayOfWeek
      : DEFAULT_DAY_OF_WEEK;
  return `weekly ${days[dow]} ${hh}:${mm}`;
}

/** Render the scheduled tasks list. Call after every mutation. */
export async function renderSchedule(): Promise<void> {
  const tasks = await listScheduledTasks();
  const list = $("scheduleList") as HTMLDivElement;
  list.setAttribute("role", "list");
  list.innerHTML = "";
  if (tasks.length === 0) {
    list.innerHTML = '<p class="empty-hint">No scheduled tasks.</p>';
    return;
  }
  for (const t of tasks) {
    const item = document.createElement("div");
    item.className = "schedule-item";
    item.setAttribute("role", "listitem");
    const preview = t.task.length > 50 ? t.task.slice(0, 50) + "…" : t.task;
    item.innerHTML =
      `<span class="schedule-summary">${escapeHtml(preview)} — ${escapeHtml(formatSchedule(t.schedule))}</span>` +
      `<span class="schedule-controls">` +
        `<button type="button" class="toggle-enable" data-enabled="${t.enabled}">${t.enabled ? "Disable" : "Enable"}</button>` +
        `<button type="button" class="schedule-delete">Delete</button>` +
      `</span>`;
    const enableBtn = item.querySelector("button.toggle-enable") as HTMLButtonElement;
    const delBtn = item.querySelector("button.schedule-delete") as HTMLButtonElement;
    delBtn.addEventListener("click", async () => {
      try {
        await withTaskMutation(async () => {
 // Re-read the freshest list INSIDE the lock so two rapid deletes can't
 // each overwrite the other's write (task-resurrection race, finding
 // #10). Removing by id (not by a stale render snapshot) is safe even if
 // another context mutated the list between renders.
        const current = await listScheduledTasks();
        const filtered = current.filter((x) => x.id !== t.id);
        await writeScheduledTasks(filtered);
 // Clear the alarm. If the storage write succeeded but `clear` fails, the
 // alarm would otherwise linger (orphaned) and fire for a deleted task,
 // so retry once before giving up (finding: delete storage-write success
 // not matched by alarm-clear success). A canonical `deleteScheduledTask`
 // in the lib would make this transactional.
        try {
          await chrome.alarms.clear(`${ALARM_PREFIX}${t.id}`);
        } catch (e) {
          console.warn("[options] alarms.clear failed, retrying:", e);
          try {
            await chrome.alarms.clear(`${ALARM_PREFIX}${t.id}`);
          } catch (e2) {
            console.warn("[options] alarms.clear retry failed (alarm may be orphaned):", e2);
          }
        }
 // `maybeReleaseKeepAwake` internally checks whether any enabled task
 // remains armed before releasing the OS power lock.
        maybeReleaseKeepAwake().catch((err) =>
          console.warn("[options] keep-awake release failed:", err),
        );
      });
      } catch (err) {
        await alertModal({
          title: "Delete failed",
          message: `Could not delete scheduled task: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      await renderSchedule().catch((err) => console.warn("[options] renderSchedule failed:", err));
    });
    enableBtn.addEventListener("click", async () => {
      await withTaskMutation(async () => {
 // Re-read the freshest list so a stale render-closure object can't resurrect
 // a task that was deleted in another context (finding #44).
        const current = await listScheduledTasks();
        const target = current.find((x) => x.id === t.id);
        if (!target) return; // deleted — do not re-persist
        target.enabled = !target.enabled;
        try {
          await saveScheduledTask(target);
        } catch (e) {
          console.warn("[options] saveScheduledTask failed:", e);
        }
      });
      await renderSchedule().catch((err) => console.warn("[options] renderSchedule failed:", err));
    });
    list.appendChild(item);
  }
}

$("addSchedule").addEventListener("click", async () => {
  const task = ($("scheduleTask") as HTMLInputElement).value.trim();
  const type = ($("scheduleType") as HTMLSelectElement).value as ScheduledTaskSchedule["type"];
  if (!task) return;
 // Bound the prompt length before persisting (finding: scheduled task prompt
 // stored with no length/content guard). An unbounded prompt bloats
 // chrome.storage.local and is only shown truncated in the list preview.
  if (task.length > MAX_SCHEDULED_TASK_PROMPT) {
    await alertModal({
      title: "Prompt too long",
      message: `Scheduled task prompt must be ${MAX_SCHEDULED_TASK_PROMPT} characters or fewer.`,
    });
    return;
  }
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
 // Surface the failure to the user instead of silently dropping the task
 // (finding: addSchedule silently swallowed saveScheduledTask failures).
    await alertModal({
      title: "Could not save scheduled task",
      message: e instanceof Error ? e.message : String(e),
    });
    await renderSchedule().catch((err) => console.warn("[options] renderSchedule failed:", err));
    return;
  }
  ($("scheduleTask") as HTMLInputElement).value = "";
  ($("scheduleInterval") as HTMLInputElement).value = "";
  ($("scheduleTime") as HTMLInputElement).value = "";
  ($("scheduleDay") as HTMLSelectElement).value = String(DEFAULT_DAY_OF_WEEK);
 // Re-sync the visible schedule sections to the now-reset form.
  ($("scheduleType") as HTMLSelectElement).dispatchEvent(new Event("change"));
  await renderSchedule();
});
