/**
 * sidepanel/lifecycle.ts — agent-lifecycle icon + task-status badge.
 *
 * Owns the lifecycle state taxonomy (`idle` / `thinking` / `acting` /
 * `waiting` / `done` / `error`), the icon + label maps, and the status
 * dot updates.
 */

import { statusDot, statusLabel } from "./elements";
import { announce } from "../accessibility";

/** Task status lifecycle — drives a single status the UI can color-code. */
type TaskStatus = "idle" | "thinking" | "acting" | "waiting" | "cancelling" | "cancelled" | "done" | "error";

/** Human-readable label for each lifecycle state. */
const LIFECYCLE_LABELS: Record<TaskStatus, string> = {
  idle: "Ready",
  thinking: "Thinking…",
  acting: "Acting…",
  waiting: "Waiting…",
  cancelling: "Cancelling…",
  cancelled: "Cancelled",
  done: "Done ✓",
  error: "Error",
};

/**
 * States that deserve an assertive live announcement (the polite status bar
 * already announces routine transitions). Errors and cancellations must reach
 * screen-reader users immediately, even mid-transcript.
 */
const ALERT_STATES: Partial<Record<TaskStatus, string>> = {
  cancelled: "Agent cancelled",
  done: "Agent finished",
  error: "Agent encountered an error",
};

/** Update the status dot + label in the status bar. */
let lastAnnounced: TaskStatus | undefined;
export function setLifecycle(state: TaskStatus): void {
  if (statusDot) {
    statusDot.dataset.status = state;
  }
  if (statusLabel) statusLabel.textContent = LIFECYCLE_LABELS[state];
  const alertText = ALERT_STATES[state];
  // Deduplicate: renderRunView re-fires on every reconcile (STATUS polling,
  // stop-polling, storage hydration), so an assertive terminal re-announcement
  // per cycle would interrupt the screen reader for the same transition.
  if (alertText && state !== lastAnnounced) {
    lastAnnounced = state;
    announce(alertText, { assertive: true });
  } else if (!alertText) {
    lastAnnounced = undefined;
  }
}
