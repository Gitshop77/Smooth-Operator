/**
 * options/stores/history-store.ts — authoritative run-history surface state
 * (Phase 12).
 *
 * Entries, load state, and the last mutation outcome are reducer state, so a
 * storage failure surfaces as an explicit `failed` load/mutation with a
 * retryable path instead of a silently-empty list.  Entry contents are never
 * rewritten here; the storage layer owns persistence and redaction.
 */

import type { RunHistoryEntry } from "../history-utils";

export type HistoryLoadState = "idle" | "pending" | "ok" | "failed";
export type HistoryMutationState = "idle" | "pending" | "ok" | "failed";

export interface HistoryState {
  entries: RunHistoryEntry[];
  loadState: HistoryLoadState;
  mutationState: HistoryMutationState;
  /** Sanitized failure message for the current/last failed operation. */
  error?: string;
  lastMutation?: { kind: "clear" | "import" | "export"; ok: boolean; summary?: string };
}

export type HistoryAction =
  | { type: "HISTORY_LOAD_START" }
  | { type: "HISTORY_LOAD_OK"; entries: RunHistoryEntry[] }
  | { type: "HISTORY_LOAD_FAIL"; error: string }
  | { type: "HISTORY_CLEAR_START" }
  | { type: "HISTORY_CLEAR_OK" }
  | { type: "HISTORY_CLEAR_FAIL"; error: string }
  | { type: "HISTORY_IMPORT_START" }
  | { type: "HISTORY_IMPORT_OK"; summary: string }
  | { type: "HISTORY_IMPORT_FAIL"; error: string }
  | { type: "HISTORY_EXPORT_OK" }
  | { type: "HISTORY_EXPORT_FAIL"; error: string };

export const initialHistoryState: HistoryState = {
  entries: [],
  loadState: "idle",
  mutationState: "idle",
};

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "HISTORY_LOAD_START":
      return { ...state, loadState: "pending", error: undefined };
    case "HISTORY_LOAD_OK":
      return { ...state, entries: action.entries, loadState: "ok", error: undefined };
    case "HISTORY_LOAD_FAIL":
      return { ...state, loadState: "failed", error: action.error };
    case "HISTORY_CLEAR_START":
      return { ...state, mutationState: "pending", error: undefined };
    case "HISTORY_CLEAR_OK":
      return {
        ...state,
        entries: [],
        mutationState: "ok",
        lastMutation: { kind: "clear", ok: true },
      };
    case "HISTORY_CLEAR_FAIL":
      return {
        ...state,
        mutationState: "failed",
        error: action.error,
        lastMutation: { kind: "clear", ok: false, summary: action.error },
      };
    case "HISTORY_IMPORT_START":
      return { ...state, mutationState: "pending", error: undefined };
    case "HISTORY_IMPORT_OK":
      return {
        ...state,
        mutationState: "ok",
        lastMutation: { kind: "import", ok: true, summary: action.summary },
      };
    case "HISTORY_IMPORT_FAIL":
      return {
        ...state,
        mutationState: "failed",
        error: action.error,
        lastMutation: { kind: "import", ok: false, summary: action.error },
      };
    case "HISTORY_EXPORT_OK":
      return { ...state, mutationState: "ok", lastMutation: { kind: "export", ok: true } };
    case "HISTORY_EXPORT_FAIL":
      return {
        ...state,
        mutationState: "failed",
        error: action.error,
        lastMutation: { kind: "export", ok: false, summary: action.error },
      };
  }
}
