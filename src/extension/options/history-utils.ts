/**
 * options/history-utils.ts — Pure helpers, types, and rendering for run history.
 *
 * Separated from history.ts (which wires DOM listeners and import-time side
 * effects) so validators and render logic are independently testable.
 */

import { $, escapeHtml } from "@/extension/shared";
import { STORAGE_KEYS } from "./storage-keys";
import { openModal } from "./modal";
import { runBadge } from "./status";

export interface RunHistoryEntry {
  task: string;
  startedAt: number;
  endedAt: number;
  stepCount: number;
  totalCostUsd: number;
  result?: { success: boolean; text: string } | null;
  transcript?: unknown;
}

/**
 * Reject import files larger than this before reading them into memory. Mirrors
 * the HTTP-layer `readCappedBody` cap: a hostile/malformed multi-MB file should
 * never be fully buffered + JSON-parsed before validation.
 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024; // 4 MiB

/** Max serialized size of a single imported run entry (keeps the ~5 MB storage quota safe). */
export const MAX_RUN_ENTRY_BYTES = 2 * 1024 * 1024; // 2 MiB per entry

/** Render cap for the transcript modal — a run entry may hold up to
 *  MAX_RUN_ENTRY_BYTES of transcript; JSON.stringify-ing and rendering the full
 *  text into the DOM (via textContent) could freeze the options page. */
export const MAX_TRANSCRIPT_CHARS = 100_000;

/**
 * Stringify a run entry for the transcript modal and cap the rendered
 * size. Truncation is code-point-aware (no lone surrogates at the cut) and
 * appends an explicit marker so a partial dump is never mistaken for the full
 * run. The full entry stays in storage — this only bounds what is rendered.
 */
export function capTranscript(run: RunHistoryEntry): string {
  const raw = JSON.stringify(run, null, 2);
  if (raw.length <= MAX_TRANSCRIPT_CHARS) return raw;
  const cut = Array.from(raw).slice(0, MAX_TRANSCRIPT_CHARS).join("");
  return `${cut}\n… (truncated: rendered first ${MAX_TRANSCRIPT_CHARS} of ${raw.length} chars; the full run remains in storage)`;
}

/**
 * Type guard for a run-history entry. Validates every field's type (and that
 * timestamps/count/cost are finite numbers) and the optional
 * `result.success` boolean. Anything else is rejected so downstream rendering
 * and cost roll-ups never see `NaN`/garbage.
 */
export function isRunHistoryEntry(value: unknown): value is RunHistoryEntry {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (typeof e.task !== "string") return false;
  if (typeof e.startedAt !== "number" || !Number.isFinite(e.startedAt)) return false;
  if (typeof e.endedAt !== "number" || !Number.isFinite(e.endedAt)) return false;
  if (typeof e.stepCount !== "number" || !Number.isFinite(e.stepCount)) return false;
  if (typeof e.totalCostUsd !== "number" || !Number.isFinite(e.totalCostUsd)) return false;
  if (e.result !== undefined && e.result !== null) {
    if (typeof e.result !== "object") return false;
    const res = e.result as Record<string, unknown>;
    if (typeof res.success !== "boolean") return false;
    if (typeof res.text !== "string") return false;
  }
  return true;
}

// ─── Run history ───────────────────────────────────────────────────────────

async function readRunHistory(): Promise<RunHistoryEntry[]> {
  try {
    const res = await chrome.storage.local.get(STORAGE_KEYS.runHistory);
    const runs = (res[STORAGE_KEYS.runHistory] as unknown) ?? [];
    return Array.isArray(runs) ? runs.filter(isRunHistoryEntry) : [];
  } catch (err) {
    console.error("[history] failed to read run history:", err);
    return [];
  }
}

/** Open the in-page transcript modal for a single run. */
function showTranscript(run: RunHistoryEntry): void {
  const body = document.createElement("div");
  body.className = "transcript-wrap";
  const pre = document.createElement("pre");
  pre.className = "transcript";
  pre.textContent = capTranscript(run);
  body.appendChild(pre);
  void openModal({
    title: "Run transcript",
    body,
    className: "modal-wide",
    actions: [{ label: "Close", value: "close", variant: "primary", autofocus: true }],
  });
}

/** Render the run history list. Each row opens the transcript in-page. */
export async function renderHistory(): Promise<void> {
  const runs = await readRunHistory();
  const list = $("historyList") as HTMLDivElement;
  list.innerHTML = "";
  if (runs.length === 0) {
    list.innerHTML = '<p class="empty-hint">No runs yet.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of runs) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    const date = Number.isFinite(r.startedAt) ? new Date(r.startedAt).toLocaleString() : "—";
    item.setAttribute("aria-label", `View transcript of run starting ${date}`);
    const duration =
      Number.isFinite(r.endedAt) && Number.isFinite(r.startedAt)
        ? ((r.endedAt - r.startedAt) / 1000).toFixed(1)
        : "—";
    const steps = Number.isFinite(r.stepCount) ? String(r.stepCount) : "—";
    const cost = Number.isFinite(r.totalCostUsd) ? r.totalCostUsd.toFixed(4) : "—";
    const result = r.result;
    const badge = result !== null && result !== undefined
      ? runBadge(result.success ? "success" : "failure", result.success ? "✓ success" : "✗ failed")
      : '<span class="badge">— unknown</span>';
    item.innerHTML =
      `<span class="task">${escapeHtml(String((r.task ?? "").slice(0, 60)))}</span>` +
      `<span class="meta">${escapeHtml(date)} · ${escapeHtml(String(duration))}s · ${escapeHtml(steps)} steps · $${escapeHtml(cost)}</span>` +
      badge;
    item.addEventListener("click", () => showTranscript(r));
    frag.appendChild(item);
  }
  list.appendChild(frag);
}
