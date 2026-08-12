/**
 * options/history-utils.ts — Pure helpers, types, and rendering for run history.
 *
 * Separated from history.ts (which wires DOM listeners and import-time side
 * effects) so validators and render logic are independently testable.
 */

import { $, escapeHtml, redactKeyLeak } from "@/extension/shared";
import { STORAGE_KEYS } from "./storage-keys";
import { openModal } from "./modal";
import { runBadge } from "./status";
import { historyStore } from "./stores";
import type { HistoryCommand } from "@/extension/background/message-types";
import {
  MAX_RUN_ENTRY_BYTES,
  CUMULATIVE_IMPORT_BUDGET_BYTES,
} from "@/lib/agent/run-history-utils";

export { MAX_RUN_ENTRY_BYTES, CUMULATIVE_IMPORT_BUDGET_BYTES };

export interface RunHistoryEntry {
  task: string;
  startedAt: number;
  endedAt: number;
  stepCount: number;
  totalCostUsd: number;
  result?: { success: boolean; text: string } | null;
  terminalReason?: string;
  transcript?: unknown;
}

/**
 * Reject import files larger than this before reading them into memory. Mirrors
 * the HTTP-layer `readCappedBody` cap: a hostile/malformed multi-MB file should
 * never be fully buffered + JSON-parsed before validation.
 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024; // 4 MiB

/** Render cap for the transcript modal — a run entry may hold up to
 *  MAX_RUN_ENTRY_BYTES of transcript; JSON.stringify-ing and rendering the full
 *  text into the DOM (via textContent) could freeze the options page. */
export const MAX_TRANSCRIPT_CHARS = 100_000;

/**
 * Stringify a run entry for the transcript modal, mask key-shaped tokens, and
 * cap the rendered size. The storage layer redacts by VALUE only, so a pasted
 * or model-echoed key-shaped token (gsk_…, ghp_…, a JWT, …) that is not in the
 * user's secret store would otherwise surface verbatim here and in exports.
 * Redaction runs BEFORE the cap so a masked token is never cut back into a
 * partial-but-recognizable secret. Truncation is code-point-aware (no lone
 * surrogates at the cut) and appends an explicit marker so a partial dump is
 * never mistaken for the full run. The full entry stays in storage — this only
 * bounds what is rendered.
 */
export function capTranscript(run: RunHistoryEntry): string {
  const raw = JSON.stringify(run, null, 2);
  const redacted = redactKeyLeak(raw);
  if (redacted.length <= MAX_TRANSCRIPT_CHARS) return redacted;
  const cut = Array.from(redacted).slice(0, MAX_TRANSCRIPT_CHARS).join("");
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
  if (e.terminalReason !== undefined && typeof e.terminalReason !== "string") return false;
  if (e.result !== undefined && e.result !== null) {
    if (typeof e.result !== "object") return false;
    const res = e.result as Record<string, unknown>;
    if (typeof res.success !== "boolean") return false;
    if (typeof res.text !== "string") return false;
  }
  return true;
}

// ─── Run history ───────────────────────────────────────────────────────────

type HistoryCommandResponse = {
  ok?: boolean;
  runs?: unknown[];
  revision?: number;
  merged?: unknown[];
  imported?: number;
  skippedInvalid?: number;
  droppedForCap?: number;
  existingDropped?: number;
  code?: string;
  error?: string;
};

/**
 * Send a background-owned history command. All mutations and whole-list
 * operations go through the service worker (the single mutation authority);
 * the Options page never read-modify-writes the list directly.
 */
export async function sendHistoryCommand(command: HistoryCommand): Promise<HistoryCommandResponse> {
  const response = await chrome.runtime.sendMessage({
    type: "HISTORY_COMMAND",
    version: 1,
    command,
  }) as HistoryCommandResponse | undefined;
  if (!response?.ok) {
    const prefix = response?.code === "HISTORY_REVISION_CONFLICT"
      ? "Run history changed in another window"
      : "History command failed";
    throw new Error(`${prefix}: ${response?.error ?? "no response from background"}`);
  }
  return response;
}

/**
 * Read run history through the background `list` command. Falls back to the
 * legacy direct storage read ONLY for read-only rendering and ONLY through the
 * migration window (a background that cannot answer `list` is treated as an
 * unreachable read surface, never as a mutation authority). When BOTH surfaces
 * fail the load reports an explicit error instead of silently rendering an
 * empty list (Phase 12: no silent data loss).
 */
async function readRunHistory(): Promise<
  { ok: true; runs: RunHistoryEntry[] } | { ok: false; error: string }
> {
  try {
    const res = await sendHistoryCommand({ kind: "list" });
    return { ok: true, runs: (res.runs ?? []).filter(isRunHistoryEntry) };
  } catch (err) {
    console.warn("[history] background list failed; using legacy direct read (migration window):", err);
    try {
      const res = await chrome.storage.local.get(STORAGE_KEYS.runHistory);
      const runs = (res[STORAGE_KEYS.runHistory] as unknown) ?? [];
      return { ok: true, runs: Array.isArray(runs) ? runs.filter(isRunHistoryEntry) : [] };
    } catch (err2) {
      console.error("[history] failed to read run history:", err2);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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

/** Render the run history list from the authoritative history store. */
export function renderHistoryFromStore(): void {
  const { entries, loadState, error } = historyStore.getState();
  const list = $("historyList") as HTMLDivElement;
  list.innerHTML = "";
  if (loadState === "failed") {
    list.innerHTML =
      `<p class="empty-hint" role="alert">Could not load run history: ${escapeHtml(error ?? "unknown error")}</p>`;
    return;
  }
  if (entries.length === 0) {
    list.innerHTML = '<p class="empty-hint">No runs yet.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of entries) {
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
    const reason = r.terminalReason ? ` · ${r.terminalReason}` : "";
    const badge = result !== null && result !== undefined
      ? runBadge(result.success ? "success" : "failure", result.success ? "✓ success" : "✗ failed")
      : '<span class="badge">— unknown</span>';
    item.innerHTML =
      `<span class="task">${escapeHtml(String((r.task ?? "").slice(0, 60)))}</span>` +
      `<span class="meta">${escapeHtml(date)} · ${escapeHtml(String(duration))}s · ${escapeHtml(steps)} steps · $${escapeHtml(cost)}${escapeHtml(reason)}</span>` +
      badge;
    item.addEventListener("click", () => showTranscript(r));
    frag.appendChild(item);
  }
  list.appendChild(frag);
}

/**
 * Load run history into the authoritative store and render from it. A storage
 * failure surfaces as an explicit `failed` load state (never a silent empty
 * list) with the error text rendered into the list region.
 */
export async function renderHistory(): Promise<void> {
  historyStore.dispatch({ type: "HISTORY_LOAD_START" });
  renderHistoryFromStore();
  const runs = await readRunHistory();
  if (runs.ok) {
    historyStore.dispatch({ type: "HISTORY_LOAD_OK", entries: runs.runs });
  } else {
    historyStore.dispatch({ type: "HISTORY_LOAD_FAIL", error: runs.error });
  }
  renderHistoryFromStore();
}

// Re-render when the store settles a load/clear/import (covers runs that
// finished while the Options page stayed open).
historyStore.subscribe(() => renderHistoryFromStore());

// Multi-surface hydration: when a run completes (or history changes) while the
// Options page is open, reload through the authoritative store so the history
// tab never shows a stale list. Guarded by the tab-lazy render in options/index.
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEYS.runHistory]) {
      void renderHistory().catch((err) => console.warn("[history] storage-change reload failed:", err));
    }
  });
}
