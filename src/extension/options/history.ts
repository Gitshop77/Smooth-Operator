/**
 * options/history.ts — run-history list + clear/export/import.
 *
 * Renders persisted run-history entries (under `open_cowork_run_history` in
 * chrome.storage.local). Each row opens the full transcript in an IN-PAGE
 * styled modal (no longer a Blob new-tab), export dumps all runs as JSON, and
 * import merges an uploaded JSON file (capped at 50 runs).
 *
 * P3: native `confirm()`/`alert()` replaced by the styled modal.
 *
 * Security notes:
 * - Imported JSON is fully user/attacker-supplied, so every entry is validated
 * against the `RunHistoryEntry` shape before it is stored or rendered
 * (findings: unbounded file read + weak schema validation).
 * - All interpolated run fields pass through the shared `escapeHtml` helper
 * (the duplicate `escapeText` was removed in favour of it).
 */

import { $, escapeHtml } from "@/extension/shared";
import { STORAGE_KEYS, showSaved } from "./settings-sync";
import { openModal, confirmModal, alertModal } from "./modal";
import { runBadge } from "./status";

interface RunHistoryEntry {
  task: string;
  startedAt: number;
  endedAt: number;
  stepCount: number;
  totalCostUsd: number;
  result?: { success: boolean };
  transcript?: unknown;
}

/**
 * Reject import files larger than this before reading them into memory. Mirrors
 * the HTTP-layer `readCappedBody` cap: a hostile/malformed multi-MB file should
 * never be fully buffered + JSON-parsed before validation.
 */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024; // 4 MiB

/**
 * Type guard for a run-history entry. Validates every field's type (and that
 * timestamps/count/cost are finite numbers) and the optional
 * `result.success` boolean. Anything else is rejected so downstream rendering
 * and cost roll-ups never see `NaN`/garbage.
 */
function isRunHistoryEntry(value: unknown): value is RunHistoryEntry {
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
 // `RunRecord.result` is `{ success: boolean; text: string } | null`, so a
 // present result must carry a `text` (consumers read `result.text`). A
 // hand-authored import omitting `text` would otherwise persist and yield
 // `undefined` downstream — reconcile the guard with the stored contract.
    if (typeof res.text !== "string") return false;
  }
 // `transcript` is free-form; accept any value (including absence).
  return true;
}

// ─── Run history ───────────────────────────────────────────────────────────

async function readRunHistory(): Promise<RunHistoryEntry[]> {
 // Promise-mode storage APIs reject on failure; `chrome.runtime.lastError` is
 // only set in callback mode, so catch the rejection to fail-safe with [].
  try {
    const res = await chrome.storage.local.get(STORAGE_KEYS.runHistory);
    const runs = (res[STORAGE_KEYS.runHistory] as unknown) ?? [];
 // Defensive: stored data should already be valid, but never trust it.
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
 // textContent (not innerHTML) — the run data is first-party but this avoids
 // any accidental markup injection from imported JSON.
  pre.textContent = JSON.stringify(run, null, 2);
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
  for (const r of runs) {
    const item = document.createElement("div");
    item.className = "history-item";
 // Safe formatting: stored/typed as numbers, but coerce defensively so a
 // malformed row renders as "—" rather than NaN/Invalid Date.
    const date = Number.isFinite(r.startedAt) ? new Date(r.startedAt).toLocaleString() : "—";
    const duration =
      Number.isFinite(r.endedAt) && Number.isFinite(r.startedAt)
        ? ((r.endedAt - r.startedAt) / 1000).toFixed(1)
        : "—";
    const steps = Number.isFinite(r.stepCount) ? String(r.stepCount) : "—";
    const cost = Number.isFinite(r.totalCostUsd) ? r.totalCostUsd.toFixed(4) : "0.0000";
    const status = r.result?.success ? "success" : "failure";
    const badge = runBadge(status, r.result?.success ? "✓ success" : "✗ failed");
    item.innerHTML =
      `<span class="task">${escapeHtml(String((r.task ?? "").slice(0, 60)))}</span>` +
      `<span class="meta">${escapeHtml(date)} · ${escapeHtml(String(duration))}s · ${escapeHtml(steps)} steps · $${escapeHtml(cost)}</span>` +
      badge;
    item.addEventListener("click", () => showTranscript(r));
    list.appendChild(item);
  }
}

document.getElementById("clearHistory")?.addEventListener("click", async () => {
  const ok = await confirmModal({
    title: "Clear run history",
    message: "Delete all run history? This cannot be undone.",
    confirmLabel: "Delete all",
    danger: true,
  });
  if (!ok) return;
 // Promise-mode storage rejects on failure (`chrome.runtime.lastError` is
 // callback-only), so catch the rejection to surface the error.
  try {
    await chrome.storage.local.remove(STORAGE_KEYS.runHistory);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[history] failed to clear run history:", message);
    await alertModal({ title: "Clear failed", message: `Storage error: ${message}` });
    return;
  }
  await renderHistory();
  showSaved();
});

// ─── A8: Run Export/Import ──────────────────────────────────────────────────

$("exportHistory")?.addEventListener("click", async () => {
  const runs = await (await import("@/lib/agent/run-history")).loadRuns();
  const blob = new Blob([JSON.stringify(runs, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `open-cowork-history-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("importHistory")?.addEventListener("click", () => {
  ($("importHistoryFile") as HTMLInputElement).click();
});

($("importHistoryFile") as HTMLInputElement)?.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
 // Bound the upload size before reading it into memory (finding: unbounded
 // file read before file.text()/JSON.parse).
  if (file.size > MAX_IMPORT_BYTES) {
    await alertModal({
      title: "File too large",
      message: `The selected file is ${(file.size / (1024 * 1024)).toFixed(1)} MiB; the import limit is ${MAX_IMPORT_BYTES / (1024 * 1024)} MiB.`,
    });
    (e.target as HTMLInputElement).value = "";
    return;
  }
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) {
      await alertModal({ title: "Invalid file", message: "Invalid file: expected an array of runs." });
      return;
    }
 // Validate every entry against the RunHistoryEntry shape; reject
 // non-conforming rows instead of storing garbage. Also bound each entry's
 // serialized size so a single multi-MB transcript can't blow the
 // ~5 MB chrome.storage.local quota (finding: import does not bound
 // per-entry size). Oversized entries are dropped (and counted as skipped)
 // rather than aborting the whole import.
    const MAX_ENTRY_BYTES = 2 * 1024 * 1024; // 2 MiB per entry
    const valid = imported.filter((e) => {
      if (!isRunHistoryEntry(e)) return false;
      try {
        return JSON.stringify(e).length <= MAX_ENTRY_BYTES;
      } catch {
        return false;
      }
    });
    const existing = await (await import("@/lib/agent/run-history")).loadRuns();
 // Keep the 50 most-recent runs across BOTH the import and existing history
 // (sorted by startedAt desc) so importing a full file never silently wipes
 // prior runs (finding: import discards all existing history when valid>=50).
    const merged = [...valid, ...existing]
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 50);
 // Detect whether any pre-existing run was dropped by the cap so we can warn
 // the user instead of silently losing data.
    const existingKept = merged.filter((r) => existing.includes(r as (typeof existing)[number])).length;
    const existingDropped = existing.length - existingKept;
 // Surface storage failures (e.g. quota exceeded) rather than reporting
 // success. Promise-mode `set` rejects on failure (`chrome.runtime.lastError`
 // is callback-only), so catch the rejection instead of guarding lastError.
    try {
      await chrome.storage.local.set({ open_cowork_run_history: merged });
    } catch (err) {
      await alertModal({
        title: "Import failed",
        message: `Storage error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    await renderHistory();
    showSaved();
    const skipped = imported.length - valid.length;
    await alertModal({
      title: "Import complete",
      message: `Imported ${valid.length} run(s).` +
        (skipped > 0 ? ` Skipped ${skipped} malformed/invalid entr${skipped === 1 ? "y" : "ies"}.` : "") +
        (existingDropped > 0
          ? ` ${existingDropped} older stored run(s) dropped to stay within the 50-run limit.`
          : ""),
    });
  } catch (err) {
    await alertModal({
      title: "Import failed",
      message: "Failed to import: " + (err instanceof Error ? err.message : String(err)),
    });
  } finally {
    (e.target as HTMLInputElement).value = "";
  }
});
