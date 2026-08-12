/**
 * options/stores/index.ts — Options store singletons (Phase 12).
 *
 * Each Options surface owns one reducer store; the DOM modules below dispatch
 * typed actions and render from `getState()`/`subscribe()`.  Singletons are
 * safe because every Options page is a fresh document; tests reset per store
 * via `reset()`.
 */

import { createStore } from "./store";
import {
  providerConfigReducer,
  initialProviderConfigState,
} from "./provider-config-store";
import { historyReducer, initialHistoryState } from "./history-store";
import { schedulesReducer, initialSchedulesState } from "./schedules-store";
import { settingsSyncReducer, initialSettingsSyncState } from "./settings-sync-store";

export { connectionDiagnosticsStore } from "./connection-diagnostics-store";
export type { ConnectionDiagnosticsState, DiagnosticEntry } from "./connection-diagnostics-store";
export type { ProviderConfigState, ProviderCapabilities } from "./provider-config-store";
export type { HistoryState } from "./history-store";
export type { SchedulesState } from "./schedules-store";
export type { SettingsSyncState } from "./settings-sync-store";

export const providerConfigStore = createStore(
  providerConfigReducer,
  initialProviderConfigState,
);
export const historyStore = createStore(historyReducer, initialHistoryState);
export const schedulesStore = createStore(schedulesReducer, initialSchedulesState);
export const settingsSyncStore = createStore(settingsSyncReducer, initialSettingsSyncState);
