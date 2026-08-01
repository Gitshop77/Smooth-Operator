/**
 * options/history.ts — run-history list + clear/export/import.
 *
 * Wires DOM listeners and import-time side effects. Rendering and validation
 * helpers live in history-utils.ts.
 */

import { $ } from "@/extension/shared";
import { showSaved } from "./settings-sync";
import { confirmModal, alertModal } from "./modal";
import {
  type RunHistoryEntry,
  MAX_IMPORT_BYTES,
  MAX_RUN_ENTRY_BYTES,
  isRunHistoryEntry,
  renderHistory,
} from "./history-utils";

export {
  isRunHistoryEntry,
  MAX_RUN_ENTRY_BYTES,
  renderHistory,
};

// ─── Run history ───────────────────────────────────────────────────────────

document.getElementById("clearHistory")?.addEventListener("click", async () => {
  const ok = await confirmModal({
    title: "Clear run history",
    message: "Delete all run history? This cannot be undone.",
    confirmLabel: "Delete all",
    danger: true,
  });
  if (!ok) return;
  try {
    await (await import("@/lib/agent/run-history")).clearAllRuns();
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

document.getElementById("exportHistory")?.addEventListener("click", async () => {
  const runs = await (await import("@/lib/agent/run-history")).loadRuns();
  const blob = new Blob([JSON.stringify(runs, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `open-cowork-history-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById("importHistory")?.addEventListener("click", () => {
  ($("importHistoryFile") as HTMLInputElement).click();
});

document.getElementById("importHistoryFile")?.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
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
    const rh = await import("@/lib/agent/run-history");
    const existing = await rh.loadRuns();
    const CUMULATIVE_BUDGET_BYTES = 4 * 1024 * 1024;
    let cumulativeBytes = existing.reduce((sum, r) => {
      try {
        return sum + JSON.stringify(r).length;
      } catch {
        return sum;
      }
    }, 0);
    const valid = imported.filter((e) => {
      if (!isRunHistoryEntry(e)) return false;
      let size = 0;
      try {
        size = JSON.stringify(e).length;
      } catch {
        return false;
      }
      if (size > MAX_RUN_ENTRY_BYTES) return false;
      if (cumulativeBytes + size > CUMULATIVE_BUDGET_BYTES) return false;
      cumulativeBytes += size;
      return true;
    });
    const keyOf = (r: RunHistoryEntry) => `${r.startedAt}|${r.task}`;
    const seen = new Set<string>();
    const deduped: RunHistoryEntry[] = [];
    for (const r of [...existing, ...valid]) {
      const k = keyOf(r);
      if (!seen.has(k)) {
        seen.add(k);
        deduped.push(r);
      }
    }
    const merged = deduped
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 50);
    const existingKept = merged.filter((r) => existing.includes(r as (typeof existing)[number])).length;
    const existingDropped = existing.length - existingKept;
    try {
      await rh.replaceAllRuns(merged as unknown as Parameters<typeof rh.replaceAllRuns>[0]);
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
    const mergedKeys = new Set(merged.map((r) => keyOf(r)));
    const validKept = valid.filter((r) => mergedKeys.has(keyOf(r))).length;
    const validDropped = valid.length - validKept;
    await alertModal({
      title: "Import complete",
      message: `Imported ${validKept} run(s).` +
        (skipped > 0 ? ` Skipped ${skipped} malformed/invalid entr${skipped === 1 ? "y" : "ies"}.` : "") +
        (validDropped > 0 ? ` ${validDropped} valid run(s) dropped to stay within the 50-run limit.` : "") +
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
