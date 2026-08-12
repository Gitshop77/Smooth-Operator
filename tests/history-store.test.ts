/**
 * History store (run-history Options surface).
 *
 * Covers: load ack lifecycle, explicit clear/import/export ack with failure
 * recovery (a failed operation surfaces as `failed` and never drops entries
 * silently), and last-mutation summaries.
 */

import { describe, expect, test } from "vitest";
import {
  historyReducer,
  initialHistoryState,
  type HistoryState,
} from "../src/extension/options/stores/history-store";
import type { RunHistoryEntry } from "../src/extension/options/history-utils";

function entry(id: number): RunHistoryEntry {
  return {
    task: `task-${id}`,
    startedAt: 1000 + id,
    endedAt: 2000 + id,
    stepCount: 1,
    totalCostUsd: 0.01,
  };
}

describe("history store", () => {
  test("load moves pending → ok with entries", () => {
    let s: HistoryState = historyReducer(initialHistoryState, { type: "HISTORY_LOAD_START" });
    expect(s.loadState).toBe("pending");
    s = historyReducer(s, { type: "HISTORY_LOAD_OK", entries: [entry(1), entry(2)] });
    expect(s.loadState).toBe("ok");
    expect(s.entries).toHaveLength(2);
    expect(s.error).toBeUndefined();
  });

  test("a storage failure surfaces as an explicit failed load (no silent empty list)", () => {
    let s = historyReducer(initialHistoryState, { type: "HISTORY_LOAD_START" });
    s = historyReducer(s, { type: "HISTORY_LOAD_FAIL", error: "chrome.storage quota exceeded" });
    expect(s.loadState).toBe("failed");
    expect(s.error).toBe("chrome.storage quota exceeded");
    // No entries were fabricated by the failure path.
    expect(s.entries).toHaveLength(0);
  });

  test("clear succeeds: entries dropped, mutation acked ok, summary recorded", () => {
    let s = historyReducer(initialHistoryState, { type: "HISTORY_LOAD_OK", entries: [entry(1)] });
    s = historyReducer(s, { type: "HISTORY_CLEAR_START" });
    expect(s.mutationState).toBe("pending");
    s = historyReducer(s, { type: "HISTORY_CLEAR_OK" });
    expect(s.mutationState).toBe("ok");
    expect(s.entries).toHaveLength(0);
    expect(s.lastMutation).toEqual({ kind: "clear", ok: true });
  });

  test("a failed clear keeps prior entries and reports the failure", () => {
    const loaded = historyReducer(initialHistoryState, { type: "HISTORY_LOAD_OK", entries: [entry(1)] });
    let s = historyReducer(loaded, { type: "HISTORY_CLEAR_START" });
    s = historyReducer(s, { type: "HISTORY_CLEAR_FAIL", error: "storage write denied" });
    expect(s.mutationState).toBe("failed");
    // No silent data loss: the previously acknowledged list stays visible.
    expect(s.entries).toHaveLength(1);
    expect(s.lastMutation).toEqual({ kind: "clear", ok: false, summary: "storage write denied" });
  });

  test("import records a summary on success and an error on failure", () => {
    let s = historyReducer(initialHistoryState, { type: "HISTORY_IMPORT_START" });
    s = historyReducer(s, { type: "HISTORY_IMPORT_OK", summary: "Imported 3 run(s)." });
    expect(s.mutationState).toBe("ok");
    expect(s.lastMutation).toEqual({ kind: "import", ok: true, summary: "Imported 3 run(s)." });

    s = historyReducer(initialHistoryState, { type: "HISTORY_IMPORT_START" });
    s = historyReducer(s, { type: "HISTORY_IMPORT_FAIL", error: "revision conflict" });
    expect(s.mutationState).toBe("failed");
    expect(s.lastMutation).toEqual({ kind: "import", ok: false, summary: "revision conflict" });
  });

  test("export acks ok on success and fails explicitly on error", () => {
    const ok = historyReducer(initialHistoryState, { type: "HISTORY_EXPORT_OK" });
    expect(ok.lastMutation).toEqual({ kind: "export", ok: true });
    const failed = historyReducer(initialHistoryState, { type: "HISTORY_EXPORT_FAIL", error: "read denied" });
    expect(failed.mutationState).toBe("failed");
    expect(failed.lastMutation).toEqual({ kind: "export", ok: false, summary: "read denied" });
  });
});
