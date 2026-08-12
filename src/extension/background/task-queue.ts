/**
 * background/task-queue.ts — scheduled-task alarm handling + run-completion
 * notifications.
 *
 * `handleScheduledTaskFire` is invoked by the alarm listener in `index.ts`
 * when a scheduled-task alarm fires; it looks up the stored task and starts a
 * run with its prompt. `fireNotifications` is invoked at the end of every run
 * (`agent-bridge.ts`'s `finally` block) to fire a Chrome notification + POST
 * to a webhook (both opt-in via Settings).
 */

import { advanceScheduledTaskPastMissedFire, getScheduledTask } from "@/lib/agent/scheduled-tasks";
import { alarmName } from "@/lib/agent/scheduled-tasks-utils";
import { redactSecrets } from "@/lib/agent/secrets";
import { clearRunState, getRunState, requestKeepAwake, safeLog } from "./state-store";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MODE,
  discardReservedRunAuthority,
  isRunStartCancellationRequested,
  isRunStarting,
  reserveScheduledRunAuthority,
  setRunStarting,
  startRun,
  type RunAuthorityReservation,
} from "./agent-bridge";
import { KNOWN_MODES } from "./message-types";
import { waitForRunRecoveryAudit } from "./run-recovery-gate";
import { clipNotificationText } from "./run-notifications";

export { fireNotifications } from "./run-notifications";


/**
 * Handle a scheduled-task alarm fire. Looks up the stored task and
 * starts a run with its prompt. Skips if the task was deleted or disabled,
 * or if a run is already active.
 */
export async function handleScheduledTaskFire(taskId: string): Promise<void> {
  let reservation: RunAuthorityReservation | undefined;
  let handedOff = false;
  const abandonCancelledAdmission = async (clearStopLatch = true): Promise<void> => {
    // STOP may have persisted `abortRequested` before a controller existed.
    // This admission owns the guard and has already awaited recovery, so it
    // can safely remove that one-shot latch instead of poisoning a later run.
    if (clearStopLatch) await clearRunState().catch(() => {});
    if (reservation) {
      await discardReservedRunAuthority(reservation, "Scheduled run stopped before start.");
      reservation = undefined;
    } else {
      setRunStarting(false);
    }
  };
  try {
    // Claim the synchronous admission guard before the first await. A STOP
    // during recovery or task lookup records an abort latch rather than being
    // lost because there is not yet a controller to cancel.
    if (isRunStarting()) {
      // Overlap policy: a fire that lands while a run is already starting is
      // deterministically collapsed — advance the missed slot to the next
      // future occurrence so the stale in-the-past nextRunAt can never trigger
      // an immediate catch-up fire loop on the next SW restart.
      console.warn("[scheduled-tasks] skipping fire — runStarting guard already set (a run may be starting)");
      void advanceScheduledTaskPastMissedFire(taskId).catch(() => {});
      return;
    }
    setRunStarting(true);

    // A restarted service worker must first reconcile any orphan snapshot.
    // Starting before this resolves allows recovery cleanup to clear a
    // successor's newly persisted state, so failure is an admission failure.
    try {
      await waitForRunRecoveryAudit();
    } catch (error) {
      // Do not clear the persisted orphan here: recovery failed to prove its
      // state safe, so preserving it is the fail-closed behavior.
      await abandonCancelledAdmission(false);
      void safeLog("error", "[scheduled-tasks] recovery audit failed; refusing alarm run:", error);
      return;
    }
    if (isRunStartCancellationRequested()) {
      await abandonCancelledAdmission();
      return;
    }

    const task = await getScheduledTask(taskId);
    if (isRunStartCancellationRequested()) {
      await abandonCancelledAdmission();
      return;
    }
    if (!task || !task.enabled) {
      // A stale alarm for a task that no longer exists (or is disabled) is
      // cleared best-effort so it cannot keep firing on later SW restarts;
      // the deterministic missed-slot policy covers the in-the-past phase.
      if (!task) {
        void chrome.alarms.clear(alarmName(taskId)).catch(() => {});
      }
      setRunStarting(false);
      return; // deleted or disabled — skip
    }
 // Don't start if a run is already active.
    const existing = await getRunState();
    if (isRunStartCancellationRequested()) {
      await abandonCancelledAdmission();
      return;
    }
    if (existing?.active) {
      console.warn("[scheduled-tasks] skipping fire — a run is already active");
      setRunStarting(false);
      return;
    }
    const mode = task.mode && KNOWN_MODES.has(task.mode) ? task.mode : DEFAULT_MODE;
    // Reserve the same in-memory authority that manual RUN reserves, before
    // keep-awake, persistence, notification, side-panel, or tab work. The
    // reservation is passed into startRun so it cannot create a successor
    // controller after recovery has already observed this run.
    reservation = reserveScheduledRunAuthority({
      task: task.task,
      maxSteps: DEFAULT_MAX_STEPS,
      mode,
    });
    if (isRunStartCancellationRequested() || reservation.controller.signal.aborted) {
      await abandonCancelledAdmission();
      return;
    }
 // re-acquire the system keep-awake lock right before starting the
 // run. The lock was acquired when the alarm was armed, but the OS may
 // have suspended Chrome between arming and firing (especially for long
 // daily/weekly schedules). Re-requesting here is idempotent and ensures
 // the system stays awake for the duration of the run. `requestKeepAwake`
 // internally checks that at least one enabled task exists (this one) —
 // so it's a no-op if all tasks were disabled between arming + firing.
    await requestKeepAwake();
    if (reservation.controller.signal.aborted) {
      await abandonCancelledAdmission();
      return;
    }
 // Persist only the run-result field. The task object was read before run
 // admission and may be stale relative to an Options enable/schedule edit;
 // writing the full object here could undo that newer user mutation.
    const { recordScheduledTaskRun } = await import("@/lib/agent/scheduled-tasks");
    await recordScheduledTaskRun(task.id, Date.now());
    if (reservation.controller.signal.aborted) {
      await abandonCancelledAdmission();
      return;
    }
 // Open the side panel + start the run. chrome.sidePanel.open requires a
 // user gesture, which alarm callbacks don't have — so it will throw. Fall
 // back to a notification + badge so the user knows a scheduled task fired;
 // the panel opens on the next action-click (which IS a user gesture).
    try {
      await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    } catch {
      void chrome.action.setBadgeText({ text: "▶" });
      void chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
      void chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon.png",
        title: "Open Cowork — Scheduled Task",
        message: `Starting: ${clipNotificationText(await redactSecrets(task.task))}\nClick the extension icon to view.`,
        priority: 2,
      }, () => { /* notifications API may not be available */ });
    }
    if (reservation.controller.signal.aborted) {
      await abandonCancelledAdmission();
      return;
    }
    handedOff = true;
    await startRun({
      task: task.task,
      maxSteps: DEFAULT_MAX_STEPS,
      mode,
      isScheduledTaskRun: true,
      reservation,
    });
  } catch (e) {
 // Route through safeLog so any secret-shaped values embedded in the error
 // (task text, webhook URLs, run-derived strings) are redacted first — the
 // same discipline used by the rest of background/.
    void safeLog(
      "error",
      "[scheduled-tasks] failed to handle alarm fire:",
      e,
    );
 // release the synchronous RUN-guard flag on failure. The flag
 // was set above (`setRunStarting(true)`) BEFORE `startRun`
 // was invoked. If anything between there and the orchestrator's own
 // `finally` throws (e.g. `requestKeepAwake` rejects, `chrome.sidePanel.open`
 // throws, or `startRun` itself throws before reaching its own try/finally),
 // the flag sticks `true` and every subsequent RUN message — manual OR
 // scheduled — is rejected with "already starting" until the SW restarts.
 // Same anti-pattern as the manual-RUN handler (which the agent-bridge fix
 // already resolved for that path).
    if (reservation && !handedOff) {
      await discardReservedRunAuthority(reservation, e instanceof Error ? e.message : String(e)).catch(() => {});
    } else if (!handedOff) {
      setRunStarting(false);
    }
  }
}
