/**
 * options/stores/connection-diagnostics-store.ts — connection-test lifecycle
 * and bounded result history (Phase 12).
 *
 * Every provider/model change invalidates the diagnostic surface (the UI
 * dispatches DIAGNOSTICS_INVALIDATED whenever the provider-config store's
 * selection key changes).  A test that started under an older selection is
 * tagged with that generation and dropped when it resolves — so a late
 * response for provider A can never overwrite the state of a test for
 * provider B (the "no stale-cache leaks" invariant).
 *
 * The result payload mirrors the background contract (ProviderConnectionResultV1)
 * and never contains a credential.
 */

import type { ProviderConnectionResultV1 } from "../../options-platform-contract";
import { createStore, type Store } from "./store";

/** Display lifecycle of the current diagnostic. */
export type DiagnosticState = "idle" | "pending" | "ok" | "failed" | "cancelled";

export interface DiagnosticEntry {
  generation: number;
  provider: string;
  model: string;
  state: DiagnosticState;
  /** Provider-owned result (never contains a credential value). */
  result?: ProviderConnectionResultV1;
  /** Sanitized local failure message (transport errors, redaction applied). */
  error?: string;
  startedAt?: number;
  settledAt?: number;
}

export interface ConnectionDiagnosticsState {
  /** The current test (one at a time per the shared test button). */
  current: DiagnosticEntry;
  /** Bounded history of finished tests, newest first. */
  history: DiagnosticEntry[];
  /** Any last surfaced transport/storage error not owned by a test. */
  error?: string;
}

export const HISTORY_LIMIT = 20;

export type ConnectionDiagnosticsAction =
  | { type: "DIAGNOSTICS_INVALIDATED" }
  | { type: "DIAGNOSTICS_TEST_STARTED"; generation: number; provider: string; model: string }
  | { type: "DIAGNOSTICS_TEST_RESOLVED"; generation: number; result: ProviderConnectionResultV1 }
  | { type: "DIAGNOSTICS_TEST_FAILED"; generation: number; error: string }
  | { type: "DIAGNOSTICS_ERROR"; error: string }
  | { type: "DIAGNOSTICS_ERROR_CLEARED" };

function emptyEntry(generation: number): DiagnosticEntry {
  return { generation, provider: "", model: "", state: "idle" };
}

export const initialConnectionDiagnosticsState: ConnectionDiagnosticsState = {
  current: emptyEntry(0),
  history: [],
};

export function connectionDiagnosticsReducer(
  state: ConnectionDiagnosticsState,
  action: ConnectionDiagnosticsAction,
): ConnectionDiagnosticsState {
  switch (action.type) {
    case "DIAGNOSTICS_INVALIDATED": {
      const generation = state.current.generation + 1;
      return { ...state, current: emptyEntry(generation) };
    }
    case "DIAGNOSTICS_TEST_STARTED": {
      if (action.generation !== state.current.generation) return state;
      return {
        ...state,
        current: {
          generation: action.generation,
          provider: action.provider,
          model: action.model,
          state: "pending",
          startedAt: Date.now(),
        },
      };
    }
    case "DIAGNOSTICS_TEST_RESOLVED": {
      if (action.generation !== state.current.generation) return state;
      const settled: DiagnosticEntry = {
        ...state.current,
        state: action.result.ok ? "ok" : "failed",
        result: action.result,
        error: action.result.ok ? undefined : action.result.message,
        settledAt: Date.now(),
      };
      return {
        ...state,
        current: settled,
        history: [settled, ...state.history].slice(0, HISTORY_LIMIT),
      };
    }
    case "DIAGNOSTICS_TEST_FAILED": {
      if (action.generation !== state.current.generation) return state;
      const settled: DiagnosticEntry = {
        ...state.current,
        state: "failed",
        error: action.error,
        settledAt: Date.now(),
      };
      return {
        ...state,
        current: settled,
        history: [settled, ...state.history].slice(0, HISTORY_LIMIT),
      };
    }
    case "DIAGNOSTICS_ERROR":
      return { ...state, error: action.error };
    case "DIAGNOSTICS_ERROR_CLEARED":
      return state.error === undefined ? state : { ...state, error: undefined };
  }
}

export const connectionDiagnosticsStore: Store<
  ConnectionDiagnosticsState,
  ConnectionDiagnosticsAction
> = createStore(connectionDiagnosticsReducer, initialConnectionDiagnosticsState);
