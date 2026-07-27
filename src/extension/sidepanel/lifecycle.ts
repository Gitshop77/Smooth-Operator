/**
 * sidepanel/lifecycle.ts — agent-lifecycle icon + task-status badge.
 *
 * Owns the lifecycle state taxonomy (`idle` / `thinking` / `acting` /
 * `waiting` / `done` / `error`), the icon + label maps, and the status
 * dot updates.
 */

import { statusDot, statusLabel } from "./elements";

/** Task status lifecycle — drives a single status the UI can color-code. */
export type TaskStatus = "idle" | "thinking" | "acting" | "waiting" | "done" | "error";

/** Human-readable label for each lifecycle state. */
const LIFECYCLE_LABELS: Record<TaskStatus, string> = {
  idle: "idle",
  thinking: "thinking",
  acting: "acting",
  waiting: "waiting",
  done: "done",
  error: "error",
};

/** Update the status dot + label in the status bar. */
export function setLifecycle(state: TaskStatus): void {
  if (statusDot) {
    statusDot.dataset.status = state === "idle" ? "idle" : state;
  }
  if (statusLabel) statusLabel.textContent = LIFECYCLE_LABELS[state];
}
