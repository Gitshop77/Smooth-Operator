/**
 * options/scheduled-tasks.ts — schedule form + chrome.alarms arming.
 *
 * Renders scheduled-task rows and sends typed commands to the background
 * service worker. The Options page never writes task storage or alarms: the
 * worker owns mutation serialization, revisions, arming, and rollback.
 *
 * Keeping those effects background-only prevents cross-context lost updates
 * and the prior disable-leak where storage and chrome.alarms diverged.
 *
 * P3: validation errors use the styled modal; visibility toggles use the
 * `is-hidden` class instead of inline `style.display`.
 */

import type { ScheduledTask, ScheduledTaskSchedule } from "@/lib/agent/scheduled-tasks";
import type { ScheduledTaskCommand } from "@/extension/background/message-types";
// Constants come from the lib (single source of truth) — a local
// duplicate here is a drift hazard.
import { DEFAULT_HOUR, DEFAULT_MINUTE, DEFAULT_DAY_OF_WEEK, isValidTaskEntry } from "@/lib/agent/scheduled-tasks-utils";
import { $, escapeHtml, redactKeyLeak } from "@/extension/shared";
import { alertModal, confirmModal } from "./modal";
import { showSaved } from "./settings-sync-utils";
import { announce, moveFocusToId } from "../accessibility";
import { schedulesStore } from "./stores";

/** Max characters allowed in a scheduled-task prompt (storage / UI sanity). */
const MAX_SCHEDULED_TASK_PROMPT = 10_000;

/**
 * Preserve click ordering within this page. The service worker remains the
 * only mutation authority; this lock merely prevents a later local render from
 * racing ahead of an earlier command response.
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

type ScheduledTaskCommandResponse = {
  ok?: boolean;
  tasks?: ScheduledTask[];
  exported?: ScheduledTask[];
  added?: number;
  updated?: number;
  skipped?: number;
  code?: string;
  error?: string;
};

async function sendScheduledTaskCommand(command: ScheduledTaskCommand): Promise<ScheduledTaskCommandResponse> {
  const response = await chrome.runtime.sendMessage({
    type: "SCHEDULED_TASK_COMMAND",
    version: 1,
    command,
  }) as ScheduledTaskCommandResponse | undefined;
  if (!response?.ok) {
    const prefix = response?.code === "SCHEDULED_TASK_REVISION_CONFLICT"
      ? "Scheduled task changed in another window"
      : "Scheduled task command failed";
    throw new Error(`${prefix}: ${response?.error ?? "no response from background"}`);
  }
  return response;
}

async function listScheduledTasks(): Promise<ScheduledTask[]> {
  const res = await sendScheduledTaskCommand({ kind: "list" });
  return Array.isArray(res.tasks) ? res.tasks : [];
}

async function saveScheduledTask(task: ScheduledTask): Promise<ScheduledTask[]> {
  const res = await sendScheduledTaskCommand({
    kind: "save",
    task,
    expectedRevision: task.revision ?? null,
  });
  return Array.isArray(res.tasks) ? res.tasks : [];
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

/** Render the scheduled tasks list strictly from the schedules store. */
function renderScheduleFromStore(): void {
  const { tasks, listAck, mutationAck } = schedulesStore.getState();
  const list = $("scheduleList") as HTMLDivElement;
  list.setAttribute("role", "list");
  list.innerHTML = "";
  if (listAck.state === "failed") {
    list.innerHTML =
      `<p class="empty-hint schedule-error" role="alert">` +
      `Could not load scheduled tasks: ${escapeHtml(listAck.error ?? "unknown error")}` +
      `</p>`;
    announce(`Could not load scheduled tasks: ${listAck.error ?? "unknown error"}`, {
      assertive: true,
    });
    return;
  }
  // While any command is awaiting its worker acknowledgement, disable the
  // per-task controls so a keyboard/mouse double-action cannot race a
  // revision-guarded mutation (the worker still rejects stale revisions).
  const mutationPending = mutationAck.state === "pending";
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
        `<button type="button" class="toggle-enable" data-enabled="${t.enabled}" ${mutationPending ? "disabled" : ""}>${t.enabled ? "Disable" : "Enable"}</button>` +
        `<button type="button" class="schedule-delete" ${mutationPending ? "disabled" : ""}>Delete</button>` +
      `</span>`;
    const enableBtn = item.querySelector("button.toggle-enable") as HTMLButtonElement;
    const delBtn = item.querySelector("button.schedule-delete") as HTMLButtonElement;
    delBtn.addEventListener("click", () => {
      // Destructive-action gate: deleting a scheduled task requires
      // explicit acknowledgement through the danger-styled modal (anti-misclick
      // delay included). Cancel leaves the list untouched.
      void confirmModal({
        title: "Delete scheduled task",
        message: `Delete scheduled task "${preview}"? This cannot be undone.`,
        confirmLabel: "Delete",
        danger: true,
      }).then((ok) => {
        if (ok) void deleteTask(t);
      });
    });
    enableBtn.addEventListener("click", () => {
      void toggleTask(t);
    });
    list.appendChild(item);
  }
}

/** Focus the schedule add-prompt after a delete so a keyboard user is not stranded. */
function focusScheduleAddForm(): void {
  if (moveFocusToId("scheduleTask")) return;
  document.querySelector<HTMLButtonElement>("#scheduleList .schedule-delete")?.focus();
}

/** Load the authoritative task list into the store (explicit list ack). */
export async function renderSchedule(): Promise<void> {
  schedulesStore.dispatch({ type: "SCHEDULES_LIST_START" });
  renderScheduleFromStore();
  try {
    const tasks = await listScheduledTasks();
    schedulesStore.dispatch({ type: "SCHEDULES_LIST_OK", tasks });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schedulesStore.dispatch({ type: "SCHEDULES_LIST_FAIL", error: message });
    console.warn("[options] renderSchedule failed:", message);
  }
  renderScheduleFromStore();
}

async function deleteTask(task: ScheduledTask): Promise<void> {
  schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_START", kind: "delete", taskId: task.id });
  try {
    await withTaskMutation(async () => {
      const res = await sendScheduledTaskCommand({
        kind: "delete",
        taskId: task.id,
        expectedRevision: task.revision ?? 0,
        expectedCreatedAt: task.createdAt,
      });
      // The worker's acknowledged task list is authoritative; render it.
      schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_OK", kind: "delete", tasks: res.tasks ?? [], taskId: task.id });
    });
    focusScheduleAddForm();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_FAIL", kind: "delete", error: message, taskId: task.id });
    announce(`Could not delete scheduled task: ${message}`, { assertive: true });
    await alertModal({
      title: "Delete failed",
      message: `Could not delete scheduled task: ${message}`,
    });
    // Recovery: re-list so the UI reflects the worker's authoritative state
    // (a failed delete must not leave the previous list silently in the DOM).
    await renderSchedule().catch((err2) => console.warn("[options] renderSchedule failed:", err2));
  }
}

async function toggleTask(task: ScheduledTask): Promise<void> {
  schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_START", kind: "toggle", taskId: task.id });
  try {
    await withTaskMutation(async () => {
      const res = await sendScheduledTaskCommand({
        kind: "set_enabled",
        taskId: task.id,
        enabled: !task.enabled,
        expectedRevision: task.revision ?? 0,
        expectedEnabled: task.enabled,
      });
      schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_OK", kind: "toggle", tasks: res.tasks ?? [], taskId: task.id });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_FAIL", kind: "toggle", error: message, taskId: task.id });
    await alertModal({
      title: "Update failed",
      message: `Could not update scheduled task: ${message}`,
    });
    await renderSchedule().catch((err2) => console.warn("[options] renderSchedule failed:", err2));
  }
}

// Re-render whenever the store settles a list/mutation command.
schedulesStore.subscribe(() => renderScheduleFromStore());

$("addSchedule").addEventListener("click", async () => {
  // The add flow runs under the same page-local mutation lock as delete/toggle,
  // so a rapid add+delete interleave cannot lose the added task (read-modify-
  // write of the whole list under two independent locks).
  await withTaskMutation(async () => {
    const task = ($("scheduleTask") as HTMLInputElement).value.trim();
    const type = ($("scheduleType") as HTMLSelectElement).value as ScheduledTaskSchedule["type"];
    if (!task) return;
    // Bound the prompt length before persisting (a scheduled-task prompt stored
    // with no length/content guard). An unbounded prompt bloats
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
    const mode = ($("scheduleMode") as HTMLSelectElement).value as ScheduledTask["mode"];
    const scheduledTask: ScheduledTask = {
      id: crypto.randomUUID(),
      task,
      schedule,
      enabled: true,
      createdAt: Date.now(),
      ...(mode && { mode }),
    };
    // Persist + arm through the typed background command. The worker validates
    // the schedule and rolls storage back if alarm reconciliation fails.
    schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_START", kind: "save" });
    try {
      const tasks = await saveScheduledTask(scheduledTask);
      schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_OK", kind: "save", tasks });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn("[options] saveScheduledTask failed:", message);
      // Surface the failure to the user instead of silently dropping the task
      // (addSchedule used to swallow saveScheduledTask failures).
      schedulesStore.dispatch({ type: "SCHEDULES_MUTATION_FAIL", kind: "save", error: message });
      await alertModal({
        title: "Could not save scheduled task",
        message,
      });
      await renderSchedule().catch((err) => console.warn("[options] renderSchedule failed:", err));
      return;
    }
    ($("scheduleTask") as HTMLInputElement).value = "";
    ($("scheduleInterval") as HTMLInputElement).value = "";
    ($("scheduleTime") as HTMLInputElement).value = "";
    ($("scheduleDay") as HTMLSelectElement).value = String(DEFAULT_DAY_OF_WEEK);
    ($("scheduleMode") as HTMLSelectElement).value = "standard";
    // Re-sync the visible schedule sections to the now-reset form.
    ($("scheduleType") as HTMLSelectElement).dispatchEvent(new Event("change"));
  });
});

// ─── A11: Scheduled-task Export/Import (background-owned) ───────────────────

/** Reject import files larger than this before reading them into memory. */
const MAX_SCHEDULE_IMPORT_BYTES = 4 * 1024 * 1024; // 4 MiB

document.getElementById("exportSchedules")?.addEventListener("click", async () => {
  let exported: ScheduledTask[];
  try {
    const res = await sendScheduledTaskCommand({ kind: "export" });
    exported = Array.isArray(res.exported) ? res.exported : [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await alertModal({ title: "Export failed", message: `Could not export scheduled tasks: ${message}` });
    return;
  }
  // Defense-in-depth key-shape masking on top of the worker's value-level
  // redaction (prompts can carry pasted credentials).
  const blob = new Blob([redactKeyLeak(JSON.stringify(exported, null, 2))], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `open-cowork-scheduled-tasks-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById("importSchedules")?.addEventListener("click", () => {
  ($("importSchedulesFile") as HTMLInputElement).click();
});

document.getElementById("importSchedulesFile")?.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > MAX_SCHEDULE_IMPORT_BYTES) {
    await alertModal({
      title: "File too large",
      message: `The selected file is ${(file.size / (1024 * 1024)).toFixed(1)} MiB; the import limit is ${MAX_SCHEDULE_IMPORT_BYTES / (1024 * 1024)} MiB.`,
    });
    (e.target as HTMLInputElement).value = "";
    return;
  }
  try {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      await alertModal({ title: "Invalid file", message: "Invalid file: expected an array of scheduled tasks." });
      return;
    }
    // Client pre-screen only; the background re-validates, re-redacts, and
    // recomputes revisions/alarms as the single mutation authority.
    const prevalidated = parsed.filter((entry) => isValidTaskEntry(entry));
    const preSkipped = parsed.length - prevalidated.length;
    const result = await sendScheduledTaskCommand({ kind: "import", tasks: prevalidated });
    await renderSchedule();
    showSaved();
    const added = result.added ?? 0;
    const updated = result.updated ?? 0;
    const skipped = (result.skipped ?? 0) + preSkipped;
    await alertModal({
      title: "Import complete",
      message: `Imported ${added} new task(s), updated ${updated} existing task(s).` +
        (skipped > 0 ? ` Skipped ${skipped} invalid entr${skipped === 1 ? "y" : "ies"}.` : ""),
    });
  } catch (err) {
    await alertModal({
      title: "Import failed",
      message: "Failed to import scheduled tasks: " + (err instanceof Error ? err.message : String(err)),
    });
    await renderSchedule().catch((err2) => console.warn("[options] renderSchedule failed:", err2));
  } finally {
    (e.target as HTMLInputElement).value = "";
  }
});
