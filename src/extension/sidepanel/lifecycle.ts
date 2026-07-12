/**
 * sidepanel/lifecycle.ts — agent-lifecycle icon + task-status badge + the
 * collapsible "agent thinking" panel.
 *
 * Owns the lifecycle state taxonomy (`idle` / `thinking` / `acting` /
 * `waiting` / `done` / `error`), the icon + label maps, and the thinking-
 * panel append/clear helpers. The status row + thinking panel are the
 * ChatWindow-style UI affordances layered on top of the existing log + cost
 * + progress UI.
 */

import { escapeHtml } from "@/extension/shared";
import { glyph, type GlyphName } from "./glyphs";
import {
  statusIcon,
  statusLabel,
  taskBadge,
  thinkingPanel,
  thinkingBody,
  thinkingHint,
} from "./elements";

/** Task status lifecycle — drives a single badge value the UI can color-code. */
export type TaskStatus = "pending" | "running" | "completed" | "failed";

/** Agent lifecycle — drives the icon shown in the status row. */
export type AgentLifecycleState =
  | "idle"
  | "thinking"
  | "acting"
  | "waiting"
  | "done"
  | "error";

/** Max entries kept in the collapsible thinking panel. */
const MAX_THINKING_ENTRIES = 50;

/** Lifecycle icon glyph (one per state) — inline-SVG, inherits currentColor. */
export const LIFECYCLE_GLYPHS: Record<AgentLifecycleState, GlyphName> = {
  idle: "circle",
  thinking: "loader",
  acting: "mouse-pointer",
  waiting: "hand",
  done: "check-circle",
  error: "alert-triangle",
};

/** Human-readable label (lowercase) for each lifecycle state. */
export const LIFECYCLE_LABELS: Record<AgentLifecycleState, string> = {
  idle: "idle",
  thinking: "thinking",
  acting: "acting",
  waiting: "waiting",
  done: "done",
  error: "error",
};

/** Update the lifecycle icon + label in the status row. */
export function setLifecycle(state: AgentLifecycleState): void {
  if (statusIcon) {
    statusIcon.innerHTML = glyph(LIFECYCLE_GLYPHS[state], 16);
    statusIcon.classList.toggle("spin", state === "thinking" || state === "acting");
  }
  if (statusLabel) statusLabel.textContent = LIFECYCLE_LABELS[state];
}

/** Update the task status badge (color-coded via the `data-status` attr). */
export function setTaskStatus(status: TaskStatus): void {
  if (!taskBadge) return;
  taskBadge.dataset.status = status;
  taskBadge.textContent = status;
}

// ─── Collapsible "agent thinking" panel ────────────────────────────────────

/** Clear the thinking panel back to its empty-state placeholder. */
export function clearThinkingPanel(): void {
  if (!thinkingBody) return;
  thinkingBody.innerHTML = `<div class="thinking-empty">Planner + Navigator reasoning will appear here as the agent runs.</div>`;
  if (thinkingHint) thinkingHint.textContent = "";
}

/**
 * Append a single reasoning entry to the thinking panel.
 *
 * @param kind Which agent produced this entry ("planner" / "navigator" / "error").
 * @param head Short header line (e.g. "Step 3 · planner").
 * @param body The reasoning text. Callers may pass RAW (unescaped) text — this
 * function HTML-escapes it before interpolating into `innerHTML`, so a
 * future unescaped LLM/page string can never XSS the side panel. Newlines in
 * `body` are rendered as `<br>` so multi-line reasoning keeps its structure.
 */
export function appendThinkingEntry(kind: "planner" | "navigator" | "error", head: string, body: string): void {
  if (!thinkingBody) return;
  const empty = thinkingBody.querySelector(".thinking-empty");
  if (empty) empty.remove();
  const entry = document.createElement("div");
  entry.className = `thinking-entry ${kind}`;
  const escapedBody = escapeHtml(body).replace(/\n/g, "<br>");
  entry.innerHTML =
    `<div class="te-head">${escapeHtml(head)}</div>` +
    `<div class="te-body">${escapedBody}</div>`;
  thinkingBody.appendChild(entry);
  while (thinkingBody.children.length > MAX_THINKING_ENTRIES) {
    thinkingBody.firstElementChild?.remove();
  }
 // Auto-scroll to the newest entry (only if the panel is open + user is near bottom).
  if (thinkingPanel?.open) {
    const nearBottom = thinkingBody.scrollHeight - thinkingBody.scrollTop - thinkingBody.clientHeight < 60;
    if (nearBottom) thinkingBody.scrollTop = thinkingBody.scrollHeight;
  }
  if (thinkingHint) thinkingHint.textContent = head;
}
