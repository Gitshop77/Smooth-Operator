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
  const frag = document.createDocumentFragment();
  for (const r of runs) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
 // Safe formatting: stored/typed as numbers, but coerce defensively so a
 // malformed row renders as "—" rather than NaN/Invalid Date.
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

document.getElementById("clearHistory")?.addEventListener("click", async () => {
  const ok = await confirmModal({
    title: "Clear run history",
    message: "Delete all run history? This cannot be undone.",
    confirmLabel: "Delete all",
    danger: true,
  });
  if (!ok) return;
 // Route through run-history's saveChain so the clear can't race a concurrent
 // `saveRun` (which writes the same `open_cowork_run_history` key).
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
 // Load existing runs up-front so their serialized sizes can seed the
 // cumulative import budget below — otherwise an existing + imported total
 // can exceed the ~5 MB chrome.storage.local quota and make replaceAllRuns
 // throw a generic QuotaExceededError (finding: import cap ignored existing
 // run sizes).
    const rh = await import("@/lib/agent/run-history");
    const existing = await rh.loadRuns();
 // Validate every entry against the RunHistoryEntry shape; reject
 // non-conforming rows instead of storing garbage. Also bound each entry's
 // serialized size so a single multi-MB transcript can't blow the
 // ~5 MB chrome.storage.local quota (finding: import does not bound
 // per-entry size). Oversized entries are dropped (and counted as skipped)
 // rather than aborting the whole import.
    const MAX_ENTRY_BYTES = MAX_RUN_ENTRY_BYTES; // 2 MiB per entry
 // Cumulative budget across the whole import. N individual 2 MiB entries can
 // still overflow the ~5 MB chrome.storage.local quota at replaceAllRuns time,
 // so we also cap the aggregate serialized size well under the quota.
    const CUMULATIVE_BUDGET_BYTES = 4 * 1024 * 1024; // 4 MiB total
 // Seed the budget with the serialized size of the EXISTING runs, since they
 // are always re-persisted as part of `merged` — valid entries are only added
 // while the running total (existing + accepted imports) stays under the cap.
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
      if (size > MAX_ENTRY_BYTES) return false;
      if (cumulativeBytes + size > CUMULATIVE_BUDGET_BYTES) return false;
      cumulativeBytes += size;
      return true;
    });
 // Keep the 50 most-recent runs across BOTH the import and existing history
 // (sorted by startedAt desc) so importing a full file never silently wipes
 // prior runs (finding: import discards all existing history when valid>=50).
 // De-duplicate on a stable key (startedAt + task) before the cap so
 // re-importing an exported file does not create duplicate runs, and only
 // genuinely-new runs displace older ones.
    const keyOf = (r: RunHistoryEntry) => `${r.startedAt}|${r.task}`;
    const seen = new Set<string>();
    const deduped: RunHistoryEntry[] = [];
 // Iterate existing first so existing object references survive (used by the
 // dropped-run warning below) and imported duplicates fold into them.
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
 // Detect whether any pre-existing run was dropped by the cap so we can warn
 // the user instead of silently losing data.
    const existingKept = merged.filter((r) => existing.includes(r as (typeof existing)[number])).length;
    const existingDropped = existing.length - existingKept;
 // Surface storage failures (e.g. quota exceeded) rather than reporting
 // success. Promise-mode `set` rejects on failure (`chrome.runtime.lastError`
 // is callback-only), so catch the rejection instead of guarding lastError.
    try {
 // Route through run-history's saveChain so this bulk write can't race a
 // concurrent `saveRun` and silently drop a just-finished run.
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
 // Some valid entries may be dropped by the 50-run cap (after dedup/sort), so
 // the count actually stored is `validKept`, not `valid.length`. Report the
 // real number and warn about the silently-dropped valid runs.
 // Count valid entries that survived into `merged` BY KEY (startedAt|task),
 // not by reference identity. A re-imported run that duplicates an existing
 // entry is kept in `merged` as the EXISTING object reference, so a
 // reference-identity `valid.includes(r)` check would wrongly report it as a
 // dropped valid run (finding: validKept/validDropped miscount on duplicates).
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
