/**
 * options/status.ts — single source of truth for status → color/label mappings.
 *
 * Previously the status-color definitions were scattered:
 *   - `vision-status.ts` defined `STATUS_DISPLAY` (badge bg + color per status)
 *   - `history.ts` hard-coded `<span class="badge success|failure">` markup
 *
 * Both now import from here so the palette lives in exactly ONE module.
 */

import type { VisionStatus } from "../vision-assistant";
import { escapeHtml } from "@/extension/shared";

/** Vision-assistant status → badge display tokens (design-system vars). */
export const STATUS_DISPLAY: Record<VisionStatus, { label: string; bg: string; color: string }> = {
  uninitialized: { label: "Not loaded",          bg: "var(--cw-raised)",         color: "var(--cw-muted)" },
  checking:      { label: "Checking cache…",     bg: "var(--cw-accent-subtle)",  color: "var(--cw-accent)" },
  downloading:   { label: "Downloading model…",  bg: "var(--cw-accent-subtle)",  color: "var(--cw-accent)" },
  compiling:     { label: "Compiling ONNX…",     bg: "var(--cw-warn-subtle)",    color: "var(--cw-warn)" },
  ready:         { label: "✓ Ready",             bg: "var(--cw-success-subtle)", color: "var(--cw-success)" },
  error:         { label: "✗ Error",             bg: "var(--cw-danger-subtle)",  color: "var(--cw-danger)" },
};

/** Outcome of a single agent run. */
export type RunStatus = "success" | "failure";

/** Map a run outcome to its badge CSS class (defined once in options.css). */
export const RUN_BADGE_CLASS: Record<RunStatus, string> = {
  success: "success",
  failure: "failure",
};

/** Build the badge `<span>` HTML for a run. The `label` is HTML-escaped so the
 *  output is safe to assign to `innerHTML` even with untrusted text. */
export function runBadge(status: RunStatus, label: string): string {
  return `<span class="badge ${RUN_BADGE_CLASS[status]}">${escapeHtml(label)}</span>`;
}
