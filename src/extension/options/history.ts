/**
 * options/history.ts — run-history list + clear/export/import.
 *
 * Renders the persisted run-history entries (stored under
 * `open_cowork_run_history` in chrome.storage.local). Each row opens the
 * full transcript in a new window. Export dumps all runs as JSON; import
 * merges an uploaded JSON file (capped at 50 runs).
 */

import { $, escapeHtml } from "@/extension/shared";
import { STORAGE_KEYS } from "./settings-sync";

interface RunHistoryEntry {
  task: string;
  startedAt: number;
  endedAt: number;
  stepCount: number;
  totalCostUsd: number;
  result?: { success: boolean };
  transcript?: unknown;
}

// ─── Run history ───────────────────────────────────────────────────────────

async function readRunHistory(): Promise<RunHistoryEntry[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.runHistory);
  return (res[STORAGE_KEYS.runHistory] as RunHistoryEntry[]) || [];
}

/** Render the run history list. Each row opens the transcript in a new window. */
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
    const date = new Date(r.startedAt).toLocaleString();
    const duration = ((r.endedAt - r.startedAt) / 1000).toFixed(1);
    const badge = r.result?.success
      ? '<span class="badge success">✓ success</span>'
      : '<span class="badge failure">✗ failed</span>';
    item.innerHTML =
      `<span class="task">${escapeHtml(String((r.task ?? "").slice(0, 60)))}</span>` +
      // imported runs come from arbitrary user-uploaded JSON
      // (see the import handler below — no schema validation, just
      // `Array.isArray`). A malicious import can set `stepCount` to a
      // string like `"<img src=x onerror=alert(1)>"` or `totalCostUsd`
      // to an object whose `toFixed` returns arbitrary HTML. Coerce to
      // String + escapeHtml so neither field can break out of the
      // surrounding `<span class="meta">…</span>` context.
      `<span class="meta">${escapeHtml(date)} · ${escapeHtml(String(duration))}s · ${escapeHtml(String(r.stepCount))} steps · $${escapeHtml(String(r.totalCostUsd?.toFixed?.(4) ?? "0.0000"))}</span>` +
      badge;
    item.addEventListener("click", () => {
      // Use a Blob URL so window.open works with noopener (which returns
      // null per HTML spec — the direct w.document.write path doesn't work).
      const html = `<pre style="font:12px monospace;white-space:pre-wrap;padding:20px;">${escapeHtml(JSON.stringify(r, null, 2))}</pre>`;
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      // Revoke the Blob URL after a short delay — the new tab needs the URL
      // to resolve during window.open, but after that the reference is held
      // by the document. 1s is generous; the browser keeps the blob alive
      // for the resolving tab even after revocation.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    list.appendChild(item);
  }
}

document.getElementById("clearHistory")?.addEventListener("click", async () => {
  if (!confirm("Delete all run history?")) return;
  await chrome.storage.local.remove(STORAGE_KEYS.runHistory);
  await renderHistory();
});

// `escapeHtml` + `$` are imported from `@/extension/shared` at the top of this
// file (single source of truth for both options.ts and sidepanel.ts).

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
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) { alert("Invalid file: expected an array of runs."); return; }
    // Per-element shape check: an imported entry missing `task` would crash
    // `renderHistory` (which slices `r.task`). Filter to entries with a
    // string `task` so a malformed/hand-edited import can't brick the
    // History tab.
    const valid = imported.filter(
      (r: unknown) => r !== null && typeof r === "object" && typeof (r as { task?: unknown }).task === "string",
    );
    const existing = await (await import("@/lib/agent/run-history")).loadRuns();
    const merged = [...valid, ...existing].slice(0, 50);
    await chrome.storage.local.set({ open_cowork_run_history: merged });
    await renderHistory();
    const skipped = imported.length - valid.length;
    alert(`Imported ${valid.length} run(s).${skipped > 0 ? ` Skipped ${skipped} malformed entr${skipped === 1 ? "y" : "ies"}.` : ""}`);
  } catch (e) {
    alert("Failed to import: " + (e instanceof Error ? e.message : String(e)));
  }
});
