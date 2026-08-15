/**
 * options/history.ts — run-history list + clear/export/import.
 *
 * Wires DOM listeners and import-time side effects. Rendering and validation
 * helpers live in history-utils.ts.
 *
 * Every operation is background-owned: read/clear/export/import go through the
 * typed HISTORY_COMMAND so the service worker stays the single mutation
 * authority (mutex + monotonic revision counter). The legacy direct-read
 * fallback lives only in history-utils.readRunHistory (read-only rendering,
 * migration window). Mutations NEVER fall back to direct storage writes.
 */

import { $, redactKeyLeak } from "@/extension/shared";
import { showSaved } from "./settings-sync";
import { confirmModal, alertModal } from "./modal";
import { historyStore } from "./stores";
import {
  MAX_IMPORT_BYTES,
  MAX_RUN_ENTRY_BYTES,
  isRunHistoryEntry,
  renderHistory,
  sendHistoryCommand,
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
  historyStore.dispatch({ type: "HISTORY_CLEAR_START" });
  try {
    await sendHistoryCommand({ kind: "clear" });
    historyStore.dispatch({ type: "HISTORY_CLEAR_OK" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[history] failed to clear run history:", message);
    historyStore.dispatch({ type: "HISTORY_CLEAR_FAIL", error: message });
    await alertModal({ title: "Clear failed", message: `Storage error: ${message}` });
    return;
  }
  await renderHistory();
  showSaved();
});

// ─── Run Export/Import ──────────────────────────────────────────────────────

document.getElementById("exportHistory")?.addEventListener("click", async () => {
  let runs: unknown[];
  try {
    // Background-owned redacted export: every value re-redacted in the worker.
    const res = await sendHistoryCommand({ kind: "export" });
    runs = res.runs ?? [];
    historyStore.dispatch({ type: "HISTORY_EXPORT_OK" });
  } catch (err) {
    // Large transcripts can exceed the message channel; the read-only legacy
    // direct-read export (with client-side key-shape redaction) remains the
    // migration-window fallback. It never mutates storage.
    console.warn("[history] background export failed; using legacy direct export (migration window):", err);
    try {
      const raw = await chrome.storage.local.get("open_cowork_run_history");
      const list = (raw.open_cowork_run_history as unknown) ?? [];
      runs = Array.isArray(list) ? list.filter(isRunHistoryEntry) : [];
      historyStore.dispatch({ type: "HISTORY_EXPORT_OK" });
    } catch (err2) {
      const message = err2 instanceof Error ? err2.message : String(err2);
      console.error("[history] failed to load runs for export:", message);
      historyStore.dispatch({ type: "HISTORY_EXPORT_FAIL", error: message });
      await alertModal({ title: "Export failed", message: `Storage error: ${message}` });
      return;
    }
  }
  // Mask key-shaped tokens in the exported JSON (defense-in-depth on top of
  // the background's value-level redaction).
  const blob = new Blob([redactKeyLeak(JSON.stringify(runs, null, 2))], { type: "application/json" });
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
    historyStore.dispatch({ type: "HISTORY_IMPORT_START" });
    // Client-side pre-screen: per-entry shape + size so an oversized payload
    // never crosses the message channel. The background re-validates, applies
    // the cumulative budget, redacts, and merges atomically under its mutex.
    const prevalidated = imported.filter((entry) => {
      if (!isRunHistoryEntry(entry)) return false;
      try {
        return JSON.stringify(entry).length <= MAX_RUN_ENTRY_BYTES;
      } catch {
        return false;
      }
    });
    const preSkipped = imported.length - prevalidated.length;

    // Optimistic concurrency: read the fresh revision, then import against it.
    // A concurrent change (another window, or a run completing) makes the
    // background reject with HISTORY_REVISION_CONFLICT — the user retries.
    const listRes = await sendHistoryCommand({ kind: "list" });
    const expectedRevision = listRes.revision ?? 0;
    const result = await sendHistoryCommand({
      kind: "import",
      entries: prevalidated,
      expectedRevision,
    });
    await renderHistory();
    showSaved();
    const skippedInvalid = (result.skippedInvalid ?? 0) + preSkipped;
    const importedKept = result.imported ?? 0;
    const droppedForCap = result.droppedForCap ?? 0;
    const existingDropped = result.existingDropped ?? 0;
    const summary =
      `Imported ${importedKept} run(s).` +
      (skippedInvalid > 0 ? ` Skipped ${skippedInvalid} malformed/oversized entr${skippedInvalid === 1 ? "y" : "ies"}.` : "") +
      (droppedForCap > 0 ? ` ${droppedForCap} valid run(s) dropped to stay within the 50-run limit.` : "") +
      (existingDropped > 0
        ? ` ${existingDropped} older stored run(s) dropped to stay within the 50-run limit.`
        : "");
    historyStore.dispatch({ type: "HISTORY_IMPORT_OK", summary });
    await alertModal({
      title: "Import complete",
      message: summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    historyStore.dispatch({ type: "HISTORY_IMPORT_FAIL", error: message });
    await alertModal({
      title: "Import failed",
      message: "Failed to import: " + message,
    });
  } finally {
    (e.target as HTMLInputElement).value = "";
  }
});
